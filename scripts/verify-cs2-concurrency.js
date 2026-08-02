#!/usr/bin/env node
'use strict';

/**
 * Comprueba el tope de partidas simultáneas por torneo (modo un servidor vs dos).
 *
 *   node scripts/verify-cs2-concurrency.js
 */

const path = require('path');
const fs = require('fs');

const concurrency = require(path.join(__dirname, '..', 'functions', 'cs2-nexus', 'lib', 'concurrency.js'));

let failed = 0;

function ok(msg) { console.log('OK  ', msg); }
function fail(msg) { console.error('FAIL', msg); failed += 1; }
function check(cond, msg) { (cond ? ok : fail)(msg); }

function tournament(mode, liveMatches) {
  return { serverMode: mode, liveMatches: liveMatches || {} };
}

// --- Modo por defecto: servidor único, aunque no haya campo en el torneo ---

check(concurrency.modeOf({}) === 'single', 'sin serverMode el torneo corre en modo servidor único');
check(concurrency.modeOf({ serverMode: 'DUAL' }) === 'dual', 'serverMode acepta mayúsculas');
check(concurrency.modeOf({ serverMode: 'triple' }) === 'single', 'un modo desconocido cae a servidor único, no a barra libre');
check(concurrency.limitOf({ serverMode: 'dual' }) === 2, 'modo dual permite dos partidas');

// --- Un servidor: la segunda partida no arranca ---

let plan = concurrency.plan(tournament('single', {}), 'r1_m1', 0);
check(plan.allowed && plan.slot === 0, 'primera partida en modo único usa el slot 0');

plan = concurrency.plan(tournament('single', { r1_m1: { status: 'live', gsltIndex: 0 } }), 'r1_m2', 1);
check(!plan.allowed, 'modo único bloquea un segundo cruce mientras el primero está vivo');
check(
  /servidor único/.test(concurrency.blockedMessage(plan, 'levantar otro servidor')) &&
  /r1_m1/.test(concurrency.blockedMessage(plan, 'levantar otro servidor')),
  'el mensaje de bloqueo dice el modo y qué cruce ocupa el servidor'
);

plan = concurrency.plan(tournament('single', { r1_m1: { status: 'live' } }), 'r1_m1', 0);
check(plan.allowed && plan.slot === 0, 'relanzar el mismo cruce no cuenta como segunda partida');

plan = concurrency.plan(tournament('single', { r1_m1: { status: 'finished' } }), 'r1_m2', 0);
check(plan.allowed, 'una partida terminada libera el servidor para el siguiente cruce');

concurrency.BUSY_STATUSES.forEach(function (status) {
  const p = concurrency.plan(tournament('single', { r1_m1: { status: status } }), 'r1_m2', 0);
  check(!p.allowed, 'estado ' + status + ' cuenta como servidor ocupado');
});

// --- Dos servidores: reparto de slot GSLT ---

plan = concurrency.plan(tournament('dual', { r1_m1: { status: 'live', gsltIndex: 0 } }), 'r1_m2', 0);
check(plan.allowed && plan.slot === 1, 'con el slot 0 ocupado el segundo cruce cae al slot 1 aunque pida el 0');

plan = concurrency.plan(tournament('dual', { r1_m1: { status: 'live', gsltIndex: 1 } }), 'r1_m2', 0);
check(plan.allowed && plan.slot === 0, 'si el ocupado es el slot 1, el nuevo cruce toma el 0');

plan = concurrency.plan(tournament('dual', {
  r1_m1: { status: 'live', gsltIndex: 0 },
  r1_m2: { status: 'starting', gsltIndex: 1 },
}), 'r2_m1', 0);
check(!plan.allowed && plan.busy.length === 2, 'con los dos servidores ocupados no cabe un tercer cruce');
check(/máximo/.test(concurrency.blockedMessage(plan, 'lanzar este cruce')), 'el bloqueo en dual habla del máximo del torneo');

// --- Las dos semifinales de un tirón: reparto y saltos ---

function bracketOf(pairs) {
  const matches = {};
  pairs.forEach(function (pair, i) {
    matches['r1_m' + (i + 1)] = {
      id: 'r1_m' + (i + 1),
      round: 1,
      teamA: pair[0] ? { teamId: pair[0] } : null,
      teamB: pair[1] ? { teamId: pair[1] } : null,
    };
  });
  matches.r2_m1 = { id: 'r2_m1', round: 2, teamA: null, teamB: null };
  return { matches };
}

function dualTournament(pairs, liveMatches) {
  return { serverMode: 'dual', bracket: bracketOf(pairs), liveMatches: liveMatches || {} };
}

const FOUR = [['a', 'b'], ['c', 'd']];

let dual = concurrency.planDualSemis(dualTournament(FOUR, {}));
check(dual.ok && dual.entries.length === 2, 'un cuadro de 4 en modo dual da dos semis que levantar');
check(
  dual.entries[0].matchId === 'r1_m1' && dual.entries[1].matchId === 'r1_m2',
  'las semis salen en orden de cuadro, no en el que devuelva la base'
);
check(
  dual.entries[0].gsltIndex === 0 && dual.entries[1].gsltIndex === 1,
  'cada semi se lleva una ranura GSLT distinta'
);

check(
  !concurrency.planDualSemis({ serverMode: 'single', bracket: bracketOf(FOUR) }).ok,
  'en modo servidor único no se levantan dos semis de una vez'
);
check(
  /servidor único/.test(concurrency.dualSemisBlockedMessage(
    concurrency.planDualSemis({ serverMode: 'single', bracket: bracketOf(FOUR) })
  )),
  'el bloqueo explica que el torneo está en modo servidor único'
);

check(
  !concurrency.planDualSemis(dualTournament([['a', 'b']], {})).ok,
  'con un solo cruce de primera ronda no hay dos semis que levantar'
);
check(
  !concurrency.planDualSemis(dualTournament([['a', 'b'], ['c', null]], {})).ok,
  'un cruce con hueco (BYE) no cuenta: no se paga una máquina donde no juega nadie'
);
check(
  !concurrency.planDualSemis({ serverMode: 'dual' }).ok,
  'sin cuadro generado no se levanta nada'
);

// Segundo clic con la primera semi ya en pie: se levanta solo la que falta.
dual = concurrency.planDualSemis(dualTournament(FOUR, {
  r1_m1: { status: 'provisioning', gsltIndex: 0, serverId: 'srv-1' },
}));
check(dual.ok, 'que una semi ya tenga servidor no tumba la petición entera');
check(dual.entries[0].skipped === 'provisioning', 'la semi que ya está levantándose se salta');
check(dual.entries[0].serverId === 'srv-1', 'el salto dice qué máquina la ocupa');
check(dual.provision.length === 1 && dual.provision[0].matchId === 'r1_m2',
  'solo se levanta la semi que falta');
check(dual.provision[0].gsltIndex === 1, 'la que falta toma la ranura libre, no la ocupada');

dual = concurrency.planDualSemis(dualTournament(FOUR, {
  r1_m1: { status: 'live', gsltIndex: 1, serverId: 'srv-9' },
}));
check(dual.provision[0].gsltIndex === 0, 'si la ocupada es la ranura 1, la que falta toma la 0');

dual = concurrency.planDualSemis(dualTournament(FOUR, {
  r1_m1: { status: 'finished', gsltIndex: 0 },
  r1_m2: { status: 'stopped', gsltIndex: 1 },
}));
check(dual.provision.length === 2, 'una semi terminada vuelve a poder levantar servidor');

// Una segunda ronda viva también gasta GSLT aunque no sea semifinal.
dual = concurrency.planDualSemis(dualTournament(FOUR, {
  r2_m1: { status: 'live', gsltIndex: 0, serverId: 'srv-3' },
}));
check(dual.provision.length === 1 && dual.provision[0].gsltIndex === 1,
  'un cruce de otra ronda en vivo se queda con su ranura');
check(dual.entries[1].blocked === true, 'sin ranura libre la segunda semi se marca bloqueada, no se pisa la ocupada');

// --- El backend tiene que usar el planificador, no repartir ranuras a mano ---

const indexDualSrc = fs.readFileSync(
  path.join(__dirname, '..', 'functions', 'cs2-nexus', 'index.js'),
  'utf8'
);
check(
  /async function provisionDualSemisCore/.test(indexDualSrc),
  'index.js expone provisionDualSemisCore'
);
check(
  /concurrency\.planDualSemis\(/.test(indexDualSrc),
  'el reparto de las dos semis sale del módulo, no de una copia suelta en index.js'
);
check(
  /case 'provisiondual':/.test(indexDualSrc),
  'la API HTTP atiende la op provisionDual'
);
check(
  /exports\.cs2ProvisionDualSemis = onCall/.test(indexDualSrc),
  'existe el callable cs2ProvisionDualSemis'
);
// Las dos provisiones tienen que ir en fila: en paralelo leerían el mismo
// estado y las dos máquinas arrancarían con el mismo token de Steam.
const dualBody = indexDualSrc.match(/async function provisionDualSemisCore[\s\S]*?\n\}/);
check(
  !!dualBody && /for \(const entry of plan\.entries\)/.test(dualBody[0]) &&
  !/Promise\.all/.test(dualBody[0]),
  'las dos semis se levantan en fila, no en paralelo repartiéndose el mismo slot'
);

const tsSrc = fs.readFileSync(path.join(__dirname, '..', 'tournament-system.js'), 'utf8');
check(
  /provisionDualSemis: provisionDualSemis/.test(tsSrc),
  'tournament-system.js publica provisionDualSemis'
);

const warroomSrc = fs.readFileSync(path.join(__dirname, '..', 'commander-warroom.js'), 'utf8');
check(
  /Creando 2 servidores para /.test(warroomSrc),
  'el War Room avisa de que va a crear dos servidores'
);
check(
  /TournamentSystem\.provisionDualSemis\(/.test(warroomSrc),
  'el botón del War Room llega a la provisión doble'
);

// --- El puntero de nivel torneo no se le quita a quien está jugando ---

check(concurrency.canClaimPrimary({}, 'srv-1'),
  'sin puntero previo la máquina nueva se queda con él');
check(concurrency.canClaimPrimary({ activeServerId: 'srv-1' }, 'srv-1'),
  'la misma máquina puede refrescar su propio puntero');
check(!concurrency.canClaimPrimary({
  activeServerId: 'srv-1',
  liveMatches: { r1_m1: { serverId: 'srv-1', status: 'live' } },
}, 'srv-2'), 'la segunda provisión no le roba la IP a la partida en juego');
check(!concurrency.canClaimPrimary({
  activeServerId: 'srv-1',
  liveMatches: { r1_m1: { serverId: 'srv-1', status: 'starting' } },
}, 'srv-2'), 'tampoco a la que está arrancando');
check(concurrency.canClaimPrimary({
  activeServerId: 'srv-1',
  liveMatches: { r1_m1: { serverId: 'srv-1', status: 'finished' } },
}, 'srv-2'), 'cuando la anterior termina, el puntero pasa a la nueva');
check(concurrency.canClaimPrimary({
  activeServerId: 'srv-1',
  liveMatches: { r1_m1: { serverId: 'srv-9', status: 'live' } },
}, 'srv-2'), 'un puntero huérfano no bloquea a nadie');

// --- Las funciones tienen que usar el módulo, no una copia suelta ---

const indexSrc = fs.readFileSync(
  path.join(__dirname, '..', 'functions', 'cs2-nexus', 'index.js'),
  'utf8'
);
check(/require\('\.\/lib\/concurrency'\)/.test(indexSrc), 'index.js carga lib/concurrency');
check(
  (indexSrc.match(/concurrency\.plan\(/g) || []).length >= 2,
  'provision y launch pasan por el mismo tope'
);
check(
  /labels: \{ tournamentId, matchId, gslt: String\(slot\) \}/.test(indexSrc),
  'la VM se etiqueta con el slot resuelto por el backend, no con el que pidió el panel'
);
check(
  (indexSrc.match(/concurrency\.canClaimPrimary\(/g) || []).length >= 3,
  'provisión, reanudación y arranque piden permiso antes de tocar el puntero del torneo'
);
// La vigilancia del arranque iba atada a activeServerId: levantar la segunda
// máquina apagaba la vigilancia de la primera a mitad del arranque.
check(
  !/activeServerId`\)\.once\('value'\)/.test(indexSrc),
  'la vigilancia de provisión ya no depende del puntero único del torneo'
);
check(
  /rtdb\.getGameServer\(String\(serverId\)\)/.test(indexSrc),
  'la vigilancia mira el registro de la propia máquina'
);

if (failed) {
  console.error('\n' + failed + ' check(s) failed');
  process.exit(1);
}
console.log('\nAll concurrency checks passed');
