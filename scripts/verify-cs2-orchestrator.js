#!/usr/bin/env node
'use strict';

/**
 * La final no se queda sin servidor.
 *
 * Con dos semifinales en paralelo, la primera que termina deja su máquina
 * marcada para apagado. Media hora después acaba la otra y la final se
 * encuentra sin nada: el Commander tenía que crear una VM nueva y esperar el
 * arranque completo con los dos finalistas ya conectados a una sala vacía.
 *
 * Aquí se comprueban las dos mitades: la decisión pura del orquestador y el
 * recorrido entero por el webhook, cerrando las dos semis de un cuadro de
 * cuatro contra una base de datos de mentira. Lo que no puede pasar bajo
 * ningún concepto es que esto arranque MatchZy por su cuenta: la final la saca
 * el Commander.
 *
 *   node scripts/verify-cs2-orchestrator.js
 */

const fs = require('fs');
const path = require('path');

process.env.FIREBASE_CONFIG = JSON.stringify({
  databaseURL: 'https://verify-only.firebaseio.com',
  projectId: 'verify-only',
});
process.env.GCLOUD_PROJECT = 'verify-only';

const rootDir = path.join(__dirname, '..');
const libDir = path.join(rootDir, 'functions', 'cs2-nexus', 'lib');

const rtdb = require(path.join(libDir, 'firebase-rtdb.js'));
const stats = require(path.join(libDir, 'match-stats.js'));
const matchzy = require(path.join(libDir, 'matchzy.js'));
const verification = require(path.join(libDir, 'verification.js'));
const bracketLib = require(path.join(libDir, 'bracket.js'));
const orchestrator = require(path.join(libDir, 'orchestrator.js'));
const webhook = require(path.join(libDir, 'webhook.js'));

let failed = 0;

function ok(msg) { console.log('OK  ', msg); }
function fail(msg) { console.error('FAIL', msg); failed += 1; }
function check(cond, msg) { (cond ? ok : fail)(msg); }
function eq(label, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) ok(label);
  else fail(label + ' — esperaba ' + b + ' y llegó ' + a);
}

/* ————————————————————— La decisión, sin base de datos ————————————————————— */

const CUADRO = bracketLib.buildSingleElimBracket(['alpha', 'bravo', 'charlie', 'delta']);

function tournamentAfterFirstSemi() {
  const t = JSON.parse(JSON.stringify({ id: 't-001', name: 'Copa', bracket: CUADRO }));
  const m = t.bracket.matches;
  m.r1_m1.status = 'finished';
  m.r1_m1.winnerTeamId = m.r1_m1.teamA.teamId;
  // Lo que deja T2: la final espera al otro finalista.
  m.r2_m1.teamA = { teamId: m.r1_m1.teamA.teamId, fromMatchId: 'r1_m1' };
  m.r2_m1.status = 'waiting';
  t.liveMatches = {
    r1_m1: { status: 'finished', serverId: 'srv-a' },
    r1_m2: { status: 'live', serverId: 'srv-b' },
  };
  return t;
}

function tournamentAfterBothSemis() {
  const t = tournamentAfterFirstSemi();
  const m = t.bracket.matches;
  m.r1_m2.status = 'finished';
  m.r1_m2.winnerTeamId = m.r1_m2.teamA.teamId;
  m.r2_m1.teamB = { teamId: m.r1_m2.teamA.teamId, fromMatchId: 'r1_m2' };
  m.r2_m1.status = 'ready';
  t.liveMatches.r1_m2 = { status: 'finished', serverId: 'srv-b' };
  return t;
}

const SERVERS = {
  'srv-a': { ip: '10.0.0.1', port: 27015, gsltIndex: 0, status: 'match_complete' },
  'srv-b': { ip: '10.0.0.2', port: 27015, gsltIndex: 1, status: 'match_complete' },
};

console.log('--- primera semifinal cerrada: la máquina se guarda ---');

const retain = orchestrator.planAfterMatchEnd({
  tournament: tournamentAfterFirstSemi(),
  matchId: 'r1_m1',
  serverId: 'srv-a',
  gameServers: SERVERS,
  advance: { tournamentComplete: false, nextMatchId: 'r2_m1' },
  now: 1000,
});

eq('se retiene, no se asigna todavía', retain.action, 'retain');
eq('la máquina retenida es la de la semi que acaba de cerrar', retain.serverId, 'srv-a');
eq('y queda reservada para la final', retain.serverPatch.reservedForMatchId, 'r2_m1');
eq('el apagado programado se cancela', retain.serverPatch.shutdownAfter, null);
eq('y también su motivo', retain.serverPatch.shutdownReason, null);
// Con 'match_complete' el barrido la apagaba igual al vencer el plazo corto,
// aunque se le hubiera quitado la fecha.
eq('la máquina vuelve a contar como encendida y libre', retain.serverPatch.status, 'online');
check(!retain.liveMatchPatch, 'todavía no se cuelga nada de la final');

eq('sin máquina que retener no se inventa una',
  orchestrator.planAfterMatchEnd({
    tournament: tournamentAfterFirstSemi(), matchId: 'r1_m1', serverId: null,
    gameServers: SERVERS, advance: { nextMatchId: 'r2_m1' },
  }).reason, 'no_server');

console.log('\n--- segunda semifinal cerrada: la final se queda la máquina ---');

const assign = orchestrator.planAfterMatchEnd({
  tournament: tournamentAfterBothSemis(),
  matchId: 'r1_m2',
  serverId: 'srv-b',
  gameServers: Object.assign({}, SERVERS, {
    'srv-a': Object.assign({}, SERVERS['srv-a'], { reservedForMatchId: 'r2_m1', status: 'online' }),
  }),
  advance: { tournamentComplete: false, nextMatchId: 'r2_m1' },
  now: 2000,
});

eq('ahora sí se asigna', assign.action, 'assign');
eq('y se usa la que se reservó, no la que acaba de terminar', assign.serverId, 'srv-a');
eq('la final apunta a esa máquina', assign.liveMatchPatch.serverId, 'srv-a');
eq('con su IP', assign.liveMatchPatch.serverIp, '10.0.0.1');
eq('y su puerto', assign.liveMatchPatch.serverPort, 27015);
eq('el hueco GSLT viaja para que la concurrencia siga cuadrando',
  assign.liveMatchPatch.gsltIndex, 0);
eq('la final queda esperando saque, no en vivo', assign.liveMatchPatch.status, 'starting');
check(assign.liveMatchPatch.prewarmed === true,
  'y marcada como preparada, no como un lanzamiento a medias');
// Lo que no puede pasar: que esto empiece la partida por su cuenta.
check(!('map' in assign.liveMatchPatch),
  'no se elige mapa: eso lo hace el Commander al dar el saque');
check(!('startedAt' in assign.liveMatchPatch) && !('startingSide' in assign.liveMatchPatch),
  'ni se fija arranque ni bandos');
eq('los dos finalistas quedan identificados para avisarlos',
  assign.teamIds.length, 2);

const noReservation = orchestrator.planAfterMatchEnd({
  tournament: tournamentAfterBothSemis(),
  matchId: 'r1_m2',
  serverId: 'srv-b',
  gameServers: SERVERS,
  advance: { nextMatchId: 'r2_m1' },
});
eq('si se perdió la reserva se usa la máquina recién liberada',
  noReservation.serverId, 'srv-b');

const stillBusy = tournamentAfterBothSemis();
stillBusy.liveMatches.r1_m1 = { status: 'live', serverId: 'srv-a' };
eq('una máquina que sigue sirviendo otro cruce no se le quita',
  orchestrator.planAfterMatchEnd({
    tournament: stillBusy, matchId: 'r1_m2', serverId: 'srv-b',
    gameServers: Object.assign({}, SERVERS, {
      'srv-a': Object.assign({}, SERVERS['srv-a'], { reservedForMatchId: 'r2_m1' }),
    }),
    advance: { nextMatchId: 'r2_m1' },
  }).serverId, 'srv-b');

const taken = tournamentAfterBothSemis();
taken.liveMatches.r2_m1 = { status: 'live', serverId: 'srv-z' };
eq('una final que ya está en marcha no se toca',
  orchestrator.planAfterMatchEnd({
    tournament: taken, matchId: 'r1_m2', serverId: 'srv-b',
    gameServers: SERVERS, advance: { nextMatchId: 'r2_m1' },
  }).reason, 'already_assigned');

eq('sin IP conocida no se anuncia un servidor que nadie puede usar',
  orchestrator.planAfterMatchEnd({
    tournament: tournamentAfterBothSemis(), matchId: 'r1_m2', serverId: 'srv-b',
    gameServers: { 'srv-b': { port: 27015 } }, advance: { nextMatchId: 'r2_m1' },
  }).reason, 'no_server_ip');

console.log('\n--- la final no retiene nada: eso es otra tarea ---');

eq('con el torneo cerrado no se guarda ninguna máquina',
  orchestrator.planAfterMatchEnd({
    tournament: tournamentAfterBothSemis(), matchId: 'r2_m1', serverId: 'srv-a',
    gameServers: SERVERS, advance: { tournamentComplete: true },
  }).reason, 'tournament_complete');

const noNext = JSON.parse(JSON.stringify({ id: 't-001', bracket: CUADRO }));
delete noNext.bracket.matches.r2_m1;
noNext.bracket.matches.r1_m1.nextMatchId = null;
eq('un cruce sin siguiente ronda tampoco',
  orchestrator.planAfterMatchEnd({
    tournament: noNext, matchId: 'r1_m1', serverId: 'srv-a',
    gameServers: SERVERS, advance: {},
  }).reason, 'no_next_match');

eq('sin torneo no se decide nada',
  orchestrator.planAfterMatchEnd({ tournament: null, matchId: 'r1_m1' }).reason, 'no_context');

/* ————————————————————— El recorrido entero por el webhook ————————————————————— */

/**
 * Base de datos de mentira que sí recuerda: el segundo fin de partida tiene que
 * ver lo que dejó escrito el primero, que es justo donde vive el fallo.
 */
function installFakeDb(store) {
  const clone = function (v) { return v == null ? v : JSON.parse(JSON.stringify(v)); };
  const merge = function (target, patch) {
    Object.keys(patch || {}).forEach(function (k) {
      if (patch[k] === null) delete target[k];
      else target[k] = patch[k];
    });
  };

  rtdb.getTournament = async function () { return clone(store.tournament); };
  rtdb.writeTournament = async function (tid, data) { merge(store.tournament, data); };
  rtdb.writeBracketMatch = async function (tid, mid, data) {
    store.tournament.bracket.matches[mid] = store.tournament.bracket.matches[mid] || {};
    merge(store.tournament.bracket.matches[mid], data);
  };
  rtdb.getBracketMatch = async function (tid, mid) {
    return clone(store.tournament.bracket.matches[mid]);
  };
  rtdb.writeTournamentLiveMatch = async function (tid, mid, data) {
    store.tournament.liveMatches = store.tournament.liveMatches || {};
    store.tournament.liveMatches[mid] = store.tournament.liveMatches[mid] || {};
    merge(store.tournament.liveMatches[mid], data);
  };
  rtdb.getTournamentLiveMatch = async function (tid, mid) {
    return clone((store.tournament.liveMatches || {})[mid]);
  };
  rtdb.writeGameServer = async function (sid, data) {
    store.gameServers[String(sid)] = store.gameServers[String(sid)] || {};
    merge(store.gameServers[String(sid)], data);
  };
  rtdb.getGameServer = async function (sid) { return clone(store.gameServers[String(sid)]); };
  rtdb.writeMatchLive = async function (tid, mid, data) {
    store.matchLive[mid] = store.matchLive[mid] || {};
    merge(store.matchLive[mid], data);
  };
  rtdb.notifyTeamRosters = async function (teamIds, noticeId, payload) {
    store.notices.push({ teamIds: teamIds, id: noticeId, text: payload.text });
    return teamIds.length;
  };
  rtdb.getTeamSummary = async function (teamId) {
    return { id: teamId, name: teamId, uids: [teamId + '-uid'] };
  };
  rtdb.writeMatchResults = async function () {};

  stats.getSteamMap = async function () { return {}; };
  stats.saveMatchStats = async function () {};
  stats.accumulateTournamentStats = async function () {};
  matchzy.getStoredMatchConfig = async function () { return null; };
  verification.consumeForMatch = async function () { return { consumed: [] }; };
}

async function runFlow() {
  console.log('\n--- las dos semifinales, de principio a fin ---');

  const tournament = {
    id: 't-001',
    name: 'Copa',
    serverMode: 'dual',
    status: 'en_vivo',
    bracket: JSON.parse(JSON.stringify(CUADRO)),
    liveMatches: {
      r1_m1: { status: 'live', serverId: 'srv-a', gsltIndex: 0, serverIp: '10.0.0.1' },
      r1_m2: { status: 'live', serverId: 'srv-b', gsltIndex: 1, serverIp: '10.0.0.2' },
    },
  };
  const store = {
    tournament: tournament,
    gameServers: {
      'srv-a': { status: 'online', ip: '10.0.0.1', port: 27015, gsltIndex: 0, rconReady: true },
      'srv-b': { status: 'online', ip: '10.0.0.2', port: 27015, gsltIndex: 1, rconReady: true },
    },
    matchLive: {},
    notices: [],
  };
  installFakeDb(store);

  const alpha = tournament.bracket.matches.r1_m1.teamA.teamId;
  const charlie = tournament.bracket.matches.r1_m2.teamA.teamId;

  await webhook.processMatchEvent({
    event: 'match_end',
    tournamentId: 't-001',
    matchId: 'r1_m1',
    serverId: 'srv-a',
    winnerTeamId: alpha,
    scoreCT: 16,
    scoreT: 9,
    players: {},
  });

  const srvA = store.gameServers['srv-a'];
  eq('tras la primera semi su máquina no tiene apagado programado',
    srvA.shutdownAfter, undefined);
  eq('queda reservada para la final', srvA.reservedForMatchId, 'r2_m1');
  eq('y vuelve a figurar como encendida', srvA.status, 'online');
  eq('la final sigue esperando al otro finalista',
    store.tournament.bracket.matches.r2_m1.status, 'waiting');
  check(!(store.tournament.liveMatches || {}).r2_m1,
    'y todavía no tiene servidor colgado');
  eq('la partida que toca sigue siendo la otra semifinal',
    store.tournament.currentMatchId, 'r1_m2');
  check(!store.notices.some(function (n) { return /servidor preparado/.test(n.text); }),
    'no se avisa de un servidor listo para una final a medio cartel');

  await webhook.processMatchEvent({
    event: 'match_end',
    tournamentId: 't-001',
    matchId: 'r1_m2',
    serverId: 'srv-b',
    winnerTeamId: charlie,
    scoreCT: 16,
    scoreT: 4,
    players: {},
  });

  const finalMatch = store.tournament.bracket.matches.r2_m1;
  const finalLive = (store.tournament.liveMatches || {}).r2_m1 || {};
  eq('con las dos semis cerradas la final está lista', finalMatch.status, 'ready');
  eq('y la partida en curso pasa a ser la final', store.tournament.currentMatchId, 'r2_m1');
  eq('la final hereda la máquina que se guardó', finalLive.serverId, 'srv-a');
  eq('con su IP, para que el Commander no cree otra', finalLive.serverIp, '10.0.0.1');
  eq('esperando el saque', finalLive.status, 'starting');
  check(finalLive.prewarmed === true, 'marcada como preparada de antemano');
  check(!finalLive.map, 'sin mapa: el saque lo da el Commander');
  eq('la máquina de la otra semifinal sí se apaga a su hora',
    typeof store.gameServers['srv-b'].shutdownAfter, 'number');
  eq('la reservada sigue sin fecha de apagado',
    store.gameServers['srv-a'].shutdownAfter, undefined);
  eq('y queda apuntada al cruce de la final',
    store.gameServers['srv-a'].matchId, 'r2_m1');
  check(store.notices.some(function (n) { return /servidor preparado/.test(n.text); }),
    'ahora sí se avisa a los dos finalistas');

  // La comprobación que da nombre a todo esto.
  const warm = store.gameServers[finalLive.serverId];
  check(!!(finalLive.serverId && finalLive.serverIp && warm),
    'Hecho: el Commander puede pulsar Comenzar sin volver a crear servidor');
}

/* ————————————————————— Que el cableado siga puesto ————————————————————— */

function runWiring() {
  console.log('\n--- cableado ---');
  const src = fs.readFileSync(path.join(libDir, 'webhook.js'), 'utf8');

  check(/require\('\.\/orchestrator'\)/.test(src),
    'el webhook carga el orquestador');
  check(
    src.indexOf('bracket.handleMatchEndEvent(') !== -1 &&
    src.indexOf('bracket.handleMatchEndEvent(') < src.indexOf('orchestrator.applyAfterMatchEnd('),
    'y lo llama después de mover el cuadro, no antes'
  );
  check(/orchestrator\.applyAfterMatchEnd\(tournamentId, matchId, endServerId, advance\)/.test(src),
    'con la máquina del cruce que acaba de cerrar');
  check(/no se pudo preparar el servidor siguiente/.test(src),
    'y un fallo suyo no tumba el cierre de la partida');

  // Sin quitar los comentarios, la propia nota de "esto no lanza MatchZy"
  // haría fallar la comprobación.
  const orch = fs.readFileSync(path.join(libDir, 'orchestrator.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  check(!/launchMatch|startMatch|require\('\.\/(matchzy|rcon)'\)/i.test(orch),
    'el orquestador no arranca ninguna partida por su cuenta');
  check(/lifecycle\.cancelShutdownPatch\(\)/.test(orch),
    'cancela el apagado con la misma función que el lanzamiento');
}

async function main() {
  await runFlow();
  runWiring();

  console.log('');
  if (failed) {
    console.error(failed + ' comprobación(es) fallaron.');
    process.exit(1);
  }
  console.log('Orquestador: la final hereda una máquina caliente y nadie la lanza sola.');
}

main().catch(function (err) {
  console.error('La comprobación reventó:', err);
  process.exit(1);
});
