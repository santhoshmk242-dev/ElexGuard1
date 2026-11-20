'use strict';
const { Schema, model } = require('mongoose');

// Records WHO is allowed to / has voted in an election – never WHAT they voted for.
// Deliberately has NO reference to any ballot or candidate.
const voterEligibilitySchema = new Schema(
  {
    election: { type: Schema.Types.ObjectId, ref: 'Election', required: true },
    voter: { type: Schema.Types.ObjectId, ref: 'Voter', required: true },
    dfaState: { type: String, enum: ['S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7'], default: 'S0' },
    hasVoted: { type: Boolean, default: false },
    // One-time ballot authorisation: only a SHA-256 hash is stored, consumed atomically on submit.
    authorizationHash: { type: String, default: null }, // never serialised by any controller
    authorizationExpiresAt: { type: Date, default: null },
    // Random receipt reference. Not derived from, or linked to, the ballot.
    receiptReference: { type: String, default: null },
    votedAt: { type: Date, default: null },
  },
  { timestamps: true }
);
// Database-level guarantee: exactly one eligibility record per voter per election.
voterEligibilitySchema.index({ election: 1, voter: 1 }, { unique: true });
voterEligibilitySchema.index({ election: 1, hasVoted: 1 });

module.exports = model('VoterEligibility', voterEligibilitySchema);
