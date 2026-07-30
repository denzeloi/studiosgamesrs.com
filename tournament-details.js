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
  var tournamentData = null;
  var liveListener = null;
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

  function getServerIp() {
    if (activeGameServer && activeGameServer.ip) return activeGameServer.ip;
    return (tournamentData && tournamentData.serverIp) || null;
  }

  function getServerPort() {
    if (activeGameServer && activeGameServer.port) return activeGameServer.port;
    return (tournamentData && tournamentData.serverPort) || 27015;
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
    return isMatchLive() && isServerReady();
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

    if (!isServerReady()) {
      conn.style.display = 'none';
      conn.innerHTML = '';
      return;
    }

    if (!shouldShowConnectPanel()) {
      conn.style.display = 'block';
      conn.innerHTML =
        '<div class="td-connect-wait"><i class="fas fa-hourglass-half"></i> ' +
        'Server is online. Waiting for the Commander to <strong>Launch Match</strong> before players can join.</div>';
      return;
    }

    var cmd = getConnectCommand();
    var steamUrl = getSteamConnectUrl();
    var udpBlocked = activeGameServer && activeGameServer.gameUdpOk === false;
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
    if (!seconds) return '—';
    var m = Math.floor(seconds / 60);
    var s = seconds % 60;
    return m + 'm ' + s + 's';
  }

  function renderTeams(t) {
    var list = $('tdTeams');
    if (!list) return;
    list.innerHTML = '';
    var teams = t.registeredTeams || {};
    var ids = Object.keys(teams);
    if (!ids.length) {
      list.innerHTML = '<li>No teams registered yet.</li>';
      return;
    }
    ids.forEach(function (tid) {
      var li = document.createElement('li');
      li.textContent = tid;
      li.dataset.teamId = tid;
      list.appendChild(li);
      db.ref('teams/' + tid + '/name').once('value').then(function (snap) {
        var name = snap.val();
        if (name) li.textContent = name;
      });
    });
  }

  function renderBracket(t) {
    var box = $('tdBracket');
    if (!box) return;
    var bracket = t.bracket;
    if (!bracket || !bracket.matches) {
      box.textContent = 'Bracket will be generated when the match starts (needs 2+ registered teams).';
      return;
    }
    box.innerHTML = '';
    Object.keys(bracket.matches).forEach(function (mid) {
      var m = bracket.matches[mid];
      var div = document.createElement('div');
      div.className = 'td-bracket-match' + (t.currentMatchId === mid ? ' active' : '');
      var teamA = tName(m.teamA && m.teamA.teamId);
      var teamB = tName(m.teamB && m.teamB.teamId);
      var label = roundName(m.round, bracket.rounds);
      var outcome = m.status === 'finished'
        ? 'gana ' + tName(m.winnerTeamId)
        : (m.status || 'pending');
      div.textContent = label + ': ' + teamA + ' vs ' + teamB + ' [' + outcome + ']';
      box.appendChild(div);
    });
  }

  function renderMeta(t) {
    var el = $('tdMeta');
    if (!el) return;
    el.innerHTML =
      '<strong>Game:</strong> ' + (t.game || 'cs2').toUpperCase() + '<br>' +
      '<strong>Format:</strong> ' + (t.format || 'SingleElim') + '<br>' +
      '<strong>Region:</strong> ' + (t.region || 'LATAM') + '<br>' +
      '<strong>Prize:</strong> ' + (t.prizePool || 0) + ' tokens<br>' +
      '<strong>Schedule:</strong> ' + (t.schedule ? new Date(t.schedule).toLocaleString() : 'TBA') +
      '<br><strong>ID:</strong> <code style="font-size:0.75rem;">' + tournamentId + '</code>';
  }

  function renderHeader(t) {
    $('tdName').textContent = t.name || 'Tournament';
    var st = $('tdStatus');
    st.textContent = t.status || 'pending';
    st.className = 'td-status ' + (t.status === 'en_vivo' ? 'live' : t.status === 'finalizado' ? 'finished' : 'pending');

    var conn = $('tdConnectInfo');
    if (conn) {
      renderConnectPanel();
    }

    activeServerId = activeGameServer
      ? activeGameServer.id
      : (t && t.activeServerId ? String(t.activeServerId) : null);
    updateActionButtons(t);
  }

  function attachLiveListener(matchId) {
    if (liveListener) liveListener.off();
    if (!matchId) return;
    liveListener = db.ref('partida_en_vivo/' + matchId);
    liveListener.on('value', function (snap) {
      var live = snap.val();
      if (!live) return;
      var ct = live.scoreCT != null ? live.scoreCT : '—';
      var tt = live.scoreT != null ? live.scoreT : '—';
      $('tdScore').textContent = ct + ' : ' + tt;
      $('tdRound').textContent = 'Round ' + (live.currentRound || '—') + ' • ' + (live.status || '');
      $('tdDuration').textContent = 'Duration: ' + formatDuration(live.durationSeconds);
      if (live.kills && typeof live.kills === 'object') {
        var tbody = $('tdKillsBody');
        var table = $('tdKillsTable');
        table.style.display = 'table';
        tbody.innerHTML = '';
        Object.keys(live.kills).forEach(function (player) {
          var tr = document.createElement('tr');
          tr.innerHTML = '<td>' + player + '</td><td>' + live.kills[player] + ' kills</td>';
          tbody.appendChild(tr);
        });
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
      hydrateActiveServerFromTournament();
      syncServerStateFromRegistry();
      if (tournamentData.activeServerId && tournamentData.serverIp && !isMatchLive()) {
        ensureServerStatusPoll();
      }
      if (isBootGraceReady() && !isMatchLive() && isLaunchReady()) {
        setAdminMsg('Server at ' + getServerIp() + ':' + getServerPort() + ' — ready. Click Launch Match.');
      }
      if (tournamentData.status === 'en_vivo' && tournamentData.activeMatchId) {
        attachLiveListener(tournamentData.activeMatchId);
      }
    });

    db.ref('gameServers').on('value', function (snap) {
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

  /** Registra al usuario como espectador del torneo, con limpieza al desconectar. */
  function registerSpectatorPresence(user) {
    if (!tournamentId || !user) return;
    db.ref('users/' + user.uid + '/nick').once('value').then(function (snap) {
      var nick = snap.val() || user.displayName || 'Espectador';
      presenceRef = db.ref('tournamentPresence/' + tournamentId + '/' + user.uid);
      presenceRef.onDisconnect().remove();
      presenceRef.set({
        nick: nick,
        role: isAdmin ? 'commander' : 'spectator',
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
      if (isAdmin) {
        $('tdAdminBar').style.display = 'block';
        if (tournamentId) $('tdAdminActions').style.display = 'flex';
        wireAdminActions();
        hydrateActiveServerFromTournament();
        syncServerStateFromRegistry();
      }
      registerSpectatorPresence(user);
      renderSentinelLine();
    });
    loadTournament();
  });
})(typeof window !== 'undefined' ? window : global);
