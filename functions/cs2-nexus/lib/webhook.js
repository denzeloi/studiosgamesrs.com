'use strict';

const rtdb = require('./firebase-rtdb');
const { handleMatchEndEvent } = require('./bracket');

async function processMatchEvent(body) {
  const { event, tournamentId, matchId, serverId } = body;
  if (!event || !matchId) throw new Error('Invalid webhook payload');

  const livePatch = {
    tournamentId: tournamentId || null,
    serverId: serverId || null,
    lastEvent: event,
    lastEventAt: Date.now(),
  };

  switch (event) {
    case 'match_start':
      livePatch.status = 'live';
      livePatch.startedAt = Date.now();
      livePatch.roster = body.roster || {};
      if (tournamentId) {
        await rtdb.writeTournament(tournamentId, { status: 'en_vivo', activeMatchId: matchId });
      }
      break;
    case 'round_end':
      livePatch.currentRound = body.round;
      livePatch.scoreCT = body.scoreCT;
      livePatch.scoreT = body.scoreT;
      livePatch.roundDuration = body.durationSeconds;
      livePatch.kills = body.kills || {};
      livePatch.mvps = body.mvps || {};
      break;
    case 'kill':
      livePatch.recentKills = body.recentKills || [];
      livePatch.kills = body.kills || {};
      break;
    case 'mvp':
      livePatch.lastMvp = body.mvp;
      break;
    case 'match_end':
      livePatch.status = 'finished';
      livePatch.finishedAt = Date.now();
      livePatch.durationSeconds = body.durationSeconds;
      livePatch.scoreCT = body.scoreCT;
      livePatch.scoreT = body.scoreT;
      livePatch.winnerTeamId = body.winnerTeamId;
      livePatch.mvp = body.mvp;
      if (serverId) {
        await rtdb.writeGameServer(serverId, { status: 'match_complete', lastMatchId: matchId });
      }
      if (tournamentId && body.winnerTeamId) {
        await handleMatchEndEvent(tournamentId, matchId, body);
      }
      break;
    default:
      livePatch.raw = body;
  }

  await rtdb.writeMatchLive(matchId, livePatch);
  return { ok: true, event };
}

module.exports = { processMatchEvent };
