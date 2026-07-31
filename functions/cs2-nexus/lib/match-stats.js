'use strict';

/**
 * Turns the raw per-SteamID stats posted by NexusBridge into a scoreboard that
 * is keyed by Studiosgamesrs account, so MVPs and prizes can be awarded.
 *
 * SteamID64 never reaches a client-readable path: the steamId -> uid map lives
 * under matchConfigs/, which has no read rule and is therefore Admin SDK only.
 */

const admin = require('firebase-admin');

// ADR is the standard individual measure. Kills and the game's own round-MVP
// stars separate players with similar damage, and deaths penalise a fragger who
// trades himself away every round.
const WEIGHT_KILL = 3;
const WEIGHT_ASSIST = 1;
const WEIGHT_ROUND_MVP = 4;
const WEIGHT_DEATH = 1;

function num(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

function ratePlayer(stat, roundsPlayed) {
  const rounds = Math.max(1, num(roundsPlayed));
  const kills = num(stat && stat.kills);
  const deaths = num(stat && stat.deaths);
  const assists = num(stat && stat.assists);
  const damage = num(stat && stat.damage);
  const roundMvps = num(stat && stat.roundMvps);
  const adr = damage / rounds;

  return {
    kills,
    deaths,
    assists,
    damage,
    roundMvps,
    adr: round1(adr),
    kd: deaths > 0 ? Math.round((kills / deaths) * 100) / 100 : kills,
    score: round1(
      adr +
      kills * WEIGHT_KILL +
      assists * WEIGHT_ASSIST +
      roundMvps * WEIGHT_ROUND_MVP -
      deaths * WEIGHT_DEATH
    ),
  };
}

function buildScoreboard(players, roundsPlayed, steamMap) {
  const map = steamMap || {};
  const rows = Object.keys(players || {}).map(function (steamId) {
    const stat = players[steamId] || {};
    return Object.assign(
      {
        uid: map[steamId] || null,
        name: stat.name || 'unknown',
      },
      ratePlayer(stat, roundsPlayed)
    );
  });

  rows.sort(function (a, b) {
    if (b.score !== a.score) return b.score - a.score;
    return b.kills - a.kills;
  });
  return rows;
}

/**
 * An unlinked top scorer is still reported so the organiser sees who actually
 * carried the match, but only a uid can be rewarded automatically.
 */
function pickMvp(scoreboard) {
  if (!scoreboard || !scoreboard.length) return null;
  const top = scoreboard[0];
  return {
    uid: top.uid || null,
    name: top.name,
    adr: top.adr,
    kills: top.kills,
    score: top.score,
    rewardable: !!top.uid,
  };
}

function countRosterHits(team, steamIds) {
  if (!team || !team.players) return 0;
  return Object.keys(team.players).filter(function (steamId) {
    return steamIds.has(String(steamId));
  }).length;
}

/**
 * Sides swap at halftime, so CT/T cannot be mapped to a Nexus team by position.
 * Instead we intersect the winning side's live roster with the two rosters that
 * went into the MatchZy config, which is side-agnostic and survives a player
 * disconnecting before the win panel.
 */
function resolveWinnerTeamId(config, winnerSteamIds) {
  if (!config || !config.team1 || !config.team2) {
    return { teamId: null, reason: 'no_match_config' };
  }

  const ids = new Set((winnerSteamIds || []).map(String));
  if (!ids.size) return { teamId: null, reason: 'no_winner_roster' };

  const hits1 = countRosterHits(config.team1, ids);
  const hits2 = countRosterHits(config.team2, ids);

  if (hits1 === 0 && hits2 === 0) return { teamId: null, reason: 'roster_mismatch' };
  if (hits1 === hits2) return { teamId: null, reason: 'ambiguous_roster' };

  const winner = hits1 > hits2 ? config.team1 : config.team2;
  return {
    teamId: winner.id || null,
    teamName: winner.name || null,
    matched: Math.max(hits1, hits2),
    reason: null,
  };
}

function winnerSteamIdsFor(payload) {
  if (payload.winnerSide === 'CT') return payload.ctSteamIds || [];
  if (payload.winnerSide === 'T') return payload.tSteamIds || [];
  return [];
}

/**
 * Maps live CT/T Steam rosters back to MatchZy team1/team2 so the public
 * scoreboard can label each Nexus team after knife or halftime swaps.
 */
function resolveSideByTeam(config, ctSteamIds, tSteamIds) {
  if (!config || !config.team1 || !config.team2) return null;
  const ct = new Set((ctSteamIds || []).map(String));
  const t = new Set((tSteamIds || []).map(String));
  if (!ct.size && !t.size) return null;

  const t1Ct = countRosterHits(config.team1, ct);
  const t1T = countRosterHits(config.team1, t);
  const t2Ct = countRosterHits(config.team2, ct);
  const t2T = countRosterHits(config.team2, t);

  let team1Side = null;
  if (t1Ct > t1T) team1Side = 'CT';
  else if (t1T > t1Ct) team1Side = 'T';
  else if (t2Ct > t2T) team1Side = 'T';
  else if (t2T > t2Ct) team1Side = 'CT';
  else return null;

  const team2Side = team1Side === 'CT' ? 'T' : 'CT';
  const sideByTeam = {};
  if (config.team1.id) sideByTeam[config.team1.id] = team1Side;
  if (config.team2.id) sideByTeam[config.team2.id] = team2Side;
  return { team1Side: team1Side, team2Side: team2Side, sideByTeam: sideByTeam };
}

/**
 * Bandos al arrancar, tomados del lado fijado en el config (map_sides).
 *
 * Hace falta porque las listas de Steam vivas solo llegan al terminar cada
 * ronda: entre el match_start y el final de la primera ronda pasan varios
 * minutos de calentamiento en los que el marcador público no sabría a quién
 * poner de CT. Con 'knife' el lado se decide dentro del juego, así que ahí no
 * se puede afirmar nada y quien pregunte se queda sin respuesta hasta el
 * primer round_end.
 */
function sideByTeamAtStart(config) {
  if (!config || !config.team1 || !config.team2) return null;
  const side = String((config.map_sides || [])[0] || '').toLowerCase();
  if (side !== 'team1_ct' && side !== 'team1_t') return null;

  const team1Side = side === 'team1_ct' ? 'CT' : 'T';
  const team2Side = team1Side === 'CT' ? 'T' : 'CT';
  const sideByTeam = {};
  if (config.team1.id) sideByTeam[config.team1.id] = team1Side;
  if (config.team2.id) sideByTeam[config.team2.id] = team2Side;
  return { team1Side: team1Side, team2Side: team2Side, sideByTeam: sideByTeam };
}

async function getSteamMap(tournamentId, matchId) {
  if (!tournamentId || !matchId) return {};
  const snap = await admin
    .database()
    .ref('matchConfigs/' + tournamentId + '/' + matchId + '/steamMap')
    .once('value');
  return snap.val() || {};
}

async function saveMatchStats(tournamentId, matchId, data) {
  await admin
    .database()
    .ref('matchStats/' + tournamentId + '/' + matchId)
    .update(Object.assign({}, data, { updatedAt: Date.now() }));
}

/**
 * Accumulated with atomic increments because two matches can finish at the same
 * time on the two server slots.
 */
async function accumulateTournamentStats(tournamentId, scoreboard, roundsPlayed) {
  if (!tournamentId || !scoreboard || !scoreboard.length) return 0;
  const db = admin.database();
  const increment = admin.database.ServerValue.increment;
  const rounds = Math.max(1, num(roundsPlayed));

  const writes = scoreboard
    .filter(function (row) { return !!row.uid; })
    .map(function (row) {
      return db.ref('tournamentStats/' + tournamentId + '/' + row.uid).update({
        name: row.name,
        kills: increment(row.kills),
        deaths: increment(row.deaths),
        assists: increment(row.assists),
        damage: increment(row.damage),
        roundMvps: increment(row.roundMvps),
        rounds: increment(rounds),
        matches: increment(1),
        updatedAt: Date.now(),
      });
    });

  await Promise.all(writes);
  return writes.length;
}

/**
 * Ranks a tournament's players once every match has been recorded. ADR is
 * recomputed from the accumulated totals so a player who joined late is not
 * flattered by a short sample.
 */
function rankTournamentPlayers(statsByUid, limit) {
  const rows = Object.keys(statsByUid || {}).map(function (uid) {
    const stat = statsByUid[uid] || {};
    const rounds = Math.max(1, num(stat.rounds));
    return Object.assign({ uid: uid, name: stat.name || uid }, ratePlayer(stat, rounds));
  });

  rows.sort(function (a, b) {
    if (b.score !== a.score) return b.score - a.score;
    return b.adr - a.adr;
  });
  return typeof limit === 'number' ? rows.slice(0, limit) : rows;
}

module.exports = {
  ratePlayer,
  buildScoreboard,
  pickMvp,
  resolveWinnerTeamId,
  resolveSideByTeam,
  sideByTeamAtStart,
  winnerSteamIdsFor,
  getSteamMap,
  saveMatchStats,
  accumulateTournamentStats,
  rankTournamentPlayers,
};
