/**
 * tournament-system.js — Tournament + CS2 (Firebase HTTP API with optional bridge)
 */
(function (global) {
  'use strict';

  var tournamentCreationInitialized = false;

  function getBridgeConfig() {
    return global.CS2_BRIDGE || {};
  }

  function useBridge() {
    var cfg = getBridgeConfig();
    return cfg.mode === 'bridge' && !!cfg.url;
  }

  function getBridgeUrl() {
    return getBridgeConfig().url || '';
  }

  function getFunctionsRegion() {
    return getBridgeConfig().region || 'us-central1';
  }

  function getProjectId() {
    if (typeof firebase !== 'undefined' && firebase.apps && firebase.apps.length) {
      return firebase.app().options.projectId;
    }
    return getBridgeConfig().projectId || 'studiosgamesrs';
  }

  function getApiUrl(op) {
    var region = getFunctionsRegion();
    var projectId = getProjectId();
    var fn = getBridgeConfig().apiFunction || 'cs2NexusApi';
    return 'https://' + region + '-' + projectId + '.cloudfunctions.net/' + fn + '?op=' + encodeURIComponent(op);
  }

  async function callCs2Api(op, data, timeoutMs) {
    var user = firebase.auth().currentUser;
    if (!user) throw new Error('Not authenticated. Please log in again.');
    var waitMs = timeoutMs || (
      op === 'provision' || op === 'resume' ? 210000 :
      op === 'check' ? 15000 :
      60000
    );
    var forceRefreshToken = op === 'provision' || op === 'launch' || op === 'shutdown';

    try {
      var token = await user.getIdToken(forceRefreshToken);
      var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      var timeoutId = controller ? setTimeout(function () { controller.abort(); }, waitMs) : null;

      var res = await fetch(getApiUrl(op), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + token,
        },
        body: JSON.stringify(data || {}),
        signal: controller ? controller.signal : undefined,
      });

      if (timeoutId) clearTimeout(timeoutId);

      var payload = await res.json().catch(function () { return {}; });
      if (!res.ok || payload.ok === false) {
        if (res.status === 504) {
          throw new Error('Gateway timeout — the server may still be provisioning. Keep this page open.');
        }
        throw new Error(payload.error || res.statusText || 'CS2 API request failed');
      }
      return payload.result;
    } catch (fetchErr) {
      if (fetchErr && fetchErr.name === 'AbortError') {
        throw new Error('Request timed out. The server may still be provisioning — watch this page for the IP address.');
      }
      throw fetchErr;
    }
  }

  async function bridgeFetch(path, options) {
    var user = firebase.auth().currentUser;
    if (!user) throw new Error('Not authenticated');
    var token = await user.getIdToken();
    var res = await fetch(getBridgeUrl() + path, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + token,
        ...(options && options.headers),
      },
    });
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  }

  function generateTournamentId() {
    return firebase.database().ref('tournaments').push().key;
  }

  function populateGameSelect() {
    var gameSelect = document.getElementById('tournamentGameSelect');
    if (!gameSelect || gameSelect.options.length) return;

    var games = [
      { value: 'cs2', label: 'Counter-Strike 2' },
      { value: 'valorant', label: 'Valorant' },
      { value: 'lol', label: 'League of Legends' },
      { value: 'rl', label: 'Rocket League' },
    ];

    games.forEach(function (g) {
      var opt = document.createElement('option');
      opt.value = g.value;
      opt.textContent = g.label;
      if (g.value === 'cs2') opt.selected = true;
      gameSelect.appendChild(opt);
    });
  }

  function setDefaultScheduleInput() {
    var scheduleInput = document.getElementById('tournamentScheduleInput');
    if (!scheduleInput || scheduleInput.value) return;

    var date = new Date();
    date.setHours(date.getHours() + 2);
    date.setMinutes(0, 0, 0);
    scheduleInput.value = date.toISOString().slice(0, 16);
  }

  function closeTournamentModal() {
    var modal = document.getElementById('tournamentCreationModal');
    if (modal) modal.style.display = 'none';
  }

  function openTournamentCreationModal() {
    initializeTournamentCreation();
    populateGameSelect();
    setDefaultScheduleInput();

    var modal = document.getElementById('tournamentCreationModal');
    if (modal) {
      modal.style.display = 'flex';
      var nameInput = document.getElementById('tournamentNameInput');
      if (nameInput) nameInput.focus();
    }
  }

  function initializeTournamentCreation() {
    if (tournamentCreationInitialized) return;

    var form = document.getElementById('createTournamentForm');
    var modal = document.getElementById('tournamentCreationModal');
    var closeBtn = document.getElementById('closeTournamentCreationModal');
    var cancelBtn = document.getElementById('cancelTournamentBtn');

    populateGameSelect();

    if (closeBtn) closeBtn.addEventListener('click', closeTournamentModal);
    if (cancelBtn) cancelBtn.addEventListener('click', closeTournamentModal);

    if (modal) {
      modal.addEventListener('click', function (e) {
        if (e.target === modal) closeTournamentModal();
      });
      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && modal.style.display === 'flex') closeTournamentModal();
      });
    }

    if (!form) return;

    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      var user = firebase.auth().currentUser;
      if (!user) return;

      var btn = document.getElementById('saveTournamentBtn');
      if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Creating...';
      }

      try {
        var scheduleValue = document.getElementById('tournamentScheduleInput').value;
        var scheduleTime = new Date(scheduleValue).getTime();
        if (!scheduleValue || Number.isNaN(scheduleTime)) {
          throw new Error('Please choose a valid start time.');
        }

        var maxTeams = parseInt(document.getElementById('tournamentMaxTeamsInput').value, 10);
        if (!maxTeams || maxTeams < 2) {
          throw new Error('Max teams must be at least 2.');
        }

        var id = generateTournamentId();
        var tournament = {
          id: id,
          name: document.getElementById('tournamentNameInput').value.trim(),
          game: document.getElementById('tournamentGameSelect').value,
          format: document.getElementById('tournamentFormatSelect').value,
          region: document.getElementById('tournamentRegionSelect').value,
          regionServer: document.getElementById('tournamentRegionSelect').value,
          modality: '5v5',
          status: 'pendiente',
          schedule: scheduleTime,
          prizePool: parseInt(document.getElementById('tournamentPrizeInput').value, 10) || 0,
          entryFee: parseInt(document.getElementById('tournamentEntryFeeInput').value, 10) || 0,
          description: (document.getElementById('tournamentDescriptionTextarea').value || '').trim(),
          createdAt: firebase.database.ServerValue.TIMESTAMP,
          organizer: { uid: user.uid, nick: user.displayName || 'Commander' },
          teams: { max: maxTeams, registered: 0 },
          registeredTeams: {},
          currentMatchId: 'r1_m1',
        };

        if (!tournament.name) throw new Error('Tournament name is required.');

        await firebase.database().ref('tournaments/' + id).set(tournament);
        closeTournamentModal();
        form.reset();
        setDefaultScheduleInput();
        if (typeof showNotification === 'function') {
          showNotification('Tournament created successfully!', 'success');
        }
        window.location.href = '/tournament-details?id=' + encodeURIComponent(id);
      } catch (err) {
        console.error(err);
        if (typeof showNotification === 'function') {
          showNotification('Error: ' + err.message, 'error');
        }
      } finally {
        if (btn) {
          btn.disabled = false;
          btn.innerHTML = '<i class="fas fa-trophy"></i> Create Tournament';
        }
      }
    });

    tournamentCreationInitialized = true;
  }

  async function checkServer(tournamentId, serverId) {
    return callCs2Api('check', { tournamentId: tournamentId, serverId: serverId }, 12000);
  }

  async function resumeProvision(tournamentId, serverId) {
    return callCs2Api('resume', { tournamentId: tournamentId, serverId: serverId });
  }

  async function provisionServer(tournamentId, matchId, gsltIndex) {
    var payload = { tournamentId: tournamentId, matchId: matchId, gsltIndex: gsltIndex || 0 };
    if (useBridge()) {
      return bridgeFetch('/api/servers/provision', { method: 'POST', body: JSON.stringify(payload) });
    }
    return callCs2Api('provision', payload);
  }

  async function launchMatch(tournamentId, matchId, map, serverId, teamIds) {
    var payload = {
      tournamentId: tournamentId,
      matchId: matchId,
      map: map || 'de_mirage',
      serverId: serverId,
      teamIds: teamIds,
    };
    if (useBridge()) {
      return bridgeFetch('/api/tournaments/' + encodeURIComponent(tournamentId) + '/launch', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
    }
    return callCs2Api('launch', payload);
  }

  async function shutdownServer(serverId, tournamentId) {
    if (useBridge()) {
      return bridgeFetch('/api/servers/' + encodeURIComponent(serverId), { method: 'DELETE' });
    }
    return callCs2Api('shutdown', { serverId: serverId, tournamentId: tournamentId });
  }

  async function buildBracket(tournamentId, teamIds) {
    if (useBridge()) {
      return bridgeFetch('/api/tournaments/' + encodeURIComponent(tournamentId) + '/bracket', {
        method: 'POST',
        body: JSON.stringify({ teamIds: teamIds }),
      });
    }
    throw new Error('Build bracket is only available through the bridge in this build.');
  }

  global.initializeTournamentCreation = initializeTournamentCreation;
  global.openTournamentCreationModal = openTournamentCreationModal;
  global.TournamentSystem = {
    provisionServer: provisionServer,
    resumeProvision: resumeProvision,
    checkServer: checkServer,
    launchMatch: launchMatch,
    shutdownServer: shutdownServer,
    buildBracket: buildBracket,
  };
})(typeof window !== 'undefined' ? window : this);
