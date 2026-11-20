'use strict';
const mongoose = require('mongoose');
const { AnonymousBallot, Candidate, Voter, Constituency, ElectionResult } = require('../../models');

const oid = (v) => new mongoose.Types.ObjectId(String(v));
const pct = (num, den) => (den > 0 ? Math.round((num / den) * 10000) / 100 : 0);

async function eligibleVoterFilter(election) {
  const f = { verificationStatus: 'approved' };
  if (election.constituencies && election.constituencies.length) {
    f.constituency = { $in: election.constituencies.map((c) => c._id || c) };
  }
  return f;
}

/** Total number of approved voters able to take part in the election. */
async function countEligible(election) {
  return Voter.countDocuments(await eligibleVoterFilter(election));
}

/** Aggregate results purely from anonymous ballots – never from voter-linked data. */
async function computeResults(election) {
  const eid = oid(election._id);
  const [candidates, voteRows, constRows, voterRows, totalEligible] = await Promise.all([
    Candidate.find({ election: eid }).select('name party symbol hasPhoto').sort({ name: 1 }),
    AnonymousBallot.aggregate([{ $match: { election: eid } }, { $group: { _id: '$candidate', votes: { $sum: 1 } } }]),
    AnonymousBallot.aggregate([{ $match: { election: eid } }, { $group: { _id: '$constituency', votes: { $sum: 1 } } }]),
    Voter.aggregate([{ $match: await eligibleVoterFilter(election) }, { $group: { _id: '$constituency', eligible: { $sum: 1 } } }]),
    countEligible(election),
  ]);

  const votesBy = new Map(voteRows.map((r) => [String(r._id), r.votes]));
  const totalVotes = voteRows.reduce((s, r) => s + r.votes, 0);

  const candidateResults = candidates
    .map((c) => ({
      candidate: c._id, name: c.name, party: c.party, symbol: c.symbol,
      photoUrl: c.hasPhoto ? `/api/candidates/${c._id}/photo` : null,
      votes: votesBy.get(String(c._id)) || 0,
      percent: pct(votesBy.get(String(c._id)) || 0, totalVotes),
    }))
    .sort((a, b) => b.votes - a.votes || a.name.localeCompare(b.name));

  const constituencyIds = new Set([...constRows.map((r) => String(r._id)), ...voterRows.map((r) => String(r._id))]);
  const constituencies = await Constituency.find({ _id: { $in: [...constituencyIds].map(oid) } }).select('name code');
  const cMap = new Map(constituencies.map((c) => [String(c._id), c]));
  const eligBy = new Map(voterRows.map((r) => [String(r._id), r.eligible]));
  const cVotes = new Map(constRows.map((r) => [String(r._id), r.votes]));
  const constituencyResults = [...constituencyIds].map((id) => {
    const c = cMap.get(id);
    const eligible = eligBy.get(id) || 0;
    const votes = cVotes.get(id) || 0;
    return { constituency: id, name: c ? c.name : 'Unknown', code: c ? c.code : '', eligible, votes, turnoutPercent: pct(votes, eligible) };
  }).sort((a, b) => a.name.localeCompare(b.name));

  let winner = null;
  if (totalVotes > 0 && candidateResults.length) {
    const top = candidateResults[0];
    const tie = candidateResults.filter((c) => c.votes === top.votes).length > 1;
    winner = { name: top.name, party: top.party, votes: top.votes, tie };
  }

  return {
    totalEligible, totalVotes, turnoutPercent: pct(totalVotes, totalEligible),
    candidates: candidateResults, constituencies: constituencyResults, winner,
  };
}

/** Lightweight counters that do not reveal candidate-wise results. */
async function participation(election) {
  const [totalEligible, totalVotes] = await Promise.all([
    countEligible(election),
    AnonymousBallot.countDocuments({ election: election._id }),
  ]);
  return { totalEligible, totalVotes, turnoutPercent: pct(totalVotes, totalEligible) };
}

async function snapshotResults(election, adminId) {
  const r = await computeResults(election);
  const doc = {
    election: election._id,
    totalEligible: r.totalEligible,
    totalVotes: r.totalVotes,
    turnoutPercent: r.turnoutPercent,
    candidates: r.candidates.map((c) => ({ candidate: c.candidate, name: c.name, party: c.party, votes: c.votes, percent: c.percent })),
    constituencies: r.constituencies.map((c) => ({
      constituency: c.constituency, name: c.name, code: c.code, eligible: c.eligible, votes: c.votes, turnoutPercent: c.turnoutPercent,
    })),
    winner: r.winner || undefined,
    publishedBy: adminId,
    publishedAt: new Date(),
  };
  await ElectionResult.findOneAndUpdate({ election: election._id }, { $setOnInsert: doc }, { upsert: true, new: true });
  return ElectionResult.findOne({ election: election._id });
}

module.exports = { computeResults, participation, snapshotResults, countEligible, pct };
