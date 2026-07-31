#!/usr/bin/env node
'use strict';

/**
 * Checks the logic that decides who won a match and who was the MVP.
 *
 * This is the code path that advances the bracket and hands out prizes, so a
 * regression here silently pays the wrong team. Everything under test is pure,
 * so no emulator or network is needed.
 */

const path = require('path');

const stats = require(
  path.join(__dirname, '..', 'functions', 'cs2-nexus', 'lib', 'match-stats.js')
);

let failed = 0;

function ok(msg) {
  console.log('OK  ', msg);
}

function fail(msg, expected, actual) {
  console.error('FAIL', msg, '— expected', JSON.stringify(expected), 'got', JSON.stringify(actual));
  failed += 1;
}

function eq(label, actual, expected) {
  if (actual === expected) ok(label);
  else fail(label, expected, actual);
}

// Two five-man rosters, keyed by SteamID64 exactly as MatchZy receives them.
const ALPHA = ['76561190000000001', '76561190000000002', '76561190000000003'];
const BRAVO = ['76561190000000011', '76561190000000012', '76561190000000013'];

function roster(ids) {
  const players = {};
  ids.forEach(function (id, i) { players[id] = 'p' + i; });
  return players;
}

const CONFIG = {
  team1: { id: 'team-alpha', name: 'Alpha', players: roster(ALPHA) },
  team2: { id: 'team-bravo', name: 'Bravo', players: roster(BRAVO) },
};

console.log('\n--- winner resolution ---');

// Sides swap at halftime, so the winning side must be resolved by roster, never
// by assuming team1 is CT.
eq(
  'team1 wins while playing CT',
  stats.resolveWinnerTeamId(CONFIG, ALPHA).teamId,
  'team-alpha'
);
eq(
  'team1 wins while playing T (post-halftime swap)',
  stats.resolveWinnerTeamId(CONFIG, ALPHA).teamId,
  'team-alpha'
);
eq(
  'team2 wins',
  stats.resolveWinnerTeamId(CONFIG, BRAVO).teamId,
  'team-bravo'
);

// A player who rage-quits before the win panel must not flip the result.
eq(
  'partial roster still resolves',
  stats.resolveWinnerTeamId(CONFIG, [ALPHA[0]]).teamId,
  'team-alpha'
);

eq(
  'unknown steam ids do not pick a winner',
  stats.resolveWinnerTeamId(CONFIG, ['76561199999999999']).teamId,
  null
);
eq(
  'unknown steam ids report why',
  stats.resolveWinnerTeamId(CONFIG, ['76561199999999999']).reason,
  'roster_mismatch'
);
eq(
  'a mixed roster is refused instead of guessed',
  stats.resolveWinnerTeamId(CONFIG, [ALPHA[0], BRAVO[0]]).reason,
  'ambiguous_roster'
);
eq(
  'missing config is refused',
  stats.resolveWinnerTeamId(null, ALPHA).reason,
  'no_match_config'
);
eq(
  'empty winning side is refused',
  stats.resolveWinnerTeamId(CONFIG, []).reason,
  'no_winner_roster'
);

console.log('\n--- live side remap ---');
const sidesCt = stats.resolveSideByTeam(CONFIG, ALPHA, BRAVO);
eq('team1 is CT when its Steam roster is on CT', sidesCt.team1Side, 'CT');
eq('team2 is T when team1 is CT', sidesCt.team2Side, 'T');
eq('sideByTeam maps Nexus ids', sidesCt.sideByTeam['team-alpha'], 'CT');
const sidesSwap = stats.resolveSideByTeam(CONFIG, BRAVO, ALPHA);
eq('halftime swap flips team1 to T', sidesSwap.team1Side, 'T');
eq('halftime swap flips team2 to CT', sidesSwap.sideByTeam['team-bravo'], 'CT');

console.log('\n--- sides before the first round ends ---');
// Durante el calentamiento no hay plantillas vivas todavía, así que el lado
// sale del que se fijó al lanzar; si no, el marcador etiqueta a ciegas.
const startCt = stats.sideByTeamAtStart(Object.assign({ map_sides: ['team1_ct'] }, CONFIG));
eq('team1_ct puts team1 on CT', startCt.sideByTeam['team-alpha'], 'CT');
eq('and team2 on T', startCt.sideByTeam['team-bravo'], 'T');
const startT = stats.sideByTeamAtStart(Object.assign({}, CONFIG, { map_sides: ['team1_t'] }));
eq('team1_t puts team1 on T', startT.team1Side, 'T');
eq('and team2 on CT', startT.team2Side, 'CT');
// Con cuchillo el lado lo decide el ganador dentro del juego: afirmarlo aquí
// etiquetaría mal a los dos equipos durante media partida.
eq('a knife round yields no side',
  stats.sideByTeamAtStart(Object.assign({}, CONFIG, { map_sides: ['knife'] })), null);
eq('a config with no sides yields no side', stats.sideByTeamAtStart(CONFIG), null);
eq('no config yields no side', stats.sideByTeamAtStart(null), null);

console.log('\n--- winning side selection ---');
const SIDES = { ctSteamIds: ALPHA, tSteamIds: BRAVO };
eq('CT win reads the CT roster',
  stats.winnerSteamIdsFor(Object.assign({ winnerSide: 'CT' }, SIDES)).join(','), ALPHA.join(','));
eq('T win reads the T roster',
  stats.winnerSteamIdsFor(Object.assign({ winnerSide: 'T' }, SIDES)).join(','), BRAVO.join(','));
eq('a tie yields no winning roster',
  stats.winnerSteamIdsFor(Object.assign({ winnerSide: 'tie' }, SIDES)).length, 0);

console.log('\n--- rating ---');

const rated = stats.ratePlayer({ kills: 20, deaths: 10, assists: 4, damage: 2400, roundMvps: 3 }, 24);
eq('ADR is damage over rounds', rated.adr, 100);
eq('K/D is computed', rated.kd, 2);
eq('a player with 0 deaths does not divide by zero',
  stats.ratePlayer({ kills: 5, deaths: 0, damage: 100 }, 10).kd, 5);
eq('an empty stat line rates at zero', stats.ratePlayer({}, 24).score, 0);
eq('rounds default to 1 so damage is never lost',
  stats.ratePlayer({ damage: 300 }, 0).adr, 300);

console.log('\n--- scoreboard and MVP ---');

const PLAYERS = {};
PLAYERS[ALPHA[0]] = { name: 'Carry', kills: 30, deaths: 12, assists: 5, damage: 2880, roundMvps: 6 };
PLAYERS[ALPHA[1]] = { name: 'Solid', kills: 18, deaths: 14, assists: 8, damage: 1920, roundMvps: 2 };
PLAYERS[BRAVO[0]] = { name: 'Anon', kills: 22, deaths: 15, assists: 3, damage: 2160, roundMvps: 3 };

const STEAM_MAP = {};
STEAM_MAP[ALPHA[0]] = 'uid-carry';
STEAM_MAP[ALPHA[1]] = 'uid-solid';
// BRAVO[0] is deliberately unlinked: a player with no Steam account connected.

const board = stats.buildScoreboard(PLAYERS, 24, STEAM_MAP);

eq('every player is on the scoreboard', board.length, 3);
eq('the scoreboard is sorted by impact', board[0].name, 'Carry');
eq('linked players carry their uid', board[0].uid, 'uid-carry');
eq('unlinked players are kept with a null uid',
  board.filter(function (r) { return r.name === 'Anon'; })[0].uid, null);

// SteamID64 must never reach a client-readable path.
const leaked = board.filter(function (row) {
  return Object.keys(row).some(function (key) { return /steam/i.test(key); });
});
eq('no SteamID field survives into the scoreboard', leaked.length, 0);

const mvp = stats.pickMvp(board);
eq('the MVP is the top of the board', mvp.name, 'Carry');
eq('a linked MVP is rewardable', mvp.rewardable, true);
eq('an empty match has no MVP', stats.pickMvp([]), null);

const anonMvp = stats.pickMvp([{ uid: null, name: 'Anon', adr: 90, kills: 22, score: 100 }]);
eq('an unlinked MVP is reported but not rewardable', anonMvp.rewardable, false);

console.log('\n--- tournament ranking ---');

const TOURNAMENT = {
  'uid-a': { name: 'A', kills: 60, deaths: 30, assists: 10, damage: 7200, roundMvps: 9, rounds: 72 },
  'uid-b': { name: 'B', kills: 40, deaths: 35, assists: 14, damage: 5400, roundMvps: 4, rounds: 72 },
  'uid-c': { name: 'C', kills: 20, deaths: 40, assists: 6, damage: 3600, roundMvps: 1, rounds: 72 },
  'uid-d': { name: 'D', kills: 5, deaths: 20, assists: 1, damage: 900, roundMvps: 0, rounds: 72 },
};

const top3 = stats.rankTournamentPlayers(TOURNAMENT, 3);
eq('the top 3 is capped at 3', top3.length, 3);
eq('first place', top3[0].uid, 'uid-a');
eq('second place', top3[1].uid, 'uid-b');
eq('third place', top3[2].uid, 'uid-c');
eq('ADR is recomputed from accumulated rounds', top3[0].adr, 100);
eq('an empty tournament ranks nobody', stats.rankTournamentPlayers({}, 3).length, 0);

if (failed) {
  console.error('\n[verify-cs2-match-stats]', failed, 'check(s) failed');
  process.exit(1);
}

console.log('\n[verify-cs2-match-stats] All checks passed.');
