'use strict';
/**
 * ElexGuard voting-workflow DFA
 *
 *   M = (Q, Σ, δ, q0, F)
 *
 *   Q  = { S0 … S7 } ∪ { SX }           (SX = rejecting / dead state, makes δ a total function)
 *   Σ  = { AUTHENTICATE, VERIFY_EMAIL, VERIFY_IDENTITY, CONFIRM_ELIGIBILITY,
 *          REQUEST_BALLOT, SUBMIT_VOTE, COMPLETE_VOTING }
 *   q0 = S0
 *   F  = { S7 }
 *
 * The language L(M) is the set of input words that describe a legitimate voting session:
 *   AUTHENTICATE · VERIFY_EMAIL · VERIFY_IDENTITY · CONFIRM_ELIGIBILITY · REQUEST_BALLOT⁺ · SUBMIT_VOTE · COMPLETE_VOTING
 * (REQUEST_BALLOT may repeat while the voter still holds ballot access, e.g. a page refresh
 * re-issues the one-time authorisation – hence the self-loop on S5.)
 */

const STATES = Object.freeze({
  S0: 'S0', S1: 'S1', S2: 'S2', S3: 'S3', S4: 'S4', S5: 'S5', S6: 'S6', S7: 'S7', SX: 'SX',
});

const STATE_LABELS = Object.freeze({
  S0: 'Not Authenticated',
  S1: 'Authenticated',
  S2: 'Email Verified',
  S3: 'Identity Verified',
  S4: 'Voter Eligible',
  S5: 'Ballot Access Granted',
  S6: 'Vote Submitted',
  S7: 'Voting Completed',
  SX: 'Rejected (dead state)',
});

const SYMBOLS = Object.freeze({
  AUTHENTICATE: 'AUTHENTICATE',
  VERIFY_EMAIL: 'VERIFY_EMAIL',
  VERIFY_IDENTITY: 'VERIFY_IDENTITY',
  CONFIRM_ELIGIBILITY: 'CONFIRM_ELIGIBILITY',
  REQUEST_BALLOT: 'REQUEST_BALLOT',
  SUBMIT_VOTE: 'SUBMIT_VOTE',
  COMPLETE_VOTING: 'COMPLETE_VOTING',
});

const INITIAL_STATE = STATES.S0;
const ACCEPTING_STATES = Object.freeze([STATES.S7]);
const REJECTING_STATES = Object.freeze([STATES.SX]);

// δ : Q × Σ → Q  (only the defined edges are listed; every other pair maps to SX)
const TRANSITIONS = Object.freeze({
  S0: { AUTHENTICATE: 'S1' },
  S1: { VERIFY_EMAIL: 'S2' },
  S2: { VERIFY_IDENTITY: 'S3' },
  S3: { CONFIRM_ELIGIBILITY: 'S4' },
  S4: { REQUEST_BALLOT: 'S5' },
  S5: { REQUEST_BALLOT: 'S5', SUBMIT_VOTE: 'S6' },
  S6: { COMPLETE_VOTING: 'S7' },
  S7: {},
  SX: {},
});

module.exports = {
  STATES, STATE_LABELS, SYMBOLS, INITIAL_STATE, ACCEPTING_STATES, REJECTING_STATES, TRANSITIONS,
};
