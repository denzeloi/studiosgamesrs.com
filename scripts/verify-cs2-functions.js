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

// --- The War Room clock must hide on evidence, not on a deadline ---

const warroom = fs.readFileSync(path.join(__dirname, '..', 'commander-warroom.js'), 'utf8');

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
