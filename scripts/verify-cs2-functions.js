#!/usr/bin/env node
'use strict';

/**
 * Static checks for cs2-nexus Cloud Functions before deploy.
 * Catches typos like undefined variable references in finishProvision.
 */

const fs = require('fs');
const path = require('path');

const indexPath = path.join(__dirname, '..', 'functions', 'cs2-nexus', 'index.js');
const src = fs.readFileSync(indexPath, 'utf8');

let failed = 0;

function fail(msg) {
  console.error('FAIL', msg);
  failed += 1;
}

function ok(msg) {
  console.log('OK  ', msg);
}

if (!src.includes('const CS2_GAME_PORT')) {
  fail('Missing CS2_GAME_PORT constant in cs2-nexus/index.js');
} else {
  ok('CS2_GAME_PORT constant defined');
}

const finishMatch = src.match(/async function finishProvision[\s\S]*?\n\}/);
if (!finishMatch) {
  fail('Could not parse finishProvision()');
} else {
  const block = finishMatch[0];
  if (/serverPort:\s*port\b/.test(block) && !/\bconst port\b/.test(block) && !/CS2_GAME_PORT/.test(block.split('serverPort')[1]?.slice(0, 40) || '')) {
    fail('finishProvision() uses serverPort: port without defining port');
  } else {
    ok('finishProvision() serverPort assignment looks safe');
  }
  if (!block.includes('serverPort: CS2_GAME_PORT')) {
    fail('finishProvision() should set serverPort: CS2_GAME_PORT');
  } else {
    ok('finishProvision() writes serverPort from CS2_GAME_PORT');
  }
}

if (!fs.existsSync(path.join(path.dirname(indexPath), 'lib', 'vultr.js'))) {
  fail('cs2-nexus/lib/vultr.js missing — deploy package is incomplete');
} else {
  ok('cs2-nexus Vultr provider present');
}

if (!fs.existsSync(path.join(path.dirname(indexPath), 'lib', 'provider.js'))) {
  fail('cs2-nexus/lib/provider.js missing — deploy package is incomplete');
} else {
  ok('cs2-nexus provider facade present');
}

// --- Readiness must never be guessed before the provider can plausibly be done ---

function constMs(name) {
  const m = src.match(new RegExp('const ' + name + '\\s*=\\s*([0-9]+)\\s*\\*\\s*60\\s*\\*\\s*1000'));
  return m ? Number(m[1]) : null;
}

const graceSnapshot = constMs('BOOT_GRACE_SNAPSHOT_MS');
const graceFull = constMs('BOOT_GRACE_FULL_MS');
const timeoutSnapshot = constMs('BOOT_TIMEOUT_SNAPSHOT_MS');
const timeoutFull = constMs('BOOT_TIMEOUT_FULL_MS');

// Snapshot restore runs 20-40 min at Vultr plus 5-10 min of CS2 boot; a from-scratch
// install is 30-45 min. A grace shorter than that declares servers online while they
// are still booting, and 'online' drops them out of the reconcile pass for good.
if (graceSnapshot === null || graceFull === null) {
  fail('Boot grace windows are no longer named constants — cannot verify them');
} else if (graceSnapshot < 40) {
  fail(`Snapshot boot grace is ${graceSnapshot} min; snapshot restore alone takes up to 40`);
} else if (graceFull < 45) {
  fail(`Full-install boot grace is ${graceFull} min; a from-scratch install takes up to 45`);
} else {
  ok(`boot grace outlasts provisioning (${graceSnapshot} min snapshot, ${graceFull} min full)`);
}

if (timeoutSnapshot === null || timeoutFull === null) {
  fail('Boot timeout windows are no longer named constants — cannot verify them');
} else if (timeoutSnapshot <= graceSnapshot || timeoutFull <= graceFull) {
  // checkServerCore only reaches the timeout branch while age < grace, so a timeout
  // below the grace window can never fire.
  fail('Boot timeout is below the boot grace, making the rcon_timeout branch dead code');
} else {
  ok(`boot timeout stays above the grace window (${timeoutSnapshot} / ${timeoutFull} min)`);
}

const markOnline = src.match(/async function markOnline[\s\S]*?\n    \}/);
if (!markOnline) {
  fail('Could not parse markOnline()');
} else if (!/readyVerified:\s*reason === 'rcon' \|\| reason === 'port'/.test(markOnline[0])) {
  fail('markOnline() must record readyVerified so the panel can tell a probe from a guess');
} else {
  ok('markOnline() separates a verified server from one assumed ready by age');
}

if (!/function needsReconcile/.test(src)) {
  fail('needsReconcile() missing — unverified servers would stop being re-checked');
} else if (!/\.filter\(\(\{ gs \}\) => needsReconcile\(gs\)\)/.test(src)) {
  fail('The reconcile pass does not use needsReconcile()');
} else {
  ok('the reconcile pass keeps watching servers that never actually answered');
}

// --- El secreto del webhook: sin él, cualquiera inventa el resultado ---

const secrets = require(path.join(path.dirname(indexPath), 'lib', 'secrets.js'));

const GOOD = 'x'.repeat(secrets.MIN_LENGTH);

function eq(label, actual, expected) {
  if (actual === expected) ok(label);
  else fail(label + ' — esperaba ' + JSON.stringify(expected) + ' y llegó ' + JSON.stringify(actual));
}

eq('un secreto con cuerpo se acepta', secrets.webhookSecret({ WEBHOOK_SECRET: GOOD }), GOOD);
eq('sin variable no hay secreto', secrets.webhookSecret({}), null);
eq('la variable vacía no cuenta como secreto', secrets.webhookSecret({ WEBHOOK_SECRET: '' }), null);
eq('un secreto de tres letras tampoco', secrets.webhookSecret({ WEBHOOK_SECRET: 'abc' }), null);
eq('los espacios de más no cuelan', secrets.webhookSecret({ WEBHOOK_SECRET: '   ' }), null);
eq('la plantilla acepta el token alternativo',
  secrets.matchConfigSecret({ MATCH_CONFIG_TOKEN: GOOD }), GOOD);
eq('la cabecera vacía nunca coincide', secrets.matches('', GOOD), false);
eq('sin secreto esperado nada coincide', secrets.matches('', null), false);
eq('una cabecera ausente nunca coincide', secrets.matches(undefined, GOOD), false);
eq('el secreto correcto sí coincide', secrets.matches(GOOD, GOOD), true);
eq('uno parecido no coincide', secrets.matches(GOOD + 'y', GOOD), false);

if (!/secrets\.webhookSecret\(process\.env\)/.test(src)) {
  fail('cs2MatchWebhook ya no comprueba que el secreto exista');
} else if (!/res\.status\(503\)/.test(src)) {
  fail('Sin secreto configurado la función debe negarse, no atender a todos');
} else {
  ok('el webhook se niega a funcionar sin secreto configurado');
}

if (/secret !== process\.env\.WEBHOOK_SECRET/.test(src)) {
  fail('El webhook volvió a comparar el secreto con === (compara tiempos y acepta vacíos)');
} else {
  ok('el secreto se compara en tiempo constante');
}

if (!/secrets\.matchConfigSecret\(process\.env\)/.test(src)) {
  fail('cs2MatchConfig sirve las plantillas sin exigir token');
} else {
  ok('la plantilla del cruce exige token siempre');
}

if (!/gsltSlot: slot/.test(src)) {
  fail('provisionServerCore no le pasa la ranura al proveedor: las dos máquinas arrancarían con el mismo token de Steam');
} else {
  ok('cada máquina se levanta con el token de Steam de su ranura');
}

// --- El marcador en vivo cuelga del torneo, no de un identificador repetido ---

const warroom = fs.readFileSync(path.join(__dirname, '..', 'commander-warroom.js'), 'utf8');
const details = fs.readFileSync(path.join(__dirname, '..', 'tournament-details.js'), 'utf8');
const panel = fs.readFileSync(path.join(__dirname, '..', 'commander-panel.js'), 'utf8');
const rules = fs.readFileSync(path.join(__dirname, '..', 'database.rules.json'), 'utf8');

[
  ['la sala del jugador', details],
  ['el War Room', warroom],
  ['el panel de Commander', panel],
].forEach(function (pair) {
  const label = pair[0];
  const source = pair[1];
  if (!/partida_en_vivo\/' \+ (tournamentId|state\.tournamentId) \+ '\//.test(source)) {
    fail(label + ' sigue leyendo el marcador por identificador de cruce suelto');
  } else {
    ok(label + ' lee el marcador dentro de su torneo');
  }
});

if (!/"partida_en_vivo":[\s\S]{0,200}"\$tournamentId"/.test(rules)) {
  fail('Las reglas no contemplan el marcador anidado por torneo');
} else {
  ok('las reglas dejan leer el marcador anidado por torneo');
}

// --- The War Room clock must hide on evidence, not on a deadline ---

if (!/function serverReadyVerified/.test(warroom)) {
  fail('commander-warroom.js is missing serverReadyVerified()');
} else if (!/serverReadyVerified\(srv\)/.test(warroom)) {
  fail('serverReadyVerified() is never used to gate the ready stage');
} else {
  ok('the War Room distinguishes a confirmed server from an assumed one');
}

if (!/\|\| serverReadyVerified\(srv\)/.test(warroom)) {
  fail('The waiting clock must hide on verified readiness, not on elapsed time');
} else {
  ok('the waiting clock only disappears once the server really answers');
}

if (failed) {
  console.error('[verify-cs2-functions]', failed, 'check(s) failed');
  process.exit(1);
}

console.log('[verify-cs2-functions] All checks passed.');
