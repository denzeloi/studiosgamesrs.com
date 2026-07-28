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

if (!fs.existsSync(path.join(path.dirname(indexPath), 'lib', 'hetzner.js'))) {
  fail('cs2-nexus/lib/hetzner.js missing — deploy package is incomplete');
} else {
  ok('cs2-nexus lib bundle present');
}

if (failed) {
  console.error('[verify-cs2-functions]', failed, 'check(s) failed');
  process.exit(1);
}

console.log('[verify-cs2-functions] All checks passed.');
