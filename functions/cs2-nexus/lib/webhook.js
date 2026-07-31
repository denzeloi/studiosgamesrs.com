'use strict';

const rtdb = require('./firebase-rtdb');
const matchzy = require('./matchzy');
const stats = require('./match-stats');
const bracket = require('./bracket');

/**
 * Rounds are needed to turn raw damage into ADR. Older plugin builds did not
 * report them, and the score sum is exact for a completed match.
 */
function roundsPlayedFrom(body) {
  const reported = Number(body.roundsPlayed);
  if (Number.isFinite(reported) && reported > 0) return reported;
  const fromScore = (Number(body.scoreCT) || 0) + (Number(body.scoreT) || 0);
  return fromScore > 0 ? fromScore : 1;
}

/**
 * Builds the public scoreboard. The raw payload is keyed by SteamID64 and must
 * never be written to partida_en_vivo, which anyone can read.
 */
async function scoreboardFor(tournamentId, matchId, body) {
  const rounds = roundsPlayedFrom(body);
  const steamMap = await stats.getSteamMap(tournamentId, matchId);
  return {
    rounds: rounds,
    rows: stats.buildScoreboard(body.players, rounds, steamMap),
  };
}

async function resolveWinner(tournamentId, matchId, body) {
  if (body.winnerTeamId) return { teamId: body.winnerTeamId, reason: 'reported' };
  const config = await matchzy.getStoredMatchConfig(tournamentId, matchId);
  return stats.resolveWinnerTeamId(config, stats.winnerSteamIdsFor(body));
}

function applySides(livePatch, sides) {
  if (!sides) return false;
  livePatch.sideByTeam = sides.sideByTeam;
  livePatch.team1Side = sides.team1Side;
  livePatch.team2Side = sides.team2Side;
  return true;
}

async function attachLiveSides(livePatch, tournamentId, matchId, body) {
  if (!body.ctSteamIds && !body.tSteamIds) return;
  const config = await matchzy.getStoredMatchConfig(tournamentId, matchId);
  applySides(livePatch, stats.resolveSideByTeam(config, body.ctSteamIds, body.tSteamIds));
}

/**
 * Bandos al arrancar. El marcador público no debe estar etiquetando a ojo
 * durante el calentamiento: el lado ya se fijó al lanzar y está en el config,
 * así que se publica desde el primer segundo y luego cada round_end lo corrige
 * con la plantilla real (cuchillo, cambio de mitad).
 */
async function attachStartingSides(livePatch, tournamentId, matchId) {
  if (!tournamentId || !matchId) return;
  const config = await matchzy.getStoredMatchConfig(tournamentId, matchId);
  applySides(livePatch, stats.sideByTeamAtStart(config));
}

function durationFromBody(body) {
  const reported = Number(body.durationSeconds);
  if (Number.isFinite(reported) && reported >= 0) return Math.floor(reported);
  return null;
}

async function processMatchEvent(body) {
  const { event, tournamentId, matchId, serverId } = body;
  if (!event || !matchId) throw new Error('Invalid webhook payload');

  // El plugin no manda serverId (no lo conoce), así que escribirlo como null en
  // cada evento borraba el que dejó el lanzamiento. Se omite si no viene.
  const livePatch = {
    tournamentId: tournamentId || null,
    lastEvent: event,
    lastEventAt: Date.now(),
  };
  if (serverId) livePatch.serverId = serverId;

  switch (event) {
    case 'match_start':
      livePatch.status = 'live';
      livePatch.startedAt = Date.now();
      livePatch.durationSeconds = 0;
      livePatch.roster = body.roster || {};
      // Absent means the server is still running a plugin build from before
      // stats were tracked by SteamID, so match_end will never arrive.
      livePatch.pluginVersion = body.pluginVersion || 'legacy';
      await attachStartingSides(livePatch, tournamentId, matchId);
      if (tournamentId) {
        await rtdb.writeTournament(tournamentId, { status: 'en_vivo', activeMatchId: matchId });
        const startPatch = {
          status: 'live',
          startedAt: livePatch.startedAt,
          durationSeconds: 0,
        };
        if (serverId) startPatch.serverId = serverId;
        if (livePatch.sideByTeam) startPatch.sideByTeam = livePatch.sideByTeam;
        await rtdb.writeTournamentLiveMatch(tournamentId, matchId, startPatch);
      }
      break;

    case 'round_end': {
      livePatch.currentRound = body.round;
      livePatch.scoreCT = body.scoreCT;
      livePatch.scoreT = body.scoreT;
      livePatch.kills = body.kills || {};
      const dur = durationFromBody(body);
      if (dur != null) livePatch.durationSeconds = dur;
      if (body.players) {
        const live = await scoreboardFor(tournamentId, matchId, body);
        livePatch.scoreboard = live.rows;
        livePatch.roundsPlayed = live.rounds;
      }
      await attachLiveSides(livePatch, tournamentId, matchId, body);
      if (tournamentId) {
        const roundPatch = {
          status: 'live',
          scoreCT: body.scoreCT,
          scoreT: body.scoreT,
          currentRound: body.round,
        };
        // Igual que la duración: si esta ronda no dejó claro el bando (plantilla
        // incompleta, empate de coincidencias), se calla en vez de borrar el
        // que ya se publicó al arrancar.
        if (livePatch.sideByTeam) roundPatch.sideByTeam = livePatch.sideByTeam;
        if (dur != null) roundPatch.durationSeconds = dur;
        await rtdb.writeTournamentLiveMatch(tournamentId, matchId, roundPatch);
      }
      break;
    }

    case 'kill':
      livePatch.recentKills = body.recentKills || [];
      livePatch.kills = body.kills || {};
      break;

    case 'mvp':
      livePatch.lastMvp = body.mvp;
      break;

    case 'match_end': {
      livePatch.status = 'finished';
      livePatch.finishedAt = Date.now();
      // Se valida igual que en round_end y solo se escribe si viene: un build
      // viejo del plugin no lo manda, y machacar el campo con null borraría la
      // duración que ya había dejado la última ronda.
      const endDuration = durationFromBody(body);
      if (endDuration != null) livePatch.durationSeconds = endDuration;
      livePatch.scoreCT = body.scoreCT;
      livePatch.scoreT = body.scoreT;
      livePatch.winnerSide = body.winnerSide || null;

      const board = await scoreboardFor(tournamentId, matchId, body);
      const mvp = stats.pickMvp(board.rows);
      const winner = await resolveWinner(tournamentId, matchId, body);
      await attachLiveSides(livePatch, tournamentId, matchId, body);

      livePatch.scoreboard = board.rows;
      livePatch.roundsPlayed = board.rounds;
      livePatch.mvp = mvp;
      livePatch.winnerTeamId = winner.teamId || null;
      livePatch.winnerResolution = winner.reason || null;

      // El plugin no sabe en qué servidor corre, así que el que hay que cerrar
      // se busca en el cruce: sin esto la partida terminaba y el servidor se
      // quedaba marcado como si siguiera jugando.
      const entry = await rtdb.getTournamentLiveMatch(tournamentId, matchId);
      const endServerId = serverId || (entry && entry.serverId) || null;
      if (endServerId) {
        await rtdb.writeGameServer(String(endServerId), {
          status: 'match_complete',
          lastMatchId: matchId,
        });
      }

      if (tournamentId) {
        await stats.saveMatchStats(tournamentId, matchId, {
          scoreboard: board.rows,
          roundsPlayed: board.rounds,
          mvp: mvp,
          scoreCT: body.scoreCT || 0,
          scoreT: body.scoreT || 0,
          winnerSide: body.winnerSide || null,
          winnerTeamId: winner.teamId || null,
          winnerResolution: winner.reason || null,
          finishedAt: Date.now(),
        });
        await stats.accumulateTournamentStats(tournamentId, board.rows, board.rounds);
        const endPatch = {
          status: 'finished',
          finishedAt: Date.now(),
          scoreCT: body.scoreCT,
          scoreT: body.scoreT,
          winnerTeamId: winner.teamId || null,
          mvp: mvp,
        };
        if (livePatch.sideByTeam) endPatch.sideByTeam = livePatch.sideByTeam;
        if (endDuration != null) endPatch.durationSeconds = endDuration;
        await rtdb.writeTournamentLiveMatch(tournamentId, matchId, endPatch);
      }

      if (tournamentId && winner.teamId) {
        await bracket.handleMatchEndEvent(
          tournamentId,
          matchId,
          Object.assign({}, body, { winnerTeamId: winner.teamId, mvp: mvp, kills: body.kills || {} })
        );
      } else if (tournamentId) {
        // The bracket stays put rather than advancing a guess; the War Room shows
        // the reason so the commander can pick the winner by hand.
        console.warn('[webhook] match_end without a resolvable winner', matchId, winner.reason);
      }
      break;
    }

    default:
      livePatch.raw = body;
  }

  await rtdb.writeMatchLive(matchId, livePatch);
  return { ok: true, event };
}

module.exports = { processMatchEvent };
