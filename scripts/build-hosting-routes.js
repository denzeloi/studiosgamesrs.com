#!/usr/bin/env node
'use strict';

/**
 * Verifies root *.html sources exist for Firebase Hosting rewrites.
 * Clean URLs (/login, /dashboard, …) are handled by firebase.json rewrites
 * pointing to login.html, dashboard.html, etc. No duplicate route folders.
 */

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

const routes = [
  { path: 'login', file: 'login.html' },
  { path: 'dashboard', file: 'dashboard.html' },
  { path: 'competition-hub', file: 'competition-hub.html' },
  { path: 'tournament-details', file: 'tournament-details.html' },
  { path: 'commander-panel', file: 'commander-panel.html' },
  { path: 'community', file: 'community.html' },
  { path: 'nexus', file: 'nexus.html' },
  { path: 'playzone', file: 'playzone.html' },
  { path: 'steam-login-handler', file: 'steam-login-handler.html' },
  { path: 'steam-callback', file: 'steam-callback.html' },
  { path: 'steam_bridge', file: 'steam_bridge.html' },
];

let failed = 0;

routes.forEach(function (route) {
  const src = path.join(root, route.file);
  if (!fs.existsSync(src)) {
    console.error('[hosting] Missing source for /' + route.path + ':', route.file);
    failed += 1;
  }
});

if (failed) {
  process.exit(1);
}

console.log('[hosting] Verified', routes.length, 'page sources (rewrites in firebase.json, no generated dirs).');
