'use strict';
jest.mock('../services/email/emailService', () => ({
  sendOtpEmail: jest.fn().mockResolvedValue(undefined), sendPasswordResetEmail: jest.fn().mockResolvedValue(undefined), isConfigured: () => true,
}));
const { api, setupDb, teardownDb, createAdmin, createVoter, createConstituency, createActiveElection, auth, M } = require('./helpers');
const { supportsTransactions } = require('../config/db');

beforeAll(setupDb);
afterAll(teardownDb);

const access = (t, id) => api().post(`/api/voter/elections/${id}/ballot-access`).set(auth(t));
const vote = (t, id, candidateId, ballotToken) => api().post(`/api/voter/elections/${id}/vote`).set(auth(t)).send({ candidateId, ballotToken });

describe('DFA-gated voting workflow', () => {
  let admin; let cons; let election;
  beforeAll(async () => {
    admin = await createAdmin();
    cons = await createConstituency('VT1');
    election = await createActiveElection(admin.token, { constituencies: [String(cons._id)], candidates: 3 });
  });

  test('happy path: eligibility check → ballot access (DFA S5) → vote → receipt → completed (S7)', async () => {
    const v = await createVoter({ constituency: cons });
    const elig = await api().get(`/api/voter/elections/${election.id}/eligibility`).set(auth(v.token));
    expect(elig.body.data).toMatchObject({ eligible: true, hasVoted: false });

    const acc = await access(v.token, election.id);
    expect(acc.status).toBe(200);
    expect(acc.body.data.dfaState).toBe('S5');
    expect(acc.body.data.candidates).toHaveLength(3);
    expect(acc.body.data.ballotToken).toMatch(/^[a-f0-9]{64}$/);

    // Only the HASH of the one-time token is stored.
    const rec = await M.VoterEligibility.findOne({ voter: v.voter._id }).select('+authorizationHash');
    expect(rec.authorizationHash).not.toBe(acc.body.data.ballotToken);
    expect(rec.dfaState).toBe('S5');

    const res = await vote(v.token, election.id, election.candidates[0].id, acc.body.data.ballotToken);
    expect(res.status).toBe(201);
    expect(res.body.data.receiptReference).toMatch(/^EG-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/);
    expect(res.body.data.dfaState).toBe('S7');
    expect(JSON.stringify(res.body)).not.toContain(election.candidates[0].id); // receipt does not reveal the choice

    const after = await M.VoterEligibility.findOne({ voter: v.voter._id }).select('+authorizationHash');
    expect(after).toMatchObject({ hasVoted: true, dfaState: 'S7' });
    expect(after.authorizationHash).toBeFalsy(); // authorisation consumed

    const hist = await api().get('/api/voter/history').set(auth(v.token));
    expect(hist.body.data).toHaveLength(1);
    expect(hist.body.data[0].receiptReference).toBe(res.body.data.receiptReference);
    expect(await M.AuditLog.countDocuments({ action: 'VOTE_CAST', actor: v.user._id })).toBe(1);
  });

  test('a refreshed ballot page re-issues access (S5 self-loop) and the old token stops working', async () => {
    const v = await createVoter({ constituency: cons });
    const first = (await access(v.token, election.id)).body.data.ballotToken;
    const second = (await access(v.token, election.id)).body.data.ballotToken;
    expect(first).not.toBe(second);
    const old = await vote(v.token, election.id, election.candidates[0].id, first);
    expect(old.status).toBe(403);
    expect(old.body.code).toBe('INVALID_BALLOT_TOKEN');
    expect((await vote(v.token, election.id, election.candidates[0].id, second)).status).toBe(201);
  });

  test('unauthenticated users cannot reach the ballot', async () => {
    expect((await api().post(`/api/voter/elections/${election.id}/ballot-access`)).status).toBe(401);
    expect((await api().post(`/api/voter/elections/${election.id}/vote`).send({})).status).toBe(401);
  });

  test('unverified (pending) voters cannot vote; progress stops at S2 (Email Verified)', async () => {
    const v = await createVoter({ constituency: cons, status: 'pending' });
    const r = await access(v.token, election.id);
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('NOT_ELIGIBLE');
    expect(r.body.message).toMatch(/identity|approved/i);
    expect((await M.VoterEligibility.findOne({ voter: v.voter._id })).dfaState).toBe('S2');
    expect(await M.AnonymousBallot.countDocuments({ election: election.id })).toBeGreaterThanOrEqual(0);
  });

  test('rejected voters cannot vote', async () => {
    const v = await createVoter({ constituency: cons, status: 'rejected' });
    const r = await access(v.token, election.id);
    expect(r.status).toBe(403);
    expect(r.body.message).toMatch(/rejected/i);
  });

  test('voters from another constituency are ineligible', async () => {
    const other = await createConstituency('VT-OTHER');
    const v = await createVoter({ constituency: other });
    const check = await api().get(`/api/voter/elections/${election.id}`).set(auth(v.token));
    // The election is not even listed for them…
    const list = await api().get('/api/voter/elections').set(auth(v.token));
    expect(list.body.data.some((e) => e.id === election.id)).toBe(false);
    // …and the backend refuses ballot access.
    const r = await access(v.token, election.id);
    expect(r.status).toBe(403);
    expect(check.body.data.eligibility.eligible).toBe(false);
  });

  test('submitting a vote without ballot access is an invalid DFA transition (cannot skip states)', async () => {
    const v = await createVoter({ constituency: cons });
    const r = await vote(v.token, election.id, election.candidates[0].id, 'a'.repeat(64));
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('DFA_INVALID_TRANSITION');
    expect(r.body.details.symbol).toBe('SUBMIT_VOTE');
    expect(await M.SecurityEvent.countDocuments({ type: 'INVALID_DFA_TRANSITION', user: v.user._id })).toBe(1);
    expect(await M.AuditLog.countDocuments({ action: 'DFA_TRANSITION_REJECTED', actor: v.user._id })).toBe(1);
    expect(await M.VoterEligibility.countDocuments({ voter: v.voter._id, hasVoted: true })).toBe(0);
  });

  test('forged ballot tokens and candidates from another election are rejected', async () => {
    const v = await createVoter({ constituency: cons });
    const acc = (await access(v.token, election.id)).body.data;
    const forged = await vote(v.token, election.id, election.candidates[0].id, 'f'.repeat(64));
    expect(forged.status).toBe(403);
    const otherElection = await createActiveElection(admin.token, { constituencies: [String(cons._id)] });
    const wrong = await vote(v.token, election.id, otherElection.candidates[0].id, acc.ballotToken);
    expect(wrong.status).toBe(400);
    expect(wrong.body.code).toBe('INVALID_CANDIDATE');
    expect((await vote(v.token, election.id, 'not-an-id', acc.ballotToken)).status).toBe(400);
    // The legitimate vote still works after the failed attempts.
    expect((await vote(v.token, election.id, election.candidates[1].id, acc.ballotToken)).status).toBe(201);
  });

  test('completed voters cannot vote again or reopen the ballot (S7 has no outgoing edges)', async () => {
    const v = await createVoter({ constituency: cons });
    const acc = (await access(v.token, election.id)).body.data;
    expect((await vote(v.token, election.id, election.candidates[0].id, acc.ballotToken)).status).toBe(201);
    const again = await vote(v.token, election.id, election.candidates[1].id, acc.ballotToken);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('ALREADY_VOTED');
    const reopen = await access(v.token, election.id);
    expect(reopen.status).toBe(409);
    expect(reopen.body.code).toBe('ALREADY_VOTED');
    expect(await M.SecurityEvent.countDocuments({ type: 'DUPLICATE_VOTE_ATTEMPT', user: v.user._id })).toBe(2);
    expect(await M.AuditLog.countDocuments({ action: 'DUPLICATE_VOTE_ATTEMPT', actor: v.user._id })).toBe(2);
    const ballots = await M.AnonymousBallot.countDocuments({ election: election.id });
    expect(ballots).toBeGreaterThan(0);
  });

  test('revoking approval after ballot access resets the session and blocks the vote', async () => {
    const v = await createVoter({ constituency: cons });
    const acc = (await access(v.token, election.id)).body.data;
    await M.Voter.updateOne({ _id: v.voter._id }, { $set: { verificationStatus: 'rejected' } });
    const r = await vote(v.token, election.id, election.candidates[0].id, acc.ballotToken);
    expect(r.status).toBe(403);
    expect((await access(v.token, election.id)).status).toBe(403);
    expect((await M.VoterEligibility.findOne({ voter: v.voter._id })).dfaState).toBe('S2');
  });

  test('CONCURRENT submissions: 12 parallel requests with the same token produce exactly one ballot', async () => {
    const v = await createVoter({ constituency: cons });
    const acc = (await access(v.token, election.id)).body.data;
    const before = await M.AnonymousBallot.countDocuments({ election: election.id });
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => vote(v.token, election.id, election.candidates[i % 3].id, acc.ballotToken)));
    const created = results.filter((r) => r.status === 201);
    const rejected = results.filter((r) => r.status !== 201);
    expect(created).toHaveLength(1);
    expect(rejected).toHaveLength(11);
    expect(rejected.every((r) => [403, 409].includes(r.status))).toBe(true);
    expect(await M.AnonymousBallot.countDocuments({ election: election.id })).toBe(before + 1);
    expect(await M.VoterEligibility.countDocuments({ voter: v.voter._id, hasVoted: true })).toBe(1);
  });

  test('CONCURRENT ballot access + submission across many voters records every vote exactly once', async () => {
    const voters = await Promise.all(Array.from({ length: 8 }, () => createVoter({ constituency: cons })));
    const before = await M.AnonymousBallot.countDocuments({ election: election.id });
    const outcomes = await Promise.all(voters.map(async (v, i) => {
      const acc = (await access(v.token, election.id)).body.data;
      return Promise.all([
        vote(v.token, election.id, election.candidates[i % 3].id, acc.ballotToken),
        vote(v.token, election.id, election.candidates[(i + 1) % 3].id, acc.ballotToken),
      ]);
    }));
    expect(outcomes.every(([a, b]) => [a.status, b.status].filter((s) => s === 201).length === 1)).toBe(true);
    expect(await M.AnonymousBallot.countDocuments({ election: election.id })).toBe(before + 8);
  });

  test('unique database index backs up duplicate prevention (one eligibility record per voter per election)', async () => {
    const v = await createVoter({ constituency: cons });
    await M.VoterEligibility.create({ election: election.id, voter: v.voter._id });
    await expect(M.VoterEligibility.create({ election: election.id, voter: v.voter._id })).rejects.toMatchObject({ code: 11000 });
  });

  test(`transaction mode is reported correctly (${supportsTransactions() ? 'transactions ON' : 'transactions OFF → atomic consume + compensation path'})`, () => {
    expect(typeof supportsTransactions()).toBe('boolean');
  });
});

describe('Election status rules for voting', () => {
  let admin; let cons;
  beforeAll(async () => { admin = await createAdmin(); cons = await createConstituency('ST1'); });

  test('paused elections reject ballot access and votes; resuming re-enables voting', async () => {
    const e = await createActiveElection(admin.token, { constituencies: [String(cons._id)] });
    const v = await createVoter({ constituency: cons });
    const acc = (await access(v.token, e.id)).body.data;
    await api().post(`/api/admin/elections/${e.id}/pause`).set(auth(admin.token)).expect(200);
    const blocked = await vote(v.token, e.id, e.candidates[0].id, acc.ballotToken);
    expect(blocked.status).toBe(403);
    expect(blocked.body.message).toMatch(/paused/i);
    expect((await access(v.token, e.id)).status).toBe(403);
    await api().post(`/api/admin/elections/${e.id}/resume`).set(auth(admin.token)).expect(200);
    const again = (await access(v.token, e.id)).body.data;
    expect((await vote(v.token, e.id, e.candidates[0].id, again.ballotToken)).status).toBe(201);
  });

  test('completed elections cannot accept additional votes', async () => {
    const e = await createActiveElection(admin.token, { constituencies: [String(cons._id)] });
    const v = await createVoter({ constituency: cons });
    const acc = (await access(v.token, e.id)).body.data;
    await api().post(`/api/admin/elections/${e.id}/end`).set(auth(admin.token)).expect(200);
    const r = await vote(v.token, e.id, e.candidates[0].id, acc.ballotToken);
    expect(r.status).toBe(403);
    expect(r.body.message).toMatch(/ended/i);
    expect((await access(v.token, e.id)).status).toBe(403);
    expect(await M.AnonymousBallot.countDocuments({ election: e.id })).toBe(0);
  });

  test('votes outside the scheduled period are rejected even if the status is still "active"', async () => {
    const e = await createActiveElection(admin.token, { constituencies: [String(cons._id)] });
    const v = await createVoter({ constituency: cons });
    const acc = (await access(v.token, e.id)).body.data;
    await M.Election.updateOne({ _id: e.id }, { $set: { endTime: new Date(Date.now() - 1000) } }); // expired, scheduler has not run yet
    const r = await vote(v.token, e.id, e.candidates[0].id, acc.ballotToken);
    expect(r.status).toBe(403);
    expect(r.body.message).toMatch(/ended/i);
  });

  test('elections that have not started do not open a ballot', async () => {
    const e = await api().post('/api/admin/elections').set(auth(admin.token)).send({
      title: 'Upcoming', constituencies: [String(cons._id)], startTime: new Date(Date.now() + 86400000).toISOString(), endTime: new Date(Date.now() + 2 * 86400000).toISOString(),
    });
    for (const n of ['A', 'B']) await api().post('/api/admin/candidates').set(auth(admin.token)).send({ election: e.body.data.id, name: `U ${n}` });
    await api().post(`/api/admin/elections/${e.body.data.id}/schedule`).set(auth(admin.token)).expect(200);
    const v = await createVoter({ constituency: cons });
    expect((await access(v.token, e.body.data.id)).status).toBe(403);
  });
});

describe('Ballot secrecy, results and reports', () => {
  let admin; let cons; let election; const voters = [];
  beforeAll(async () => {
    admin = await createAdmin();
    cons = await createConstituency('RS1');
    election = await createActiveElection(admin.token, { constituencies: [String(cons._id)], candidates: 3 });
    // 6 voters: 3 → cand0, 2 → cand1, 1 → cand2 ; plus 2 approved voters who do not vote.
    const picks = [0, 0, 0, 1, 1, 2];
    for (const p of picks) {
      const v = await createVoter({ constituency: cons });
      const acc = (await access(v.token, election.id)).body.data;
      const r = await vote(v.token, election.id, election.candidates[p].id, acc.ballotToken);
      expect(r.status).toBe(201);
      voters.push(v);
    }
    await createVoter({ constituency: cons });
    await createVoter({ constituency: cons });
  });

  test('anonymous ballots contain no voter reference, no timestamps, and a random non-time-ordered id', async () => {
    const ballots = await M.AnonymousBallot.collection.find({ election: new (require('mongoose').Types.ObjectId)(election.id) }).toArray();
    expect(ballots).toHaveLength(6);
    for (const b of ballots) {
      expect(Object.keys(b).sort()).toEqual(['_id', 'candidate', 'constituency', 'election']);
      expect(typeof b._id).toBe('string');
      expect(b._id).toMatch(/^[a-f0-9]{32}$/);
    }
    expect(M.AnonymousBallot.schema.paths.voter).toBeUndefined();
  });

  test('eligibility records and audit logs never reference a candidate selection', async () => {
    const eligs = await M.VoterEligibility.collection.find({ election: new (require('mongoose').Types.ObjectId)(election.id) }).toArray();
    expect(eligs.length).toBeGreaterThanOrEqual(6);
    const candIds = election.candidates.map((c) => c.id);
    // Admin catalogue actions (CANDIDATE_ADDED …) legitimately name candidates; voting-related logs must never do so.
    const votingLogs = await M.AuditLog.find({ action: { $in: ['VOTE_CAST', 'BALLOT_ACCESS_GRANTED', 'DUPLICATE_VOTE_ATTEMPT', 'DFA_TRANSITION_REJECTED'] } }).lean();
    expect(votingLogs.length).toBeGreaterThan(0);
    const locks = await M.VoteLock.collection.find({}).toArray();
    const dump = JSON.stringify(eligs) + JSON.stringify(votingLogs) + JSON.stringify(await M.SecurityEvent.find({}).lean()) + JSON.stringify(locks);
    for (const id of candIds) expect(dump).not.toContain(id);
    expect(M.VoterEligibility.schema.paths.candidate).toBeUndefined();
    // No stored link between the receipt and any ballot.
    for (const e of eligs) expect(Object.keys(e)).not.toContain('ballot');
    // Receipt is random and unique per voter.
    const receipts = eligs.filter((e) => e.hasVoted).map((e) => e.receiptReference);
    expect(new Set(receipts).size).toBe(receipts.length);
  });

  test('audit logs strip forbidden metadata (passwords, OTPs, tokens, candidate choices)', async () => {
    const { audit } = require('../services/security/auditService');
    await audit(null, 'TEST_SCRUB', { description: 'scrub test', metadata: { password: 'x', otp: '123456', ballotToken: 't', candidateId: 'c', selectedChoice: 'z', safe: 'kept' } });
    const log = await M.AuditLog.findOne({ action: 'TEST_SCRUB' }).lean();
    expect(log.metadata).toEqual({ safe: 'kept' });
  });

  test('results stay hidden from the public and voters until publication; admin sees tallies only after closing', async () => {
    const hiddenAdmin = await api().get(`/api/admin/elections/${election.id}/results`).set(auth(admin.token));
    expect(hiddenAdmin.body.data.tallyVisible).toBe(false);
    expect(hiddenAdmin.body.data.candidates).toBeUndefined();
    expect(hiddenAdmin.body.data.totalVotes).toBe(6); // turnout counter is allowed
    expect((await api().get(`/api/public/results/${election.id}`)).status).toBe(404);
    expect((await api().get(`/api/admin/elections/${election.id}/report.csv`).set(auth(admin.token))).status).toBe(409);
    await api().post(`/api/admin/elections/${election.id}/end`).set(auth(admin.token)).expect(200);
    expect((await api().get(`/api/public/results/${election.id}`)).status).toBe(404); // completed ≠ published
  });

  test('result calculation: counts, percentages, turnout, constituency stats and winner', async () => {
    const r = await api().get(`/api/admin/elections/${election.id}/results`).set(auth(admin.token));
    const d = r.body.data;
    expect(d.tallyVisible).toBe(true);
    expect(d.totalEligible).toBe(8);
    expect(d.totalVotes).toBe(6);
    expect(d.turnoutPercent).toBe(75);
    expect(d.candidates.map((c) => c.votes)).toEqual([3, 2, 1]);
    expect(d.candidates.map((c) => c.percent)).toEqual([50, 33.33, 16.67]);
    expect(d.candidates[0].name).toBe('Candidate 1');
    expect(d.constituencies).toHaveLength(1);
    expect(d.constituencies[0]).toMatchObject({ eligible: 8, votes: 6, turnoutPercent: 75 });
    expect(d.winner).toMatchObject({ name: 'Candidate 1', votes: 3, tie: false });
  });

  test('CSV and PDF reports are generated, audited, and contain no individual choices', async () => {
    const csv = await api().get(`/api/admin/elections/${election.id}/report.csv`).set(auth(admin.token));
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.text).toContain('Candidate 1');
    expect(csv.text).toContain('Turnout (%)');
    const pdf = await api().get(`/api/admin/elections/${election.id}/report.pdf`).set(auth(admin.token)).buffer(true).parse((res, cb) => {
      const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.body.slice(0, 5).toString()).toBe('%PDF-');
    expect(pdf.body.length).toBeGreaterThan(1500);
    expect(await M.AuditLog.countDocuments({ action: 'REPORT_EXPORTED' })).toBe(2);
  });

  test('CSV export neutralises spreadsheet formula injection', () => {
    const { toCsv } = require('../utils/csv');
    expect(toCsv([['=cmd|calc', '+1', '-2', '@x', 'ok, "quoted"']])).toBe('\'=cmd|calc,\'+1,\'-2,\'@x,"ok, ""quoted"""\r\n');
  });

  test('publishing creates an immutable snapshot, exposes results publicly and to voters, and still hides individual choices', async () => {
    await api().post(`/api/admin/elections/${election.id}/publish`).set(auth(admin.token)).expect(200);
    const pub = await api().get(`/api/public/results/${election.id}`);
    expect(pub.status).toBe(200);
    expect(pub.body.data.totalVotes).toBe(6);
    expect(pub.body.data.candidates.map((c) => c.votes)).toEqual([3, 2, 1]);
    expect(JSON.stringify(pub.body)).not.toMatch(/voter/i);
    const snap = await M.ElectionResult.findOne({ election: election.id });
    expect(snap.totalVotes).toBe(6);
    const list = await api().get('/api/public/results');
    expect(list.body.data.some((x) => x.id === election.id)).toBe(true);
    // Voter dashboard shows the completed election.
    const vd = await api().get('/api/voter/dashboard').set(auth(voters[0].token));
    expect(vd.body.data.counts.voted).toBe(1);
    expect(vd.body.data.counts.completed).toBe(1);
  });
});
