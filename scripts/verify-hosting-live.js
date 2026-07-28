#!/usr/bin/env node
'use strict';

const https = require('https');

const base = process.env.HOSTING_URL || 'https://studiosgamesrs.web.app';

const checks = [
  { path: '/', expectStatus: [200, 301, 302] },
  { path: '/login', expectStatus: [200] },
  { path: '/dashboard', expectStatus: [200] },
  { path: '/competition-hub', expectStatus: [200] },
  { path: '/tournament-details', expectStatus: [200] },
  { path: '/commander-panel', expectStatus: [200] },
  { path: '/tournament-details.js', expectStatus: [200] },
  { path: '/tournament-system.js', expectStatus: [200] },
  { path: '/cs2-bridge-config.js', expectStatus: [200] },
  { path: '/404.html', expectStatus: [200, 301] },
];

function head(url) {
  return new Promise(function (resolve, reject) {
    const req = https.request(url, { method: 'HEAD' }, function (res) {
      res.resume();
      resolve(res.statusCode || 0);
    });
    req.on('error', reject);
    req.setTimeout(15000, function () { req.destroy(new Error('timeout')); });
    req.end();
  });
}

(async function () {
  let failed = 0;
  for (const check of checks) {
    const url = base.replace(/\/$/, '') + check.path;
    try {
      const status = await head(url);
      const ok = check.expectStatus.includes(status);
      console.log((ok ? 'OK' : 'FAIL'), status, check.path);
      if (!ok) failed += 1;
    } catch (err) {
      console.log('FAIL', err.message, check.path);
      failed += 1;
    }
  }
  if (failed) {
    console.error('[hosting] Live verification failed (' + failed + ' checks). Run: cd repo && npm run deploy:hosting');
    process.exit(1);
  }
  console.log('[hosting] Live verification passed.');
})();
