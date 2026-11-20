'use strict';
/**
 * DFA validation service – connects the pure DFA (dfaEngine) to the real voting workflow.
 *
 * Every ballot-access / vote-submission request is turned into a word over Σ and executed on
 * the DFA. Real-world facts (email verified? admin approved? election active?) act as guards:
 * a symbol is only fed to the DFA when its guard holds, and the DFA alone decides whether
 * the ordering of symbols is legal (no skipping states, no voting twice, …).
 */
const crypto = require('crypto');
const { votingDfa } = require('./dfaEngine');
const { STATES, SYMBOLS } = require('./dfaDefinition');
const { VoterEligibility, Voter } = require('../../models');
const { sha256, randomToken } = require('../../utils/crypto');
const AppError = require('../../utils/AppError');
const config = require('../../config/env');
const { audit, securityEvent } = require('../security/auditService');

// Canonical session word: AUTHENTICATE · VERIFY_EMAIL · VERIFY_IDENTITY · CONFIRM_ELIGIBILITY · REQUEST_BALLOT
const CANONICAL = [
  SYMBOLS.AUTHENTICATE,
  SYMBOLS.VERIFY_EMAIL,
  SYMBOLS.VERIFY_IDENTITY,
  SYMBOLS.CONFIRM_ELIGIBILITY,
  SYMBOLS.REQUEST_BALLOT,
];
const STATE_AFTER = [STATES.S0, STATES.S1, STATES.S2, STATES.S3, STATES.S4, STATES.S5]; // state after i symbols

function stateIndex(state) {
  const i = STATE_AFTER.indexOf(state);
  return i === -1 ? STATE_AFTER.length : i; // S6/S7 are beyond the ballot-access prefix
}

function electionOpenFacts(election, now = new Date()) {
  const reasons = [];
  if (election.status === 'draft' || election.status === 'scheduled') {
    reasons.push('Voting has not started for this election.');
  } else if (election.status === 'paused') {
    reasons.push('Voting is temporarily paused by the election administrator.');
  } else if (election.status === 'completed' || election.status === 'published') {
    reasons.push('Voting for this election has ended.');
  } else if (now < election.startTime) {
    reasons.push('Voting period has not started yet.');
  } else if (now > election.endTime) {
    reasons.push('Voting period has ended.');
  }
  return reasons;
}

function constituencyAllowed(election, voter) {
  if (!election.constituencies || election.constituencies.length === 0) return true;
  return election.constituencies.some((c) => String(c._id || c) === String(voter.constituency._id || voter.constituency));
}

/** Evaluate the guard for each canonical symbol. */
function evaluateGuards({ user, voter, election, eligibility }) {
  const g = [];
  g.push({ symbol: SYMBOLS.AUTHENTICATE, ok: Boolean(user && user.isActive), reason: 'Your account is not active.' });
  g.push({
    symbol: SYMBOLS.VERIFY_IDENTITY,
    ok: Boolean(voter && voter.verificationStatus === 'approved'),
    reason: voter && voter.verificationStatus === 'rejected'
      ? 'Your voter registration was rejected by the administrator.'
      : 'Your identity has not been verified and approved by the administrator yet.',
  });
  const windowReasons = electionOpenFacts(election);
  const inConstituency = voter ? constituencyAllowed(election, voter) : false;
  g.push({
    symbol: SYMBOLS.CONFIRM_ELIGIBILITY,
    ok: inConstituency && windowReasons.length === 0,
    reason: !inConstituency
      ? 'Your constituency is not part of this election.'
      : windowReasons[0] || 'Election is not open.',
  });
  g.push({ symbol: SYMBOLS.REQUEST_BALLOT, ok: !(eligibility && eligibility.hasVoted), reason: 'You have already voted in this election.' });
  return g;
}

async function ensureEligibilityRecord(election, voter) {
  const filter = { election: election._id, voter: voter._id };
  let rec = await VoterEligibility.findOne(filter);
  if (rec) return rec;
  try {
    rec = await VoterEligibility.create({ ...filter, dfaState: STATES.S0 });
  } catch (err) {
    if (err && err.code === 11000) rec = await VoterEligibility.findOne(filter); // lost a creation race
    else throw err;
  }
  return rec;
}

/** Read-only eligibility summary used by the UI ("Voting eligibility check"). */
async function checkEligibility({ user, voter, election }) {
  const eligibility = voter
    ? await VoterEligibility.findOne({ election: election._id, voter: voter._id })
    : null;
  const guards = evaluateGuards({ user, voter, election, eligibility });
  const failing = guards.find((x) => !x.ok);
  const upcomingOnly = failing && failing.symbol === SYMBOLS.CONFIRM_ELIGIBILITY &&
    constituencyAllowed(election, voter || { constituency: null }) === true;
  return {
    eligible: !failing,
    hasVoted: Boolean(eligibility && eligibility.hasVoted),
    receiptReference: eligibility && eligibility.hasVoted ? eligibility.receiptReference : null,
    dfaState: eligibility ? eligibility.dfaState : STATES.S0,
    dfaStateLabel: votingDfa.labels[eligibility ? eligibility.dfaState : STATES.S0],
    reasons: guards.filter((x) => !x.ok).map((x) => x.reason),
    steps: guards.map((x) => ({ step: x.symbol, passed: x.ok })),
    electionOpen: electionOpenFacts(election).length === 0,
    upcomingOnly: Boolean(upcomingOnly),
  };
}

async function rejectTransition(req, user, step, eligibility, extra = '') {
  const allowed = votingDfa.allowedSymbols(step.from);
  await securityEvent(req, 'INVALID_DFA_TRANSITION', {
    severity: 'high',
    user,
    details: `Rejected δ(${step.from}, ${step.symbol}) → ${step.to}. Allowed from ${step.from}: [${allowed.join(', ')}]. ${extra}`.trim(),
  });
  await audit(req, 'DFA_TRANSITION_REJECTED', {
    actor: user,
    targetType: 'Election',
    targetId: eligibility && eligibility.election,
    description: `Invalid DFA transition rejected (${step.from} --${step.symbol}--> ${step.to})`,
    metadata: { from: step.from, symbol: step.symbol },
  });
  throw new AppError(
    `Workflow violation: "${step.symbol}" is not permitted from state ${step.from} (${votingDfa.labels[step.from]}).`,
    409,
    'DFA_INVALID_TRANSITION',
    { state: step.from, symbol: step.symbol, allowedSymbols: allowed }
  );
}

/**
 * Drive the DFA to S5 (Ballot Access Granted) and issue a one-time ballot authorisation token.
 * Returns { token, expiresAt, state }.
 */
async function grantBallotAccess({ req, user, voter, election }) {
  const eligibility = await ensureEligibilityRecord(election, voter);

  // Completed voters can never re-enter: the DFA itself rejects REQUEST_BALLOT from S6/S7.
  if (eligibility.hasVoted || stateIndex(eligibility.dfaState) > 5) {
    const step = votingDfa.step(eligibility.dfaState === STATES.S6 ? STATES.S6 : STATES.S7, SYMBOLS.REQUEST_BALLOT);
    await securityEvent(req, 'DUPLICATE_VOTE_ATTEMPT', {
      severity: 'high', user, details: `Ballot access requested after voting completed (election ${election._id}).`,
    });
    await audit(req, 'DUPLICATE_VOTE_ATTEMPT', {
      actor: user, targetType: 'Election', targetId: election._id, description: 'Voter attempted to access the ballot again after voting.',
    });
    throw new AppError('You have already voted in this election. Each voter may vote only once.', 409, 'ALREADY_VOTED', {
      state: step.from, symbol: step.symbol,
    });
  }

  const guards = evaluateGuards({ user, voter, election, eligibility });
  let reachable = guards.findIndex((x) => !x.ok);
  if (reachable === -1) reachable = guards.length;

  // If facts changed since the last request (e.g. admin revoked approval), reset the session state.
  let state = eligibility.dfaState;
  const maxState = STATE_AFTER[Math.min(reachable, 5)];
  if (stateIndex(state) > stateIndex(maxState)) state = maxState;

  // Remaining suffix of the canonical word from the persisted state.
  const startIdx = state === STATES.S5 ? 4 : stateIndex(state);
  const word = CANONICAL.slice(startIdx);
  for (const symbol of word) {
    const guard = guards[CANONICAL.indexOf(symbol)];
    if (!guard.ok) {
      await VoterEligibility.updateOne({ _id: eligibility._id, hasVoted: false }, { $set: { dfaState: state } });
      throw new AppError(guard.reason, 403, 'NOT_ELIGIBLE', { state, blockedAt: symbol, dfaStateLabel: votingDfa.labels[state] });
    }
    const step = votingDfa.step(state, symbol);
    if (!step.valid) {
      return rejectTransition(req, user, step, eligibility);
    }
    state = step.to;
  }

  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + config.security.ballotTokenTtlMinutes * 60 * 1000);
  const updated = await VoterEligibility.findOneAndUpdate(
    { _id: eligibility._id, hasVoted: false },
    { $set: { dfaState: state, authorizationHash: sha256(token), authorizationExpiresAt: expiresAt } },
    { new: true }
  );
  if (!updated) throw new AppError('You have already voted in this election.', 409, 'ALREADY_VOTED');

  await audit(req, 'BALLOT_ACCESS_GRANTED', {
    actor: user, targetType: 'Election', targetId: election._id, description: 'Ballot access granted after DFA validation.',
    metadata: { dfaState: state },
  });
  return { token, expiresAt, state };
}

module.exports = {
  CANONICAL, stateIndex, evaluateGuards, electionOpenFacts, constituencyAllowed,
  ensureEligibilityRecord, checkEligibility, grantBallotAccess, rejectTransition,
};
