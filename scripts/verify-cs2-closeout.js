#!/usr/bin/env node
'use strict';

/**
 * Cuando cae la final, ni una máquina encendida ni un premio sin entregar.
 *
 * Las dos mitades del cierre se rompen de formas distintas y silenciosas: las
 * VMs se quedaban vivas porque cada una tenía su propio motivo para no
 * apagarse (la de la final con su plazo de cortesía, la que T6 había reservado
 * con la ventana larga de ociosa, y la que se aprovisionó y nunca llegó a
 * colgarse de un cruce sin ningún motivo en absoluto); y el podio se entregaba
 * puesto a puesto, de madrugada, así que el tercero se quedaba sin marcar.
 *
 * Se comprueba la decisión del cierre, el recorrido entero por el webhook al
 * cerrar la final, y el reparto del podio ejecutando la regla tal y como está
 * escrita en el War Room.
 *
 *   node scripts/verify-cs2-closeout.js
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
const lifecycle = require(path.join(libDir, 'lifecycle.js'));
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

const CUADRO = bracketLib.buildSingleElimBracket(['alpha', 'bravo', 'charlie', 'delta']);

function torneoAcabado() {
  const t = { id: 't-001', name: 'Copa', status: 'finalizado', bracket: JSON.parse(JSON.stringify(CUADRO)) };
  const m = t.bracket.matches;
  ['r1_m1', 'r1_m2', 'r2_m1'].forEach(function (mid) {
    m[mid].status = 'finished';
    m[mid].winnerTeamId = 'alpha';
  });
  t.liveMatches = {
    r1_m1: { status: 'finished', serverId: 'srv-a' },
    r1_m2: { status: 'finished', serverId: 'srv-b' },
    r2_m1: { status: 'finished', serverId: 'srv-a' },
  };
  return t;
}

/* ————————————————————— La decisión del cierre ————————————————————— */

console.log('--- al cerrar el torneo se apaga todo lo suyo ---');

const flota = {
  'srv-a': { tournamentId: 't-001', ip: '10.0.0.1', reservedForMatchId: 'r2_m1', status: 'match_complete' },
  'srv-b': { tournamentId: 't-001', ip: '10.0.0.2', status: 'match_complete' },
  // La que se creó y nunca llegó a colgarse de un cruce: no aparece en
  // liveMatches y era la que se quedaba encendida para siempre.
  'srv-huerfano': { tournamentId: 't-001', ip: '10.0.0.3', status: 'online' },
  'srv-ajeno': { tournamentId: 't-999', ip: '10.9.9.9', status: 'online' },
};

const cierre = orchestrator.planTournamentCloseout({
  tournament: torneoAcabado(),
  tournamentId: 't-001',
  gameServers: flota,
  env: {},
  now: 5000,
});

eq('el plan es cerrar', cierre.action, 'closeout');
eq('entran las tres máquinas del torneo, incluida la que no jugó nada',
  cierre.servers.map(function (s) { return s.serverId; }).sort(),
  ['srv-a', 'srv-b', 'srv-huerfano']);
check(!cierre.servers.some(function (s) { return s.serverId === 'srv-ajeno'; }),
  'y ninguna de otro torneo');
eq('la de otro torneo queda anotada como saltada',
  (cierre.skipped[0] || {}).reason, 'other_tournament');

const patchA = (cierre.servers.filter(function (s) { return s.serverId === 'srv-a'; })[0] || {}).patch || {};
eq('el plazo vence ya, no dentro de un rato', patchA.shutdownAfter, 5000);
eq('con el motivo del cierre', patchA.shutdownReason, 'tournament_complete');
eq('y la reserva de la final se borra', patchA.reservedForMatchId, null);

// El barrido es quien apaga de verdad: lo que escribe el cierre tiene que
// bastarle para recogerla en la siguiente pasada.
eq('con eso el barrido ya la da por vencida',
  lifecycle.shutdownReasonFor(
    Object.assign({}, flota['srv-a'], patchA), 5001, {}, false
  ),
  'grace_elapsed');
eq('pero no antes de tiempo',
  lifecycle.shutdownReasonFor(
    Object.assign({}, flota['srv-a'], patchA), 4999, {}, false
  ),
  null);

const conPartidaViva = torneoAcabado();
conPartidaViva.liveMatches.r1_m2 = { status: 'live', serverId: 'srv-b' };
const cierreParcial = orchestrator.planTournamentCloseout({
  tournament: conPartidaViva, tournamentId: 't-001', gameServers: flota, env: {}, now: 5000,
});
check(!cierreParcial.servers.some(function (s) { return s.serverId === 'srv-b'; }),
  'una máquina con una partida todavía en marcha no se apaga por debajo');
eq('y se dice por qué',
  (cierreParcial.skipped.filter(function (s) { return s.serverId === 'srv-b'; })[0] || {}).reason,
  'busy');

eq('con el apagado automático desactivado a mano no se toca nada',
  orchestrator.planTournamentCloseout({
    tournament: torneoAcabado(), tournamentId: 't-001', gameServers: flota,
    env: { CS2_AUTOSHUTDOWN: '0' }, now: 5000,
  }).reason, 'autoshutdown_off');

eq('sin torneo no se decide nada',
  orchestrator.planTournamentCloseout({ tournament: null, gameServers: flota }).reason,
  'no_context');

/* ————————————————————— El recorrido por el webhook ————————————————————— */

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
  rtdb.getGameServersByTournament = async function (tid) {
    const out = {};
    Object.keys(store.gameServers).forEach(function (id) {
      if (String(store.gameServers[id].tournamentId || '') === String(tid)) {
        out[id] = clone(store.gameServers[id]);
      }
    });
    return out;
  };
  rtdb.writeMatchLive = async function () {};
  rtdb.notifyTeamRosters = async function () { return 0; };
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
  console.log('\n--- la final, de principio a fin ---');

  const bracket = JSON.parse(JSON.stringify(CUADRO));
  const m = bracket.matches;
  m.r1_m1.status = 'finished';
  m.r1_m1.winnerTeamId = m.r1_m1.teamA.teamId;
  m.r1_m2.status = 'finished';
  m.r1_m2.winnerTeamId = m.r1_m2.teamA.teamId;
  m.r2_m1.teamA = { teamId: m.r1_m1.teamA.teamId, fromMatchId: 'r1_m1' };
  m.r2_m1.teamB = { teamId: m.r1_m2.teamA.teamId, fromMatchId: 'r1_m2' };
  m.r2_m1.status = 'ready';

  const store = {
    tournament: {
      id: 't-001',
      name: 'Copa',
      serverMode: 'dual',
      status: 'en_vivo',
      currentMatchId: 'r2_m1',
      bracket: bracket,
      liveMatches: {
        r1_m1: { status: 'finished', serverId: 'srv-a' },
        r1_m2: { status: 'finished', serverId: 'srv-b' },
        r2_m1: { status: 'live', serverId: 'srv-a', serverIp: '10.0.0.1' },
      },
    },
    gameServers: {
      'srv-a': { tournamentId: 't-001', ip: '10.0.0.1', reservedForMatchId: 'r2_m1', status: 'online' },
      'srv-b': { tournamentId: 't-001', ip: '10.0.0.2', status: 'match_complete', shutdownAfter: 1 },
      'srv-huerfano': { tournamentId: 't-001', ip: '10.0.0.3', status: 'online' },
      'srv-ajeno': { tournamentId: 't-999', ip: '10.9.9.9', status: 'online' },
    },
  };
  installFakeDb(store);

  await webhook.processMatchEvent({
    event: 'match_end',
    tournamentId: 't-001',
    matchId: 'r2_m1',
    serverId: 'srv-a',
    winnerTeamId: m.r2_m1.teamA.teamId,
    scoreCT: 16,
    scoreT: 12,
    players: {},
  });

  eq('el torneo queda finalizado', store.tournament.status, 'finalizado');
  eq('con su campeón', store.tournament.championTeamId, m.r2_m1.teamA.teamId);

  const srv = store.gameServers;
  check(Number(srv['srv-a'].shutdownAfter) > 0, 'la máquina de la final tiene el apagado puesto');
  eq('con el motivo del cierre del torneo', srv['srv-a'].shutdownReason, 'tournament_complete');
  eq('y sin la reserva que le puso T6', srv['srv-a'].reservedForMatchId, undefined);
  eq('la de la otra semi también', srv['srv-b'].shutdownReason, 'tournament_complete');
  eq('y la que nunca llegó a jugar, que era la que se quedaba encendida',
    srv['srv-huerfano'].shutdownReason, 'tournament_complete');
  check(!srv['srv-ajeno'].shutdownAfter,
    'la máquina de otro torneo sigue como estaba');

  const vencidas = ['srv-a', 'srv-b', 'srv-huerfano'].filter(function (id) {
    return lifecycle.shutdownReasonFor(srv[id], Date.now() + 1000, {}, false) === 'grace_elapsed';
  });
  eq('Hecho: las tres van camino de apagarse en el siguiente barrido',
    vencidas.length, 3);
}

/* ————————————————————— El podio, de un click ————————————————————— */

const warRoomSrc = fs.readFileSync(path.join(rootDir, 'commander-warroom.js'), 'utf8')
  .replace(/\r\n/g, '\n');

function extract(name) {
  const re = new RegExp('\\n  function ' + name + '\\([\\s\\S]*?\\n  \\}\\n');
  const found = re.exec(warRoomSrc);
  if (!found) {
    fail('no se encontró la función ' + name + '() en commander-warroom.js');
    return 'function ' + name + '() { throw new Error("missing"); }';
  }
  return found[0];
}

const buildRules = new Function('state', [
  '"use strict";',
  'function num(v, d) { var n = Number(v); return isNaN(n) ? (d || 0) : n; }',
  'var PODIUM_PLACES = [',
  '  { key: "first", label: "1.er puesto" },',
  '  { key: "second", label: "2.º puesto" },',
  '  { key: "third", label: "3.er puesto" }',
  '];',
  extract('prizeForPlace'),
  extract('planPodiumPayout'),
  'return { planPodiumPayout: planPodiumPayout };',
].join('\n'));

function runPodium(t) {
  return buildRules({ tournament: t }).planPodiumPayout(t);
}

function torneoConPremios(extra) {
  return Object.assign({
    prizes: {
      cashCurrency: 'USD',
      places: {
        first: { tokens: 5000, cash: 100 },
        second: { tokens: 2500 },
        third: { tokens: 1000 },
      },
    },
    podium: {
      first: { teamId: 'alpha' },
      second: { teamId: 'bravo' },
      third: { teamId: 'charlie' },
    },
  }, extra || {});
}

function runPodiumChecks() {
  console.log('\n--- entregar el podio de un click ---');

  const todo = runPodium(torneoConPremios());
  eq('con podio y bolsa se entregan los tres puestos',
    todo.pending.map(function (p) { return p.place; }), ['first', 'second', 'third']);
  eq('cada uno con su equipo', todo.pending[0].teamId, 'alpha');
  eq('y su importe', [todo.pending[0].tokens, todo.pending[0].cash], [5000, 100]);
  eq('un puesto sin dinero no lleva importe', todo.pending[1].cash, 0);

  // Volver a pulsar no puede reescribir una entrega ni cambiarle la fecha.
  const yaPagado = runPodium(torneoConPremios({
    prizePayouts: { first: { paidAt: 1 }, second: { paidAt: 1 } },
  }));
  eq('lo ya entregado no se vuelve a entregar',
    yaPagado.pending.map(function (p) { return p.place; }), ['third']);
  eq('y se dice cuál estaba ya pagado', yaPagado.alreadyPaid.length, 2);

  const sinPodio = runPodium(torneoConPremios({ podium: {} }));
  eq('sin podio asignado no se entrega nada', sinPodio.pending.length, 0);
  eq('y los tres puestos quedan señalados como pendientes de asignar',
    sinPodio.missing.length, 3);

  const sinBolsa = runPodium(torneoConPremios({ prizes: {} }));
  eq('sin bolsa definida tampoco se registra una entrega de cero',
    sinBolsa.pending.length, 0);
  eq('y se dice que esos puestos no tienen premio', sinBolsa.noPrize.length, 3);

  const aMedias = runPodium(torneoConPremios({
    podium: { first: { teamId: 'alpha' } },
  }));
  eq('con medio podio se entrega lo que hay', aMedias.pending.length, 1);
  eq('y los otros dos quedan fuera', aMedias.missing.length, 2);
}

/* ————————————————————— Que el cableado siga puesto ————————————————————— */

function runWiring() {
  console.log('\n--- cableado ---');

  const orch = fs.readFileSync(path.join(libDir, 'orchestrator.js'), 'utf8');
  check(/tournamentComplete\)\s*\{\s*\n\s*return applyTournamentCloseout\(/.test(orch),
    'el fin de la final entra por el cierre, no por el precalentado');

  const panel = fs.readFileSync(path.join(rootDir, 'commander-panel.html'), 'utf8');
  check(/data-cwr-payout-podium/.test(panel),
    'el botón de entregar el podio está en el panel');
  check(/Entregar premios del podio/.test(panel),
    'y dice lo que hace');
  check(/commander-warroom\.js\?v=20260801closeout1/.test(panel),
    'el War Room se sirve con versión nueva, si no nadie ve el botón');

  check(/data-cwr-payout-podium/.test(warRoomSrc) && /payoutPodium\(\);/.test(warRoomSrc),
    'y el click está enganchado');
  check(/db\.ref\(\)\.update\(updates\)/.test(warRoomSrc.slice(warRoomSrc.indexOf('function payoutPodium'))),
    'las entregas se escriben en una sola operación');
  check(/servidores se están apagando/.test(warRoomSrc),
    'el Commander se entera de que las máquinas se apagan solas');
}

async function main() {
  await runFlow();
  runPodiumChecks();
  runWiring();

  console.log('');
  if (failed) {
    console.error(failed + ' comprobación(es) fallaron.');
    process.exit(1);
  }
  console.log('Cierre: ni una máquina encendida ni un premio sin entregar.');
}

main().catch(function (err) {
  console.error('La comprobación reventó:', err);
  process.exit(1);
});
