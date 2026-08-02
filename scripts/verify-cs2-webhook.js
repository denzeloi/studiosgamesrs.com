#!/usr/bin/env node
'use strict';

/**
 * End-to-end check of the match webhook without touching Firebase.
 *
 * Covers the path that closes a match on its own: NexusBridge posts match_end,
 * the bridge maps the winning side back to a Nexus team, credits stats to the
 * right accounts and advances the bracket. The real modules are loaded and only
 * their write calls are swapped for recorders, so the wiring between them is
 * exercised for real.
 */

const path = require('path');

// Lets firebase-admin initialise offline: firebase-rtdb.js calls admin.database()
// at require time, which needs a databaseURL but no credentials or network.
process.env.FIREBASE_CONFIG = JSON.stringify({
  databaseURL: 'https://verify-only.firebaseio.com',
  projectId: 'verify-only',
});
process.env.GCLOUD_PROJECT = 'verify-only';

const libDir = path.join(__dirname, '..', 'functions', 'cs2-nexus', 'lib');
const rtdb = require(path.join(libDir, 'firebase-rtdb.js'));
const matchzy = require(path.join(libDir, 'matchzy.js'));
const stats = require(path.join(libDir, 'match-stats.js'));
const bracket = require(path.join(libDir, 'bracket.js'));
const verification = require(path.join(libDir, 'verification.js'));
const webhook = require(path.join(libDir, 'webhook.js'));

let failed = 0;

function ok(msg) {
  console.log('OK  ', msg);
}

function eq(label, actual, expected) {
  if (actual === expected) ok(label);
  else {
    console.error('FAIL', label, '— expected', JSON.stringify(expected), 'got', JSON.stringify(actual));
    failed += 1;
  }
}

const ALPHA = ['76561190000000001', '76561190000000002', '76561190000000003'];
const BRAVO = ['76561190000000011', '76561190000000012', '76561190000000013'];

function roster(ids) {
  const players = {};
  ids.forEach(function (id, i) { players[id] = 'p' + i; });
  return players;
}

// map_sides es el lado fijado al lanzar: de ahí salen las etiquetas CT/T
// mientras la partida calienta y todavía no ha terminado ninguna ronda.
const STORED_CONFIG = {
  map_sides: ['team1_ct'],
  team1: { id: 'team-alpha', name: 'Alpha', players: roster(ALPHA) },
  team2: { id: 'team-bravo', name: 'Bravo', players: roster(BRAVO) },
};

// BRAVO[0] is deliberately absent: a player who never linked his Steam account.
// He must still show up on the scoreboard, but he cannot be credited or paid.
const STEAM_MAP = {};
STEAM_MAP[ALPHA[0]] = 'uid-a1';
STEAM_MAP[ALPHA[1]] = 'uid-a2';

const recorded = {};

// Lo que ya hay guardado del cruce. El plugin no sabe en qué servidor corre,
// así que match_end tiene que sacarlo de aquí para poder cerrarlo.
let storedLiveMatch = { serverId: 'srv-from-index', map: 'de_nuke' };

// Los dos equipos del cruce salen del cuadro: el marcador viene por bandos y
// los bandos cambian a la mitad, así que no sirven para saber a quién avisar.
let storedBracketMatch = {
  teamA: { teamId: 'team-alpha' },
  teamB: { teamId: 'team-bravo' },
};

function resetRecorder() {
  recorded.live = [];
  recorded.liveMatches = [];
  recorded.matchStats = [];
  recorded.accumulated = [];
  recorded.servers = [];
  recorded.bracket = [];
  recorded.tournaments = [];
  recorded.notices = [];
  recorded.verification = [];
  recorded.results = [];
}

function resultFor(uid) {
  const batch = recorded.results[0];
  if (!batch) return null;
  const row = batch.entries.find(function (e) { return e.uid === uid; });
  return row ? row.data : null;
}

function noticeFor(teamId) {
  return (recorded.notices || []).find(function (n) {
    return (n.teamIds || []).indexOf(teamId) !== -1;
  }) || null;
}

rtdb.writeMatchLive = async function (tournamentId, matchId, data) {
  recorded.live.push({ tournamentId: tournamentId, matchId: matchId, data: data });
};
rtdb.writeTournamentLiveMatch = async function (tournamentId, matchId, data) {
  recorded.liveMatches = recorded.liveMatches || [];
  recorded.liveMatches.push({ tournamentId: tournamentId, matchId: matchId, data: data });
};
rtdb.getTournamentLiveMatch = async function () {
  return storedLiveMatch;
};
rtdb.writeGameServer = async function (serverId, data) {
  recorded.servers.push({ serverId: serverId, data: data });
};
// El orquestador mira las máquinas del torneo al cerrar un cruce: sin esto la
// comprobación se iba a la red de verdad y se colgaba en vez de fallar.
rtdb.getGameServer = async function (serverId) {
  return { ip: '10.0.0.1', port: 27015, status: 'online', gsltIndex: 0, id: serverId };
};
rtdb.getGameServersByTournament = async function () {
  return {};
};
rtdb.writeTournament = async function (tournamentId, data) {
  recorded.tournaments.push({ tournamentId: tournamentId, data: data });
};
verification.consumeForMatch = async function (tournamentId, matchId, teamIds) {
  recorded.verification.push({ tournamentId: tournamentId, matchId: matchId, teamIds: teamIds });
  return { consumed: teamIds.map(function (id) { return { teamId: id }; }), skipped: false };
};
matchzy.getStoredMatchConfig = async function () {
  return STORED_CONFIG;
};
stats.getSteamMap = async function () {
  return STEAM_MAP;
};
stats.saveMatchStats = async function (tournamentId, matchId, data) {
  recorded.matchStats.push({ tournamentId: tournamentId, matchId: matchId, data: data });
};
stats.accumulateTournamentStats = async function (tournamentId, scoreboard) {
  recorded.accumulated.push({ tournamentId: tournamentId, scoreboard: scoreboard });
  return scoreboard.filter(function (r) { return !!r.uid; }).length;
};
bracket.handleMatchEndEvent = async function (tournamentId, matchId, payload) {
  recorded.bracket.push({ tournamentId: tournamentId, matchId: matchId, payload: payload });
  return { tournamentComplete: false, nextMatchId: 'r2_m1' };
};

rtdb.getBracketMatch = async function () {
  return storedBracketMatch;
};
rtdb.getTournament = async function () {
  return { name: 'Copa Demo', activeMap: 'de_mirage' };
};
const TEAM_SUMMARIES = {
  'team-alpha': { id: 'team-alpha', name: 'Alpha', uids: ['uid-a1', 'uid-a2'] },
  'team-bravo': { id: 'team-bravo', name: 'Bravo', uids: ['uid-b1'] },
};
rtdb.getTeamSummary = async function (teamId) {
  return TEAM_SUMMARIES[teamId] || null;
};
rtdb.writeMatchResults = async function (resultId, entries) {
  recorded.results.push({ resultId: resultId, entries: entries });
  return entries.length;
};
rtdb.notifyTeamRosters = async function (teamIds, noticeId, payload) {
  recorded.notices.push({
    teamIds: (teamIds || []).filter(Boolean),
    noticeId: noticeId,
    payload: payload,
  });
  return (teamIds || []).filter(Boolean).length;
};

// Tripwire. Any real read or write would otherwise sit in Firebase's retry loop
// forever instead of failing, which is exactly how this check first hung: a
// destructured import kept pointing at the unstubbed function.
rtdb.writeBracketMatch = async function () {
  throw new Error('unstubbed Firebase write — a dependency is not being intercepted');
};

function matchEndPayload(overrides) {
  const players = {};
  players[ALPHA[0]] = { name: 'Carry', kills: 26, deaths: 11, assists: 4, damage: 2400, roundMvps: 6 };
  players[ALPHA[1]] = { name: 'Solid', kills: 15, deaths: 13, assists: 7, damage: 1680, roundMvps: 2 };
  players[BRAVO[0]] = { name: 'Anon', kills: 19, deaths: 16, assists: 2, damage: 1920, roundMvps: 3 };

  return Object.assign({
    event: 'match_end',
    tournamentId: 't-001',
    matchId: 'r1_m1',
    serverId: 'srv-9',
    scoreCT: 13,
    scoreT: 11,
    winnerSide: 'CT',
    ctSteamIds: ALPHA,
    tSteamIds: BRAVO,
    roundsPlayed: 24,
    durationSeconds: 2100,
    players: players,
    kills: { Carry: 26, Solid: 15, Anon: 19 },
  }, overrides || {});
}

function lastLive() {
  return recorded.live[recorded.live.length - 1].data;
}

async function run() {
  console.log('\n--- match_end closes the match by itself ---');
  resetRecorder();
  await webhook.processMatchEvent(matchEndPayload());

  let live = lastLive();
  eq('the match is marked finished', live.status, 'finished');
  // Dos torneos con un 'r1_m1' en marcha escribían en el mismo sitio y se
  // pisaban el marcador: ahora cada uno cuelga del suyo.
  eq('el marcador se guarda bajo su torneo',
    recorded.live[recorded.live.length - 1].tournamentId, 't-001');
  eq('the winning side is resolved to a Nexus team', live.winnerTeamId, 'team-alpha');
  eq('the bracket is advanced', recorded.bracket.length, 1);
  eq('the bracket receives the resolved winner', recorded.bracket[0].payload.winnerTeamId, 'team-alpha');
  eq('the server is released', recorded.servers[0].data.status, 'match_complete');
  // Sin esta marca la máquina se queda encendida en Vultr hasta que alguien
  // pulsa Shutdown a mano, que es como se iba la factura de la noche.
  eq('the shutdown countdown starts',
    typeof recorded.servers[0].data.shutdownAfter, 'number');
  eq('the shutdown says why', recorded.servers[0].data.shutdownReason, 'match_complete');
  // La verificación cubre tres partidas y hasta ahora no las gastaba nadie.
  eq('la partida gasta verificación de los dos equipos',
    (recorded.verification[0] && recorded.verification[0].teamIds || []).join(','),
    'team-alpha,team-bravo');
  eq('final stats are archived', recorded.matchStats.length, 1);
  eq('tournament totals are credited', recorded.accumulated.length, 1);
  eq('only linked accounts are credited',
    recorded.accumulated[0].scoreboard.filter(function (r) { return r.uid; }).length, 2);
  eq('an unlinked player is still on the board',
    live.scoreboard.filter(function (r) { return r.uid === null; }).length, 1);

  console.log('\n--- MVP and scoreboard ---');
  eq('an MVP is chosen', live.mvp.name, 'Carry');
  eq('the MVP is linked to an account', live.mvp.uid, 'uid-a1');
  eq('the MVP can be paid automatically', live.mvp.rewardable, true);
  eq('ADR reaches the panel', live.mvp.adr, 100);
  eq('the whole scoreboard is published', live.scoreboard.length, 3);
  eq('the kill board keeps display names for the War Room', live.kills, undefined);

  const exposed = live.scoreboard.filter(function (row) {
    return Object.keys(row).some(function (k) { return /steam/i.test(k); }) ||
      Object.values(row).some(function (v) { return /^7656119\d{10}$/.test(String(v)); });
  });
  eq('no SteamID64 is published on a public path', exposed.length, 0);

  console.log('\n--- el resultado llega a la campana de los dos rosters ---');
  eq('se avisa a los dos equipos', recorded.notices.length, 2);
  eq('el ganador se entera de que ganó',
    noticeFor('team-alpha').payload.text.indexOf('Ganaste 13-11') === 0, true);
  eq('el perdedor lee su propio marcador',
    noticeFor('team-bravo').payload.text.indexOf('Perdiste 11-13') === 0, true);
  eq('el aviso lleva a la sala',
    noticeFor('team-alpha').payload.link, '/tournament-details?id=t-001');
  // Misma clave para los dos: si el webhook se reintenta, se reescribe el mismo
  // aviso en vez de llenar la campana de copias.
  eq('la clave del aviso es la del cruce',
    noticeFor('team-bravo').noticeId, 'tourend_t-001_r1_m1');

  console.log('\n--- el resultado llega a la ficha de cada jugador ---');
  // De aquí cuelgan el overlay de victoria/derrota y la EXP de torneo, que
  // escuchaban un nodo que nadie escribía.
  eq('se escribe una vez por cruce', recorded.results.length, 1);
  eq('con la clave del torneo y el cruce', recorded.results[0].resultId, 't-001_r1_m1');
  eq('a todo el roster de los dos equipos', recorded.results[0].entries.length, 3);
  eq('el ganador lo ve como victoria', resultFor('uid-a1').result, 'win');
  eq('con su marcador a favor', resultFor('uid-a1').score, '13-11');
  eq('y el nombre del rival', resultFor('uid-a1').opponentName, 'Bravo');
  eq('el perdedor lo ve como derrota', resultFor('uid-b1').result, 'loss');
  eq('con su marcador en contra', resultFor('uid-b1').score, '11-13');
  eq('el mapa sale del cruce', resultFor('uid-b1').map, 'de_nuke');
  // Sin marca de tiempo fresca welcome-overlay.js lo trata como histórico y no
  // lo enseña; sin 'result' reconocible tournamentXp.js no reparte EXP.
  eq('lleva marca de tiempo', typeof resultFor('uid-a2').at, 'number');

  console.log('\n--- a T-side win after the halftime swap ---');
  resetRecorder();
  await webhook.processMatchEvent(matchEndPayload({
    winnerSide: 'T',
    ctSteamIds: BRAVO,
    tSteamIds: ALPHA,
    scoreCT: 11,
    scoreT: 13,
  }));
  eq('the roster decides the winner, not the side', lastLive().winnerTeamId, 'team-alpha');

  console.log('\n--- an unresolvable winner never advances the bracket ---');
  resetRecorder();
  await webhook.processMatchEvent(matchEndPayload({
    ctSteamIds: ['76561199999999999'],
    tSteamIds: [],
  }));
  live = lastLive();
  eq('no winner is invented', live.winnerTeamId, null);
  eq('the reason is surfaced to the commander', live.winnerResolution, 'roster_mismatch');
  eq('the bracket stays untouched', recorded.bracket.length, 0);
  eq('stats are still archived for a manual decision', recorded.matchStats.length, 1);
  // Decirle a un equipo que perdió una partida que nadie sabe quién ganó es
  // peor que no decir nada: se avisa del final, sin repartir victoria.
  eq('se avisa una sola vez, sin ganador', recorded.notices.length, 1);
  eq('a los dos equipos a la vez', recorded.notices[0].teamIds.length, 2);
  eq('y sin decir quién ganó',
    /Ganaste|Perdiste/.test(recorded.notices[0].payload.text), false);
  // El overlay da por victoria todo lo que no diga 'loss': escribir el
  // resultado aquí le diría a los dos equipos que ganaron.
  eq('tampoco se escribe resultado por jugador', recorded.results.length, 0);

  console.log('\n--- a commander-reported winner is honoured ---');
  resetRecorder();
  await webhook.processMatchEvent(matchEndPayload({ winnerTeamId: 'team-bravo' }));
  eq('an explicit winner wins', lastLive().winnerTeamId, 'team-bravo');
  eq('the source is recorded', lastLive().winnerResolution, 'reported');

  console.log('\n--- live events still work ---');
  resetRecorder();
  await webhook.processMatchEvent({
    event: 'round_end',
    tournamentId: 't-001',
    matchId: 'r1_m1',
    round: 7,
    scoreCT: 4,
    scoreT: 3,
    durationSeconds: 540,
    ctSteamIds: ALPHA,
    tSteamIds: BRAVO,
    kills: { Carry: 8 },
    players: (function () {
      const p = {};
      p[ALPHA[0]] = { name: 'Carry', kills: 8, deaths: 3, damage: 700 };
      return p;
    })(),
  });
  live = lastLive();
  eq('the round number is the round, not the winning team', live.currentRound, 7);
  eq('the kill board is preserved by display name', live.kills.Carry, 8);
  eq('a live scoreboard is published mid-match', live.scoreboard.length, 1);
  eq('live ADR is computed', live.scoreboard[0].adr, 100);
  eq('mid-match duration is published', live.durationSeconds, 540);
  eq('team-alpha is on CT mid-match', live.sideByTeam['team-alpha'], 'CT');
  eq('team-bravo is on T mid-match', live.sideByTeam['team-bravo'], 'T');
  eq('liveMatches index is updated', (recorded.liveMatches || []).length > 0, true);

  resetRecorder();
  await webhook.processMatchEvent({
    event: 'match_start', tournamentId: 't-001', matchId: 'r1_m1', pluginVersion: '1.1.0',
  });
  eq('match_start flips the tournament live', recorded.tournaments[0].data.status, 'en_vivo');
  eq('the plugin build is recorded', lastLive().pluginVersion, '1.1.0');

  // Sin esto el marcador público pasa el calentamiento entero sin saber quién
  // juega de CT: las plantillas vivas solo llegan al cerrar cada ronda.
  live = lastLive();
  eq('sides are published from the launch config at match_start',
    live.sideByTeam['team-alpha'], 'CT');
  eq('the other team gets the opposite side', live.sideByTeam['team-bravo'], 'T');
  eq('team1Side is published too', live.team1Side, 'CT');
  eq('the duration starts at zero', live.durationSeconds, 0);
  eq('liveMatches gets the starting sides',
    recorded.liveMatches[0].data.sideByTeam['team-alpha'], 'CT');

  resetRecorder();
  await webhook.processMatchEvent({
    event: 'match_start', tournamentId: 't-001', matchId: 'r1_m1',
  });
  eq('a server still on the old DLL is flagged', lastLive().pluginVersion, 'legacy');

  console.log('\n--- a knife round leaves the sides undecided ---');
  resetRecorder();
  const realConfig = matchzy.getStoredMatchConfig;
  matchzy.getStoredMatchConfig = async function () {
    return Object.assign({}, STORED_CONFIG, { map_sides: ['knife'] });
  };
  await webhook.processMatchEvent({
    event: 'match_start', tournamentId: 't-001', matchId: 'r1_m1',
  });
  // Con cuchillo el lado lo decide el ganador dentro del juego, así que
  // inventarlo aquí etiquetaría mal a los dos equipos.
  eq('no side is invented before the knife round', lastLive().sideByTeam, undefined);
  matchzy.getStoredMatchConfig = realConfig;

  console.log('\n--- an older plugin build is tolerated ---');
  resetRecorder();
  await webhook.processMatchEvent({
    event: 'match_end',
    tournamentId: 't-001',
    matchId: 'r1_m1',
    scoreCT: 16,
    scoreT: 9,
    winnerTeamId: 'team-alpha',
  });
  live = lastLive();
  eq('a payload with no player stats does not throw', live.status, 'finished');
  eq('the winner still advances', recorded.bracket.length, 1);
  eq('rounds fall back to the score sum', live.roundsPlayed, 25);
  // Escribir null aquí borraría la duración que dejó la última ronda, y el
  // marcador final se quedaría con un guion.
  eq('a missing duration does not wipe the one already published',
    Object.prototype.hasOwnProperty.call(live, 'durationSeconds'), false);
  eq('nor in the liveMatches index',
    Object.prototype.hasOwnProperty.call(recorded.liveMatches[0].data, 'durationSeconds'), false);

  console.log('\n--- el plugin no manda serverId ---');
  resetRecorder();
  storedLiveMatch = { serverId: 'srv-from-index', map: 'de_nuke' };
  await webhook.processMatchEvent(matchEndPayload({ serverId: undefined }));
  live = lastLive();
  // Escribir serverId: null en cada evento borraba el que dejó el lanzamiento,
  // y con él la única pista para cerrar el servidor al terminar.
  eq('no se pisa el serverId del lanzamiento',
    Object.prototype.hasOwnProperty.call(live, 'serverId'), false);
  eq('el servidor se cierra igual, resuelto desde el cruce',
    recorded.servers[0].serverId, 'srv-from-index');
  eq('y queda marcado como partida completada',
    recorded.servers[0].data.status, 'match_complete');

  resetRecorder();
  storedLiveMatch = null;
  await webhook.processMatchEvent(matchEndPayload({ serverId: undefined }));
  eq('sin servidor conocido no se inventa ninguno', recorded.servers.length, 0);
  // Sin mapa en el cruce se usa el del torneo, que es el que se está jugando.
  eq('el mapa cae al del torneo', resultFor('uid-a1').map, 'de_mirage');
  storedLiveMatch = { serverId: 'srv-from-index', map: 'de_nuke' };

  console.log('\n--- una ronda sin bandos claros no borra los del arranque ---');
  resetRecorder();
  await webhook.processMatchEvent({
    event: 'round_end',
    tournamentId: 't-001',
    matchId: 'r1_m1',
    round: 3,
    scoreCT: 2,
    scoreT: 1,
    // Sin plantillas Steam no se puede saber quién es CT en esta ronda.
    kills: {},
  });
  eq('no se escribe un sideByTeam vacío en el cruce',
    Object.prototype.hasOwnProperty.call(recorded.liveMatches[0].data, 'sideByTeam'), false);

  resetRecorder();
  await webhook.processMatchEvent(matchEndPayload({
    ctSteamIds: [],
    tSteamIds: [],
    winnerTeamId: 'team-alpha',
  }));
  eq('ni al terminar la partida',
    Object.prototype.hasOwnProperty.call(recorded.liveMatches[0].data, 'sideByTeam'), false);

  let threw = false;
  try {
    await webhook.processMatchEvent({ event: 'match_end' });
  } catch (err) {
    threw = true;
  }
  eq('a payload with no matchId is rejected', threw, true);
}

// Firebase retries a failed connection indefinitely, so cap the whole run.
const guard = setTimeout(function () {
  console.error('\n[verify-cs2-webhook] timed out — something tried to reach the network');
  process.exit(1);
}, 20000);
guard.unref();

run().then(function () {
  if (failed) {
    console.error('\n[verify-cs2-webhook]', failed, 'check(s) failed');
    process.exit(1);
  }
  console.log('\n[verify-cs2-webhook] All checks passed.');
}).catch(function (err) {
  console.error('\n[verify-cs2-webhook] crashed:', err && err.stack ? err.stack : err);
  process.exit(1);
});
