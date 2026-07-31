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
 * Pushed over RCON on every launch, not only through cfg/MatchZy/config.cfg, so a
 * server that is already running or booted from an older snapshot behaves the same
 * as a freshly provisioned one. Without this, a config change would only take effect
 * on the next VM, which is 30-50 minutes away.
 *
 * The knife default matters most in the pug fallback below: that path loads no match
 * JSON, so nothing overrides it, players are not locked to a team, and the knife round
 * ends with everyone free to pick a side — which is how a launch got wedged.
 */
const SERVER_RULES_CVARS = [
  'matchzy_knife_enabled_default 0',
  'matchzy_chat_prefix "[{Gold}Studiosgamesrs{Default}]"',
  'matchzy_admin_chat_prefix "[{Red}Centinela{Default}]"',
  'matchzy_show_credits_on_match_start 0',
  'matchzy_match_start_message "{Gold}Studiosgamesrs{Default} - partida oficial en marcha. Mucha suerte."',
];

async function applyServerRules(client) {
  for (let i = 0; i < SERVER_RULES_CVARS.length; i += 1) {
    try {
      await client.send(SERVER_RULES_CVARS[i]);
    } catch (err) {
      // An older MatchZy build may not know one of these; never block the launch for it.
    }
  }
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
    await applyServerRules(client);

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
  }, 15000);
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
