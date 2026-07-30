#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

const required = [
  'index.html',
  'login.html',
  '404.html',
  'dashboard.html',
  'competition-hub.html',
  'tournament-details.html',
  'tournament-details.css',
  'commander-panel.html',
  'cs2-bridge-config.js',
  'tournament-system.js',
  'tournament-details.js',
  'firebase.json',
];

const missing = required.filter(function (file) {
  return !fs.existsSync(path.join(root, file));
});

if (missing.length) {
  console.error('[hosting] Missing required files before deploy:');
  missing.forEach(function (file) { console.error('  -', file); });
  process.exit(1);
}

console.log('[hosting] Verified', required.length, 'critical hosting files.');
