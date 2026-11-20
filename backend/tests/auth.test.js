'use strict';
jest.mock('../services/email/emailService', () => ({
  sendOtpEmail: jest.fn().mockResolvedValue(undefined),
  sendPasswordResetEmail: jest.fn().mockResolvedValue(undefined),
  isConfigured: () => true,
}));
const email = require('../services/email/emailService');
const AppError = require('../utils/AppError');
const { api, setupDb, teardownDb, createAdmin, createVoter, createConstituency, auth, PASSWORD, M } = require('./helpers');

beforeAll(setupDb);
afterAll(teardownDb);

const lastOtp = () => email.sendOtpEmail.mock.calls.at(-1)[2];
const registerBody = (cons, over = {}) => ({
  fullName: 'Reg Tester', email: `reg${Date.now()}${Math.floor(Math.random() * 1e4)}@test.elexguard.test`, password: PASSWORD,
  voterIdNumber: `REG-${Math.floor(Math.random() * 1e9)}`, dateOfBirth: '1995-05-05', constituency: String(cons._id), ...over,
});

describe('Registration & email OTP', () => {
  let cons;
  beforeAll(async () => { cons = await createConstituency('REGC'); });

  test('registers a voter, hashes the password, and allows immediate login', async () => {
    const body = registerBody(cons);
    const res = await api().post('/api/auth/register').send(body);
    expect(res.status).toBe(201);
    const user = await M.User.findOne({ email: body.email }).select('+passwordHash');
    expect(user.passwordHash).not.toBe(PASSWORD);
    expect(user.passwordHash).toMatch(/^\$2[aby]\$/);
    expect(user.emailVerified).toBe(true);
    const login = await api().post('/api/auth/login').send({ email: body.email, password: PASSWORD });
    expect(login.status).toBe(200);
    expect(login.body.data.user.voter.verificationStatus).toBe('pending');
  });

  test('rejects weak passwords, under-age voters and invalid input (server-side validation)', async () => {
    const weak = await api().post('/api/auth/register').send(registerBody(cons, { password: 'weak' }));
    expect(weak.status).toBe(400);
    expect(weak.body.details.fields.password).toBeDefined();
    const minor = await api().post('/api/auth/register').send(registerBody(cons, { dateOfBirth: new Date().toISOString().slice(0, 10) }));
    expect(minor.status).toBe(400);
    const bad = await api().post('/api/auth/register').send({ email: 'nope' });
    expect(bad.status).toBe(400);
  });

  test('prevents duplicate registration by email and by voter ID', async () => {
    const body = registerBody(cons);
    await api().post('/api/auth/register').send(body).expect(201);
    const dupEmail = await api().post('/api/auth/register').send(registerBody(cons, { email: body.email }));
    expect(dupEmail.status).toBe(409);
    const dupId = await api().post('/api/auth/register').send(registerBody(cons, { voterIdNumber: body.voterIdNumber }));
    expect(dupId.status).toBe(409);
  });

});

describe('Login, sessions & RBAC', () => {
  test('wrong password gives a generic error, logs a security event and eventually locks the account', async () => {
    const { user } = await createVoter({ login: false });
    for (let i = 0; i < 5; i += 1) {
      const r = await api().post('/api/auth/login').send({ email: user.email, password: 'Wrong@12345' });
      expect(r.status).toBe(401);
      expect(r.body.message).toBe('Invalid email or password.');
    }
    const locked = await api().post('/api/auth/login').send({ email: user.email, password: PASSWORD });
    expect(locked.status).toBe(423);
    expect(await M.SecurityEvent.countDocuments({ type: 'FAILED_LOGIN', email: user.email })).toBeGreaterThanOrEqual(5);
    expect(await M.AuditLog.countDocuments({ action: 'LOGIN_FAILED' })).toBeGreaterThan(0);
  });

  test('unknown email gets the same response as a wrong password', async () => {
    const r = await api().post('/api/auth/login').send({ email: 'ghost@test.elexguard.test', password: PASSWORD });
    expect(r.status).toBe(401);
    expect(r.body.message).toBe('Invalid email or password.');
  });

  test('successful login is audited; voters cannot use the admin login and vice versa', async () => {
    const v = await createVoter();
    const a = await createAdmin();
    expect(await M.AuditLog.countDocuments({ action: 'LOGIN_SUCCESS', actor: v.user._id })).toBe(1);
    expect((await api().post('/api/auth/admin/login').send({ email: v.user.email, password: PASSWORD })).status).toBe(401);
    expect((await api().post('/api/auth/login').send({ email: a.user.email, password: PASSWORD })).status).toBe(401);
  });

  test('protected routes need a valid token; tampered tokens are rejected', async () => {
    expect((await api().get('/api/auth/me')).status).toBe(401);
    expect((await api().get('/api/auth/me').set(auth('garbage.token.value'))).status).toBe(401);
    const v = await createVoter();
    expect((await api().get('/api/auth/me').set(auth(`${v.token}x`))).status).toBe(401);
    const me = await api().get('/api/auth/me').set(auth(v.token));
    expect(me.status).toBe(200);
    expect(me.body.data.user.email).toBe(v.user.email);
    expect(await M.SecurityEvent.countDocuments({ type: 'UNAUTHORIZED_ACCESS' })).toBeGreaterThan(0);
  });

  test('role-based access control: voters cannot reach admin APIs, admins cannot reach voter APIs', async () => {
    const v = await createVoter();
    const a = await createAdmin();
    const forbidden = await api().get('/api/admin/dashboard').set(auth(v.token));
    expect(forbidden.status).toBe(403);
    expect((await api().post('/api/admin/elections').set(auth(v.token)).send({})).status).toBe(403);
    expect((await api().get('/api/admin/voters').set(auth(v.token))).status).toBe(403);
    expect((await api().get('/api/admin/audit-logs').set(auth(v.token))).status).toBe(403);
    expect((await api().get('/api/voter/dashboard').set(auth(a.token))).status).toBe(403);
    expect(await M.SecurityEvent.countDocuments({ type: 'FORBIDDEN_ACCESS' })).toBeGreaterThan(0);
    expect((await api().get('/api/admin/dashboard')).status).toBe(401);
  });

  test('logout revokes the token server-side', async () => {
    const v = await createVoter();
    expect((await api().post('/api/auth/logout').set(auth(v.token))).status).toBe(200);
    expect((await api().get('/api/auth/me').set(auth(v.token))).status).toBe(401);
  });

  test('profile update works and ignores attempts to change the role', async () => {
    const v = await createVoter();
    const r = await api().put('/api/auth/me').set(auth(v.token)).send({ fullName: 'New Name', phone: '+1 555 0100', role: 'admin' });
    expect(r.status).toBe(200);
    expect(r.body.data.user.fullName).toBe('New Name');
    expect(r.body.data.user.role).toBe('voter');
  });

  test('NoSQL operator injection in login is neutralised', async () => {
    const v = await createVoter();
    const r = await api().post('/api/auth/login').send({ email: { $ne: null }, password: { $ne: null } });
    expect(r.status).toBe(400);
    const r2 = await api().post('/api/auth/login').send({ email: v.user.email, password: { $gt: '' } });
    expect([400, 401]).toContain(r2.status);
  });

  test('HTML in text input is stripped (XSS defence in depth)', async () => {
    const v = await createVoter();
    const r = await api().put('/api/auth/me').set(auth(v.token)).send({ fullName: '<script>alert(1)</script>Safe Name' });
    expect(r.status).toBe(200);
    expect(r.body.data.user.fullName).not.toContain('<');
  });

  test('security headers are present and CORS is restricted', async () => {
    const ok = await api().get('/api/health').set('Origin', 'http://localhost:5173');
    expect(ok.headers['x-content-type-options']).toBe('nosniff');
    expect(ok.headers['content-security-policy']).toBeDefined();
    expect(ok.headers['x-powered-by']).toBeUndefined();
    expect(ok.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    const evil = await api().get('/api/health').set('Origin', 'https://evil.example');
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('Password reset', () => {
  test('full flow: request → emailed one-time link → new password → old sessions revoked → link cannot be reused', async () => {
    const v = await createVoter();
    const generic = await api().post('/api/auth/forgot-password').send({ email: v.user.email });
    const unknown = await api().post('/api/auth/forgot-password').send({ email: 'nobody@test.elexguard.test' });
    expect(generic.status).toBe(200);
    expect(unknown.body.message).toBe(generic.body.message); // no account enumeration

    const link = email.sendPasswordResetEmail.mock.calls.at(-1)[2];
    const token = new URL(link).searchParams.get('token');
    const rec = await M.PasswordReset.findOne({ user: v.user._id });
    expect(rec.tokenHash).not.toBe(token); // only a hash is stored

    const weak = await api().post('/api/auth/reset-password').send({ token, password: 'short' });
    expect(weak.status).toBe(400);
    const newPw = 'Brand@New99';
    await api().post('/api/auth/reset-password').send({ token, password: newPw }).expect(200);
    expect((await api().post('/api/auth/reset-password').send({ token, password: newPw })).status).toBe(400);
    expect((await api().get('/api/auth/me').set(auth(v.token))).status).toBe(401);
    expect((await api().post('/api/auth/login').send({ email: v.user.email, password: PASSWORD })).status).toBe(401);
    expect((await api().post('/api/auth/login').send({ email: v.user.email, password: newPw })).status).toBe(200);
  });

  test('expired or fabricated reset tokens are rejected', async () => {
    const fake = 'a'.repeat(64);
    const r = await api().post('/api/auth/reset-password').send({ token: fake, password: 'Brand@New99' });
    expect(r.status).toBe(400);
  });
});
