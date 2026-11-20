'use strict';
const bcrypt = require('bcryptjs');
const request = require('supertest');
const createApp = require('../app');
const { connectDB, disconnectDB, mongoose } = require('../config/db');
const M = require('../models');

const app = createApp();
const api = () => request(app);

async function setupDb() {
  await connectDB();
  await Promise.all(Object.values(M).map((m) => m.deleteMany({})));
  await Promise.all(Object.values(M).map((m) => m.init()));
}
async function teardownDb() { await disconnectDB(); }

const PASSWORD = 'Test@12345';
const hash = bcrypt.hashSync(PASSWORD, 4);
let counter = 0;
const uniq = () => { counter += 1; return `${Date.now().toString(36)}${counter}`; };

async function createAdmin() {
  const user = await M.User.create({ fullName: 'Test Admin', email: `admin${uniq()}@test.elexguard.test`, passwordHash: hash, role: 'admin', emailVerified: true });
  await M.Administrator.create({ user: user._id });
  const res = await api().post('/api/auth/admin/login').send({ email: user.email, password: PASSWORD });
  return { user, token: res.body.data.token };
}

async function createConstituency(code) {
  return M.Constituency.create({ name: `Const ${code || uniq()}`, code: (code || `C${uniq()}`).toUpperCase() });
}

async function createVoter({ constituency, status = 'approved', emailVerified = true, login = true } = {}) {
  const cons = constituency || (await createConstituency());
  const user = await M.User.create({ fullName: 'Test Voter', email: `voter${uniq()}@test.elexguard.test`, passwordHash: hash, role: 'voter', emailVerified });
  const voter = await M.Voter.create({
    user: user._id, constituency: cons._id, voterIdNumber: `TV-${uniq().toUpperCase()}`, dateOfBirth: new Date('1990-01-01'), verificationStatus: status,
  });
  let token = null;
  if (login && emailVerified) {
    const res = await api().post('/api/auth/login').send({ email: user.email, password: PASSWORD });
    token = res.body.data && res.body.data.token;
  }
  return { user, voter, token, constituency: cons };
}

const auth = (token) => ({ Authorization: `Bearer ${token}` });

/** Creates an election with N candidates and walks it through the real admin lifecycle to "active". */
async function createActiveElection(adminToken, { constituencies = [], candidates = 2 } = {}) {
  const now = Date.now();
  const e = await api().post('/api/admin/elections').set(auth(adminToken)).send({
    title: `Election ${uniq()}`, description: 'Test', type: 'general', constituencies,
    startTime: new Date(now - 3600000).toISOString(), endTime: new Date(now + 24 * 3600000).toISOString(),
  });
  if (e.status !== 201) throw new Error(`createElection failed: ${JSON.stringify(e.body)}`);
  const id = e.body.data.id;
  const cands = [];
  for (let i = 0; i < candidates; i += 1) {
    const c = await api().post('/api/admin/candidates').set(auth(adminToken)).send({ election: id, name: `Candidate ${i + 1}`, party: `Party ${i + 1}` });
    if (c.status !== 201) throw new Error(`addCandidate failed: ${JSON.stringify(c.body)}`);
    cands.push(c.body.data);
  }
  await api().post(`/api/admin/elections/${id}/schedule`).set(auth(adminToken)).expect(200);
  await api().post(`/api/admin/elections/${id}/start`).set(auth(adminToken)).expect(200);
  return { id, candidates: cands };
}

module.exports = { app, api, setupDb, teardownDb, createAdmin, createVoter, createConstituency, createActiveElection, auth, PASSWORD, mongoose, M };
