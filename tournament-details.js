/* tournament-details.js */
(function (global) {
  'use strict';

  var firebaseConfig = {
    apiKey: 'AIzaSyBiGoggMhj_yCE7NbmXKE9VqneG0uqyDrU',
    authDomain: 'studiosgamesrs.firebaseapp.com',
    databaseURL: 'https://studiosgamesrs-default-rtdb.firebaseio.com',
    projectId: 'studiosgamesrs',
    storageBucket: 'studiosgamesrs.firebasestorage.app',
    messagingSenderId: '113076073338',
    appId: '1:113076073338:web:74354ea705903240029cc3',
  };

  if (typeof firebase !== 'undefined' && !firebase.apps.length) {
    firebase.initializeApp(firebaseConfig);
  }

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
  var ipSeenAt = null;
  var pollCount = 0;
  var provisionMode = (global.CS2_BRIDGE && global.CS2_BRIDGE.provisionMode) || 'full';
  var BOOT_GRACE_MS = 4 * 60 * 1000;

  function $(id) { return document.getElementById(id); }

  function getBootWaitMsg() {
    return provisionMode === 'snapshot'
      ? 'CS2 is starting on the cloud server (usually 5–8 min with snapshot).'
      : 'CS2 is installing on the cloud server (first install usually 15–45 min).';
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
    return !!getServerIp();
  }

  function hydrateActiveServerFromTournament() {
    if (activeGameServer || !tournamentData || !tournamentData.activeServerId) return;
    activeGameServer = {
      id: String(tournamentData.activeServerId),
      ip: tournamentData.serverIp || null,
      port: tournamentData.serverPort || 27015,
      status: 'booting',
      error: null,
      createdAt: tournamentData.serverCreatedAt || null,
    };
    activeServerId = String(tournamentData.activeServerId);
  }

  function applyServerApiResult(result) {
    if (!result) return;
    var sid = String(result.serverId || activeServerId || (tournamentData && tournamentData.activeServerId) || '');
    if (!sid) return;
    activeServerId = sid;
    if (!activeGameServer) {
      activeGameServer = {
        id: sid,
        ip: null,
        port: 27015,
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
    syncServerStateFromRegistry();
  }

  function noteIpSeen() {
    if (isServerReady() && !ipSeenAt) ipSeenAt = Date.now();
  }

  function isBootGraceReady() {
    if (!isServerReady()) return false;
    if (activeGameServer && activeGameServer.createdAt) {
      if (Date.now() - Number(activeGameServer.createdAt) >= BOOT_GRACE_MS) return true;
    }
    return !!(ipSeenAt && (Date.now() - ipSeenAt) >= BOOT_GRACE_MS);
  }

  function isLaunchReady() {
    if (isMatchLive()) return false;
    if (!isServerReady()) return false;
    if (!activeGameServer) hydrateActiveServerFromTournament();
    if (activeGameServer && (activeGameServer.status === 'online' || activeGameServer.portReady === true)) {
      return true;
    }
    return isBootGraceReady();
  }

  function isMatchLive() {
    if (!tournamentData) return false;
    if (tournamentData.status === 'en_vivo') return true;
    return !!tournamentData.activeMatchId;
  }

  function stopServerStatusPoll() {
    if (statusPollTimer) {
      clearInterval(statusPollTimer);
      statusPollTimer = null;
    }
  }

  function startServerStatusPoll() {
    stopServerStatusPoll();
    if (!isAdmin || !activeServerId || !tournamentId) return;
    hydrateActiveServerFromTournament();
    if (activeGameServer && (activeGameServer.status === 'online' || activeGameServer.status === 'error')) {
      return;
    }

    async function pollOnce() {
      if (!activeServerId || !tournamentId) {
        stopServerStatusPoll();
        return;
      }
      noteIpSeen();
      if (isBootGraceReady()) {
        if (activeGameServer) {
          activeGameServer.status = 'online';
          activeGameServer.portReady = true;
        }
        setAdminMsg('Server at ' + getServerIp() + ':' + getServerPort() + ' — ready (boot grace). Click Launch Match.');
        syncServerStateFromRegistry();
        stopServerStatusPoll();
        return;
      }
      if (activeGameServer && (activeGameServer.status === 'online' || activeGameServer.status === 'error')) {
        stopServerStatusPoll();
        return;
      }
      pollCount += 1;
      try {
        var result = await TournamentSystem.checkServer(tournamentId, activeServerId);
        applyServerApiResult(result);
        if (result && (result.status === 'online' || result.rconOk || result.portReady)) {
          setAdminMsg('Server ready at ' + result.ip + ':' + (result.port || 27015) + '. Click Launch Match.');
          stopServerStatusPoll();
          return;
        }
        if (result && result.ip) {
          var mins = ipSeenAt ? Math.floor((Date.now() - ipSeenAt) / 60000) : 0;
          if (mins >= 4) {
            setAdminMsg('Server at ' + result.ip + ':' + (result.port || 27015) + ' — should be ready. Click Launch Match.');
          } else {
            setAdminMsg('Server at ' + result.ip + ':' + (result.port || 27015) + ' — CS2 starting (~' + Math.max(0, 4 - mins) + ' min). Checking again...');
          }
        }
      } catch (e) {
        if (!isServerReady()) {
          try {
            var resumed = await TournamentSystem.resumeProvision(tournamentId, activeServerId);
            applyServerApiResult(resumed);
            if (resumed && resumed.ip) {
              noteIpSeen();
              setAdminMsg('Server at ' + resumed.ip + ':27015 — CS2 starting. Checking automatically...');
            }
          } catch (resumeErr) {
            /* keep polling */
          }
        }
      }
      if (pollCount >= 20) stopServerStatusPoll();
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

  function syncServerStateFromRegistry() {
    if (!tournamentData) return;
    if (!activeGameServer) {
      hydrateActiveServerFromTournament();
    }
    if (!activeGameServer) {
      renderHeader(tournamentData);
      updateServerStatus(tournamentData);
      updateActionButtons(tournamentData);
      updateCheckButton();
      return;
    }
    tournamentData.serverIp = activeGameServer.ip || tournamentData.serverIp || null;
    tournamentData.serverPort = activeGameServer.port || 27015;
    tournamentData.activeServerId = activeGameServer.id;
    noteIpSeen();
    renderHeader(tournamentData);
    updateServerStatus(tournamentData);
    updateActionButtons(tournamentData);
    updateCheckButton();
    if (activeGameServer.status === 'online') {
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

  function updateServerStatus(t) {
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
        if (activeGameServer.rconReady === false) {
          setAdminMsg('Server online at ' + ip + ':' + port + ' — CS2 is up. Click Launch Match (RCON will connect on launch).');
        } else {
          setAdminMsg('Server ready at ' + ip + ':' + port + '. Click Launch Match.');
        }
        return;
      }
      if (activeGameServer && activeGameServer.status === 'booting') {
        setAdminMsg('Server at ' + ip + ':' + port + ' — ' + getBootWaitMsg() + ' Checking automatically every 20s...');
        startServerStatusPoll();
        return;
      }
      if (activeGameServer && activeGameServer.status === 'rcon_timeout') {
        setAdminMsg('Server at ' + ip + ':' + port + ' — CS2 install is taking longer than usual. You can try Launch, or wait a few more minutes.');
        return;
      }
      setAdminMsg('Server at ' + ip + ':' + port + ' — ' + getBootWaitMsg() + ' Checking automatically...');
      startServerStatusPoll();
      return;
    }
    if (hasActiveServer()) {
      setAdminMsg('Server provisioning in progress (ID: ' + activeGameServer.id + '). Waiting for IP address (usually 2–5 minutes)...');
      return;
    }
    if (t.serverIp && !activeGameServer) {
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
      var teamA = (m.teamA && m.teamA.teamId) || 'TBD';
      var teamB = (m.teamB && m.teamB.teamId) || 'TBD';
      div.textContent = mid + ': ' + teamA + ' vs ' + teamB + ' [' + (m.status || 'pending') + ']';
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
    if (isServerReady() && conn) {
      conn.style.display = 'block';
      var line = 'connect ' + getServerIp() + ':' + getServerPort();
      conn.innerHTML =
        '<div style="margin-bottom:8px;">' + line + '</div>' +
        '<div style="font-size:0.8rem;color:#aaa;line-height:1.5;">' +
        '1. Open CS2 → press <strong>~</strong> (console)<br>' +
        '2. Paste the line above and press Enter<br>' +
        '3. Do not use Community Server browser — direct connect only<br>' +
        '4. Both players need a Steam account with CS2 installed' +
        '</div>';
    } else if (conn) {
      conn.style.display = 'none';
      conn.textContent = '';
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
      renderHeader(tournamentData);
      renderTeams(tournamentData);
      renderBracket(tournamentData);
      renderMeta(tournamentData);
      hydrateActiveServerFromTournament();
      syncServerStateFromRegistry();
      if (isBootGraceReady() && !isMatchLive()) {
        setAdminMsg('Server at ' + getServerIp() + ':' + getServerPort() + ' — ready. Click Launch Match.');
      }
      if (tournamentData.activeMatchId) {
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
            createdAt: s.createdAt || null,
            provisionMode: s.provisionMode || provisionMode,
          };
          if (s.provisionMode) provisionMode = s.provisionMode;
        }
      });
      if (matched) {
        activeGameServer = matched;
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
        if (result.rconOk || result.status === 'online' || result.portReady || result.readyByAge) {
          setAdminMsg('Server ready at ' + result.ip + ':' + (result.port || 27015) + '. Click Launch Match.');
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
      setAdminMsg('Creating Hetzner server (IP usually in 1–3 min, CS2 ready in 5–8 min)...');
      try {
        var matchId = getMatchId();
        var result = await TournamentSystem.provisionServer(tournamentId, matchId, 0);
        activeServerId = String(result.serverId);
        if (result.provisionMode) provisionMode = result.provisionMode;
        if (result.error) {
          if (result.ip) {
            setAdminMsg('Server at ' + result.ip + ':' + (result.port || 27015) + ' — CS2 starting. (Recovered from backend warning: ' + result.error + ')');
            startServerStatusPoll();
          } else {
            setAdminMsg('Provisioning failed: ' + result.error, true);
          }
        } else if (result.status === 'online' && result.ip) {
          setAdminMsg('Server ready at ' + result.ip + ':27015. Click Launch Match.');
        } else if (result.ip) {
          setAdminMsg('Server at ' + result.ip + ':27015 — CS2 starting (5–8 min). Checking automatically...');
          startServerStatusPoll();
        } else {
          setAdminMsg('Server created (ID: ' + result.serverId + '). Waiting for IP...');
          startServerStatusPoll();
        }
      } catch (e) {
        var msg = (e && e.message) ? e.message : String(e);
        hydrateActiveServerFromTournament();
        if (tournamentData && tournamentData.activeServerId) {
          activeServerId = String(tournamentData.activeServerId);
        }
        if (/timed out|504|gateway timeout|aborted/i.test(msg) && (hasActiveServer() || activeServerId)) {
          setAdminMsg('Provision still running on Hetzner — keep this page open. Checking every 20s...');
          startServerStatusPoll();
        } else if (hasActiveServer() && activeServerId && !getServerIp()) {
          setAdminMsg('Still waiting for IP — trying to resume provisioning...');
          try {
            var resumed = await TournamentSystem.resumeProvision(tournamentId, activeServerId);
            if (resumed.ip) {
              setAdminMsg('Server at ' + resumed.ip + ':27015 — CS2 starting. Checking automatically...');
              startServerStatusPoll();
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
      if (isMatchLive()) {
        setAdminMsg('Match is already live. Connect: ' + getServerIp() + ':' + getServerPort());
        return;
      }
      setButtonLoading('tdBtnLaunch', true);
      setAdminMsg('Launching match on ' + activeGameServer.ip + '...');
      try {
        var map = $('tdMapSelect').value;
        var matchId = getMatchId();
        var teamIds = Object.keys(tournamentData.registeredTeams || {});
        var result = await TournamentSystem.launchMatch(
          tournamentId, matchId, map, activeServerId || tournamentData.activeServerId, teamIds
        );
        var msg = 'Match launched. Connect in CS2 console (~): connect ' + result.serverIp + ':' + (result.port || 27015);
        if (result.manualConnect || result.rconOk === false) {
          msg += ' (Map may need a minute to load if RCON timed out — try connect anyway.)';
        }
        if (result.manualConnect || result.rconOk === false) {
          msg += '. RCON could not load the map from the cloud — join the server and run: changelevel ' + map;
          if (result.rconError) msg += ' (' + result.rconError + ')';
        }
        setAdminMsg(msg);
        if (tournamentData) {
          tournamentData.status = 'en_vivo';
          tournamentData.activeMatchId = matchId;
          tournamentData.activeMap = map;
        }
        renderHeader(tournamentData);
        attachLiveListener(matchId);
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
      if (!window.confirm('Shut down the Hetzner server? This stops billing for this instance.')) return;
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
    });
    loadTournament();
  });
})(typeof window !== 'undefined' ? window : global);
