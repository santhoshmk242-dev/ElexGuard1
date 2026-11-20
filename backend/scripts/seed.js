'use strict';
/**
 * DEVELOPMENT SAMPLE DATA – synthetic only. Refuses to run in production.
 *
 *   npm run seed              (aborts if data already exists)
 *   npm run seed -- --reset   (wipes ALL collections first – development only!)
 *
 * All accounts use the reserved ".test" TLD (RFC 2606) so no real person can be affected.
 * Passwords are generated randomly on each run and printed once; nothing is hard-coded.
 */
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const config = require('../config/env');
const { connectDB, disconnectDB, mongoose } = require('../config/db');
const M = require('../models');
const { receiptReference } = require('../utils/crypto');

if (config.isProd) { console.error('Refusing to seed in production.'); process.exit(1); }

const randomPassword = () => `Dev-${crypto.randomBytes(6).toString('hex')}!A1`;
const day = 24 * 3600 * 1000;

async function main() {
  await connectDB();
  const reset = process.argv.includes('--reset');
  if (reset) {
    for (const m of Object.values(M)) await m.deleteMany({});
    console.log('Collections cleared.');
  } else if ((await M.User.countDocuments()) > 0) {
    throw new Error('Database already has data. Re-run with "-- --reset" to wipe it (development only).');
  }
  await Promise.all(Object.values(M).map((m) => m.init()));

  const adminPassword = randomPassword();
  const voterPassword = randomPassword();
  const adminUser = await M.User.create({
    fullName: 'Dev Sample Admin', email: 'admin@sample.elexguard.test', passwordHash: await bcrypt.hash(adminPassword, 12),
    role: 'admin', emailVerified: true,
  });
  await M.Administrator.create({ user: adminUser._id, designation: 'Chief Election Officer (DEV SAMPLE)' });

  const constituencies = await M.Constituency.insertMany([
    { name: 'Riverside North', code: 'RSN-01', region: 'Northern Zone', description: 'DEV SAMPLE constituency' },
    { name: 'Hillview East', code: 'HVE-02', region: 'Eastern Zone', description: 'DEV SAMPLE constituency' },
    { name: 'Lakeside South', code: 'LKS-03', region: 'Southern Zone', description: 'DEV SAMPLE constituency' },
    { name: 'Central Plains', code: 'CPL-04', region: 'Central Zone', description: 'DEV SAMPLE constituency' },
  ]);

  const names = ['Aarav Sample', 'Diya Sample', 'Kabir Sample', 'Meera Sample', 'Rohan Sample', 'Sana Sample', 'Vivek Sample', 'Isha Sample',
    'Arjun Sample', 'Nila Sample', 'Tara Sample', 'Dev Sample', 'Zoya Sample', 'Omar Sample', 'Lena Sample'];
  const passwordHash = await bcrypt.hash(voterPassword, 12);
  const voters = [];
  for (let i = 0; i < names.length; i += 1) {
    const n = String(i + 1).padStart(2, '0');
    const status = i < 11 ? 'approved' : i < 13 ? 'pending' : 'rejected';
    const user = await M.User.create({
      fullName: names[i], email: `voter${n}@sample.elexguard.test`, passwordHash, role: 'voter',
      emailVerified: i !== 14, phone: `+10000000${n}`,
    });
    const voter = await M.Voter.create({
      user: user._id, constituency: constituencies[i % 4]._id, voterIdNumber: `DEV-${n}${String(1000 + i * 7)}`,
      dateOfBirth: new Date(1985 + (i % 15), i % 12, 10 + (i % 15)), address: `${10 + i} Sample Street (DEV SAMPLE)`,
      verificationStatus: status, rejectionReason: status === 'rejected' ? 'ID number could not be matched (sample rejection).' : '',
      reviewedBy: status === 'pending' ? null : adminUser._id, reviewedAt: status === 'pending' ? null : new Date(), isDevSample: true,
    });
    voters.push(voter);
  }

  const now = Date.now();
  const mk = (data) => M.Election.create({ createdBy: adminUser._id, ...data });
  const active = await mk({
    title: 'Student Council Election 2026 (DEV SAMPLE)', description: 'Sample active election – vote for the next student council president.',
    type: 'student', constituencies: [], status: 'active', startTime: new Date(now - day), endTime: new Date(now + 6 * day), startedAt: new Date(now - day),
  });
  const upcoming = await mk({
    title: 'Municipal Ward Election (DEV SAMPLE)', description: 'Sample scheduled election for two constituencies.',
    type: 'local', constituencies: [constituencies[0]._id, constituencies[1]._id], status: 'scheduled', startTime: new Date(now + 3 * day), endTime: new Date(now + 4 * day),
  });
  const done = await mk({
    title: 'Campus Referendum 2025 (DEV SAMPLE)', description: 'Sample completed election with published results.',
    type: 'referendum', constituencies: [], status: 'published', startTime: new Date(now - 30 * day), endTime: new Date(now - 28 * day),
    startedAt: new Date(now - 30 * day), endedAt: new Date(now - 28 * day), resultsPublishedAt: new Date(now - 27 * day),
  });
  await mk({ title: 'Library Committee Election (DEV SAMPLE – draft)', description: 'Sample draft election.', type: 'general', status: 'draft', startTime: new Date(now + 10 * day), endTime: new Date(now + 11 * day) });

  const cand = (election, list) => M.Candidate.insertMany(list.map(([name, party, symbol, manifesto]) => ({ election: election._id, name, party, symbol, manifesto, biography: 'Sample biography (DEV SAMPLE).', isDevSample: true })));
  const activeCands = await cand(active, [
    ['Priya Sharma (sample)', 'Progress Alliance', 'Torch', 'Better study spaces, 24/7 library access and transparent budgets.'],
    ['Daniel Okoye (sample)', 'Unity Forum', 'Bridge', 'Inclusive events, mental-health support and affordable canteens.'],
    ['Li Wei (sample)', 'Independent', 'Star', 'Open-source campus tools and cleaner energy initiatives.'],
  ]);
  await cand(upcoming, [
    ['Hannah Cole (sample)', 'Civic Action', 'Leaf', 'Safer roads and ward-level budgeting.'],
    ['Ravi Menon (sample)', 'Community First', 'Hand', 'Public parks and better drainage.'],
  ]);
  const doneCands = await cand(done, [
    ['Proposal A – Extended library hours (sample)', 'Referendum', 'A', 'Keep the library open until midnight.'],
    ['Proposal B – Keep current hours (sample)', 'Referendum', 'B', 'Maintain existing hours.'],
  ]);

  // Sample ballots for the completed referendum + a couple of sample votes in the active election.
  // Ballots carry NO voter reference – exactly like production ballots.
  const approved = voters.slice(0, 11);
  const castSample = async (election, cands, voter, pick) => {
    await M.VoterEligibility.create({ election: election._id, voter: voter._id, hasVoted: true, dfaState: 'S7', receiptReference: receiptReference(), votedAt: new Date(Math.floor(now / 3600000) * 3600000) });
    await M.VoteLock.create({ election: election._id, voter: voter._id });
    await M.AnonymousBallot.create({ election: election._id, candidate: cands[pick]._id, constituency: voter.constituency });
  };
  for (let i = 0; i < 9; i += 1) await castSample(done, doneCands, approved[i], i % 3 === 0 ? 1 : 0);
  await castSample(active, activeCands, approved[0], 0);
  await castSample(active, activeCands, approved[1], 1);

  const { snapshotResults } = require('../services/voting/resultsService');
  await snapshotResults(done, adminUser._id);
  await M.Notice.create([
    { title: 'Welcome to the ElexGuard development sample', body: 'All data in this system is synthetic (DEV SAMPLE).', kind: 'info', createdBy: adminUser._id },
    { title: 'Voting is now open: Student Council Election 2026 (DEV SAMPLE)', body: 'Eligible voters can cast their ballot until the closing time.', kind: 'election', election: active._id, createdBy: adminUser._id },
    { title: 'Results published: Campus Referendum 2025 (DEV SAMPLE)', body: 'See the Results page for turnout and counts.', kind: 'result', election: done._id, createdBy: adminUser._id },
  ]);

  console.log('\n=== ElexGuard DEVELOPMENT sample data created (synthetic – never use in production) ===');
  console.log(`Admin  : ${adminUser.email}   password: ${adminPassword}`);
  console.log(`Voters : voter01..voter11@sample.elexguard.test (approved) — password: ${voterPassword}`);
  console.log('         voter12, voter13 = pending approval, voter14 = rejected, voter15 = email not verified');
  console.log('         voter01 and voter02 have already voted in the active election; try voter03..voter11.');
  console.log('Passwords are random per run and are shown only once.\n');
}

main().catch((e) => { console.error('Seed failed:', e.message); process.exitCode = 1; }).finally(() => mongoose.disconnect());
