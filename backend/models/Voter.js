'use strict';
const { Schema, model } = require('mongoose');

const voterSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    constituency: { type: Schema.Types.ObjectId, ref: 'Constituency', required: true, index: true },
    // Government-style identity number supplied at registration (synthetic in this prototype).
    voterIdNumber: { type: String, required: true, unique: true, uppercase: true, trim: true, match: /^[A-Z0-9-]{6,20}$/ },
    dateOfBirth: { type: Date, required: true },
    address: { type: String, trim: true, maxlength: 300, default: '' },
    verificationStatus: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending', index: true },
    rejectionReason: { type: String, trim: true, maxlength: 300, default: '' },
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    reviewedAt: { type: Date, default: null },
    isDevSample: { type: Boolean, default: false },
  },
  { timestamps: true }
);
voterSchema.index({ verificationStatus: 1, constituency: 1 });

module.exports = model('Voter', voterSchema);
