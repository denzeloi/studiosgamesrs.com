'use strict';

const { Rcon } = require('rcon-client');

const DEFAULT_TIMEOUT_MS = 5000;

function withTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise(function (_, reject) {
      setTimeout(function () {
        reject(new Error(message || 'Timed out'));
      }, ms);
    }),
  ]);
}

async function withRcon(host, port, password, fn, timeoutMs) {
  const waitMs = timeoutMs || DEFAULT_TIMEOUT_MS;
  const client = new Rcon({
    host,
    port: Number(port) || 27015,
    password,
    timeout: waitMs,
  });
  client.on('error', function () { /* socket resets during CS2 boot */ });

  return withTimeout(
    (async function () {
      await client.connect();
      try {
        return await fn(client);
      } finally {
        try {
          await client.end();
        } catch (e) {
          /* ignore */
        }
      }
    })(),
    waitMs + 2000,
    'RCON connection timed out'
  );
}

async function sendCommand(host, port, password, command, timeoutMs) {
  return withRcon(host, port, password, function (client) {
    return client.send(command);
  }, timeoutMs);
}

/**
 * Start a tournament match via MatchZy (preferred) or pug fallback.
 * Do NOT send mp_warmup_end — that fights MatchZy's warmup/ready/knife flow.
 */
async function startMatch(host, port, password, opts) {
  const options = opts || {};
  const map = options.map || 'de_mirage';
  const tournamentId = options.tournamentId;
  const matchId = options.matchId;
  const matchConfigUrl = options.matchConfigUrl;
  const matchToken = options.matchToken || process.env.WEBHOOK_SECRET || '';
  const useMatchZyLoad = !!matchConfigUrl && options.hasSteamRosters === true;

  return withRcon(host, port, password, async function (client) {
    if (tournamentId && matchId) {
      await client.send('css_nexus_setcontext ' + tournamentId + ' ' + matchId);
    }
    await client.send('hostname "Studiosgamesrs | Nexus Tournament"');
    await client.send('tv_enable 1');

    if (useMatchZyLoad) {
      // MatchZy fetches JSON and runs knife → live (no mp_warmup_end)
      var loadCmd = 'matchzy_loadmatch_url "' + matchConfigUrl + '"';
      if (matchToken) {
        loadCmd += ' "X-Match-Token" "' + matchToken + '"';
      }
      await client.send(loadCmd);
      return { ok: true, map: map, mode: 'matchzy_loadmatch_url' };
    }

    // Pug / practice match mode when Steam rosters are incomplete
    await client.send('changelevel ' + map);
    try {
      await client.send('css_match');
    } catch (e) {
      /* MatchZy may be loading after map change */
    }
    return { ok: true, map: map, mode: 'css_match_fallback' };
  }, 12000);
}

async function ping(host, port, password, timeoutMs) {
  if (!password) {
    return { ok: false, error: 'RCON password not configured' };
  }
  try {
    const response = await sendCommand(host, port, password, 'status', timeoutMs || 2500);
    return { ok: true, response: String(response).slice(0, 200) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = {
  sendCommand,
  startMatch,
  ping,
  withRcon,
  withTimeout,
};
