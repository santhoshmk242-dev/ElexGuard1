'use strict';
const mongoose = require('mongoose');
const { votingDfa } = require('../dfa/dfaEngine');
const { STATES, SYMBOLS } = require('../dfa/dfaDefinition');
const workflow = require('../dfa/votingWorkflow');
const { VoterEligibility, AnonymousBallot, Candidate, VoteLock } = require('../../models');
const { supportsTransactions } = require('../../config/db');
const { sha256, receiptReference, safeEqualHex } = require('../../utils/crypto');
const AppError = require('../../utils/AppError');
const { audit, securityEvent } = require('../security/auditService');

function coarseTime(d = new Date()) {
  // Vote time is only recorded to the hour so it cannot be matched against ballot insertion order.
  return new Date(Math.floor(d.getTime() / 3600000) * 3600000);
}

/**
 * Submit a vote.
 *
 *  1. Re-check live facts (election open, voter approved …).
 *  2. DFA: δ(state, SUBMIT_VOTE) must be valid – i.e. state must be S5. S6/S7 => duplicate attempt.
 *  3. Atomically CONSUME the one-time ballot authorisation (findOneAndUpdate with the full
 *     precondition in the filter: only one concurrent request can ever match).
 *  4. Insert the anonymous ballot (no voter reference).
 *  5. DFA: COMPLETE_VOTING S6 → S7.
 * Steps 3–5 run in a MongoDB transaction when available (Atlas); otherwise the consume step
 * is the atomic guard and a compensating rollback restores it if the ballot insert fails.
 */
async function submitVote({ req, user, voter, election, candidateId, ballotToken }) {
  const eligibility = await workflow.ensureEligibilityRecord(election, voter);
  const guards = workflow.evaluateGuards({ user, voter, election, eligibility: { hasVoted: false } });
  const failing = guards.find((g) => !g.ok);

  // Duplicate / completed voters are reported before anything else.
  if (eligibility.hasVoted || eligibility.dfaState === STATES.S6 || eligibility.dfaState === STATES.S7) {
    await securityEvent(req, 'DUPLICATE_VOTE_ATTEMPT', {
      severity: 'high', user, details: `Second vote submission blocked (election ${election._id}).`,
    });
    await audit(req, 'DUPLICATE_VOTE_ATTEMPT', {
      actor: user, targetType: 'Election', targetId: election._id, description: 'Duplicate vote submission blocked.',
    });
    throw new AppError('You have already voted in this election. Votes cannot be changed or repeated.', 409, 'ALREADY_VOTED');
  }
  if (failing) throw new AppError(failing.reason, 403, 'NOT_ELIGIBLE');

  const step = votingDfa.step(eligibility.dfaState, SYMBOLS.SUBMIT_VOTE);
  if (!step.valid) return workflow.rejectTransition(req, user, step, eligibility);

  const candidate = await Candidate.findOne({ _id: candidateId, election: election._id }).select('_id');
  if (!candidate) throw new AppError('The selected candidate is not valid for this election.', 400, 'INVALID_CANDIDATE');

  const receipt = receiptReference();
  const now = new Date();
  const consumeFilter = {
    _id: eligibility._id,
    hasVoted: false,
    dfaState: STATES.S5,
    authorizationHash: sha256(ballotToken),
    authorizationExpiresAt: { $gt: now },
  };
  const consumeUpdate = {
    $set: { hasVoted: true, dfaState: STATES.S6, receiptReference: receipt, votedAt: coarseTime(now) },
    $unset: { authorizationHash: '', authorizationExpiresAt: '' },
  };
  const ballotDoc = { election: election._id, candidate: candidate._id, constituency: voter.constituency._id || voter.constituency };

  const tokenError = async () => {
    // Distinguish a bad/expired token from a lost race for clearer errors.
    const fresh = await VoterEligibility.findById(eligibility._id).select('+authorizationHash +authorizationExpiresAt');
    if (fresh && fresh.hasVoted) {
      await securityEvent(req, 'DUPLICATE_VOTE_ATTEMPT', { severity: 'high', user, details: 'Concurrent duplicate submission blocked.' });
      return new AppError('You have already voted in this election.', 409, 'ALREADY_VOTED');
    }
    await securityEvent(req, 'INVALID_BALLOT_TOKEN', { severity: 'medium', user, details: 'Invalid or expired ballot authorisation.' });
    return new AppError('Your ballot session is invalid or has expired. Please reopen the ballot and try again.', 403, 'INVALID_BALLOT_TOKEN');
  };

  if (supportsTransactions()) {
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        const consumed = await VoterEligibility.findOneAndUpdate(consumeFilter, consumeUpdate, { new: true, session });
        if (!consumed) throw new AppError('consume-failed', 409, 'CONSUME_FAILED');
        await VoteLock.create([{ election: election._id, voter: voter._id }], { session }); // unique-key arbiter
        await AnonymousBallot.create([ballotDoc], { session });
        const done = votingDfa.step(STATES.S6, SYMBOLS.COMPLETE_VOTING);
        await VoterEligibility.updateOne({ _id: eligibility._id }, { $set: { dfaState: done.to } }, { session });
      });
    } catch (err) {
      if (err && (err.code === 11000 || err.code === 'CONSUME_FAILED' || (err.hasErrorLabel && err.hasErrorLabel('TransientTransactionError')))) {
        throw await tokenError();
      }
      throw err;
    } finally {
      await session.endSession();
    }
  } else {
    const consumed = await VoterEligibility.findOneAndUpdate(consumeFilter, consumeUpdate, { new: true });
    if (!consumed) throw await tokenError();
    // Second, engine-independent guard: only ONE request can ever insert the unique lock.
    try {
      await VoteLock.create({ election: election._id, voter: voter._id });
    } catch (err) {
      if (err && err.code === 11000) {
        // Lost a race against a concurrent submission that already holds the lock. Do NOT touch the
        // eligibility record (the winner owns it) and do NOT write a ballot.
        await securityEvent(req, 'DUPLICATE_VOTE_ATTEMPT', { severity: 'high', user, details: 'Concurrent duplicate submission blocked by vote lock.' });
        throw new AppError('You have already voted in this election.', 409, 'ALREADY_VOTED');
      }
      throw err;
    }
    try {
      await AnonymousBallot.create(ballotDoc);
      const done = votingDfa.step(STATES.S6, SYMBOLS.COMPLETE_VOTING);
      await VoterEligibility.updateOne({ _id: eligibility._id }, { $set: { dfaState: done.to } });
    } catch (err) {
      // Compensating rollback so the voter is not locked out by a failed ballot insert.
      await VoteLock.deleteOne({ election: election._id, voter: voter._id });
      await VoterEligibility.updateOne(
        { _id: eligibility._id },
        { $set: { hasVoted: false, dfaState: STATES.S4, receiptReference: null, votedAt: null } }
      );
      throw new AppError('Your vote could not be recorded. Please try again.', 500, 'VOTE_RECORD_FAILED');
    }
  }

  await audit(req, 'VOTE_CAST', {
    actor: user, targetType: 'Election', targetId: election._id,
    description: 'Vote recorded (selection intentionally not logged).',
  });
  return { receiptReference: receipt, state: STATES.S7, stateLabel: votingDfa.labels[STATES.S7] };
}

module.exports = { submitVote, coarseTime, safeEqualHex };
