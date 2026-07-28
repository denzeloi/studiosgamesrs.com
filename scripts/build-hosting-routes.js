#!/usr/bin/env node
'use strict';

/**
 * Creates /login/index.html, /dashboard/index.html, etc.
 * Source of truth: *.html at repo root. Generated dirs are gitignored.
 * Runs automatically via firebase.json predeploy and npm run hosting:build.
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

const marker = path.join(root, '.hosting-routes-built.json');

function build() {
  let built = 0;
  routes.forEach(function (route) {
    const src = path.join(root, route.file);
    if (!fs.existsSync(src)) {
      console.error('[hosting] Missing source file for route /' + route.path + ':', route.file);
      process.exit(1);
    }
    const dir = path.join(root, route.path);
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(src, path.join(dir, 'index.html'));
    built += 1;
  });

  fs.writeFileSync(
    marker,
    JSON.stringify({ builtAt: new Date().toISOString(), routes: routes.map(function (r) { return r.path; }) }, null, 2)
  );

  console.log('[hosting] Built', built, 'clean URL directories (e.g. /login → login/index.html).');
}

build();
