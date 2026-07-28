'use strict';

const rtdb = require('./firebase-rtdb');

function buildSingleElimBracket(teamIds) {
  const n = teamIds.length;
  if (n < 2) throw new Error('Need at least 2 teams');

  const rounds = Math.ceil(Math.log2(n));
  const bracketSize = 2 ** rounds;
  const slots = [...teamIds];
  while (slots.length < bracketSize) slots.push(null);

  const matches = {};
  let matchNum = 1;
  const round1 = [];

  for (let i = 0; i < bracketSize; i += 2) {
    const matchId = `r1_m${matchNum}`;
    matches[matchId] = {
      id: matchId,
      round: 1,
      teamA: slots[i] ? { teamId: slots[i] } : null,
      teamB: slots[i + 1] ? { teamId: slots[i + 1] } : null,
      status: 'pending',
      winnerTeamId: null,
      nextMatchId: null,
    };
    round1.push(matchId);
    matchNum += 1;
  }

  let prevRound = round1;
  for (let r = 2; r <= rounds; r += 1) {
    const thisRound = [];
    for (let i = 0; i < prevRound.length; i += 2) {
      const matchId = `r${r}_m${Math.floor(i / 2) + 1}`;
      matches[matchId] = {
        id: matchId,
        round: r,
        teamA: null,
        teamB: null,
        status: 'pending',
        winnerTeamId: null,
        nextMatchId: r < rounds ? `r${r + 1}_m${Math.floor(i / 4) + 1}` : null,
      };
      matches[prevRound[i]].nextMatchId = matchId;
      if (prevRound[i + 1]) matches[prevRound[i + 1]].nextMatchId = matchId;
      thisRound.push(matchId);
    }
    prevRound = thisRound;
  }

  return { format: 'SingleElim', rounds, matches, currentMatchId: round1[0] };
}

async function advanceWinner(tournamentId, matchId, winnerTeamId, score = {}) {
  const tournament = await rtdb.getTournament(tournamentId);
  if (!tournament?.bracket?.matches?.[matchId]) {
    throw new Error(`Match ${matchId} not found in bracket`);
  }

  const match = tournament.bracket.matches[matchId];
  await rtdb.writeBracketMatch(tournamentId, matchId, {
    status: 'finished',
    winnerTeamId,
    score,
    finishedAt: Date.now(),
  });

  const nextId = match.nextMatchId;
  if (!nextId) {
    await rtdb.writeTournament(tournamentId, {
      status: 'finalizado',
      championTeamId: winnerTeamId,
      finishedAt: Date.now(),
    });
    return { tournamentComplete: true, championTeamId: winnerTeamId };
  }

  const nextMatch = tournament.bracket.matches[nextId];
  const slotField = !nextMatch.teamA ? 'teamA' : 'teamB';
  await rtdb.writeBracketMatch(tournamentId, nextId, {
    [slotField]: { teamId: winnerTeamId },
    status: nextMatch.teamA || nextMatch.teamB ? 'ready' : 'waiting',
  });

  await rtdb.writeTournament(tournamentId, {
    currentMatchId: nextId,
    status: 'en_vivo',
  });

  return { tournamentComplete: false, nextMatchId: nextId };
}

async function handleMatchEndEvent(tournamentId, matchId, payload) {
  const winnerTeamId = payload.winnerTeamId;
  if (!winnerTeamId) return null;

  await rtdb.writeMatchLive(matchId, {
    status: 'finished',
    winnerTeamId,
    scoreCT: payload.scoreCT,
    scoreT: payload.scoreT,
    durationSeconds: payload.durationSeconds,
    mvp: payload.mvp || null,
    kills: payload.kills || {},
  });

  return advanceWinner(tournamentId, matchId, winnerTeamId, {
    scoreCT: payload.scoreCT,
    scoreT: payload.scoreT,
  });
}

module.exports = {
  buildSingleElimBracket,
  advanceWinner,
  handleMatchEndEvent,
};
