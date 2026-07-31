/* tournament-details.js */
(function (global) {
  'use strict';

  if (typeof global.sgInitFirebaseApp !== 'function') {
    throw new Error('sg-firebase-init.js must load before tournament-details.js');
  }
  global.sgInitFirebaseApp();

  var db = firebase.database();
  var tournamentId = new URLSearchParams(window.location.search).get('id');
  var currentUser = null;
  var isAdmin = false;
  var isPlayer = false;
  var playerTeamId = null;
  var presenceRole = 'spectator';
  var tournamentData = null;
  var liveListener = null;
  var liveMatchesListener = null;
  var serverRegistryListener = null;
  var liveMatches = {};
  var selectedMatchId = null;
  var lastLivePayload = null;
  var durationTickTimer = null;
  var liveStartedAt = null;
  var rulesPrompted = false;
  var rosterBackfillDone = false;
  var activeServerId = null;
  var activeGameServer = null;
  var adminActionsWired = false;
  var buttonDefaults = {};
  var loadingButtonId = null;
  var statusPollTimer = null;
  var pollInFlight = false;
  var pollStarted = false;
  var ipSeenAt = null;
  var pollCount = 0;
  var provisionMode = (global.CS2_BRIDGE && global.CS2_BRIDGE.provisionMode) || 'full';
  var BOOT_GRACE_MS_SNAPSHOT = 4 * 60 * 1000;
  var BOOT_GRACE_MS_FULL = 25 * 60 * 1000;

  function getBootGraceMs() {
    return provisionMode === 'snapshot' ? BOOT_GRACE_MS_SNAPSHOT : BOOT_GRACE_MS_FULL;
  }

  function $(id) { return document.getElementById(id); }

  function getBootWaitMsg() {
    return provisionMode === 'snapshot'
      ? 'Vultr is restoring the snapshot disk, then CS2 starts (often 25–45 min total on first boot from snapshot).'
      : 'CS2 is installing on the cloud server (first install usually 30–45 min).';
  }

  function setAdminMsg(msg, isError) {
    var el = $('tdAdminMsg');
    if (el) {
      el.textContent = msg || '';
      el.style.color = isError ? '#e53935' : '#ffca3a';
    }
  }

  function storeButtonDefault(btnId) {
    var btn = $(btnId);
    if (btn && !buttonDefaults[btnId]) {
      buttonDefaults[btnId] = btn.innerHTML;
    }
  }

  function setButtonLoading(btnId, loading) {
    var btn = $(btnId);
    if (!btn) return;
    storeButtonDefault(btnId);
    if (loading) {
      loadingButtonId = btnId;
      btn.disabled = true;
      btn.classList.add('td-btn-loading');
      btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Please wait...';
    } else {
      loadingButtonId = null;
      btn.classList.remove('td-btn-loading');
      btn.innerHTML = buttonDefaults[btnId];
      updateActionButtons(tournamentData);
    }
  }

  function hasActiveServer() {
    if (activeGameServer) return true;
    return !!(tournamentData && tournamentData.activeServerId);
  }

  function getSelectedLiveMatch() {
    if (selectedMatchId && liveMatches && liveMatches[selectedMatchId]) {
      return liveMatches[selectedMatchId];
    }
    return null;
  }

  function getServerIp() {
    var lm = getSelectedLiveMatch();
    if (lm && lm.serverIp) return lm.serverIp;
    if (lastLivePayload && lastLivePayload.serverIp) return lastLivePayload.serverIp;
    if (activeGameServer && activeGameServer.ip) return activeGameServer.ip;
    return (tournamentData && tournamentData.serverIp) || null;
  }

  function getServerPort() {
    var lm = getSelectedLiveMatch();
    if (lm && lm.serverPort) return lm.serverPort;
    if (lastLivePayload && lastLivePayload.serverPort) return lastLivePayload.serverPort;
    if (activeGameServer && activeGameServer.port) return activeGameServer.port;
    return (tournamentData && tournamentData.serverPort) || 27015;
  }

  function canSeeConnect() {
    return !!(isAdmin || isPlayer);
  }

  function isServerReady() {
    var ip = getServerIp();
    return !!(ip && /^\d{1,3}(\.\d{1,3}){3}$/.test(String(ip).trim()));
  }

  function getConnectCommand() {
    if (!isServerReady()) return null;
    return 'connect ' + getServerIp() + ':' + getServerPort();
  }

  function getSteamConnectUrl() {
    if (!isServerReady()) return null;
    return 'steam://connect/' + getServerIp() + ':' + getServerPort();
  }

  function shouldShowConnectPanel() {
    return canSeeConnect() && isMatchLive() && isServerReady();
  }

  function copyConnectCommand() {
    var cmd = getConnectCommand();
    if (!cmd) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(cmd).then(function () {
        setAdminMsg('Copied to clipboard. Paste in CS2 console (~) and press Enter.');
      }).catch(function () {
        window.prompt('Copy this command (Ctrl+C), then paste in CS2 console (~):', cmd);
      });
    } else {
      window.prompt('Copy this command (Ctrl+C), then paste in CS2 console (~):', cmd);
    }
  }

  function renderConnectPanel() {
    var conn = $('tdConnectInfo');
    if (!conn) return;

    if (!canSeeConnect()) {
      conn.style.display = 'none';
      conn.innerHTML = '';
      return;
    }

    if (!isServerReady()) {
      conn.style.display = 'none';
      conn.innerHTML = '';
      return;
    }

    if (!(isMatchLive() && isServerReady())) {
      conn.style.display = 'block';
      // Un torneo cerrado no espera a nadie: mandar al jugador a esperar el
      // lanzamiento de una partida que ya no va a existir es peor que callarse.
      conn.innerHTML = isTournamentOver()
        ? '<div class="td-connect-wait"><i class="fas fa-flag-checkered"></i> ' +
          'Torneo finalizado. Ya no hay servidor al que conectarse.</div>'
        : '<div class="td-connect-wait"><i class="fas fa-hourglass-half"></i> ' +
          'Server is online. Waiting for the Commander to <strong>Launch Match</strong> before players can join.</div>';
      return;
    }

    var cmd = getConnectCommand();
    var steamUrl = getSteamConnectUrl();
    var lmUdp = getSelectedLiveMatch();
    var udpBlocked = (lmUdp && lmUdp.gameUdpOk === false) ||
      (activeGameServer && activeGameServer.gameUdpOk === false);
    conn.style.display = 'block';
    conn.innerHTML =
      (udpBlocked
        ? '<div class="td-connect-warn" style="margin-bottom:10px;"><strong>Cannot connect yet:</strong> ' +
          'The game port (UDP 27015) is blocked on this server. Tell the Commander to click ' +
          '<strong>Shutdown Server</strong> then <strong>Provision Server</strong> again.</div>'
        : '') +
      '<div style="font-size:0.75rem;color:#888;margin-bottom:6px;">Tournament server (remote — not local)</div>' +
      '<div class="td-connect" id="tdConnectCmd">' + cmd + '</div>' +
      '<div class="td-connect-actions">' +
      '<button type="button" class="td-connect-btn" id="tdBtnCopyConnect"><i class="fas fa-copy"></i> Copy command</button>' +
      (steamUrl ? '<a class="td-connect-btn" id="tdBtnSteamConnect" href="' + steamUrl + '" style="text-decoration:none;display:inline-block;">' +
        '<i class="fab fa-steam"></i> Open in Steam</a>' : '') +
      '</div>' +
      '<div class="td-connect-steps">' +
      '<strong>How to join (required):</strong><ol style="margin:8px 0 0 18px;padding:0;">' +
      '<li>In CS2: <strong>Settings → Game → Enable Developer Console (~)</strong></li>' +
      '<li>From the main menu, press <strong>~</strong> (tilde key, top-left of keyboard)</li>' +
      '<li>Click <strong>Copy command</strong> above, paste in the console, press <strong>Enter</strong></li>' +
      '<li>Do <strong>not</strong> use Play → Offline, Practice, or Community Server browser</li>' +
      '</ol></div>' +
      '<div class="td-connect-warn">' +
      '<strong>Wrong connection?</strong> If the console says <code>loopback</code> or Map is <code>&lt;empty&gt;</code>, ' +
      'you are on a <strong>local</strong> server — not the tournament. Close CS2, reopen from the main menu, and use the command above.' +
      '</div>';

    var copyBtn = $('tdBtnCopyConnect');
    if (copyBtn) {
      copyBtn.onclick = function (e) {
        e.preventDefault();
        copyConnectCommand();
      };
    }
  }

  function hydrateActiveServerFromTournament() {
    if (!tournamentData || !tournamentData.activeServerId) return;
    if (!activeGameServer) {
      activeGameServer = {
        id: String(tournamentData.activeServerId),
        ip: tournamentData.serverIp || null,
        port: tournamentData.serverPort || 27015,
        status: 'booting',
        error: null,
        createdAt: tournamentData.serverCreatedAt || null,
      };
      activeServerId = String(tournamentData.activeServerId);
      return;
    }
    if (!activeGameServer.ip && tournamentData.serverIp) {
      activeGameServer.ip = tournamentData.serverIp;
    }
    if (!activeGameServer.port && tournamentData.serverPort) {
      activeGameServer.port = tournamentData.serverPort;
    }
    if (!activeGameServer.id) {
      activeGameServer.id = String(tournamentData.activeServerId);
    }
    activeServerId = String(activeGameServer.id || tournamentData.activeServerId);
  }

  function applyServerApiResult(result, opts) {
    if (!result) return;
    opts = opts || {};
    var sid = String(result.serverId || activeServerId || (tournamentData && tournamentData.activeServerId) || '');
    if (!sid) return;
    activeServerId = sid;
    if (!activeGameServer) {
      activeGameServer = {
        id: sid,
        ip: (tournamentData && tournamentData.serverIp) || null,
        port: (tournamentData && tournamentData.serverPort) || 27015,
        status: 'booting',
        error: null,
        rconReady: false,
        portReady: false,
      };
    }
    if (result.ip) {
      activeGameServer.ip = result.ip;
      activeGameServer.port = result.port || 27015;
      if (tournamentData) {
        tournamentData.serverIp = result.ip;
        tournamentData.serverPort = result.port || 27015;
        tournamentData.activeServerId = sid;
      }
    }
    if (result.status) activeGameServer.status = result.status;
    if (result.rconOk === true) activeGameServer.rconReady = true;
    if (result.portReady === true || result.status === 'online') activeGameServer.portReady = true;
    if (result.gameUdpOk === true) activeGameServer.gameUdpOk = true;
    if (result.gameUdpOk === false) activeGameServer.gameUdpOk = false;
    if (result.playerConnectOk === true) activeGameServer.gameUdpOk = true;
    if (result.playerConnectOk === false) activeGameServer.gameUdpOk = false;
    syncServerStateFromRegistry({ skipPollRestart: !!opts.skipPollRestart });
  }

  function noteIpSeen() {
    if (isServerReady() && !ipSeenAt) ipSeenAt = Date.now();
  }

  function isBootGraceReady() {
    if (!isServerReady()) return false;
    var graceMs = getBootGraceMs();
    if (activeGameServer && activeGameServer.createdAt) {
      if (Date.now() - Number(activeGameServer.createdAt) >= graceMs) return true;
    }
    return !!(ipSeenAt && (Date.now() - ipSeenAt) >= graceMs);
  }

  function isLaunchReady() {
    if (isMatchLive()) return false;
    if (!isServerReady()) return false;
    if (!activeGameServer) hydrateActiveServerFromTournament();
    if (!activeGameServer) return false;
    if (activeGameServer.status === 'online' || activeGameServer.rconReady === true) return true;
    if (activeGameServer.portReady === true && activeGameServer.status !== 'error') return true;
    return false;
  }

  function isMatchLive() {
    if (!tournamentData) return false;
    return tournamentData.status === 'en_vivo';
  }

  function isTournamentOver() {
    return !!(tournamentData && tournamentData.status === 'finalizado');
  }

  function stopServerStatusPoll() {
    pollStarted = false;
    pollInFlight = false;
    if (statusPollTimer) {
      clearInterval(statusPollTimer);
      statusPollTimer = null;
    }
  }

  function ensureServerStatusPoll() {
    if (pollStarted || statusPollTimer) return;
    startServerStatusPoll();
  }

  function startServerStatusPoll() {
    if (!isAdmin || !activeServerId || !tournamentId) return;
    if (pollStarted || statusPollTimer) return;
    if (activeGameServer && (activeGameServer.status === 'online' || activeGameServer.status === 'error')) {
      return;
    }

    pollStarted = true;
    hydrateActiveServerFromTournament();

    async function pollOnce() {
      if (pollInFlight) return;
      if (!activeServerId || !tournamentId) {
        stopServerStatusPoll();
        return;
      }
      if (activeGameServer && (activeGameServer.status === 'online' || activeGameServer.status === 'error')) {
        stopServerStatusPoll();
        return;
      }

      pollInFlight = true;
      pollCount += 1;
      try {
        noteIpSeen();
        var result = await TournamentSystem.checkServer(tournamentId, activeServerId, { quick: true });
        applyServerApiResult(result, { skipPollRestart: true });
        if (result && (result.status === 'online' || result.rconOk || result.portReady)) {
          setAdminMsg('Server ready at ' + getServerIp() + ':' + getServerPort() + '. Click Launch Match.');
          stopServerStatusPoll();
          return;
        }
        if (result && (result.ip || isServerReady())) {
          var displayIp = result.ip || getServerIp();
          var displayPort = result.port || getServerPort();
          var mins = ipSeenAt ? Math.floor((Date.now() - ipSeenAt) / 60000) : 0;
          var readyMins = Math.ceil(getBootGraceMs() / 60000);
          if (mins >= readyMins) {
            setAdminMsg('Server at ' + displayIp + ':' + displayPort + ' — waiting for CS2 port. Click Check Readiness, then Launch Match.');
          } else {
            setAdminMsg('Server at ' + displayIp + ':' + displayPort + ' — ' + getBootWaitMsg() + ' Next check in ~20s...');
          }
        }
      } catch (e) {
        hydrateActiveServerFromTournament();
        if (isServerReady()) {
          var waitMins = ipSeenAt ? Math.floor((Date.now() - ipSeenAt) / 60000) : 0;
          setAdminMsg('Server at ' + getServerIp() + ':' + getServerPort() + ' — ' + getBootWaitMsg() +
            (waitMins > 0 ? ' (' + waitMins + ' min elapsed)' : '') + ' Next check in ~20s...');
        } else if (!isServerReady()) {
          try {
            var resumed = await TournamentSystem.resumeProvision(tournamentId, activeServerId);
            applyServerApiResult(resumed, { skipPollRestart: true });
            if (resumed && resumed.ip) {
              noteIpSeen();
              setAdminMsg('Server at ' + resumed.ip + ':27015 — CS2 starting. Checking automatically...');
            }
          } catch (resumeErr) {
            /* keep polling */
          }
        }
      } finally {
        pollInFlight = false;
      }
      if (pollCount >= 30) stopServerStatusPoll();
    }

    pollOnce();
    statusPollTimer = setInterval(pollOnce, 20000);
  }

  function updateCheckButton() {
    var btn = $('tdBtnCheck');
    if (!btn) return;
    var show = isAdmin && isServerReady() && activeGameServer &&
      activeGameServer.status !== 'online' && activeGameServer.status !== 'error';
    btn.style.display = show ? 'inline-block' : 'none';
  }

  function syncServerStateFromRegistry(opts) {
    opts = opts || {};
    if (!tournamentData) return;
    if (!activeGameServer) {
      hydrateActiveServerFromTournament();
    }
    if (!activeGameServer) {
      renderHeader(tournamentData);
      updateServerStatus(tournamentData, opts);
      updateActionButtons(tournamentData);
      updateCheckButton();
      return;
    }
    if (!activeGameServer.ip && tournamentData.serverIp) {
      activeGameServer.ip = tournamentData.serverIp;
    }
    if (!activeGameServer.port && tournamentData.serverPort) {
      activeGameServer.port = tournamentData.serverPort;
    }
    tournamentData.serverIp = activeGameServer.ip || tournamentData.serverIp || null;
    tournamentData.serverPort = activeGameServer.port || 27015;
    tournamentData.activeServerId = activeGameServer.id;
    noteIpSeen();
    renderHeader(tournamentData);
    updateServerStatus(tournamentData, opts);
    updateActionButtons(tournamentData);
    updateCheckButton();
    if (activeGameServer.status === 'online' || activeGameServer.status === 'udp_blocked') {
      stopServerStatusPoll();
    }
  }

  function updateActionButtons(t) {
    if (loadingButtonId) return;

    var btnProvision = $('tdBtnProvision');
    var btnLaunch = $('tdBtnLaunch');
    var btnShutdown = $('tdBtnShutdown');
    if (!btnProvision || !btnLaunch || !btnShutdown) return;

    storeButtonDefault('tdBtnProvision');
    storeButtonDefault('tdBtnLaunch');
    storeButtonDefault('tdBtnShutdown');

    var serverActive = hasActiveServer();
    var launchReady = isLaunchReady();
    var matchLive = isMatchLive();

    btnProvision.disabled = serverActive || matchLive;
    btnLaunch.disabled = !launchReady || matchLive;
    btnShutdown.disabled = !serverActive;

    btnProvision.classList.toggle('td-btn-disabled', serverActive || matchLive);
    btnLaunch.classList.toggle('td-btn-disabled', !launchReady || matchLive);
    btnShutdown.classList.toggle('td-btn-disabled', !serverActive);

    if (matchLive) {
      btnLaunch.innerHTML = '<i class="fas fa-circle" style="color:#4caf50;font-size:0.6rem;vertical-align:middle;margin-right:6px;"></i> Match Live';
    } else if (buttonDefaults.tdBtnLaunch) {
      btnLaunch.innerHTML = buttonDefaults.tdBtnLaunch;
    }
  }

  function clearServerDisplay() {
    stopServerStatusPoll();
    ipSeenAt = null;
    pollCount = 0;
    activeGameServer = null;
    activeServerId = null;
    if (tournamentData) {
      tournamentData.serverIp = null;
      tournamentData.serverPort = null;
      tournamentData.activeServerId = null;
      tournamentData.status = 'pendiente';
    }
    syncServerStateFromRegistry();
  }

  function updateServerStatus(t, opts) {
    opts = opts || {};
    if (!t || loadingButtonId) return;
    if (isMatchLive()) return;
    if (activeGameServer && activeGameServer.status === 'error') {
      setAdminMsg('Provisioning failed: ' + (activeGameServer.error || 'Unknown error') + '. Shut down and try Provision again.', true);
      return;
    }
    if (isServerReady()) {
      var ip = getServerIp();
      var port = getServerPort();
      if (activeGameServer && activeGameServer.status === 'online') {
        if (activeGameServer.gameUdpOk === false) {
          setAdminMsg('RCON works but UDP 27015 is blocked — players cannot connect. Shutdown and Provision a new server.', true);
        } else if (activeGameServer.rconReady === false) {
          setAdminMsg('Server online at ' + ip + ':' + port + ' — CS2 is up. Click Launch Match (RCON will connect on launch).');
        } else {
          setAdminMsg('Server ready at ' + ip + ':' + port + '. Click Launch Match.');
        }
        return;
      }
      if (activeGameServer && activeGameServer.status === 'udp_blocked') {
        setAdminMsg('Game port UDP 27015 blocked on ' + ip + '. Shutdown → Provision again to fix firewall.', true);
        return;
      }
      if (activeGameServer && activeGameServer.status === 'booting') {
        setAdminMsg('Server at ' + ip + ':' + port + ' — ' + getBootWaitMsg() + ' Checking automatically every 20s...');
        if (!opts.skipPollRestart) ensureServerStatusPoll();
        return;
      }
      if (activeGameServer && activeGameServer.status === 'rcon_timeout') {
        setAdminMsg('Server at ' + ip + ':' + port + ' — CS2 install is taking longer than usual. Use Check Readiness when ready.');
        return;
      }
      setAdminMsg('Server at ' + ip + ':' + port + ' — ' + getBootWaitMsg() + ' Checking automatically every 20s...');
      if (!opts.skipPollRestart) ensureServerStatusPoll();
      return;
    }
    if (hasActiveServer()) {
      var sid = (activeGameServer && activeGameServer.id) ||
        activeServerId ||
        (t && t.activeServerId) ||
        'unknown';
      setAdminMsg('Server provisioning in progress (ID: ' + sid + '). Waiting for IP address (usually 2–5 minutes)...');
      return;
    }
    // Stale IP left after shutdown — activeServerId is cleared in Firebase on shutdown.
    if (t.serverIp && !t.activeServerId) {
      setAdminMsg('Previous server was shut down. Click Provision Server to start a new one.');
      return;
    }
    setAdminMsg('');
  }

  function formatDuration(seconds) {
    var n = Number(seconds);
    if (seconds == null || !isFinite(n) || n < 0) return '—';
    var m = Math.floor(n / 60);
    var s = Math.floor(n % 60);
    return m + 'm ' + s + 's';
  }

  function renderFrags(kills) {
    var tbody = $('tdKillsBody');
    var table = $('tdKillsTable');
    var empty = $('tdFragsEmpty');
    if (!tbody || !table) return;
    var players = kills && typeof kills === 'object' ? Object.keys(kills) : [];
    if (!players.length) {
      table.style.display = 'none';
      if (empty) empty.style.display = 'block';
      return;
    }
    table.style.display = 'table';
    if (empty) empty.style.display = 'none';
    players.sort(function (a, b) { return toNum(kills[b]) - toNum(kills[a]); });
    tbody.innerHTML = players.map(function (player, idx) {
      var medal = idx === 0 ? '🥇 ' : idx === 1 ? '🥈 ' : idx === 2 ? '🥉 ' : '';
      return '<tr><td>' + medal + escHtml(player) + '</td><td>' + toNum(kills[player]) + ' kills</td></tr>';
    }).join('');
  }

  /**
   * Estadísticas de la partida: lo que el servidor ya publica por jugador.
   *
   * Mientras solo hay bajas (plugin viejo, o partida recién arrancada) se sigue
   * enseñando la lista de siempre; en cuanto llega la tabla completa manda esa,
   * porque decir solo las bajas de un jugador que murió doce veces engaña.
   */
  function renderMatchStats(live) {
    var rows = live && Array.isArray(live.scoreboard) ? live.scoreboard : [];
    var title = $('tdFragsTitle');
    var table = $('tdStatsTable');
    var body = $('tdStatsBody');
    var killsTable = $('tdKillsTable');
    var empty = $('tdFragsEmpty');

    renderMvp(live && (live.mvp || null));

    if (!table || !body || !rows.length) {
      if (table) table.style.display = 'none';
      if (title) title.textContent = 'Top Fraggers';
      renderFrags(live && live.kills);
      return;
    }

    if (killsTable) killsTable.style.display = 'none';
    if (empty) empty.style.display = 'none';
    if (title) title.textContent = 'Estadísticas de la partida';
    table.style.display = 'table';
    body.innerHTML = rows.map(function (row) {
      var mine = currentUser && row.uid && row.uid === currentUser.uid;
      return '<tr' + (mine ? ' class="is-you"' : '') + '>' +
        '<td class="td-stats-name">' + escHtml(row.name || '—') +
        (mine ? ' <b>· tú</b>' : '') + '</td>' +
        '<td>' + toNum(row.kills) + '</td>' +
        '<td>' + toNum(row.deaths) + '</td>' +
        '<td>' + toNum(row.assists) + '</td>' +
        '<td>' + toNum(row.adr) + '</td>' +
        '<td class="td-stats-score">' + toNum(row.score) + '</td>' +
        '</tr>';
    }).join('');
  }

  function renderMvp(mvp) {
    var box = $('tdMvp');
    if (!box) return;
    if (!mvp || !mvp.name) {
      box.hidden = true;
      box.innerHTML = '';
      return;
    }
    box.hidden = false;
    box.innerHTML =
      '<i class="fas fa-star td-mvp-icon"></i>' +
      '<div class="td-mvp-body">' +
        '<span class="td-mvp-label">MVP de la partida</span>' +
        '<span class="td-mvp-name">' + escHtml(mvp.name) + '</span>' +
      '</div>' +
      '<div class="td-mvp-stats">' +
        '<span>' + toNum(mvp.kills) + ' bajas</span>' +
        '<span>' + toNum(mvp.adr) + ' ADR</span>' +
      '</div>';
  }

  function renderTeams(t) {
    var list = $('tdTeams');
    if (!list) return;
    list.innerHTML = '';
    var teams = t.registeredTeams || {};
    var ids = Object.keys(teams);
    if (!ids.length) {
      list.innerHTML = '<li class="td-team-pending">Aún no hay equipos inscritos.</li>';
      return;
    }
    var rosters = t.registeredRosters || {};
    var target = toNum(t.playersPerTeam) ||
      (global.SGTournamentRoster ? global.SGTournamentRoster.DEFAULT_TEAM_SIZE : 5);

    list.innerHTML = ids.map(function (id) {
      var entry = rosters[id];
      var players = global.SGTournamentRoster ? global.SGTournamentRoster.playersOf(entry) : [];
      var name = (entry && entry.name) || tName(id);
      var mine = playerTeamId === id;
      var pending = players.filter(function (p) { return p.steam === false; }).length;

      var body = players.length
        ? '<div class="td-team-players">' + players.map(function (p) {
            var you = currentUser && p.uid === currentUser.uid;
            return '<span class="td-team-player' + (you ? ' is-you' : '') +
              (p.steam === false ? ' no-steam' : '') + '">' +
              '<i class="fas ' + (p.role === 'Captain' ? 'fa-crown' : 'fa-user') + '"></i>' +
              escHtml(p.nick) + (you ? ' <b>· tú</b>' : '') + '</span>';
          }).join('') + '</div>'
        // Equipos inscritos antes de que existiera la foto del roster: el
        // capitán la rellena solo al entrar (ver backfillOwnRoster).
        : '<p class="td-team-pending">Roster sin publicar todavía.</p>';

      // Lo de Steam solo le sirve a quien puede arreglarlo.
      var warn = (pending && (isAdmin || mine))
        ? '<p class="td-team-warn"><i class="fas fa-exclamation-triangle"></i> ' + pending +
          ' sin Steam vinculado</p>'
        : '';

      return '<li class="td-team' + (mine ? ' is-mine' : '') + '" data-team-id="' + escHtml(id) + '">' +
        '<div class="td-team-head">' +
          '<span class="td-team-name">' + escHtml(name) + '</span>' +
          (players.length
            ? '<span class="td-team-count">' + players.length + '/' + target + '</span>'
            : '') +
        '</div>' + body + warn +
      '</li>';
    }).join('');
  }

  /**
   * Un equipo pudo inscribirse antes de que se guardara la foto del roster, o
   * cambiar de jugadores después. Solo el capitán puede escribirla, así que se
   * intenta al entrar él y el resto lo ve en cuanto llega el evento de RTDB.
   */
  function backfillOwnRoster() {
    if (rosterBackfillDone || !currentUser || !tournamentId || !tournamentData) return;
    if (!global.SGTournamentRoster) return;
    rosterBackfillDone = true;
    Object.keys(tournamentData.registeredTeams || {}).forEach(function (id) {
      global.SGTournamentRoster.ensureSnapshot(tournamentId, id, currentUser.uid);
    });
  }

  function orderedBracketMatchIds(matches) {
    return Object.keys(matches || {}).sort(function (a, b) {
      var ma = matches[a] || {};
      var mb = matches[b] || {};
      var ra = toNum(ma.round);
      var rb = toNum(mb.round);
      if (ra !== rb) return ra - rb;
      return toNum(String(a).split('_m')[1]) - toNum(String(b).split('_m')[1]);
    });
  }

  function isMatchLiveId(mid, t) {
    if (!mid) return false;
    if (selectedMatchId === mid) return true;
    if ((t.activeMatchId || t.currentMatchId) === mid) return true;
    var lm = liveMatches && liveMatches[mid];
    return !!(lm && (lm.status === 'live' || lm.status === 'starting'));
  }

  function renderBracket(t) {
    var box = $('tdBracket');
    if (!box) return;
    var bracket = t.bracket;
    if (!bracket || !bracket.matches) {
      box.textContent = 'El cuadro se genera cuando el Commander siembra el bracket (2+ equipos).';
      return;
    }
    var matches = bracket.matches;
    var rounds = toNum(bracket.rounds) || 1;
    var ordered = orderedBracketMatchIds(matches);
    var cols = [];

    for (var r = 1; r <= rounds; r += 1) {
      /* eslint-disable no-loop-func */
      var ids = ordered.filter(function (mid) {
        return toNum(matches[mid].round) === r && !matches[mid].bye;
      });
      /* eslint-enable no-loop-func */
      cols.push(
        '<div class="td-bracket-col">' +
          '<div class="td-bracket-col-title">' + escHtml(roundName(r, rounds)) + '</div>' +
          ids.map(function (mid) {
            var m = matches[mid];
            var live = isMatchLiveId(mid, t);
            var done = m.status === 'finished';
            var a = m.teamA && m.teamA.teamId;
            var b = m.teamB && m.teamB.teamId;
            var lm = (liveMatches && liveMatches[mid]) || null;
            var mapName = (lm && lm.map) || m.map || null;
            // Un cruce en vivo se puede abrir en el marcador; el resto es
            // informativo, así que solo esos llevan foco y cursor de acción.
            var pick = live && mid !== selectedMatchId;
            var cls = 'td-bracket-match' +
              (live ? ' live active' : '') +
              (done ? ' done' : '') +
              (live && mid === selectedMatchId ? ' is-selected' : '') +
              (pick ? ' is-pickable' : '');
            var state = done
              ? 'Final'
              : (live ? '<span class="live-tag">EN VIVO</span>' : 'Pendiente');
            var scoreA = m.score && m.score.a != null ? m.score.a : '';
            var scoreB = m.score && m.score.b != null ? m.score.b : '';
            // El equipo que no gana se atenúa: así se lee de un vistazo quién
            // sigue vivo en el cuadro.
            var sideCls = function (teamId) {
              if (!done || !m.winnerTeamId) return '';
              return m.winnerTeamId === teamId ? ' win' : ' lost';
            };
            return '<div class="' + cls + '" data-match-id="' + escHtml(mid) + '"' +
                (pick ? ' role="button" tabindex="0" title="Ver este cruce en el marcador"' : '') + '>' +
              '<div class="td-bracket-match-meta">' +
                '<span>' + escHtml(matchLabel(mid)) + '</span>' +
                '<span>' + state + '</span>' +
              '</div>' +
              '<div class="td-bracket-side' + sideCls(a) + '">' +
                '<span>' + escHtml(tName(a)) + '</span><span>' + escHtml(scoreA) + '</span></div>' +
              '<div class="td-bracket-side' + sideCls(b) + '">' +
                '<span>' + escHtml(tName(b)) + '</span><span>' + escHtml(scoreB) + '</span></div>' +
              (mapName
                ? '<div class="td-bracket-match-map"><i class="fas fa-map"></i>' +
                  escHtml(prettyMapName(mapName)) + '</div>'
                : '') +
              '</div>';
          }).join('') +
        '</div>'
      );
    }

    cols.push(
      '<div class="td-bracket-col">' +
        '<div class="td-bracket-col-title">Campeón</div>' +
        '<div class="td-bracket-champ">' +
          '<i class="fas fa-crown"></i>' +
          '<div class="td-bracket-champ-name">' +
            escHtml(t.championTeamId ? tName(t.championTeamId) : 'Por decidir') +
          '</div>' +
        '</div>' +
      '</div>'
    );

    box.innerHTML = '<div class="td-bracket">' + cols.join('') + '</div>';

    Array.prototype.forEach.call(box.querySelectorAll('.is-pickable'), function (card) {
      var open = function () { selectMatch(card.getAttribute('data-match-id')); };
      card.addEventListener('click', open);
      card.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open();
        }
      });
    });
  }

  /** "r2_m3" es lenguaje de bracket; el público lee "Cruce 3". */
  function matchLabel(mid) {
    var n = String(mid || '').split('_m')[1];
    return n ? 'Cruce ' + n : String(mid || '');
  }

  function renderMeta(t) {
    var el = $('tdMeta');
    if (!el) return;
    el.innerHTML =
      '<strong>Game:</strong> ' + (t.game || 'cs2').toUpperCase() +
      '<br><strong>ID:</strong> <code style="font-size:0.75rem;">' + tournamentId + '</code>';
  }

  // ---------------------------------------------------------------------------
  // Hero: banner del torneo, tarjeta de informacion y compartir
  // ---------------------------------------------------------------------------

  function statusLabel(status) {
    if (status === 'en_vivo') return 'En vivo';
    if (status === 'finalizado') return 'Finalizado';
    return 'Pendiente';
  }

  function infoRow(label, value, valueClass) {
    return '<div class="td-info-row"><span class="td-info-row-label">' + escHtml(label) + '</span>' +
      '<span class="td-info-row-value' + (valueClass ? ' ' + valueClass : '') + '">' + escHtml(value) + '</span></div>';
  }

  function renderInfoRows(t) {
    var box = $('tdInfoRows');
    if (!box) return;
    var teams = Object.keys(t.registeredTeams || {}).length;
    var maxTeams = toNum(t.maxTeams);
    var prizes = t.prizes || {};
    var tokenPool = toNum(prizes.tokenPool) || toNum(t.prizePool);
    var entryFee = toNum(prizes.entryFee) || toNum(t.entryFee);

    box.innerHTML =
      infoRow('Estado', statusLabel(t.status), t.status === 'en_vivo' ? 'td-live-value' : '') +
      infoRow('Inicia', t.schedule ? fmtLocalDateTime(t.schedule) : 'Por definir') +
      infoRow('Premio Base', tokenPool.toLocaleString('es-ES') + ' Tokens') +
      infoRow('Inscripción', entryFee ? entryFee.toLocaleString('es-ES') + ' Tokens' : 'Gratis') +
      infoRow('Equipos', teams + (maxTeams ? ' / ' + maxTeams : '')) +
      infoRow('Región', t.region || 'LATAM') +
      infoRow('Modalidad', t.format || 'SingleElim');
  }

  function renderBanner(t) {
    var box = $('tdBanner');
    var sub = $('tdBannerName');
    if (!box) return;
    if (sub) {
      var bits = [];
      if (t.format) bits.push(String(t.format));
      if (t.region) bits.push(String(t.region));
      if (t.schedule) bits.push(fmtLocalDateTime(t.schedule));
      sub.textContent = bits.length ? bits.join(' · ') : 'Torneo oficial Studiosgamesrs';
    }
    if (t.bannerUrl) {
      box.style.backgroundImage = 'url("' + t.bannerUrl + '")';
      box.classList.add('has-photo');
    } else {
      box.style.backgroundImage = 'none';
      box.classList.remove('has-photo');
    }
  }

  function wireBannerUpload() {
    var input = $('tdBannerInput');
    var label = $('tdBannerUploadLabel');
    if (!input || input.dataset.wired) return;
    input.dataset.wired = '1';

    input.addEventListener('change', function () {
      var file = input.files && input.files[0];
      if (!file || !tournamentId) return;
      if (!/^image\//.test(file.type)) {
        setAdminMsg('Elige un archivo de imagen.', true);
        return;
      }
      var ext = (file.name.split('.').pop() || 'jpg').toLowerCase();
      if (label) {
        label.classList.add('uploading');
        label.querySelector('span').textContent = 'Subiendo...';
      }
      var storageRef = firebase.storage().ref('tournament_banners/' + tournamentId + '/banner.' + ext);
      storageRef.put(file).then(function (snapshot) {
        return snapshot.ref.getDownloadURL();
      }).then(function (url) {
        return db.ref('tournaments/' + tournamentId).update({ bannerUrl: url });
      }).then(function () {
        setAdminMsg('Foto del torneo actualizada.');
      }).catch(function (err) {
        setAdminMsg((err && err.message) || 'No se pudo subir la foto.', true);
      }).finally(function () {
        if (label) {
          label.classList.remove('uploading');
          label.querySelector('span').textContent = 'Subir foto';
        }
        input.value = '';
      });
    });
  }

  function shareUrls() {
    var url = window.location.href;
    var text = 'Mira el torneo ' + ((tournamentData && tournamentData.name) || 'Studiosgamesrs') + ' en Studiosgamesrs';
    return {
      url: url,
      twitter: 'https://twitter.com/intent/tweet?text=' + encodeURIComponent(text) + '&url=' + encodeURIComponent(url),
      whatsapp: 'https://wa.me/?text=' + encodeURIComponent(text + ' ' + url)
    };
  }

  function wireShareButtons() {
    var tw = $('tdShareTwitter');
    var wa = $('tdShareWhatsapp');
    var link = $('tdShareLink');
    if (tw && !tw.dataset.wired) {
      tw.dataset.wired = '1';
      tw.addEventListener('click', function () { window.open(shareUrls().twitter, '_blank', 'noopener'); });
    }
    if (wa && !wa.dataset.wired) {
      wa.dataset.wired = '1';
      wa.addEventListener('click', function () { window.open(shareUrls().whatsapp, '_blank', 'noopener'); });
    }
    if (link && !link.dataset.wired) {
      link.dataset.wired = '1';
      link.addEventListener('click', function () {
        var url = shareUrls().url;
        var icon = link.querySelector('i');
        var restore = function () { if (icon) icon.className = 'fas fa-link'; };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(url).then(function () {
            if (icon) icon.className = 'fas fa-check';
            setTimeout(restore, 1500);
          }).catch(function () { window.prompt('Copia el enlace:', url); });
        } else {
          window.prompt('Copia el enlace:', url);
        }
      });
    }
  }

  var chatBooted = false;

  function wireTabs() {
    var tabInfo = $('tdTabInfo');
    var tabChat = $('tdTabChat');
    var body = $('tdBody');
    if (!tabInfo || !tabChat || tabInfo.dataset.wired) return;
    tabInfo.dataset.wired = '1';

    // Desktop shows arena + chat together; mobile tabs only flip which pane is visible.
    function activate(tab) {
      var isChat = tab === 'chat';
      tabInfo.classList.toggle('active', !isChat);
      tabChat.classList.toggle('active', isChat);
      tabInfo.setAttribute('aria-selected', String(!isChat));
      tabChat.setAttribute('aria-selected', String(isChat));
      if (body) body.classList.toggle('td-show-chat', isChat);
      bootTournamentChat();
    }

    tabInfo.addEventListener('click', function () { activate('info'); });
    tabChat.addEventListener('click', function () { activate('chat'); });
    bootTournamentChat();
  }

  function updateChatPresence(count) {
    if (window.SGCampfire && typeof window.SGCampfire.refreshPresence === 'function') {
      window.SGCampfire.refreshPresence(count);
    }
    var badge = $('tdChatCount');
    if (badge) {
      badge.textContent = count > 0 ? String(count) : '';
      badge.classList.toggle('show', count > 0);
    }
  }

  function bootTournamentChat() {
    if (chatBooted || !tournamentId) return;
    if (!window.SGCampfire || typeof window.SGCampfire.boot !== 'function') return;
    chatBooted = true;
    window.SGCampfire.boot({ node: 'tournamentChats', room: tournamentId });
  }

  function openSettingsModal() {
    var modal = $('tdSettingsModal');
    if (modal) modal.style.display = 'flex';
  }

  function closeSettingsModal() {
    var modal = $('tdSettingsModal');
    if (modal) modal.style.display = 'none';
  }

  function wireSettingsButton() {
    var btn = $('tdSettingsBtn');
    var close = $('tdSettingsClose');
    var modal = $('tdSettingsModal');
    if (!btn) return;
    btn.classList.toggle('locked', !isAdmin);

    if (!btn.dataset.wired) {
      btn.dataset.wired = '1';
      btn.addEventListener('click', function () {
        if (!isAdmin) {
          toastLocked();
          return;
        }
        openSettingsModal();
      });
    }
    if (close && !close.dataset.wired) {
      close.dataset.wired = '1';
      close.addEventListener('click', closeSettingsModal);
    }
    if (modal && !modal.dataset.wired) {
      modal.dataset.wired = '1';
      modal.addEventListener('click', function (e) {
        if (e.target === modal) closeSettingsModal();
      });
    }
  }

  function toastLocked() {
    var btn = $('tdSettingsBtn');
    if (!btn) return;
    var original = btn.innerHTML;
    btn.innerHTML = '<i class="fas fa-lock"></i> Solo Commander';
    setTimeout(function () {
      btn.innerHTML = original;
      btn.classList.toggle('locked', !isAdmin);
    }, 1800);
  }

  function prettyMapName(map) {
    if (!map) return 'Por definir';
    return String(map).replace(/^de_/, '').replace(/_/g, ' ').toUpperCase();
  }

  function renderMapWidget(t) {
    var widget = $('tdMapWidget');
    var visual = $('tdMapVisual');
    var nameEl = $('tdMapWidgetName');
    if (!widget || !visual || !nameEl) return;
    var lm = getSelectedLiveMatch();
    var map = (lm && lm.map) || (lastLivePayload && lastLivePayload.map) || (t && t.activeMap) || null;
    if (!map && t && t.bracket && t.bracket.matches) {
      var mid = selectedMatchId || t.activeMatchId || t.currentMatchId;
      var m = mid && t.bracket.matches[mid];
      if (m && m.map) map = m.map;
    }
    // Con dos partidas a la vez el mapa por sí solo es ambiguo: se dice de qué
    // cruce se está hablando, que es el mismo que muestra el marcador.
    var kicker = widget.querySelector('.td-map-widget-kicker');
    if (kicker) {
      var liveIds = Object.keys(liveMatches || {}).filter(function (mid) {
        var entry = liveMatches[mid];
        return entry && (entry.status === 'live' || entry.status === 'starting');
      });
      kicker.textContent = (liveIds.length > 1 && selectedMatchId)
        ? 'Mapa · ' + matchLabel(selectedMatchId)
        : 'Mapa';
    }

    if (!map) {
      widget.hidden = t && t.status === 'finalizado';
      visual.setAttribute('data-map', 'pending');
      nameEl.textContent = t && t.status === 'finalizado' ? 'Cerrado' : 'Por definir';
      return;
    }
    widget.hidden = false;
    visual.setAttribute('data-map', String(map));
    nameEl.textContent = prettyMapName(map);
  }

  function renderScoreboardMeta(t) {
    var liveBadge = $('tdSbLive');
    var mapEl = $('tdSbMap');
    if (liveBadge) liveBadge.classList.toggle('on', isMatchLive());
    // Si el torneo dejó de estar en vivo (cierre a mano, servidor apagado sin
    // match_end) el reloj no puede seguir sumando minutos él solo.
    if (!isMatchLive()) stopDurationTick();
    if (mapEl) {
      var lm = getSelectedLiveMatch();
      var map = (lm && lm.map) || (t && t.activeMap);
      if (isMatchLive()) {
        mapEl.textContent = (map || 'CS2').toUpperCase();
      } else if (t.status === 'finalizado') {
        mapEl.textContent = 'Torneo finalizado';
      } else {
        mapEl.textContent = 'Esperando partida';
      }
    }
    renderScoreboardTeams(t, lastLivePayload);
    renderMapWidget(t);
  }

  function resolveCtTTeams(t, live) {
    var matchId = selectedMatchId || (t && (t.activeMatchId || t.currentMatchId)) || 'r1_m1';
    var match = t && t.bracket && t.bracket.matches && t.bracket.matches[matchId];
    var teamAId = match && match.teamA && match.teamA.teamId;
    var teamBId = match && match.teamB && match.teamB.teamId;
    var sideByTeam = (live && live.sideByTeam) || (getSelectedLiveMatch() && getSelectedLiveMatch().sideByTeam) || null;
    var ctId = null;
    var tId = null;

    if (sideByTeam && teamAId && sideByTeam[teamAId]) {
      if (sideByTeam[teamAId] === 'CT') {
        ctId = teamAId;
        tId = teamBId;
      } else {
        ctId = teamBId;
        tId = teamAId;
      }
    } else if (live && live.startingSide && teamAId && teamBId) {
      // MatchZy team1 is bracket teamA in our builder.
      if (live.startingSide === 'team1_ct') {
        ctId = teamAId;
        tId = teamBId;
      } else if (live.startingSide === 'team1_t') {
        ctId = teamBId;
        tId = teamAId;
      }
    }

    // Sin bando resuelto (config a cuchillo antes de la primera ronda) se
    // mantiene el orden del cuadro para no dejar el marcador vacío, pero queda
    // marcado como no confirmado: afirmar CT/T a ciegas acierta la mitad de las
    // veces y el equipo se ve etiquetado al revés durante media partida.
    var resolved = !!(ctId || tId);
    if (!resolved) {
      ctId = teamAId;
      tId = teamBId;
    }
    return { ctId: ctId, tId: tId, matchId: matchId, resolved: resolved };
  }

  function renderScoreboardTeams(t, live) {
    var labelA = $('tdSbTeamA');
    var labelB = $('tdSbTeamB');
    var sideA = $('tdSbSideA');
    var sideB = $('tdSbSideB');
    if (!labelA || !labelB || !t) return;
    var sides = resolveCtTTeams(t, live || lastLivePayload);
    labelA.textContent = sides.ctId ? tName(sides.ctId) : 'Equipo CT';
    labelB.textContent = sides.tId ? tName(sides.tId) : 'Equipo T';
    if (sideA) sideA.textContent = sides.resolved ? 'CT' : 'Bando por definir';
    if (sideB) sideB.textContent = sides.resolved ? 'T' : 'Bando por definir';
  }

  function stopDurationTick() {
    if (durationTickTimer) {
      clearInterval(durationTickTimer);
      durationTickTimer = null;
    }
  }

  function startDurationTick(startedAt, explicitSeconds) {
    stopDurationTick();
    liveStartedAt = startedAt || null;
    var apply = function () {
      var el = $('tdDuration');
      if (!el) return;
      if (explicitSeconds != null && isFinite(Number(explicitSeconds))) {
        el.textContent = 'Duración: ' + formatDuration(explicitSeconds);
        return;
      }
      if (!liveStartedAt) {
        el.textContent = 'Duración: —';
        return;
      }
      var secs = Math.max(0, Math.floor((Date.now() - Number(liveStartedAt)) / 1000));
      el.textContent = 'Duración: ' + formatDuration(secs);
    };
    apply();
    if (explicitSeconds == null && liveStartedAt) {
      durationTickTimer = setInterval(apply, 1000);
    }
  }

  /**
   * Deja el marcador en blanco. Sin esto, una partida que desaparece o un
   * cambio de cruce dejaban en pantalla el resultado de otra partida, que es
   * peor que no mostrar nada.
   */
  function clearLiveScoreboard() {
    stopDurationTick();
    lastLivePayload = null;
    liveStartedAt = null;
    if ($('tdScore')) $('tdScore').textContent = '— : —';
    if ($('tdRound')) $('tdRound').textContent = 'Ronda —';
    if ($('tdDuration')) $('tdDuration').textContent = 'Duración: —';
    renderMatchStats(null);
  }

  function applyLivePayload(live) {
    if (!live) return;
    lastLivePayload = live;
    var ct = live.scoreCT != null ? live.scoreCT : '—';
    var tt = live.scoreT != null ? live.scoreT : '—';
    if ($('tdScore')) $('tdScore').textContent = ct + ' : ' + tt;
    if ($('tdRound')) {
      $('tdRound').textContent = 'Ronda ' + (live.currentRound != null ? live.currentRound : '—') +
        ' • ' + (live.status || '');
    }
    // El servidor solo reporta la duración al cerrar cada ronda, así que
    // tomarla como valor fijo dejaba el reloj congelado dos minutos entre
    // rondas. Mientras se juega se cuenta en el cliente desde startedAt y la
    // cifra del servidor queda como respaldo (plugins viejos que no lo mandan)
    // y como valor definitivo al terminar.
    var explicit = live.durationSeconds != null && isFinite(Number(live.durationSeconds))
      ? Number(live.durationSeconds)
      : null;
    var startedAt = live.startedAt || liveStartedAt;
    var finished = String(live.status || '') === 'finished';
    if (finished) {
      var finalSecs = explicit;
      if (finalSecs == null && startedAt) {
        // Sin duración ni hora de cierre el reloj se quedaba corriendo en una
        // partida ya terminada. Se congela con lo que se sabe al enterarse.
        var endAt = Number(live.finishedAt) || Number(live.lastEventAt) || Date.now();
        finalSecs = Math.max(0, Math.floor((endAt - Number(startedAt)) / 1000));
      }
      // Sin punto de partida no hay duración que enseñar: un guion es honesto,
      // un 0m 0s no. Lo que no puede pasar es que el reloj siga sumando.
      if (finalSecs == null) startDurationTick(null, null);
      else startDurationTick(startedAt, finalSecs);
    } else if (startedAt) {
      startDurationTick(startedAt, null);
    } else {
      startDurationTick(null, explicit);
    }
    renderMatchStats(live);
    if (tournamentData) {
      renderScoreboardTeams(tournamentData, live);
      renderMapWidget(tournamentData);
    }
  }

  function renderHeader(t) {
    $('tdName').textContent = t.name || 'Tournament';
    var st = $('tdStatus');
    st.textContent = statusLabel(t.status || 'pendiente');
    st.className = 'td-status ' + (t.status === 'en_vivo' ? 'live' : t.status === 'finalizado' ? 'finished' : 'pending');

    if (global.TDHeroVideo) {
      global.TDHeroVideo.setActive(t.status !== 'finalizado');
    }

    var conn = $('tdConnectInfo');
    if (conn) {
      renderConnectPanel();
    }
    renderScoreboardMeta(t);

    activeServerId = activeGameServer
      ? activeGameServer.id
      : (t && t.activeServerId ? String(t.activeServerId) : null);
    updateActionButtons(t);
  }

  /** Qué cruce enseña el marcador cuando el visitante no ha elegido ninguno. */
  function defaultMatchId(t) {
    if (t && t.activeMatchId) return t.activeMatchId;
    var ids = Object.keys(liveMatches || {});
    if (ids.length) {
      ids.sort(function (a, b) {
        return recencyOf(liveMatches[b]) - recencyOf(liveMatches[a]);
      });
      return ids[0];
    }
    return (t && t.currentMatchId) || null;
  }

  function recencyOf(entry) {
    if (!entry) return 0;
    return Number(entry.finishedAt || entry.updatedAt || entry.startedAt || 0);
  }

  function attachLiveListener(matchId) {
    if (liveListener) liveListener.off();
    liveListener = null;
    if (!matchId) return;
    selectedMatchId = matchId;
    liveListener = db.ref('partida_en_vivo/' + matchId);
    liveListener.on('value', function (snap) {
      var live = snap.val();
      if (!live) {
        clearLiveScoreboard();
        if (tournamentData) renderScoreboardMeta(tournamentData);
        return;
      }
      applyLivePayload(live);
      if (tournamentData) renderScoreboardMeta(tournamentData);
    });
  }

  function renderMatchTabs(t) {
    var box = $('tdMatchTabs');
    if (!box) return;
    var ids = Object.keys(liveMatches || {}).filter(function (mid) {
      var m = liveMatches[mid];
      return m && (m.status === 'live' || m.status === 'starting');
    });
    if (!ids.length && t && t.activeMatchId && t.status === 'en_vivo') {
      ids = [t.activeMatchId];
    }
    if (ids.length < 2) {
      box.hidden = true;
      box.innerHTML = '';
      return;
    }
    box.hidden = false;
    if (!selectedMatchId || ids.indexOf(selectedMatchId) === -1) {
      selectedMatchId = ids[0];
    }
    box.innerHTML = ids.map(function (mid) {
      var m = liveMatches[mid] || {};
      var match = t && t.bracket && t.bracket.matches && t.bracket.matches[mid];
      var a = match && match.teamA && match.teamA.teamId ? tName(match.teamA.teamId) : 'A';
      var b = match && match.teamB && match.teamB.teamId ? tName(match.teamB.teamId) : 'B';
      var active = mid === selectedMatchId ? ' active' : '';
      return '<button type="button" class="td-match-tab' + active + '" data-match-id="' + escHtml(mid) + '">' +
        '<span class="td-match-tab-live">●</span>' + escHtml(a) + ' vs ' + escHtml(b) +
        '</button>';
    }).join('');
    Array.prototype.forEach.call(box.querySelectorAll('[data-match-id]'), function (btn) {
      btn.addEventListener('click', function () {
        selectMatch(btn.getAttribute('data-match-id'));
      });
    });
  }

  /** Cambia el marcador (y la IP) a otra de las partidas en curso. */
  function selectMatch(mid) {
    if (!mid || mid === selectedMatchId) return;
    selectedMatchId = mid;
    // El marcador del cruce anterior seguiría en pantalla hasta que conteste
    // Firebase, y en ese hueco parece el resultado del cruce nuevo.
    clearLiveScoreboard();
    attachLiveListener(mid);
    renderMatchTabs(tournamentData);
    renderConnectPanel();
    if (tournamentData) {
      renderScoreboardMeta(tournamentData);
      renderBracket(tournamentData);
    }
  }

  function attachLiveMatchesListener() {
    if (!tournamentId || liveMatchesListener) return;
    liveMatchesListener = db.ref('tournaments/' + tournamentId + '/liveMatches');
    liveMatchesListener.on('value', function (snap) {
      liveMatches = snap.val() || {};
      renderMatchTabs(tournamentData || {});
      var prefer = selectedMatchId ||
        (tournamentData && (tournamentData.activeMatchId || tournamentData.currentMatchId));
      var liveIds = Object.keys(liveMatches).filter(function (mid) {
        var m = liveMatches[mid];
        return m && (m.status === 'live' || m.status === 'starting');
      });
      var nextId = null;
      if (prefer && liveIds.indexOf(prefer) !== -1) nextId = prefer;
      else if (liveIds.length) nextId = liveIds[0];
      if (nextId && nextId !== selectedMatchId) {
        attachLiveListener(nextId);
      } else if (nextId && !liveListener) {
        attachLiveListener(nextId);
      }
      if (tournamentData) {
        renderBracket(tournamentData);
        renderConnectPanel();
        renderMapWidget(tournamentData);
      }
    });
  }

  function showInvalidState(message) {
    $('tdName').textContent = 'Invalid tournament';
    setAdminMsg(message || 'Open Competition Hub and create a tournament first.', true);
    var actions = $('tdAdminActions');
    if (actions) actions.style.display = 'none';
  }

  function loadTournament() {
    if (!tournamentId) {
      showInvalidState('Missing tournament ID. Go to Competition Hub → Create Tournament.');
      return;
    }
    db.ref('tournaments/' + tournamentId).on('value', function (snap) {
      tournamentData = snap.val();
      if (!tournamentData) {
        showInvalidState('Tournament not found. It may have been deleted.');
        return;
      }
      tournamentData.id = tournamentId;
      if (!tournamentData.currentMatchId) {
        tournamentData.currentMatchId = 'r1_m1';
      }
      cacheTeamNames(tournamentData);
      renderHeader(tournamentData);
      renderTeams(tournamentData);
      renderBracket(tournamentData);
      renderMeta(tournamentData);
      renderNote(tournamentData);
      renderPodium(tournamentData);
      renderPrizes(tournamentData);
      renderSchedule(tournamentData);
      renderBanner(tournamentData);
      renderInfoRows(tournamentData);
      renderScoreboardMeta(tournamentData);
      wireShareButtons();
      hydrateActiveServerFromTournament();
      syncServerStateFromRegistry();
      resolvePlayerRole(currentUser, tournamentData).then(function () {
        renderConnectPanel();
        refreshPresenceRole();
        renderTeams(tournamentData);
        maybeShowRulesOverlay();
      });
      backfillOwnRoster();
      if (tournamentData.activeServerId && tournamentData.serverIp && !isMatchLive()) {
        ensureServerStatusPoll();
      }
      if (isBootGraceReady() && !isMatchLive() && isLaunchReady()) {
        setAdminMsg('Server at ' + getServerIp() + ':' + getServerPort() + ' — ready. Click Launch Match.');
      }
      if (!selectedMatchId) {
        // También con el torneo cerrado: el resultado de la última partida es
        // lo primero que viene a buscar el que llega tarde, y antes la sala se
        // quedaba con el marcador en blanco en cuanto acababa el campeonato.
        var firstMatchId = defaultMatchId(tournamentData);
        if (firstMatchId) attachLiveListener(firstMatchId);
      }
    });

    attachLiveMatchesListener();
    attachServerRegistryListener();
  }

  /**
   * El registro de servidores es lectura de mando (regla de gameServers), así
   * que engancharlo para todo el mundo solo servía para llenar la consola de
   * cada jugador y espectador con permiso denegado. Lo que ellos necesitan
   * (IP, puerto, aviso de puerto bloqueado) viaja por el cruce en liveMatches.
   */
  function attachServerRegistryListener() {
    if (!tournamentId || !isAdmin || serverRegistryListener) return;
    serverRegistryListener = db.ref('gameServers');
    serverRegistryListener.on('value', function (snap) {
      if (!tournamentId) return;
      var matched = null;
      snap.forEach(function (child) {
        var s = child.val();
        if (s && s.tournamentId === tournamentId && s.status !== 'deleted') {
          matched = {
            id: child.key,
            ip: s.ip || null,
            port: s.port || 27015,
            status: s.status || 'unknown',
            error: s.error || null,
            rconReady: s.rconReady === true,
            portReady: !!s.portReady,
            gameUdpOk: s.gameUdpOk,
            createdAt: s.createdAt || null,
            provisionMode: s.provisionMode || provisionMode,
          };
          if (s.provisionMode) provisionMode = s.provisionMode;
        }
      });
      if (matched) {
        activeGameServer = Object.assign({}, activeGameServer || {}, matched, {
          ip: matched.ip || (activeGameServer && activeGameServer.ip) ||
            (tournamentData && tournamentData.serverIp) || null,
          port: matched.port || (activeGameServer && activeGameServer.port) ||
            (tournamentData && tournamentData.serverPort) || 27015,
        });
        activeServerId = matched.id;
        syncServerStateFromRegistry();
      }
    });
  }

  function getMatchId() {
    return (tournamentData && tournamentData.currentMatchId) || 'r1_m1';
  }

  function wireAdminActions() {
    if (adminActionsWired) return;
    adminActionsWired = true;

    storeButtonDefault('tdBtnProvision');
    storeButtonDefault('tdBtnLaunch');
    storeButtonDefault('tdBtnShutdown');
    storeButtonDefault('tdBtnCheck');

    $('tdBtnCheck').addEventListener('click', async function () {
      if (!activeServerId || !tournamentId) return;
      setButtonLoading('tdBtnCheck', true);
      setAdminMsg('Checking if CS2 is ready...');
      try {
        var result = await TournamentSystem.checkServer(tournamentId, activeServerId);
        applyServerApiResult(result);
        if (result.stillInstalling) {
          var elapsed = result.bootAgeMs ? Math.floor(result.bootAgeMs / 60000) : 0;
          setAdminMsg(
            'CS2 is still installing or starting at ' + result.ip + ':' + (result.port || 27015) +
            ' (~' + elapsed + ' min elapsed). Wait for install to finish on the server, then check again.'
          );
        } else if (result.connectHint && (result.gameUdpOk === false || result.playerConnectOk === false)) {
          setAdminMsg(result.connectHint, true);
        } else if (result.rconOk || result.status === 'online' || result.portReady || result.readyByAge) {
          var udpNote = (result.gameUdpOk === false) ? ' Warning: UDP game port not reachable for players.' : '';
          setAdminMsg('Server ready at ' + result.ip + ':' + (result.port || 27015) + '. Click Launch Match.' + udpNote,
            result.gameUdpOk === false);
        } else if (isBootGraceReady()) {
          if (activeGameServer) {
            activeGameServer.status = 'online';
            activeGameServer.portReady = true;
          }
          setAdminMsg('Server at ' + getServerIp() + ':' + getServerPort() + ' — ready (boot grace). Click Launch Match.');
          syncServerStateFromRegistry();
        } else {
          setAdminMsg('CS2 still starting at ' + result.ip + ':' + (result.port || 27015) + '. Try again in a minute.');
        }
      } catch (e) {
        setAdminMsg((e && e.message) ? e.message : String(e), true);
      } finally {
        setButtonLoading('tdBtnCheck', false);
      }
    });

    $('tdBtnProvision').addEventListener('click', async function () {
      if (!tournamentId || !tournamentData) {
        setAdminMsg('Load a valid tournament first (Competition Hub → Create Tournament).', true);
        return;
      }
      if (hasActiveServer()) {
        setAdminMsg('A server is already active for this tournament.', true);
        return;
      }
      setButtonLoading('tdBtnProvision', true);
      setAdminMsg('Creating Vultr server in Miami (IP in ~1–3 min; snapshot restore + CS2 often 25–45 min)...');
      try {
        var matchId = getMatchId();
        var result = await TournamentSystem.provisionServer(tournamentId, matchId, 0);
        activeServerId = String(result.serverId);
        if (result.provisionMode) provisionMode = result.provisionMode;
        if (result.error) {
          if (result.ip) {
            setAdminMsg('Server at ' + result.ip + ':' + (result.port || 27015) + ' — CS2 starting. (Recovered from backend warning: ' + result.error + ')');
            ensureServerStatusPoll();
          } else {
            setAdminMsg('Provisioning failed: ' + result.error, true);
          }
        } else if (result.status === 'online' && result.ip) {
          setAdminMsg('Server ready at ' + result.ip + ':27015. Click Launch Match.');
        } else if (result.ip) {
          setAdminMsg('Server at ' + result.ip + ':27015 — snapshot restoring / CS2 starting. Keep this page open...');
          ensureServerStatusPoll();
        } else {
          setAdminMsg('Server created (ID: ' + result.serverId + '). Waiting for IP...');
          ensureServerStatusPoll();
        }
      } catch (e) {
        var msg = (e && e.message) ? e.message : String(e);
        hydrateActiveServerFromTournament();
        if (tournamentData && tournamentData.activeServerId) {
          activeServerId = String(tournamentData.activeServerId);
        }
        if (/timed out|504|gateway timeout|aborted/i.test(msg) && (hasActiveServer() || activeServerId)) {
          setAdminMsg('Provision still running on Vultr — keep this page open. Checking every 20s...');
          ensureServerStatusPoll();
        } else if (hasActiveServer() && activeServerId && !getServerIp()) {
          setAdminMsg('Still waiting for IP — trying to resume provisioning...');
          try {
            var resumed = await TournamentSystem.resumeProvision(tournamentId, activeServerId);
            if (resumed.ip) {
              setAdminMsg('Server at ' + resumed.ip + ':27015 — CS2 starting. Checking automatically...');
              ensureServerStatusPoll();
            } else {
              setAdminMsg(msg, true);
            }
          } catch (resumeErr) {
            setAdminMsg((resumeErr && resumeErr.message) || msg, true);
          }
        } else {
          setAdminMsg(msg, true);
        }
      } finally {
        setButtonLoading('tdBtnProvision', false);
      }
    });

    $('tdBtnLaunch').addEventListener('click', async function () {
      if (!tournamentId || !tournamentData) {
        setAdminMsg('Load a valid tournament first.', true);
        return;
      }
      if (!isServerReady()) {
        setAdminMsg('Provision a server first and wait until the IP appears.', true);
        return;
      }
      if (!isLaunchReady()) {
        setAdminMsg('Server is not ready yet. Wait until Check Readiness passes, then Launch Match.', true);
        return;
      }
      if (isMatchLive()) {
        setAdminMsg('Match is already live. Use the connect panel above or: ' + getConnectCommand());
        return;
      }
      setButtonLoading('tdBtnLaunch', true);
      hydrateActiveServerFromTournament();
      setAdminMsg('Launching match on ' + getServerIp() + ':' + getServerPort() + '...');
      try {
        var map = $('tdMapSelect').value;
        var matchId = getMatchId();
        var teamIds = Object.keys(tournamentData.registeredTeams || {});
        var result = await TournamentSystem.launchMatch(
          tournamentId, matchId, map, activeServerId || tournamentData.activeServerId, teamIds
        );
        var msg;
        if (result.rconOk) {
          msg = 'Match launched. Players: use the green connect box above (or CS2 console: ' + getConnectCommand() + ').';
        } else {
          msg = 'Launch failed — CS2 did not respond over RCON. Wait for the server to finish starting, click Check Readiness, then try again.';
          if (result.rconError) msg += ' (' + result.rconError + ')';
        }
        if (result.connectWarning) {
          msg += ' ' + result.connectWarning;
        }
        setAdminMsg(msg, !result.rconOk || !!result.connectWarning);
        if (tournamentData && result.rconOk) {
          tournamentData.status = 'en_vivo';
          tournamentData.activeMatchId = matchId;
          tournamentData.activeMap = map;
          renderHeader(tournamentData);
          attachLiveListener(matchId);
        } else {
          renderHeader(tournamentData);
        }
      } catch (e) {
        setAdminMsg((e && e.message) ? e.message : String(e), true);
      } finally {
        setButtonLoading('tdBtnLaunch', false);
      }
    });

    $('tdBtnShutdown').addEventListener('click', async function () {
      var serverId = activeServerId || (tournamentData && tournamentData.activeServerId);
      if (!serverId) {
        setAdminMsg('No active server to shut down. Provision a server first.', true);
        return;
      }
      if (!window.confirm('Shut down the cloud server? This stops billing for this instance.')) return;
      setButtonLoading('tdBtnShutdown', true);
      setAdminMsg('Shutting down server...');
      try {
        await TournamentSystem.shutdownServer(serverId, tournamentId);
        clearServerDisplay();
        setAdminMsg('Server shut down. Provision a new server to run another match.');
      } catch (e) {
        setAdminMsg((e && e.message) ? e.message : String(e), true);
      } finally {
        setButtonLoading('tdBtnShutdown', false);
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Vista publica en vivo: premios, podio, calendario y espectadores.
  // El Commander publica estos datos desde el Control Universal del panel y
  // cualquiera que este viendo el torneo los recibe al instante.
  // ---------------------------------------------------------------------------

  var teamNames = {};
  var presenceRef = null;
  var presenceBeat = null;
  var watchers = {};
  var PRESENCE_TTL_MS = 90 * 1000;

  function escHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function toNum(value) {
    var n = Number(value);
    return isFinite(n) ? n : 0;
  }

  function tName(teamId) {
    if (!teamId) return 'TBD';
    return teamNames[teamId] || teamId;
  }

  /** Resuelve nombres de equipo una sola vez y repinta lo que dependa de ellos. */
  function cacheTeamNames(t) {
    var ids = Object.keys((t && t.registeredTeams) || {});
    if (t && t.bracket && t.bracket.matches) {
      Object.keys(t.bracket.matches).forEach(function (mid) {
        var m = t.bracket.matches[mid];
        ['teamA', 'teamB'].forEach(function (slot) {
          if (m[slot] && m[slot].teamId) ids.push(m[slot].teamId);
        });
      });
    }
    ids.filter(function (id) { return id && !(id in teamNames); }).forEach(function (id) {
      teamNames[id] = null;
      db.ref('teams/' + id + '/name').once('value').then(function (snap) {
        teamNames[id] = snap.val() || id;
        if (tournamentData) {
          renderBracket(tournamentData);
          renderSchedule(tournamentData);
          renderPodium(tournamentData);
          renderTeams(tournamentData);
          // El selector de cruces y el marcador se pintan antes de que lleguen
          // los nombres, y sin este repintado se quedaban enseñando el id crudo
          // del equipo en lugar de "Alpha Squad".
          renderMatchTabs(tournamentData);
          renderScoreboardMeta(tournamentData);
        }
      }).catch(function () { teamNames[id] = id; });
    });
  }

  function fmtLocalDateTime(ms) {
    var n = toNum(ms);
    if (!n) return 'TBA';
    return new Date(n).toLocaleString('es-ES', {
      day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
    });
  }

  function fmtLocalTime(ms) {
    var n = toNum(ms);
    if (!n) return '--';
    return new Date(n).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
  }

  function kv(label, value) {
    return '<div class="td-kv"><div class="td-kv-label">' + escHtml(label) + '</div>' +
      '<div class="td-kv-value">' + escHtml(value) + '</div></div>';
  }

  function roundName(round, total) {
    var fromEnd = toNum(total) - toNum(round);
    if (fromEnd === 0) return 'Final';
    if (fromEnd === 1) return 'Semifinal';
    if (fromEnd === 2) return 'Cuartos';
    if (fromEnd === 3) return 'Octavos';
    return 'Ronda ' + round;
  }

  function renderNote(t) {
    var box = $('tdNoteBanner');
    if (!box) return;
    var note = t && t.commanderNote;
    if (!note || !note.text) {
      box.style.display = 'none';
      return;
    }
    box.style.display = 'flex';
    box.innerHTML = '<i class="fas fa-bullhorn"></i><div>' + escHtml(note.text) +
      '<span class="td-note-by">Aviso del Commander' +
      (note.byNick ? ' ' + escHtml(note.byNick) : '') +
      (note.at ? ' - ' + escHtml(fmtLocalDateTime(note.at)) : '') + '</span></div>';
  }

  var PODIUM_META = [
    { key: 'first', place: '1er puesto', icon: 'fa-trophy', cls: 'td-podium-1' },
    { key: 'second', place: '2do puesto', icon: 'fa-medal', cls: 'td-podium-2' },
    { key: 'third', place: '3er puesto', icon: 'fa-award', cls: 'td-podium-3' }
  ];

  function renderPodium(t) {
    var box = $('tdPodium');
    if (!box) return;
    var podium = (t && t.podium) || {};
    var prizes = (t && t.prizes) || {};
    var places = prizes.places || {};
    var currency = prizes.cashCurrency || 'USD';

    box.innerHTML = PODIUM_META.map(function (meta) {
      var entry = podium[meta.key] || {};
      var prize = places[meta.key] || {};
      var name = entry.teamId ? tName(entry.teamId) : (entry.teamName || 'Por decidir');
      var tokens = toNum(prize.tokens);
      var cash = toNum(prize.cash);
      var prizeText = tokens || cash
        ? tokens.toLocaleString('es-ES') + ' tokens' + (cash ? ' + ' + cash + ' ' + currency : '')
        : 'Sin asignar';
      return '<div class="td-podium-card ' + meta.cls + '">' +
        '<i class="fas ' + meta.icon + '"></i>' +
        '<div class="td-podium-place">' + escHtml(meta.place) + '</div>' +
        '<div class="td-podium-team">' + escHtml(name) + '</div>' +
        '<div class="td-podium-prize">' + escHtml(prizeText) + '</div>' +
      '</div>';
    }).join('');
  }

  function renderPrizes(t) {
    var box = $('tdPrizes');
    if (!box) return;
    var p = (t && t.prizes) || {};
    var teamCount = Object.keys((t && t.registeredTeams) || {}).length;
    var tokenPool = toNum(p.tokenPool) || toNum(t && t.prizePool);
    var entryFee = toNum(p.entryFee) || toNum(t && t.entryFee);
    var currency = p.cashCurrency || 'USD';
    var paid = (t && t.prizePayouts) || {};
    var deliveredTokens = Object.keys(paid).reduce(function (acc, k) { return acc + toNum(paid[k].tokens); }, 0);
    var deliveredCash = Object.keys(paid).reduce(function (acc, k) { return acc + toNum(paid[k].cash); }, 0);

    box.innerHTML =
      kv('Pozo en juego', tokenPool.toLocaleString('es-ES') + ' tokens') +
      kv('Dinero en juego', toNum(p.cashPool) ? toNum(p.cashPool) + ' ' + currency : 'Solo tokens') +
      kv('Inscripcion por equipo', entryFee ? entryFee.toLocaleString('es-ES') + ' tokens' : 'Gratis') +
      kv('Recaudado', (entryFee * teamCount).toLocaleString('es-ES') + ' tokens (' + teamCount + ' equipos)') +
      kv('Premio MVP', toNum(p.mvpTokens) ? toNum(p.mvpTokens).toLocaleString('es-ES') + ' tokens' : '--') +
      kv('Ya entregado', deliveredTokens.toLocaleString('es-ES') + ' tokens' +
        (deliveredCash ? ' + ' + deliveredCash + ' ' + currency : '')) +
      kv('Actualizado', p.updatedAt ? fmtLocalDateTime(p.updatedAt) : 'Sin publicar') +
      (p.notes ? kv('Notas', p.notes) : '');
  }

  function renderSchedule(t) {
    var box = $('tdSchedule');
    if (!box) return;
    var bracket = t && t.bracket;
    if (!bracket || !bracket.matches) {
      box.innerHTML = '<p style="color:#888;font-size:0.85rem;">El calendario se publica cuando el Commander siembra el cuadro.</p>';
      return;
    }
    var matches = bracket.matches;
    var ids = Object.keys(matches).filter(function (mid) { return !matches[mid].bye; }).sort(function (a, b) {
      var ra = toNum(matches[a].round), rb = toNum(matches[b].round);
      if (ra !== rb) return ra - rb;
      return toNum(a.split('_m')[1]) - toNum(b.split('_m')[1]);
    });
    if (!ids.length) {
      box.innerHTML = '<p style="color:#888;font-size:0.85rem;">Sin partidas programadas.</p>';
      return;
    }

    var currentId = t.activeMatchId || t.currentMatchId;
    box.innerHTML = ids.map(function (mid) {
      var m = matches[mid];
      var cls = m.status === 'finished' ? 'done' : (mid === currentId ? 'live' : '');
      var a = m.teamA && m.teamA.teamId;
      var b = m.teamB && m.teamB.teamId;
      var nameA = m.winnerTeamId === a ? '<b>' + escHtml(tName(a)) + '</b>' : escHtml(tName(a));
      var nameB = m.winnerTeamId === b ? '<b>' + escHtml(tName(b)) + '</b>' : escHtml(tName(b));
      var state = m.status === 'finished'
        ? ((m.score && m.score.a != null) ? m.score.a + ' - ' + m.score.b : 'Finalizada')
        : (mid === currentId ? 'EN VIVO' : 'Programada');
      return '<div class="td-sched-row ' + cls + '">' +
        '<div class="td-sched-time">' + escHtml(fmtLocalTime(m.scheduledAt)) +
          '<span>' + escHtml(m.scheduledAt ? fmtLocalDateTime(m.scheduledAt).split(',')[0] : '') + '</span></div>' +
        '<div class="td-sched-round">' + escHtml(roundName(m.round, bracket.rounds)) + '</div>' +
        '<div class="td-sched-teams">' + nameA + ' vs ' + nameB +
          (m.map ? ' <span style="color:#666;font-size:0.75rem;">' + escHtml(m.map) + '</span>' : '') + '</div>' +
        '<div class="td-sched-state">' + escHtml(state) + '</div>' +
      '</div>';
    }).join('');
  }

  function renderSentinelLine() {
    var box = $('tdSentinelLine');
    if (!box) return;
    db.ref('security/sentinelConfig').once('value').then(function (snap) {
      var cfg = snap.val();
      if (!cfg || !cfg.defaultNick) {
        box.style.display = 'none';
        return;
      }
      box.style.display = 'flex';
      box.innerHTML = '<i class="fas fa-user-shield"></i><span>Sentinela de guardia: <b>' +
        escHtml(cfg.defaultNick) + '</b> - vigila las partidas contra tramposos.</span>';
    }).catch(function () { box.style.display = 'none'; });
  }

  function renderWatchers() {
    var box = $('tdWatchers');
    if (!box) return;
    var now = Date.now();
    var list = Object.keys(watchers).map(function (uid) {
      var w = watchers[uid] || {};
      w.uid = uid;
      return w;
    }).filter(function (w) {
      return now - toNum(w.lastSeen || w.joinedAt) <= PRESENCE_TTL_MS;
    });

    updateChatPresence(list.length);

    if (!list.length) {
      box.innerHTML = '<p style="color:#888;font-size:0.85rem;">Nadie mas viendo ahora mismo.</p>';
      return;
    }
    var roleOrder = { commander: 0, sentinel: 1, player: 2, spectator: 3 };
    list.sort(function (a, b) {
      var oa = roleOrder[a.role] == null ? 4 : roleOrder[a.role];
      var ob = roleOrder[b.role] == null ? 4 : roleOrder[b.role];
      return oa - ob;
    });
    var icons = { commander: 'fa-user-shield', sentinel: 'fa-user-secret', player: 'fa-gamepad', spectator: 'fa-eye' };

    box.innerHTML = '<p style="color:#ffca3a;font-size:0.9rem;margin:0 0 8px;"><b>' + list.length +
      '</b> viendo este torneo</p>' + list.map(function (w) {
      var role = w.role || 'spectator';
      return '<div class="td-watcher-row">' +
        '<i class="fas ' + (icons[role] || 'fa-eye') + '"></i>' +
        '<span>' + escHtml(w.nick || w.uid) + '</span>' +
        '<span class="td-watcher-role">' + escHtml(role) + '</span>' +
      '</div>';
    }).join('');
  }

  function rosterUidsFrom(entry) {
    if (!entry) return [];
    if (Array.isArray(entry.uids)) return entry.uids.filter(Boolean);
    if (entry.uids && typeof entry.uids === 'object') {
      return Object.keys(entry.uids).map(function (k) {
        var v = entry.uids[k];
        return typeof v === 'string' ? v : k;
      }).filter(Boolean);
    }
    if (entry.players && typeof entry.players === 'object') return Object.keys(entry.players);
    return [];
  }

  function resolvePlayerRole(user, t) {
    if (!user || !t) return Promise.resolve(presenceRole);
    if (isAdmin) {
      isPlayer = false;
      presenceRole = 'commander';
      return Promise.resolve(presenceRole);
    }

    var registered = Object.keys(t.registeredTeams || {});
    var rosters = t.registeredRosters || {};
    for (var i = 0; i < registered.length; i += 1) {
      var tid = registered[i];
      var uids = rosterUidsFrom(rosters[tid]);
      if (uids.indexOf(user.uid) !== -1) {
        isPlayer = true;
        playerTeamId = tid;
        presenceRole = 'player';
        return Promise.resolve(presenceRole);
      }
    }

    var checks = registered.map(function (tid) {
      return db.ref('teams/' + tid).once('value').then(function (snap) {
        var team = snap.val() || {};
        if (team.captain === user.uid) return tid;
        var roster = team.roster || team.members || {};
        if (roster[user.uid]) return tid;
        return null;
      }).catch(function () { return null; });
    });

    return Promise.all(checks).then(function (hits) {
      var hit = hits.filter(Boolean)[0] || null;
      isPlayer = !!hit;
      playerTeamId = hit;
      presenceRole = hit ? 'player' : 'spectator';
      return presenceRole;
    });
  }

  function refreshPresenceRole() {
    if (!presenceRef) return;
    presenceRef.update({
      role: presenceRole,
      teamId: playerTeamId || null,
      lastSeen: Date.now()
    }).catch(function () {});
  }

  /** Datos del torneo que acompañan al reglamento como chips (mapa, pozo, hora). */
  function tournamentRulesMeta(t) {
    var meta = [];
    if (t && t.activeMap) {
      meta.push({ icon: 'fa-map', label: 'Mapa', value: prettyMapName(t.activeMap) });
    }
    var prizes = (t && t.prizes) || {};
    var pool = toNum(prizes.tokenPool) || toNum(t && t.prizePool);
    if (pool) {
      meta.push({ icon: 'fa-coins', label: 'Pozo', value: pool.toLocaleString('es-ES') + ' tokens' });
    }
    if (t && t.schedule) {
      meta.push({ icon: 'fa-clock', label: 'Inicia', value: fmtLocalDateTime(t.schedule) });
    }
    return meta;
  }

  function rulesPayload(t) {
    return {
      kicker: 'Reglas del torneo',
      title: 'Código de Conducta',
      tournamentName: (t && t.name) || 'Torneo Studiosgamesrs',
      subtitle: 'Se lee una sola vez, antes de conectar. Aplica a todo el roster inscrito.',
      buttonText: 'Entendido, entrar al torneo',
      meta: tournamentRulesMeta(t)
    };
  }

  /**
   * Overlay de bienvenida al torneo. Se apoya en el escenario 3D del Nexus
   * (la wyvern) y, si ese módulo no está en la página, cae al overlay plano.
   */
  function maybeShowRulesOverlay() {
    if (rulesPrompted || !isPlayer || !currentUser || !tournamentId || !tournamentData) return;
    if (isAdmin) return;
    rulesPrompted = true;
    var localKey = 'sgRulesAck:' + tournamentId + ':' + currentUser.uid;

    function markSeen() {
      try { localStorage.setItem(localKey, String(Date.now())); } catch (e) { /* noop */ }
      db.ref('tournaments/' + tournamentId + '/rulesAck/' + currentUser.uid)
        .set(Date.now())
        .catch(function () {});
    }

    function show() {
      var payload = rulesPayload(tournamentData);
      var sensor = window.SGNexusSensor;
      if (sensor && typeof sensor.showTournamentRules === 'function') {
        sensor.showTournamentRules(payload, markSeen);
        return;
      }
      var fallback = window.SGWelcomeOverlay;
      if (fallback && typeof fallback.showTournamentRules === 'function') {
        window.__sgOnTournamentRulesAck = markSeen;
        fallback.showTournamentRules({
          title: 'Reglas — ' + payload.tournamentName,
          subtitle: payload.subtitle,
          rules: [
            'Respeto y cero toxicidad: la primera falta descalifica al equipo completo.',
            'Grabación obligatoria: sin el clip pedido por el Centinela, culpable automático.',
            'Puntualidad: 10 minutos de tolerancia o derrota por default (16 - 0).',
            'Pausas técnicas: 1 por equipo y mapa, máximo 3 minutos, avisando en el chat.',
            'Las decisiones del Centinela durante la partida son inapelables.'
          ]
        }, markSeen);
      }
    }

    try {
      if (localStorage.getItem(localKey)) return;
    } catch (e) { /* continue */ }

    db.ref('tournaments/' + tournamentId + '/rulesAck/' + currentUser.uid).once('value')
      .then(function (snap) {
        if (snap.val()) {
          try { localStorage.setItem(localKey, String(snap.val())); } catch (e2) { /* noop */ }
          return;
        }
        show();
      })
      .catch(function () { show(); });
  }

  /** Registra presencia con rol player/spectator/commander. */
  function registerPresence(user) {
    if (!tournamentId || !user) return;
    db.ref('users/' + user.uid + '/nick').once('value').then(function (snap) {
      var nick = snap.val() || user.displayName || 'Espectador';
      presenceRef = db.ref('tournamentPresence/' + tournamentId + '/' + user.uid);
      presenceRef.onDisconnect().remove();
      presenceRef.set({
        nick: nick,
        role: presenceRole,
        teamId: playerTeamId || null,
        page: 'tournament-details',
        joinedAt: Date.now(),
        lastSeen: Date.now()
      }).catch(function (err) {
        console.warn('presencia de torneo:', err && err.message);
      });
      if (presenceBeat) clearInterval(presenceBeat);
      presenceBeat = setInterval(function () {
        if (presenceRef) presenceRef.update({ lastSeen: Date.now() }).catch(function () {});
      }, 40000);
    });

    db.ref('tournamentPresence/' + tournamentId).on('value', function (snap) {
      watchers = snap.val() || {};
      renderWatchers();
    }, function () { /* sin permiso: se queda vacio */ });

    window.addEventListener('beforeunload', function () {
      if (presenceRef) {
        try {
          presenceRef.onDisconnect().cancel();
          presenceRef.remove();
        } catch (err) { /* noop */ }
      }
    });
  }

  firebase.auth().onAuthStateChanged(function (user) {
    if (!user) {
      window.location.href = '/login';
      return;
    }
    currentUser = user;
    db.ref('users/' + user.uid + '/rango').once('value').then(function (snap) {
      var rango = (snap.val() || '').toLowerCase();
      isAdmin = rango === 'commander' || rango === 'boss_of_the_state' ||
        rango === 'divisional_commander';
      presenceRole = isAdmin ? 'commander' : 'spectator';
      wireSettingsButton();
      wireTabs();
      if (isAdmin) {
        if (tournamentId) $('tdAdminActions').style.display = 'flex';
        wireAdminActions();
        wireBannerUpload();
        hydrateActiveServerFromTournament();
        syncServerStateFromRegistry();
        // El rango llega después de loadTournament(), así que el registro de
        // servidores se engancha aquí, cuando ya se sabe que hay permiso.
        attachServerRegistryListener();
      }
      registerPresence(user);
      if (tournamentData) {
        resolvePlayerRole(user, tournamentData).then(function () {
          renderConnectPanel();
          refreshPresenceRole();
          maybeShowRulesOverlay();
        });
      }
      renderSentinelLine();
    });
    loadTournament();
  });
})(typeof window !== 'undefined' ? window : global);
