#!/usr/bin/env node
'use strict';

/**
 * Removes legacy generated route directories (login/, dashboard/, etc.) if present.
 * Safe to run anytime — these folders are no longer part of the deploy flow.
 */

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

const legacyDirs = [
  'login',
  'dashboard',
  'competition-hub',
  'tournament-details',
  'commander-panel',
  'community',
  'nexus',
  'playzone',
  'steam-login-handler',
  'steam-callback',
  'steam_bridge',
];

let removed = 0;

legacyDirs.forEach(function (name) {
  const dir = path.join(root, name);
  if (!fs.existsSync(dir)) return;
  fs.rmSync(dir, { recursive: true, force: true });
  removed += 1;
  console.log('[hosting] Removed legacy dir:', name + '/');
});

const marker = path.join(root, '.hosting-routes-built.json');
if (fs.existsSync(marker)) {
  fs.unlinkSync(marker);
  console.log('[hosting] Removed .hosting-routes-built.json');
}

console.log(removed ? '[hosting] Cleaned ' + removed + ' legacy route dir(s).' : '[hosting] No legacy route dirs found.');
