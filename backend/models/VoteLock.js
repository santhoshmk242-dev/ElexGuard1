'use strict';
const { Schema, model } = require('mongoose');

// Database-level arbiter for "one vote per voter per election".
// A unique-key insert is atomic on every MongoDB-compatible engine, so even if two requests
// both pass the application checks, exactly one insert can succeed. Stores NO choice and NO ballot link.
const voteLockSchema = new Schema(
  {
    election: { type: Schema.Types.ObjectId, ref: 'Election', required: true },
    voter: { type: Schema.Types.ObjectId, ref: 'Voter', required: true },
  },
  { timestamps: false, versionKey: false }
);
voteLockSchema.index({ election: 1, voter: 1 }, { unique: true });

module.exports = model('VoteLock', voteLockSchema);
