'use strict';
const { Election, Candidate, Notice } = require('../../models');
const AppError = require('../../utils/AppError');
const { snapshotResults } = require('./resultsService');

/** Allowed lifecycle transitions: Draft → Scheduled → Active ⇄ Paused → Completed → Published */
const ACTIONS = {
  schedule: { from: ['draft'], to: 'scheduled' },
  start: { from: ['scheduled'], to: 'active' },
  pause: { from: ['active'], to: 'paused' },
  resume: { from: ['paused'], to: 'active' },
  end: { from: ['active', 'paused'], to: 'completed' },
  publish: { from: ['completed'], to: 'published' },
};

const AUDIT_NAME = {
  schedule: 'ELECTION_SCHEDULED', start: 'ELECTION_ACTIVATED', pause: 'ELECTION_PAUSED',
  resume: 'ELECTION_RESUMED', end: 'ELECTION_CLOSED', publish: 'ELECTION_RESULTS_PUBLISHED',
};

async function notice(election, title, kind, adminId) {
  try {
    await Notice.create({ title, kind, election: election._id, createdBy: adminId || null, body: election.title });
  } catch (_e) { /* notices are best-effort */ }
}

async function transition(electionId, action, adminId) {
  const rule = ACTIONS[action];
  if (!rule) throw new AppError('Unknown election action.', 400, 'BAD_ACTION');
  const election = await Election.findById(electionId);
  if (!election) throw new AppError('Election not found.', 404, 'NOT_FOUND');
  if (!rule.from.includes(election.status)) {
    throw new AppError(
      `Cannot ${action} an election that is "${election.status}". Allowed from: ${rule.from.join(', ')}.`,
      409, 'INVALID_LIFECYCLE_TRANSITION'
    );
  }
  const now = new Date();

  if (action === 'schedule') {
    const count = await Candidate.countDocuments({ election: election._id });
    if (count < 2) throw new AppError('Add at least two candidates before scheduling the election.', 422, 'NEEDS_CANDIDATES');
    if (election.endTime <= now) throw new AppError('The election end time is in the past. Edit the schedule first.', 422, 'INVALID_SCHEDULE');
  }
  if (action === 'start' || action === 'resume') {
    if (election.endTime <= now) {
      throw new AppError('The voting period has already passed. Extend the election duration first.', 422, 'INVALID_SCHEDULE');
    }
  }
  if (action === 'start') {
    election.startedAt = now;
    if (election.startTime > now) election.startTime = now; // manual early start
  }
  if (action === 'end') {
    election.endedAt = now;
    if (election.endTime > now) election.endTime = now;
  }
  if (action === 'publish') {
    election.resultsPublishedAt = now;
  }
  election.status = rule.to;
  await election.save();

  if (action === 'publish') await snapshotResults(election, adminId);
  const titles = {
    start: `Voting is now open: ${election.title}`,
    end: `Voting has closed: ${election.title}`,
    publish: `Results published: ${election.title}`,
    schedule: `Election scheduled: ${election.title}`,
  };
  if (titles[action]) {
    await notice(election, titles[action], action === 'publish' ? 'result' : 'election', adminId);
  }
  return { election, auditAction: AUDIT_NAME[action] };
}

/** Background tick: auto-start scheduled elections and auto-close expired ones. */
async function tickElections(now = new Date()) {
  const started = await Election.updateMany(
    { status: 'scheduled', startTime: { $lte: now }, endTime: { $gt: now } },
    { $set: { status: 'active', startedAt: now } }
  );
  const ended = await Election.updateMany(
    { status: { $in: ['active', 'paused'] }, endTime: { $lte: now } },
    { $set: { status: 'completed', endedAt: now } }
  );
  return { started: started.modifiedCount || 0, ended: ended.modifiedCount || 0 };
}

module.exports = { ACTIONS, transition, tickElections };
