'use strict';
jest.mock('../services/email/emailService', () => ({
  sendOtpEmail: jest.fn().mockResolvedValue(undefined), sendPasswordResetEmail: jest.fn().mockResolvedValue(undefined), isConfigured: () => true,
}));
const { api, setupDb, teardownDb, createAdmin, createVoter, createConstituency, createActiveElection, auth, M } = require('./helpers');

beforeAll(setupDb);
afterAll(teardownDb);

const future = (h) => new Date(Date.now() + h * 3600000).toISOString();

describe('Election management & lifecycle (admin)', () => {
  let admin; let cons;
  beforeAll(async () => { admin = await createAdmin(); cons = await createConstituency('EL1'); });

  const mkElection = async (over = {}) => (await api().post('/api/admin/elections').set(auth(admin.token)).send({
    title: 'Lifecycle Test', description: 'd', type: 'general', constituencies: [String(cons._id)], startTime: future(1), endTime: future(48), ...over,
  }));

  test('creates a draft election, validates input, and audits it', async () => {
    const res = await mkElection();
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('draft');
    expect(await M.AuditLog.countDocuments({ action: 'ELECTION_CREATED', targetId: res.body.data.id })).toBe(1);
    const bad = await mkElection({ startTime: future(5), endTime: future(2) });
    expect(bad.status).toBe(400);
    expect((await mkElection({ title: 'x' })).status).toBe(400);
  });

  test('edits a draft election but not an active one', async () => {
    const e = await mkElection();
    const id = e.body.data.id;
    const upd = await api().put(`/api/admin/elections/${id}`).set(auth(admin.token)).send({ title: 'Renamed Election' });
    expect(upd.status).toBe(200);
    expect(upd.body.data.title).toBe('Renamed Election');
    const act = await createActiveElection(admin.token);
    const locked = await api().put(`/api/admin/elections/${act.id}`).set(auth(admin.token)).send({ title: 'Hacked title' });
    expect(locked.status).toBe(409);
  });

  test('only draft elections can be deleted', async () => {
    const e = await mkElection();
    expect((await api().delete(`/api/admin/elections/${e.body.data.id}`).set(auth(admin.token))).status).toBe(200);
    const act = await createActiveElection(admin.token);
    expect((await api().delete(`/api/admin/elections/${act.id}`).set(auth(admin.token))).status).toBe(409);
  });

  test('scheduling requires at least two candidates', async () => {
    const e = await mkElection();
    const r = await api().post(`/api/admin/elections/${e.body.data.id}/schedule`).set(auth(admin.token));
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('NEEDS_CANDIDATES');
  });

  test('full lifecycle Draft → Scheduled → Active → Paused → Active → Completed → Published, with illegal jumps rejected', async () => {
    const e = await mkElection();
    const id = e.body.data.id;
    for (const n of ['A', 'B']) await api().post('/api/admin/candidates').set(auth(admin.token)).send({ election: id, name: `Cand ${n}`, party: 'P' }).expect(201);
    const act = (a) => api().post(`/api/admin/elections/${id}/${a}`).set(auth(admin.token));

    expect((await act('start')).status).toBe(409);   // draft → active not allowed
    expect((await act('pause')).status).toBe(409);
    expect((await act('publish')).status).toBe(409);
    expect((await act('schedule')).body.data.status).toBe('scheduled');
    expect((await act('schedule')).status).toBe(409);
    expect((await act('start')).body.data.status).toBe('active');
    expect((await act('pause')).body.data.status).toBe('paused');
    expect((await act('pause')).status).toBe(409);
    expect((await act('resume')).body.data.status).toBe('active');
    expect((await act('publish')).status).toBe(409); // cannot publish before completion
    expect((await act('end')).body.data.status).toBe('completed');
    expect((await act('start')).status).toBe(409);
    expect((await act('publish')).body.data.status).toBe('published');
    for (const a of ['ELECTION_SCHEDULED', 'ELECTION_ACTIVATED', 'ELECTION_PAUSED', 'ELECTION_RESUMED', 'ELECTION_CLOSED', 'ELECTION_RESULTS_PUBLISHED']) {
      expect(await M.AuditLog.countDocuments({ action: a, targetId: id })).toBe(1);
    }
  });

  test('duration of a running election can be extended but not set in the past', async () => {
    const act = await createActiveElection(admin.token);
    const ok = await api().patch(`/api/admin/elections/${act.id}/duration`).set(auth(admin.token)).send({ endTime: future(72) });
    expect(ok.status).toBe(200);
    const past = await api().patch(`/api/admin/elections/${act.id}/duration`).set(auth(admin.token)).send({ endTime: new Date(Date.now() - 60000).toISOString() });
    expect(past.status).toBe(400);
    expect(await M.AuditLog.countDocuments({ action: 'ELECTION_DURATION_CHANGED', targetId: act.id })).toBe(1);
  });

  test('searching, filtering, sorting and pagination of elections', async () => {
    await mkElection({ title: 'Zebra Searchable Election' });
    const s = await api().get('/api/admin/elections').query({ q: 'zebra searchable' }).set(auth(admin.token));
    expect(s.status).toBe(200);
    expect(s.body.data.length).toBeGreaterThanOrEqual(1);
    const f = await api().get('/api/admin/elections').query({ status: 'draft', limit: 2, page: 1, sort: 'title' }).set(auth(admin.token));
    expect(f.body.data.every((e) => e.status === 'draft')).toBe(true);
    expect(f.body.data.length).toBeLessThanOrEqual(2);
    expect(f.body.meta.pages).toBeGreaterThanOrEqual(1);
  });
});

describe('Candidate management', () => {
  let admin; let electionId;
  beforeAll(async () => {
    admin = await createAdmin();
    const e = await api().post('/api/admin/elections').set(auth(admin.token)).send({ title: 'Candidates Test', startTime: future(1), endTime: future(30), constituencies: [] });
    electionId = e.body.data.id;
  });

  // Smallest valid PNG (1x1)
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

  test('adds, edits and removes candidates with party and manifesto', async () => {
    const add = await api().post('/api/admin/candidates').set(auth(admin.token))
      .send({ election: electionId, name: 'Jane Doe', party: 'Test Party', manifesto: 'A fine manifesto.', symbol: 'Oak' });
    expect(add.status).toBe(201);
    const id = add.body.data.id;
    const upd = await api().put(`/api/admin/candidates/${id}`).set(auth(admin.token)).send({ manifesto: 'Updated manifesto.' });
    expect(upd.body.data.manifesto).toBe('Updated manifesto.');
    expect((await api().post('/api/admin/candidates').set(auth(admin.token)).send({ election: electionId, name: 'Jane Doe' })).status).toBe(409); // duplicate name
    expect((await api().delete(`/api/admin/candidates/${id}`).set(auth(admin.token))).status).toBe(200);
    expect(await M.AuditLog.countDocuments({ action: { $in: ['CANDIDATE_ADDED', 'CANDIDATE_UPDATED', 'CANDIDATE_REMOVED'] } })).toBeGreaterThanOrEqual(3);
  });

  test('uploads a photograph, validating the real file type and size', async () => {
    const ok = await api().post('/api/admin/candidates').set(auth(admin.token))
      .field('election', electionId).field('name', 'Photo Person').field('party', 'Photo Party')
      .attach('photo', PNG, { filename: 'p.png', contentType: 'image/png' });
    expect(ok.status).toBe(201);
    expect(ok.body.data.hasPhoto).toBe(true);
    const img = await api().get(ok.body.data.photoUrl);
    expect(img.status).toBe(200);
    expect(img.headers['content-type']).toBe('image/png');

    const fake = await api().post('/api/admin/candidates').set(auth(admin.token))
      .field('election', electionId).field('name', 'Fake Image')
      .attach('photo', Buffer.from('<?php echo 1; ?> not an image at all'), { filename: 'x.png', contentType: 'image/png' });
    expect(fake.status).toBe(400);
    const wrongType = await api().post('/api/admin/candidates').set(auth(admin.token))
      .field('election', electionId).field('name', 'Wrong Type')
      .attach('photo', Buffer.from('hello world'), { filename: 'x.txt', contentType: 'text/plain' });
    expect(wrongType.status).toBe(400);
    const big = await api().post('/api/admin/candidates').set(auth(admin.token))
      .field('election', electionId).field('name', 'Huge')
      .attach('photo', Buffer.concat([PNG, Buffer.alloc(1100000)]), { filename: 'big.png', contentType: 'image/png' });
    expect(big.status).toBe(413);
  });

  test('candidates cannot be changed once the election is running', async () => {
    const act = await createActiveElection(admin.token);
    const r = await api().post('/api/admin/candidates').set(auth(admin.token)).send({ election: act.id, name: 'Late Entry' });
    expect(r.status).toBe(409);
    const d = await api().delete(`/api/admin/candidates/${act.candidates[0].id}`).set(auth(admin.token));
    expect(d.status).toBe(409);
  });
});

describe('Constituencies, voter management & monitoring', () => {
  let admin;
  beforeAll(async () => { admin = await createAdmin(); });

  test('constituency CRUD with duplicate protection and in-use protection', async () => {
    const c = await api().post('/api/admin/constituencies').set(auth(admin.token)).send({ name: 'North Ward', code: 'nw-1', region: 'North' });
    expect(c.status).toBe(201);
    expect(c.body.data.code).toBe('NW-1');
    expect((await api().post('/api/admin/constituencies').set(auth(admin.token)).send({ name: 'Other', code: 'NW-1' })).status).toBe(409);
    expect((await api().put(`/api/admin/constituencies/${c.body.data.id}`).set(auth(admin.token)).send({ region: 'Far North' })).body.data.region).toBe('Far North');
    const voter = await createVoter({ constituency: await M.Constituency.findById(c.body.data.id) });
    expect(voter.voter).toBeDefined();
    expect((await api().delete(`/api/admin/constituencies/${c.body.data.id}`).set(auth(admin.token))).status).toBe(409); // voters reference it
    const lone = await api().post('/api/admin/constituencies').set(auth(admin.token)).send({ name: 'Lonely', code: 'LONE' });
    expect((await api().delete(`/api/admin/constituencies/${lone.body.data.id}`).set(auth(admin.token))).status).toBe(200);
  });

  test('approve / reject voters, search & filter, and the approval is audited', async () => {
    const cons = await createConstituency('VM1');
    const v1 = await createVoter({ constituency: cons, status: 'pending' });
    const v2 = await createVoter({ constituency: cons, status: 'pending' });
    const approve = await api().post(`/api/admin/voters/${v1.voter._id}/approve`).set(auth(admin.token));
    expect(approve.status).toBe(200);
    expect((await api().post(`/api/admin/voters/${v1.voter._id}/approve`).set(auth(admin.token))).status).toBe(409);
    expect((await api().post(`/api/admin/voters/${v2.voter._id}/reject`).set(auth(admin.token)).send({})).status).toBe(400);
    expect((await api().post(`/api/admin/voters/${v2.voter._id}/reject`).set(auth(admin.token)).send({ reason: 'ID mismatch' })).status).toBe(200);
    expect(await M.AuditLog.countDocuments({ action: 'VOTER_APPROVED', targetId: String(v1.voter._id) })).toBe(1);
    expect(await M.AuditLog.countDocuments({ action: 'VOTER_REJECTED', targetId: String(v2.voter._id) })).toBe(1);

    const rejected = await api().get('/api/admin/voters').query({ status: 'rejected', constituency: String(cons._id) }).set(auth(admin.token));
    expect(rejected.body.data.map((v) => v.id)).toEqual([String(v2.voter._id)]);
    const search = await api().get('/api/admin/voters').query({ q: v1.voter.voterIdNumber.slice(0, 8) }).set(auth(admin.token));
    expect(search.body.data.some((v) => v.id === String(v1.voter._id))).toBe(true);
    const detail = await api().get(`/api/admin/voters/${v1.voter._id}`).set(auth(admin.token));
    expect(detail.status).toBe(200);
    expect(detail.body.data.verificationStatus).toBe('approved');
  });

  test('cannot approve a voter whose email is unverified', async () => {
    const v = await createVoter({ status: 'pending', emailVerified: false });
    const r = await api().post(`/api/admin/voters/${v.voter._id}/approve`).set(auth(admin.token));
    expect(r.status).toBe(409);
  });

  test('dashboard statistics, audit log filtering/date range and security monitoring', async () => {
    const d = await api().get('/api/admin/dashboard').set(auth(admin.token));
    expect(d.status).toBe(200);
    expect(d.body.data.voters.total).toBeGreaterThan(0);
    expect(d.body.data.elections).toHaveProperty('active');
    expect(d.body.data.participation).toHaveProperty('turnoutPercent');

    const logs = await api().get('/api/admin/audit-logs').query({ action: 'VOTER_APPROVED' }).set(auth(admin.token));
    expect(logs.body.data.every((l) => l.action === 'VOTER_APPROVED')).toBe(true);
    const today = new Date().toISOString().slice(0, 10);
    const ranged = await api().get('/api/admin/audit-logs').query({ from: today, to: today, q: 'approved' }).set(auth(admin.token));
    expect(ranged.body.data.length).toBeGreaterThan(0);
    const none = await api().get('/api/admin/audit-logs').query({ from: '2000-01-01', to: '2000-01-02' }).set(auth(admin.token));
    expect(none.body.data).toHaveLength(0);

    await api().get('/api/admin/dashboard'); // unauthenticated → security event
    const sec = await api().get('/api/admin/security-events').query({ type: 'UNAUTHORIZED_ACCESS' }).set(auth(admin.token));
    expect(sec.status).toBe(200);
    expect(sec.body.data.length).toBeGreaterThan(0);
    expect(sec.body.data.every((s) => s.type === 'UNAUTHORIZED_ACCESS')).toBe(true);
  });

  test('public notices & contact form are real, validated endpoints', async () => {
    const bad = await api().post('/api/public/contact').send({ name: 'A', email: 'x', subject: '', message: 'short' });
    expect(bad.status).toBe(400);
    const ok = await api().post('/api/public/contact').send({ name: 'Visitor', email: 'visitor@test.elexguard.test', subject: 'Question', message: 'How do I verify my identity?' });
    expect(ok.status).toBe(201);
    const msgs = await api().get('/api/admin/messages').set(auth(admin.token));
    expect(msgs.body.data.length).toBeGreaterThan(0);
    const n = await api().post('/api/admin/notices').set(auth(admin.token)).send({ title: 'Maintenance window', body: 'Sunday 02:00', kind: 'maintenance' });
    expect(n.status).toBe(201);
    const pub = await api().get('/api/public/notices');
    expect(pub.body.data.some((x) => x.title === 'Maintenance window')).toBe(true);
  });
});

describe('Public portal does not leak private data', () => {
  test('draft elections are hidden; public data never exposes voters, ballots or tallies before publication', async () => {
    const admin = await createAdmin();
    const draft = await api().post('/api/admin/elections').set(auth(admin.token)).send({ title: 'Secret Draft', startTime: future(1), endTime: future(5) });
    expect((await api().get(`/api/public/elections/${draft.body.data.id}`)).status).toBe(404);
    const act = await createActiveElection(admin.token);
    const pub = await api().get(`/api/public/elections/${act.id}`);
    expect(pub.status).toBe(200);
    expect(pub.body.data.candidates).toHaveLength(2);
    expect(JSON.stringify(pub.body)).not.toMatch(/votes"\s*:\s*[1-9]/); // no candidate tallies
    expect((await api().get(`/api/public/results/${act.id}`)).status).toBe(404);
    expect((await api().get('/api/public/stats')).status).toBe(200);
    expect((await api().get('/api/public/constituencies')).status).toBe(200);
    expect((await api().get('/api/public/dfa')).body.data.q0).toBe('S0');
    expect((await api().get('/api/admin/voters')).status).toBe(401);
    expect((await api().get('/api/health')).body.status).toBe('ok');
  });
});
