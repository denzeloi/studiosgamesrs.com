/* ======== CÓDIGO PARA playzone.js - PARTE 1 DE 3 (MEJORADO) ======== */

// === 1. FIREBASE (sg-firebase-init.js — SEC-022) ===
if (typeof sgInitFirebaseApp === 'function') {
  sgInitFirebaseApp();
} else if (window.SG_FIREBASE_CONFIG) {
  firebase.initializeApp(window.SG_FIREBASE_CONFIG);
}
const auth = firebase.auth();
const db = firebase.database();

// === 2. VARIABLES GLOBALES ===
let currentUser = null;
let currentUserData = null;
let userHasActiveMission = false; 
let currentMissionId = null;

let allMissionsData = [];
let allPlayersData = [];
let missionsBrowseMode = 'all'; // 'all' | 'coop'

// Variables de Listeners (Para limpiar memoria)
let currentMissionListener = null;
let currentHubChatListener = null;
let hubChatInitializedFor = null;
let hubChatActiveTab = 'team';
let hubChatDmPartnerUid = null;
let hubChatTeamListener = null;
let hubChatDmListener = null;
let hubChatDmListenerRoom = null;
let hubChatDmTabs = {};
let currentPrivateChatListener = null;
let currentPrivateChatRoomID = null;
let activeChats = {}; 

// === 3. HELPERS (Funciones de Ayuda) ===

function forgeDebounce(fn, ms) {
  var t; return function() { var a = arguments, c = this; clearTimeout(t); t = setTimeout(function() { fn.apply(c, a); }, ms); };
}

function showFloatingMessage(type, text) {
  const msg = document.getElementById("floatingMessage");
  if (!msg) return;
  msg.textContent = text;
  msg.className = "floating-message" + (type === "error" ? " error" : "");
  msg.style.display = "block";
  setTimeout(() => { msg.style.display = "none"; }, 3500);
}

// Escapa texto para insertarlo de forma segura dentro de innerHTML (evita XSS).
// PZ-008/PZ-009: el truco de textContent/innerHTML no codifica comillas, así
// que no bastaba para valores usados dentro de atributos (src="...", title="...");
// aquí se codifican & < > " ' de forma explícita, válido tanto en texto como en atributos.
function pzEsc(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Solo se admite un avatar local del proyecto o una URL https; cualquier otro
// esquema (javascript:, data:, http:, etc.) cae al avatar por defecto.
function pzSanitizeAvatarUrl(url) {
  var safe = 'dragon_profile_studiosgamesrs.png';
  if (typeof url !== 'string' || !url) return safe;
  var trimmed = url.trim();
  if (/^https:\/\//i.test(trimmed)) return trimmed;
  if (/^[a-z0-9_\-.]+\.(png|jpg|jpeg|gif|webp)$/i.test(trimmed)) return trimmed;
  return safe;
}

// PZ-016: las imágenes del chat privado deben salir siempre de Firebase Storage
// (ver handlePrivateChatImageUpload), nunca de un valor libre. Solo se acepta
// una URL https cuyo host sea el de Storage; cualquier otra cosa (javascript:,
// data:, un https de otro dominio, etc.) se descarta devolviendo null, y el
// llamador simplemente no dibuja la imagen.
function pzSanitizeChatImageUrl(url) {
  if (typeof url !== 'string' || !url) return null;
  var trimmed = url.trim();
  if (!/^https:\/\//i.test(trimmed)) return null;
  try {
    var host = new URL(trimmed).hostname.toLowerCase();
    if (host === 'firebasestorage.googleapis.com' || host.endsWith('.firebasestorage.app')) {
      return trimmed;
    }
  } catch (e) { /* URL inválida */ }
  return null;
}

// === 3.1 MARCOS DE PERFIL (mismo helper que dashboard y chat de la comunidad) ===
// El marco equipado vive en users/{uid}/profileCustomization/equippedFrame y se
// pinta con SGProfileCustomization.applyFrameId (profile-customization.js).
// Se escucha con on('value') para que un cambio se vea sin recargar la página.
// Nota: el buscador puede dibujar cientos de tarjetas, así que se limita el
// número de listeners simultáneos y se sueltan los de avatares ya no visibles.
var PZ_FRAME_MAX_LISTENERS = 150;
var pzFrameCache = {};
var pzFrameRefs = {};
var pzFrameAssetsPromise = null;

function pzFrameAssets() {
  var SG = window.SGProfileCustomization;
  if (!SG || typeof SG.loadAssets !== 'function') return Promise.resolve();
  if (!pzFrameAssetsPromise) pzFrameAssetsPromise = SG.loadAssets(db).catch(function() {});
  return pzFrameAssetsPromise;
}

// Apertura del contenedor que envuelve un avatar destacado; el overlay del marco
// se inyecta dentro de este wrap (hay que cerrar el </div> en el llamador).
function pzFrameWrapOpen(uid, extraClass) {
  return '<div class="pz-avatar-frame' + (extraClass ? ' ' + extraClass : '') +
    '" data-pz-frame-uid="' + pzEsc(uid || '') + '">';
}

function pzFramePaint(el, frameId) {
  var SG = window.SGProfileCustomization;
  if (!el || !SG || typeof SG.applyFrameId !== 'function') return;
  pzFrameAssets().then(function() { SG.applyFrameId(el, frameId || null); });
}

function pzFrameRepaint(uid) {
  var nodes = document.querySelectorAll('.pz-avatar-frame');
  for (var i = 0; i < nodes.length; i++) {
    if (nodes[i].getAttribute('data-pz-frame-uid') === uid) pzFramePaint(nodes[i], pzFrameCache[uid]);
  }
}

function pzFrameWatch(uid) {
  if (!uid || pzFrameRefs[uid]) return;
  if (Object.keys(pzFrameRefs).length >= PZ_FRAME_MAX_LISTENERS) return;
  var ref = db.ref('users/' + uid + '/profileCustomization/equippedFrame');
  pzFrameRefs[uid] = ref;
  ref.on('value', function(snap) {
    var id = snap.val();
    pzFrameCache[uid] = (id && id !== 'default') ? String(id) : null;
    pzFrameRepaint(uid);
  }, function() {
    ref.off();
    delete pzFrameRefs[uid];
  });
}

// Engancha el listener y pinta el marco ya conocido de cada avatar dentro de root.
function pzFrameApply(root) {
  if (!root || typeof root.querySelectorAll !== 'function') return;
  var nodes = root.querySelectorAll('.pz-avatar-frame');
  for (var i = 0; i < nodes.length; i++) {
    var uid = nodes[i].getAttribute('data-pz-frame-uid');
    if (!uid) continue;
    pzFrameWatch(uid);
    if (pzFrameCache[uid] !== undefined) pzFramePaint(nodes[i], pzFrameCache[uid]);
  }
}

// Suelta los listeners de uids que ya no tienen avatar en pantalla (los listados
// se redibujan al filtrar, así que sin esto los listeners se acumularían).
function pzFramePrune() {
  var alive = {};
  var nodes = document.querySelectorAll('.pz-avatar-frame');
  for (var i = 0; i < nodes.length; i++) alive[nodes[i].getAttribute('data-pz-frame-uid')] = true;
  Object.keys(pzFrameRefs).forEach(function(uid) {
    if (alive[uid]) return;
    pzFrameRefs[uid].off();
    delete pzFrameRefs[uid];
  });
}

// Alterna tema rojo (normal) / dorado. Usa la clase CSS ya existente (dashboard-styles.css).
function toggleTheme() {
  const isGold = document.body.classList.toggle('dashboard-theme-gold');
  try {
    localStorage.setItem('dashboard_theme', isGold ? 'gold' : 'red');
  } catch (e) {}
  const themeIcon = document.getElementById('theme-icon');
  if (themeIcon) {
    themeIcon.className = isGold ? 'fas fa-sun' : 'fas fa-palette';
  }
}
window.toggleTheme = toggleTheme;

(function restorePlayzoneTheme() {
  try {
    if (localStorage.getItem('dashboard_theme') === 'gold') {
      document.body.classList.add('dashboard-theme-gold');
      var themeIcon = document.getElementById('theme-icon');
      if (themeIcon) themeIcon.className = 'fas fa-sun';
    }
  } catch (e) {}
})();

function getFeaturedGameImage(gameName) {
  const gameMap = {
    "Warzone": "Warzone.jpg", "Valorant": "Valorant.jpg", "Rocket-league": "Rocket-league.jpg",
    "LoL": "LoL.jpg", "gta-5": "gta-5.jpg", "cs2": "cs2.jpg", "Battlefield": "Battlefield 6.jpg",
    "apex-legends": "apex-legends.jpg", "Counter-Strike 2": "cs2.jpg", "League of Legends": "LoL.jpg",
    "Apex Legends": "apex-legends.jpg", "GTA V": "gta-5.jpg", "Rocket League": "Rocket-league.jpg",
    "Fortnite": "fortnite.jpg", "Call of Duty": "callofduty.jpg", "Minecraft": "minecraft.jpg",
    "Overwatch 2": "overwatch.jpg", "PUBG": "pugb.jpg", "Rainbow Six Siege": "rainbow.jpg",
    "Otro": "default-game.jpg", "Other": "default-game.jpg"
  };
  const imageName = gameMap[gameName] || 'default-game.jpg'; 
  return `/img_playzone/${imageName}`;
}

// === NUEVO: Helper para Emblemas Inteligentes ===
function getSmartMissionEmblem(type, skill) {
    // Retorna un icono y un color basado en el tipo y nivel para dar variedad
    let icon = "fa-shield-alt";
    let color = "#ccc";
    
    if (type === 'Ranked') { icon = "fa-trophy"; color = "#e53935"; }
    else if (type === 'Casual') { icon = "fa-gamepad"; color = "#4caf50"; }
    else if (type === 'Evento') { icon = "fa-star"; color = "#e53935"; }
    else if (type === 'Cooperativo') { icon = "fa-handshake"; color = "#4bdfff"; }

    if (skill === 'Pro') icon = "fa-crown";
    else if (skill === 'Principiante') icon = "fa-seedling";

    return { icon, color };
}

// === NUEVO: Helper para Iconos de Plataforma ===
var CS2_FRIENDS_DISPLAY_TITLE = 'Partida Cooperativa Premier/Competitivo/CS2';

function getPlatformIconsHTML(activePlatform = 'PC') {
    if (String(activePlatform).toLowerCase() === 'steam') {
        return '<i class="fab fa-steam hub-platform-steam" title="Steam"></i>';
    }
    const platforms = [
        { name: 'PC', icon: 'fa-desktop' },
        { name: 'PlayStation', icon: 'fa-playstation' },
        { name: 'Xbox', icon: 'fa-xbox' }
    ];

    return platforms.map(p => {
        const isActive = p.name === activePlatform;
        const color = isActive ? '#4bdfff' : '#444';
        const opacity = isActive ? '1' : '0.3';
        const shadow = isActive ? 'text-shadow: 0 0 10px #4bdfff;' : '';
        
        return `<i class="fab ${p.icon}" style="color: ${color}; opacity: ${opacity}; ${shadow} font-size: 1.2rem; margin: 0 5px;" title="${p.name}"></i>`;
    }).join('');
}

// === 4. SISTEMA DE PESTAÑAS ===
function setupTabSwitching() {
  const tabs = {
    missions: { btn: document.getElementById('tabFindMissions'), section: document.getElementById('missionsBrowser') },
    players: { btn: document.getElementById('tabFindPlayers'), section: document.getElementById('playersBrowser') },
    create: { btn: document.getElementById('tabCreateMission'), section: document.getElementById('missionCreator') },
    active: { btn: document.getElementById('tabActiveMission'), section: document.getElementById('activeMissionView') }
  };

  function switchTab(activeTabKey) {
    Object.keys(tabs).forEach(key => {
      const tab = tabs[key];
      if (!tab.btn || !tab.section) return;
      if (key === activeTabKey) {
        tab.btn.classList.add('active');
        tab.section.style.display = 'block';
        tab.section.style.animation = 'forge-fadeIn 0.4s ease-out';
        try { localStorage.setItem('playzone_lastTab', activeTabKey); } catch (e) {}
        if (key === 'active') {
          if (typeof checkUserMissionStatus === 'function') {
            checkUserMissionStatus().then(function() {
              if (userHasActiveMission && currentMissionId && typeof loadActiveMission === 'function') {
                loadActiveMission();
              } else {
                var findBtn = document.getElementById('tabFindMissions');
                if (findBtn) findBtn.click();
                showFloatingMessage('info', 'No tienes ninguna misión activa. Únete a una desde Buscar misiones.');
              }
            });
          }
        }
        if (key === 'create' && typeof updateCreatorTokensBadge === 'function') updateCreatorTokensBadge();
      } else {
        tab.btn.classList.remove('active');
        tab.section.style.display = 'none';
      }
    });
  }
  try {
    var initialTab = null;
    try {
      var params = new URLSearchParams(window.location.search);
      var urlTab = params.get('tab');
      if (urlTab === 'active') initialTab = 'active';
      else if (urlTab && tabs[urlTab]) initialTab = urlTab;
    } catch (eUrl) {}
    if (!initialTab) {
      var lastTab = localStorage.getItem('playzone_lastTab');
      if (lastTab === 'active' && !userHasActiveMission) {
        lastTab = 'missions';
        try { localStorage.setItem('playzone_lastTab', 'missions'); } catch (e2) {}
      }
      if (lastTab && tabs[lastTab] && tabs[lastTab].btn) initialTab = lastTab;
    }
    if (initialTab) switchTab(initialTab);
  } catch (e) {}

  tabs.missions.btn.addEventListener('click', () => switchTab('missions'));
  tabs.players.btn.addEventListener('click', () => switchTab('players'));
  tabs.create.btn.addEventListener('click', () => switchTab('create'));
  if (tabs.active.btn) tabs.active.btn.addEventListener('click', () => switchTab('active'));
}

// === 5. INITIALIZATION ===
document.addEventListener('DOMContentLoaded', () => {
  auth.onAuthStateChanged(async (user) => {
    if (user) {
      currentUser = user;
      try {
        const snapshot = await db.ref(`users/${user.uid}`).once('value');
        if (snapshot.exists()) {
            currentUserData = snapshot.val();
            window.currentUserData = currentUserData;
            // Commander Panel is TOP: blocked users cannot use the site
            if (currentUserData.blocked === true) {
                await auth.signOut();
                window.location.href = '/login?blocked=1';
                return;
            }
            if (currentUserData.playZoneOnboardingComplete) {
                initializeApp();
            } else {
                document.querySelector('header').style.display = 'none';
                document.querySelector('.playzone-main').style.display = 'none';
                document.getElementById('playzone-onboarding').style.display = 'flex';
                setupOnboardingFlow();
            }
        }
      } catch (error) { console.error(error); }
    } else { window.location.href = '/login'; }
  });
});

async function initializeApp() {
  await checkUserMissionStatus();
  setupTabSwitching();
  if (typeof setupMissionsCoopBrowse === 'function') setupMissionsCoopBrowse();
  try {
    var params = new URLSearchParams(window.location.search);
    if (params.get('view') !== 'coop' && typeof setMissionsBrowseMode === 'function') {
      setMissionsBrowseMode('all');
    }
  } catch (eInitCoop) {}
  if (typeof setupMissionCreator === 'function') setupMissionCreator();
  if (typeof loadMissions === 'function') loadMissions();
  if (typeof loadPlayers === 'function') loadPlayers();

  const filterIds = ['filterMissionGame', 'filterMissionType', 'filterMissionSkill', 'filterPlayerGame', 'filterPlayerStyle', 'filterPlayerTimezone'];
  filterIds.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('change', forgeDebounce(function() {
             if(id.includes('Mission') && typeof renderFilteredMissions === 'function') renderFilteredMissions();
             if(id.includes('Player') && typeof renderFilteredPlayers === 'function') renderFilteredPlayers();
      }, 200));
  });

  if (typeof setupChatRequestModal === 'function') setupChatRequestModal();
  if (typeof setupFriendRequestModal === 'function') setupFriendRequestModal();
  if (typeof setupHubSlotInviteModal === 'function') setupHubSlotInviteModal();
  if (typeof setupPrivateChatWindow === 'function') setupPrivateChatWindow();
  if (typeof listenForChatRequests === 'function') listenForChatRequests();
  if (typeof listenForFriendRequests === 'function') listenForFriendRequests();
  if (typeof listenForMissionInvites === 'function') listenForMissionInvites();

  var theaterBtn = document.getElementById('forgeTheaterBtn');
  if (theaterBtn) theaterBtn.style.display = 'block';
  if (typeof initForgeExtras === 'function') initForgeExtras();
  forgeLogicEnhancements();
  if (window.PlayzoneMechanics && typeof PlayzoneMechanics.init === 'function') PlayzoneMechanics.init();
  setupMechanicsSort();
  if (userHasActiveMission && window.PlayzoneMechanics && PlayzoneMechanics.showToast) {
    PlayzoneMechanics.showToast('Tienes una misión activa. Revisa la pestaña Misión Activa.');
  }
  filterIds.slice(0, 3).forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.addEventListener('change', function() {
      if (window.PlayzoneMechanics && typeof PlayzoneMechanics.saveFilters === 'function') PlayzoneMechanics.saveFilters();
    });
  });
  setupPlayzoneHeaderSearch();
  if (typeof maybeMarkPlayZoneWelcomeSeen === 'function') maybeMarkPlayZoneWelcomeSeen();
  joinMissionFromUrl();
}

/**
 * "Ver misión" en el aviso de invitación desde otra página nos trae aquí con
 * ?mission=ID; aquí se completa lo que en Play Zone hace el botón directamente.
 */
function joinMissionFromUrl() {
  var missionId = null;
  try {
    missionId = new URLSearchParams(window.location.search).get('mission');
  } catch (e) { return; }
  if (!missionId) return;
  // Fuera de la URL antes de unirse, para que un recargado no lo repita.
  try {
    var url = new URL(window.location.href);
    url.searchParams.delete('mission');
    window.history.replaceState({}, '', url.pathname + url.search + url.hash);
  } catch (e) {}
  if (typeof window.joinMission === 'function') window.joinMission(missionId);
}

function setupPlayzoneHeaderSearch() {
  var inp = document.getElementById('playzoneSearchInput');
  var res = document.getElementById('playzoneSearchResults');
  if (!inp || !res) return;
  inp.addEventListener('input', forgeDebounce(function() {
    var q = (inp.value || '').trim().toLowerCase();
    res.innerHTML = '';
    res.style.display = 'none';
    if (q.length < 2) return;
    var items = [];
    allMissionsData.forEach(function(m) {
      var t = (m.title || '') + ' ' + (m.game || '') + ' ' + (m.description || '');
      if (t.toLowerCase().indexOf(q) !== -1) items.push({ type: 'mission', id: m.id, text: m.title + ' (' + (m.game || '') + ')' });
    });
    allPlayersData.forEach(function(p) {
      var t = (p.nick || '') + ' ' + (p.mainGame || '') + ' ' + ((p.secondaryGames || []).join(' '));
      if (t.toLowerCase().indexOf(q) !== -1) items.push({ type: 'player', id: p.uid, text: (p.nick || 'Jugador') + ' (' + (p.mainGame || '') + ')' });
    });
    if (items.length === 0) res.innerHTML = '<div class="search-result-item" style="color:#888;padding:8px;">Sin resultados</div>';
    else items.slice(0, 8).forEach(function(it) {
      var div = document.createElement('div');
      div.className = 'search-result-item';
      div.textContent = it.text;
      div.style.cursor = 'pointer';
      div.addEventListener('click', function() {
        if (it.type === 'mission') document.getElementById('tabFindMissions').click();
        else if (it.type === 'player' && typeof viewProfile === 'function') { document.getElementById('tabFindPlayers').click(); viewProfile(it.id); }
        inp.value = '';
        res.style.display = 'none';
      });
      res.appendChild(div);
    });
    res.style.display = 'block';
  }, 250));
  inp.addEventListener('blur', function() { setTimeout(function() { res.style.display = 'none'; }, 200); });
}

function setupProTips() {
  var container = document.getElementById('proTipsContainer');
  if (!container) return;
  var tips = [
    { text: 'PlayZone conecta jugadores para misiones ranked, casual y cooperativas en equipo.' },
    { text: 'Completar misiones te da Honor, Reputación y tokens al verificar la partida.' },
    { text: 'Crear una misión es gratis. La recompensa base es 5 tokens por jugador.' },
    { text: 'Vincula Steam en tu perfil para unirte a partidas cooperativas de CS2.' },
    { text: 'Tres reglas: perfil Steam público, cero toxicidad y prohibido hacer trampas.' },
    { text: 'Usa el chat de misión para coordinar horario, lobby y estrategia con tu equipo.' }
  ];
  var tipIdx = 0;
  function spawnDust(cx, cy) {
    for (var i = 0; i < 12; i++) {
      var d = document.createElement('div');
      d.className = 'pro-tip-dust';
      var dx = (Math.random() - 0.5) * 90;
      var dy = (Math.random() - 0.5) * 90;
      d.style.left = (cx - 5) + 'px'; d.style.top = (cy - 5) + 'px';
      d.style.setProperty('--dx', dx + 'px'); d.style.setProperty('--dy', dy + 'px');
      document.body.appendChild(d);
      setTimeout(function(el) { if (el.parentNode) el.remove(); }, 2600, d);
    }
  }
  function showNextTip() {
    var tip = tips[tipIdx % tips.length];
    tipIdx++;
    var bubble = document.createElement('div');
    bubble.className = 'pro-tip-bubble';
    var isLeft = Math.random() > 0.5;
    var topPct = 15 + Math.random() * 60;
    bubble.style.left = isLeft ? '12px' : 'auto';
    bubble.style.right = isLeft ? 'auto' : '12px';
    bubble.style.top = topPct + '%';
    bubble.style.setProperty('--tip-dir', isLeft ? '-25px' : '25px');
    bubble.innerHTML = '<span class="pro-tip-text">' + tip.text + '</span>';
    container.appendChild(bubble);
    var duration = 5500 + Math.random() * 2000;
    setTimeout(function() {
      var rect = bubble.getBoundingClientRect();
      var cx = rect.left + rect.width / 2;
      var cy = rect.top + rect.height / 2;
      bubble.classList.add('ProTip-out');
      spawnDust(cx, cy);
      setTimeout(function() {
        bubble.remove();
        var nextDelay = 25000 + Math.random() * 15000;
        setTimeout(showNextTip, nextDelay);
      }, 600);
    }, duration);
  }
  setTimeout(showNextTip, 8000);
}

function setupMechanicsSort() {
  document.querySelectorAll('.mechanics-sort-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      document.querySelectorAll('.mechanics-sort-btn').forEach(function(b) { b.classList.remove('active'); });
      btn.classList.add('active');
      var mode = btn.dataset.sort || 'default';
      if (window.PlayzoneMechanics) PlayzoneMechanics.setSortMode(mode);
      if (typeof renderFilteredMissions === 'function') renderFilteredMissions();
    });
  });
}

function forgeLogicEnhancements() {
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') {
      var mDetail = document.getElementById('missionDetailModal');
      if (mDetail && mDetail.style.display === 'flex') { mDetail.style.display = 'none'; return; }
      var modals = document.querySelectorAll('.chat-request-modal, .private-chat-window[style*="display: flex"], [data-forge-modal]');
      modals.forEach(function(m) {
        if (m.style.display === 'flex' || m.style.display === '') m.style.display = 'none';
      });
    }
    if (e.key === 'j' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      var target = e.target;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;
      var first = document.querySelector('.card-join-btn:not(:disabled)');
      if (first) { first.click(); e.preventDefault(); }
    }
  });
  var main = document.querySelector('.playzone-main');
  if (main) {
    document.querySelectorAll('.toggle-btn').forEach(function(btn) {
      btn.addEventListener('click', function() {
        main.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });
  }
}

async function checkUserMissionStatus() {
  if (!currentUser) return;
  try {
    const missionsRef = db.ref('missions');
    let foundMission = null;

    /**
     * Solo cuenta misión activa si sigues en participants.
     * Antes se usaba creatorUid: al abandonar seguías siendo creador en la misión pero ya no en participants,
     * y al abrir "Misión Activa" Firebase devolvía "no participas" → "Has salido" y se ocultaba el botón.
     */
    const joinedQuery = missionsRef.orderByChild(`participants/${currentUser.uid}`).startAt(0).limitToFirst(1);
    const joinedSnapshot = await joinedQuery.once('value');
    if (joinedSnapshot.exists()) {
      const key = Object.keys(joinedSnapshot.val())[0];
      const raw = joinedSnapshot.val()[key];
      if (raw && raw.participants && raw.participants[currentUser.uid]) {
        foundMission = { id: key, ...raw };
      }
    }

    const activeTabBtn = document.getElementById('tabActiveMission');
    if (foundMission) {
      userHasActiveMission = true;
      currentMissionId = foundMission.id;
      if (activeTabBtn) {
        activeTabBtn.style.display = 'block';
        activeTabBtn.innerHTML = '<i class="fas fa-satellite-dish fa-pulse"></i> Misión Activa';
      }
    } else {
      userHasActiveMission = false;
      currentMissionId = null;
      if (activeTabBtn) activeTabBtn.style.display = 'none';
    }
  } catch (error) { console.error("Error checking status:", error); }
}

function guessUserTimezoneGmt() {
  try {
    var offsetHours = -new Date().getTimezoneOffset() / 60;
    var rounded = Math.round(offsetHours * 2) / 2;
    var sign = rounded >= 0 ? '+' : '';
    return 'GMT' + sign + rounded;
  } catch (e) {
    return 'GMT-5';
  }
}

/** Usuarios que ya completaron onboarding antes de playZoneWelcomeSeen: no mostrar tips. */
function maybeMarkPlayZoneWelcomeSeen() {
  if (!currentUser || !currentUserData || currentUserData.playZoneWelcomeSeen) return;
  if (!currentUserData.playZoneOnboardingComplete) return;
  currentUserData.playZoneWelcomeSeen = true;
  db.ref('users/' + currentUser.uid + '/playZoneWelcomeSeen').set(true).catch(function() {});
}

// === 6. ONBOARDING FLOW (rápido: juego + idioma) ===
function setupOnboardingFlow() {
  const onboardingModal = document.getElementById('playzone-onboarding');
  const steps = Array.from(onboardingModal.querySelectorAll('.onboarding-step'));
  const nextButtons = onboardingModal.querySelectorAll('.next-step-btn');
  const backButtons = onboardingModal.querySelectorAll('.back-step-btn');
  let currentStep = 0;
  const onboardingData = {
    playStyle: 'Both',
    mainLanguage: null,
    mainGame: null,
    secondaryGames: [],
    timezone: guessUserTimezoneGmt(),
    country: ''
  };

  function showStep(stepIndex) {
    steps.forEach((step, index) => step.classList.toggle('active', index === stepIndex));
    currentStep = stepIndex;
  }

  nextButtons.forEach(btn => {
    btn.addEventListener('click', () => showStep(currentStep + 1));
  });
  backButtons.forEach(btn => btn.addEventListener('click', () => showStep(currentStep - 1)));

  const mainGameStep = document.getElementById('step-main-game');
  const languageStep = document.getElementById('step-language');
  const mainGameCards = onboardingModal.querySelectorAll('.game-card');
  const otherGameInput = document.getElementById('onboarding-main-game-other');
  mainGameCards.forEach(card => {
    card.addEventListener('click', () => {
      mainGameCards.forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      onboardingData.mainGame = card.dataset.value;
      if (card.dataset.value === 'Otro') {
        otherGameInput.style.display = 'block';
        otherGameInput.required = true;
        mainGameStep.querySelector('.next-step-btn').disabled = true;
      } else {
        otherGameInput.style.display = 'none';
        mainGameStep.querySelector('.next-step-btn').disabled = false;
      }
    });
  });
  otherGameInput.addEventListener('input', () => {
    onboardingData.mainGame = otherGameInput.value.trim();
    mainGameStep.querySelector('.next-step-btn').disabled = otherGameInput.value.trim().length < 2;
  });

  const languageSelect = document.getElementById('onboarding-language');
  const finishBtn = document.getElementById('finish-onboarding-btn');
  languageSelect.addEventListener('change', () => {
    onboardingData.mainLanguage = languageSelect.value;
    finishBtn.disabled = !languageSelect.value;
  });

  finishBtn.addEventListener('click', saveOnboardingData);

  async function saveOnboardingData() {
    finishBtn.disabled = true;
    finishBtn.innerHTML = '<span>Guardando...</span>';
    const updates = {};
    updates[`/users/${currentUser.uid}/playStyle`] = onboardingData.playStyle;
    updates[`/users/${currentUser.uid}/mainLanguage`] = onboardingData.mainLanguage;
    updates[`/users/${currentUser.uid}/mainGame`] = onboardingData.mainGame;
    updates[`/users/${currentUser.uid}/secondaryGames`] = onboardingData.secondaryGames;
    updates[`/users/${currentUser.uid}/timezone`] = onboardingData.timezone;
    updates[`/users/${currentUser.uid}/playZoneOnboardingComplete`] = true;
    updates[`/users/${currentUser.uid}/playZoneWelcomeSeen`] = true;

    try {
      await db.ref().update(updates);
      currentUserData.playZoneOnboardingComplete = true;
      currentUserData.playZoneWelcomeSeen = true;
      currentUserData.mainGame = onboardingData.mainGame;
      currentUserData.mainLanguage = onboardingData.mainLanguage;
      showStep(steps.length - 1);
      setTimeout(() => {
        onboardingModal.style.display = 'none';
        document.body.style.overflow = 'auto';
        document.querySelector('header').style.display = 'flex';
        document.querySelector('.playzone-main').style.display = 'block';
        initializeApp();
      }, 2800);
    } catch (error) {
      console.error(error);
      finishBtn.disabled = false;
      finishBtn.innerHTML = '<span>Entrar a PlayZone</span> <i class="fas fa-check"></i>';
    }
  }
}
/* --- FIN PARTE 1 --- */
/* ======== CÓDIGO PARA playzone.js - PARTE 2 DE 3 ======== */

// === 7. LÓGICA DE CREAR MISIÓN ===
function setupCreatorGameCards() {
  setupCreatorGamePicker();
}
function setupCreatorGamePicker() {
  var trigger = document.getElementById('creatorGameTrigger');
  var modal = document.getElementById('creatorGameModal');
  var grid = document.getElementById('creatorGameModalGrid');
  var hidden = document.getElementById('missionGame');
  var selectedText = document.getElementById('creatorGameSelected');
  var selectedImg = document.getElementById('creatorGameSelectedImg');
  if (!trigger || !modal || !grid || !hidden) return;
  var games = (window.PlayzoneGames && window.PlayzoneGames.all) || [
    { id: 'Counter-Strike 2', img: 'cs2.jpg' }, { id: 'Valorant', img: 'Valorant.jpg' },
    { id: 'League of Legends', img: 'LoL.jpg' }, { id: 'Apex Legends', img: 'apex-legends.jpg' },
    { id: 'Fortnite', img: 'fortnite.jpg' }, { id: 'Rocket League', img: 'Rocket-league.jpg' },
    { id: 'GTA V', img: 'gta-5.jpg' }, { id: 'Otro', img: 'default-game.jpg' }
  ];
  function getImg(id) {
    var g = games.find(function(x) { return x.id === id; });
    return '/img_playzone/' + (g ? g.img : 'default-game.jpg');
  }
  var closeBtn = modal.querySelector('.creator-game-modal-close');
  var backdrop = modal.querySelector('.creator-game-modal-backdrop');
  function openModal(e) {
    if (e) { e.preventDefault(); e.stopPropagation(); }
    modal.classList.add('is-open');
    trigger.setAttribute('aria-expanded', 'true');
    document.body.style.overflow = 'hidden';
  }
  function closeModal() {
    modal.classList.remove('is-open');
    trigger.setAttribute('aria-expanded', 'false');
    document.body.style.overflow = '';
  }
  function selectGame(g) {
    hidden.value = g.id;
    hidden.dispatchEvent(new Event('change'));
    selectedText.textContent = g.id;
    selectedText.innerHTML = '<i class="fas fa-check-circle"></i> ' + g.id;
    trigger.classList.add('has-selection');
    if (g.id !== 'Otro') {
      selectedImg.style.display = 'block';
      selectedImg.src = getImg(g.id);
      selectedImg.alt = g.id;
    } else {
      selectedImg.style.display = 'none';
    }
    if (typeof creatorValidateField === 'function') creatorValidateField('game', g.id);
    if (typeof creatorValidateForm === 'function') creatorValidateForm();
    closeModal();
  }
  grid.innerHTML = '';
  games.forEach(function(g) {
    var card = document.createElement('div');
    card.className = 'creator-game-modal-card';
    card.dataset.value = g.id;
    if (g.id === 'Otro') {
      card.innerHTML = '<div class="game-img-wrap"><div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#2a2520,#1a1612);"><i class="fas fa-plus-circle" style="font-size:2.5rem;color:#8b6914;"></i></div></div><span>' + g.id + '</span>';
    } else {
      card.innerHTML = '<div class="game-img-wrap"><img src="' + getImg(g.id) + '" alt="' + g.id + '" onerror="this.src=\'/img_playzone/default-game.jpg\'"></div><span>' + g.id + '</span>';
    }
    card.addEventListener('click', function() { selectGame(g); });
    grid.appendChild(card);
  });
  trigger.addEventListener('click', openModal);
  if (closeBtn) closeBtn.addEventListener('click', closeModal);
  if (backdrop) backdrop.addEventListener('click', closeModal);
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape' && modal.classList.contains('is-open')) closeModal();
  });
  function updateTriggerFromValue() {
    var v = hidden.value;
    if (!v) {
      selectedText.innerHTML = '<i class="fas fa-gamepad"></i> Selecciona un juego';
      trigger.classList.remove('has-selection');
      selectedImg.style.display = 'none';
    } else {
      var gg = games.find(function(x) { return x.id === v; });
      if (gg) {
        selectedText.innerHTML = '<i class="fas fa-check-circle"></i> ' + v;
        trigger.classList.add('has-selection');
        if (v !== 'Otro') {
          selectedImg.style.display = 'block';
          selectedImg.src = getImg(v);
          selectedImg.alt = v;
        } else selectedImg.style.display = 'none';
      }
    }
  }
  hidden.addEventListener('change', updateTriggerFromValue);
  var current = hidden.value;
  if (current) updateTriggerFromValue();
  window._playzoneCreatorSelectGame = function(gameId, silent) {
    var g = games.find(function(x) { return x.id === gameId; });
    if (!g) return;
    if (silent) {
      hidden.value = g.id;
      selectedText.innerHTML = '<i class="fas fa-check-circle"></i> ' + g.id;
      trigger.classList.add('has-selection');
      if (g.id !== 'Otro') {
        selectedImg.style.display = 'block';
        selectedImg.src = getImg(g.id);
        selectedImg.alt = g.id;
      } else {
        selectedImg.style.display = 'none';
      }
      return;
    }
    selectGame(g);
  };
}
window.playzoneSelectCreatorGame = function(gameId, silent) {
  if (typeof window._playzoneCreatorSelectGame === 'function') window._playzoneCreatorSelectGame(gameId, silent);
};

function updateCreatorTokensBadge() {
  var badge = document.getElementById('creatorTokensBadge');
  var span = document.getElementById('creatorTokensBalance');
  if (!badge || !span) return;
  var tokens = (typeof currentUserData !== 'undefined' && currentUserData && typeof currentUserData.tokens === 'number') ? currentUserData.tokens : 0;
  span.textContent = tokens;
  badge.classList.toggle('low', tokens === 0);
}

/* === CREADOR: 100 MEJORAS DE LÓGICA === */
var creatorValidationState = {};
var CREATOR_DRAFT_KEY = 'playzone_creator_draft';

var CREATOR_PREMADE_TEMPLATES = {
  cs2_friends: {
    id: 'cs2_friends',
    icon: 'fab fa-steam',
    title: 'Partida Cooperativa CS2',
    summary: 'Solo eliges el horario. Todos los participantes ganan 5 tokens al completar.',
    tag: 'Creación rápida',
    game: 'Counter-Strike 2',
    type: 'Friends',
    skill: 'Cualquiera',
    maxParticipants: 5,
    quick: true
  },
  coop_openworld: {
    id: 'coop_openworld',
    icon: 'fas fa-handshake',
    title: 'Co-op Mundo Abierto',
    summary: 'ARK, survival, sandbox... Elige juego y horario. Juega en equipo y confirma en el Nexus.',
    tag: 'Cooperativa',
    game: '',
    type: 'Cooperativo',
    skill: 'Cualquiera',
    maxParticipants: 4,
    quick: false
  }
};

function creatorGetNick() {
  return (typeof currentUserData !== 'undefined' && currentUserData && currentUserData.nick) ? currentUserData.nick : 'Usuario';
}

function creatorIsQuickMode() {
  return !!((document.getElementById('creatorPremadeTemplate') || {}).value || '').trim();
}

function buildCs2PremadeCopy(comment) {
  var nick = creatorGetNick();
  var title = CS2_FRIENDS_DISPLAY_TITLE;
  var desc = 'Misión preconfigurada de Counter-Strike 2 iniciada por ' + nick + '. Plantilla pre-made: juega en equipo Premier/Competitivo, verifica la partida con Steam y todos los que participen y completen la misión se llevan 5 tokens. Nivel abierto — cualquiera puede unirse.';
  var note = (comment || '').trim();
  if (note) desc += ' Comentario del anfitrión: ' + note;
  if (desc.length > 200) desc = desc.slice(0, 197) + '...';
  return { title: title, description: desc };
}

function buildCoopOpenworldCopy(comment) {
  var nick = creatorGetNick();
  var title = 'Sesión Cooperativa Mundo Abierto';
  var desc = 'Misión cooperativa iniciada por ' + nick + '. Juega en equipo (mundo abierto, survival, sandbox). Todos deben confirmar la finalización en el Nexus.';
  var note = (comment || '').trim();
  if (note) desc += ' Detalles: ' + note;
  if (desc.length > 200) desc = desc.slice(0, 197) + '...';
  return { title: title, description: desc };
}

function creatorSyncQuickSchedule() {
  var quick = document.getElementById('missionScheduleQuick');
  var standard = document.getElementById('missionSchedule');
  if (quick && standard) standard.value = quick.value || '';
}

function creatorApplyPremadeFields(tpl, comment) {
  if (!tpl) return;
  var set = function(id, v) { var el = document.getElementById(id); if (el && v != null) el.value = v; };
  var hiddenGame = document.getElementById('missionGame');
  if (tpl.game) {
    if (!hiddenGame || hiddenGame.value !== tpl.game) {
      if (typeof window.playzoneSelectCreatorGame === 'function') {
        window.playzoneSelectCreatorGame(tpl.game, true);
      } else {
        set('missionGame', tpl.game);
      }
    }
  }
  set('missionType', tpl.type);
  set('missionSkill', tpl.skill);
  set('missionMaxParticipants', String(tpl.maxParticipants));
  var copy = (tpl.id === 'cs2_friends') ? buildCs2PremadeCopy(comment)
    : (tpl.id === 'coop_openworld') ? buildCoopOpenworldCopy(comment)
    : { title: tpl.title, description: tpl.summary };
  set('missionTitle', copy.title);
  set('missionDescription', copy.description);
  var tc = document.getElementById('titleCharCount');
  var dc = document.getElementById('descCharCount');
  if (tc) tc.textContent = (copy.title || '').length + '/60';
  if (dc) dc.textContent = (copy.description || '').length + '/200';
  creatorSetCharCountClasses();
}

function creatorSetQuickModeUI(active, templateId) {
  var quickPanel = document.getElementById('creatorQuickPanel');
  var standardGrid = document.getElementById('creatorStandardGrid');
  var hiddenTpl = document.getElementById('creatorPremadeTemplate');
  var submitBtn = document.getElementById('creatorSubmitBtn');
  var quickSched = document.getElementById('missionScheduleQuick');
  var stdSched = document.getElementById('missionSchedule');
  if (hiddenTpl) hiddenTpl.value = active ? (templateId || '') : '';
  if (quickPanel) quickPanel.style.display = active ? 'block' : 'none';
  if (standardGrid) standardGrid.style.display = active ? 'none' : '';
  if (quickSched) {
    if (active) quickSched.setAttribute('required', 'required');
    else quickSched.removeAttribute('required');
  }
  if (stdSched) {
    if (active) stdSched.removeAttribute('required');
    else stdSched.setAttribute('required', 'required');
  }
  if (submitBtn) {
    submitBtn.innerHTML = active
      ? '<i class="fas fa-bolt"></i> Lanzar misión rápida'
      : '<i class="fas fa-rocket"></i> Lanzar Misión';
  }
  if (active && quickSched) {
    if (!quickSched.value && stdSched && stdSched.value) quickSched.value = stdSched.value;
    if (!quickSched.value) {
      var now = new Date();
      now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
      quickSched.value = now.toISOString().slice(0, 16);
    }
    creatorSyncQuickSchedule();
  }
}

function creatorExitQuickMode() {
  creatorSetQuickModeUI(false);
  creatorValidateForm();
  creatorUpdateProgress();
}

function applyPremadeTemplate(templateId) {
  var tpl = CREATOR_PREMADE_TEMPLATES[templateId];
  if (!tpl) return;
  creatorSetQuickModeUI(!!tpl.quick, templateId);
  creatorApplyPremadeFields(tpl, (document.getElementById('missionQuickComment') || {}).value || '');
  creatorValidateForm();
  creatorUpdateProgress();
  if (typeof updateCreatorEstimate === 'function') updateCreatorEstimate();
}

function setupPremadeMissions() {
  var openBtn = document.getElementById('creatorPremadeBtn');
  var modal = document.getElementById('creatorPremadeModal');
  var grid = document.getElementById('creatorPremadeGrid');
  var exitBtn = document.getElementById('creatorExitQuickMode');
  if (!modal || !grid) return;

  function closePremadeModal() {
    modal.classList.remove('is-open');
    document.body.style.overflow = '';
  }
  function openPremadeModal() {
    modal.classList.add('is-open');
    document.body.style.overflow = 'hidden';
  }

  grid.innerHTML = '';
  Object.keys(CREATOR_PREMADE_TEMPLATES).forEach(function(key) {
    var tpl = CREATOR_PREMADE_TEMPLATES[key];
    var card = document.createElement('button');
    card.type = 'button';
    card.className = 'creator-premade-card';
    card.innerHTML = '<div class="creator-premade-card-icon"><i class="' + tpl.icon + '"></i></div>' +
      '<div class="creator-premade-card-body"><h4>' + tpl.title + '</h4><p>' + tpl.summary + '</p>' +
      '<span class="creator-premade-card-tag">' + tpl.tag + '</span></div>';
    card.addEventListener('click', function() {
      applyPremadeTemplate(tpl.id);
      closePremadeModal();
      showFloatingMessage('success', 'Plantilla aplicada. Solo elige el horario y lanza.');
    });
    grid.appendChild(card);
  });

  if (openBtn) openBtn.addEventListener('click', openPremadeModal);
  modal.querySelector('.creator-premade-modal-close')?.addEventListener('click', closePremadeModal);
  modal.querySelector('.creator-premade-modal-backdrop')?.addEventListener('click', closePremadeModal);
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape' && modal.classList.contains('is-open')) closePremadeModal();
  });
  if (exitBtn) exitBtn.addEventListener('click', creatorExitQuickMode);

  var quickSched = document.getElementById('missionScheduleQuick');
  if (quickSched) {
    quickSched.addEventListener('change', function() {
      creatorSyncQuickSchedule();
      creatorValidateField('scheduleQuick', this.value);
      creatorValidateForm();
    });
    quickSched.addEventListener('blur', function() {
      creatorValidateField('scheduleQuick', this.value);
    });
  }
  var quickComment = document.getElementById('missionQuickComment');
  if (quickComment) {
    quickComment.addEventListener('input', function() {
      var cc = document.getElementById('quickCommentCharCount');
      if (cc) cc.textContent = (this.value || '').length + '/120';
      var tpl = CREATOR_PREMADE_TEMPLATES[(document.getElementById('creatorPremadeTemplate') || {}).value];
      if (tpl) creatorApplyPremadeFields(tpl, this.value);
      creatorUpdateProgress();
    });
  }
}

function creatorUpdateProgress() {
  if (creatorIsQuickMode()) {
    var qSched = (document.getElementById('missionScheduleQuick') || {}).value;
    var filled = qSched ? 9 : 8;
    var pct = Math.round((filled / 9) * 100);
    var fillEl = document.getElementById('creatorProgressFill');
    var textEl = document.getElementById('creatorProgressText');
    if (fillEl) fillEl.style.width = pct + '%';
    if (textEl) {
      textEl.textContent = pct + '% completado';
      textEl.classList.toggle('complete', pct === 100);
    }
    return;
  }
  var total = 7;
  var filled = 0;
  if ((document.getElementById('missionGame') || {}).value) filled++;
  if ((document.getElementById('missionType') || {}).value) filled++;
  if ((document.getElementById('missionSkill') || {}).value) filled++;
  var mp = parseInt((document.getElementById('missionMaxParticipants') || {}).value) || 0;
  if (mp >= 2 && mp <= 10) filled++;
  var t = (document.getElementById('missionTitle') || {}).value || '';
  if (t.trim().length >= 3 && t.trim().length <= 60) filled++;
  if ((document.getElementById('missionSchedule') || {}).value) filled++;
  filled++;
  var pct = Math.round((filled / total) * 100);
  var fillEl = document.getElementById('creatorProgressFill');
  var textEl = document.getElementById('creatorProgressText');
  if (fillEl) { fillEl.style.width = pct + '%'; }
  if (textEl) {
    textEl.textContent = pct + '% completado';
    textEl.classList.toggle('complete', pct === 100);
  }
}

function creatorShowError(elId, msg) {
  var el = document.getElementById(elId);
  if (!el) return;
  el.style.display = msg ? 'block' : 'none';
  el.textContent = msg || '';
}

function creatorSetInputState(inputId, state) {
  var inp = document.querySelector('#' + inputId);
  if (!inp) return;
  inp.classList.remove('creator-valid', 'creator-invalid');
  if (state === 'valid') inp.classList.add('creator-valid');
  if (state === 'invalid') inp.classList.add('creator-invalid');
}

function creatorValidateField(field, value) {
  var err = null;
  var inp = null;
  if (field === 'game') {
    inp = document.getElementById('missionGame');
    if (!value || !value.trim()) err = 'Selecciona un juego';
    creatorShowError('creatorGameErr', err);
    document.getElementById('creatorGameErr')?.closest('.creator-section')?.classList.toggle('creator-has-error', !!err);
  } else if (field === 'type') {
    inp = document.getElementById('missionType');
    if (!value) err = 'Selecciona un tipo';
    creatorSetInputState('missionType', err ? 'invalid' : 'valid');
  } else if (field === 'skill') {
    inp = document.getElementById('missionSkill');
    creatorSetInputState('missionSkill', 'valid');
  } else if (field === 'maxParticipants') {
    var n = parseInt(value) || 0;
    inp = document.getElementById('missionMaxParticipants');
    if (n < 2 || n > 10) err = 'Debe estar entre 2 y 10';
    creatorShowError('creatorMaxErr', err);
    creatorSetInputState('missionMaxParticipants', err ? 'invalid' : 'valid');
  } else if (field === 'title') {
    var t = (value || '').trim();
    inp = document.getElementById('missionTitle');
    if (t.length < 3) err = 'Mínimo 3 caracteres';
    else if (t.length > 60) err = 'Máximo 60 caracteres';
    creatorShowError('creatorTitleErr', err);
    creatorSetInputState('missionTitle', err ? 'invalid' : (t.length >= 3 ? 'valid' : ''));
  } else if (field === 'schedule') {
    var d = value ? new Date(value) : null;
    inp = document.getElementById('missionSchedule');
    if (!value) err = 'Indica un horario';
    else if (d && d.getTime() < Date.now() - 60000) err = 'El horario no puede ser en el pasado';
    creatorShowError('creatorScheduleErr', err);
    creatorSetInputState('missionSchedule', err ? 'invalid' : 'valid');
  } else if (field === 'scheduleQuick') {
    var dq = value ? new Date(value) : null;
    inp = document.getElementById('missionScheduleQuick');
    if (!value) err = 'Indica un horario';
    else if (dq && dq.getTime() < Date.now() - 60000) err = 'El horario no puede ser en el pasado';
    creatorShowError('creatorScheduleQuickErr', err);
    creatorSetInputState('missionScheduleQuick', err ? 'invalid' : 'valid');
    creatorSyncQuickSchedule();
    if (!err && value) creatorValidateField('schedule', value);
  } else if (field === 'tokenPrize') {
    return true;
  }
  creatorUpdateProgress();
  return !err;
}

function creatorValidateForm() {
  if (creatorIsQuickMode()) {
    creatorSyncQuickSchedule();
    var schedQ = (document.getElementById('missionScheduleQuick') || {}).value;
    var valid = !!schedQ;
    if (schedQ) {
      var dq = new Date(schedQ);
      if (dq.getTime() < Date.now() - 60000) valid = false;
    }
    var btn = document.getElementById('creatorSubmitBtn');
    if (btn) btn.disabled = !valid;
    creatorUpdateProgress();
    return valid;
  }
  var game = (document.getElementById('missionGame') || {}).value;
  var type = (document.getElementById('missionType') || {}).value;
  var skill = (document.getElementById('missionSkill') || {}).value;
  var maxP = parseInt((document.getElementById('missionMaxParticipants') || {}).value) || 0;
  var title = ((document.getElementById('missionTitle') || {}).value || '').trim();
  var sched = (document.getElementById('missionSchedule') || {}).value;
  var valid = !!game && !!type && skill !== '' && maxP >= 2 && maxP <= 10 && title.length >= 3 && title.length <= 60 && sched;
  if (sched) {
    var d = new Date(sched);
    if (d.getTime() < Date.now() - 60000) valid = false;
  }
  var btn = document.getElementById('creatorSubmitBtn');
  if (btn) btn.disabled = !valid;
  creatorUpdateProgress();
  return valid;
}

function creatorSaveDraft() {
  try {
    var data = {
      game: (document.getElementById('missionGame') || {}).value,
      type: (document.getElementById('missionType') || {}).value,
      skill: (document.getElementById('missionSkill') || {}).value,
      maxParticipants: (document.getElementById('missionMaxParticipants') || {}).value,
      title: (document.getElementById('missionTitle') || {}).value,
      schedule: (document.getElementById('missionSchedule') || {}).value,
      tokenPrize: (document.getElementById('missionTokenPrize') || {}).value,
      description: (document.getElementById('missionDescription') || {}).value,
      savedAt: Date.now()
    };
    localStorage.setItem(CREATOR_DRAFT_KEY, JSON.stringify(data));
    var wrap = document.getElementById('creatorDraftActions');
    if (wrap) wrap.style.display = 'block';
    showFloatingMessage('success', 'Borrador guardado.');
  } catch (e) { showFloatingMessage('error', 'Error al guardar borrador.'); }
}

function creatorRestoreDraft() {
  try {
    var raw = localStorage.getItem(CREATOR_DRAFT_KEY);
    if (!raw) return;
    var data = JSON.parse(raw);
    var g = document.getElementById('missionGame');
    if (g && data.game) {
      g.value = data.game;
      g.dispatchEvent(new Event('change'));
    }
    var set = function(id, v) { var el = document.getElementById(id); if (el && v != null) el.value = v; };
    set('missionType', data.type);
    set('missionSkill', data.skill);
    set('missionMaxParticipants', data.maxParticipants);
    set('missionTitle', data.title);
    set('missionSchedule', data.schedule);
    set('missionTokenPrize', data.tokenPrize);
    set('missionDescription', data.description);
    creatorValidateForm();
    creatorUpdateProgress();
    var tc = document.getElementById('titleCharCount');
    if (tc && data.title) tc.textContent = (data.title || '').length + '/60';
    var dc = document.getElementById('descCharCount');
    if (dc && data.description) dc.textContent = (data.description || '').length + '/200';
    creatorSetCharCountClasses();
    showFloatingMessage('success', 'Borrador restaurado.');
  } catch (e) { showFloatingMessage('error', 'Error al restaurar.'); }
}

function creatorSetCharCountClasses() {
  var tl = ((document.getElementById('missionTitle') || {}).value || '').length;
  var dl = ((document.getElementById('missionDescription') || {}).value || '').length;
  var tc = document.getElementById('titleCharCount');
  var dc = document.getElementById('descCharCount');
  if (tc) {
    tc.classList.remove('near-limit', 'at-limit');
    if (tl >= 55) tc.classList.add('near-limit');
    if (tl >= 60) tc.classList.add('at-limit');
  }
  if (dc) {
    dc.classList.remove('near-limit', 'at-limit');
    if (dl >= 180) dc.classList.add('near-limit');
    if (dl >= 200) dc.classList.add('at-limit');
  }
}

function creatorShowPreview() {
  if (creatorIsQuickMode()) {
    creatorSyncQuickSchedule();
    var tpl = CREATOR_PREMADE_TEMPLATES[(document.getElementById('creatorPremadeTemplate') || {}).value];
    if (tpl) creatorApplyPremadeFields(tpl, (document.getElementById('missionQuickComment') || {}).value || '');
  }
  if (!creatorValidateForm()) {
    showFloatingMessage('error', 'Completa todos los campos requeridos antes de ver la vista previa.');
    return;
  }
  var game = (document.getElementById('missionGame') || {}).value;
  var type = (document.getElementById('missionType') || {}).value;
  var skill = (document.getElementById('missionSkill') || {}).value;
  var maxP = (document.getElementById('missionMaxParticipants') || {}).value;
  var title = (document.getElementById('missionTitle') || {}).value;
  var sched = (document.getElementById('missionSchedule') || {}).value;
  var desc = (document.getElementById('missionDescription') || {}).value;
  var rewardLabel = '5 tokens/jugador';
  var schedStr = sched ? new Date(sched).toLocaleString('es-ES', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
  var body = document.getElementById('creatorPreviewBody');
  if (body) {
    body.innerHTML = '<div class="preview-row"><span class="preview-label">Juego</span><span class="preview-val">' + (game || '—') + '</span></div>' +
      '<div class="preview-row"><span class="preview-label">Tipo</span><span class="preview-val">' + (type || '—') + '</span></div>' +
      '<div class="preview-row"><span class="preview-label">Nivel</span><span class="preview-val">' + (skill || '—') + '</span></div>' +
      '<div class="preview-row"><span class="preview-label">Jugadores</span><span class="preview-val">' + maxP + '</span></div>' +
      '<div class="preview-row"><span class="preview-label">Título</span><span class="preview-val">' + (title || '—') + '</span></div>' +
      '<div class="preview-row"><span class="preview-label">Horario</span><span class="preview-val">' + schedStr + '</span></div>' +
      '<div class="preview-row"><span class="preview-label">Premio</span><span class="preview-val">' + rewardLabel + '</span></div>' +
      '<div class="preview-row"><span class="preview-label">Descripción</span><span class="preview-val">' + (desc || '—') + '</span></div>';
  }
  var modal = document.getElementById('creatorPreviewModal');
  if (modal) modal.style.display = 'flex';
}

function creatorClosePreview() {
  var modal = document.getElementById('creatorPreviewModal');
  if (modal) modal.style.display = 'none';
}

function setupMissionCreator() {
  var form = document.getElementById('createMissionForm');
  if (!form) return;

  if (typeof setupCreatorGameCards === 'function') setupCreatorGameCards();
  if (typeof setupPremadeMissions === 'function') setupPremadeMissions();
  if (typeof updateCreatorTokensBadge === 'function') updateCreatorTokensBadge();
  form.addEventListener('focusin', function() { if (typeof updateCreatorTokensBadge === 'function') updateCreatorTokensBadge(); });

  var titleInput = document.getElementById('missionTitle');
  var descInput = document.getElementById('missionDescription');
  var titleCount = document.getElementById('titleCharCount');
  var descCount = document.getElementById('descCharCount');
  if (titleInput && titleCount) {
    titleInput.addEventListener('input', function() {
      titleCount.textContent = (this.value || '').length + '/60';
      creatorSetCharCountClasses();
      creatorValidateField('title', this.value);
      creatorValidateForm();
    });
  }
  if (descInput && descCount) {
    descInput.addEventListener('input', function() {
      descCount.textContent = (this.value || '').length + '/200';
      creatorSetCharCountClasses();
      creatorUpdateProgress();
    });
  }

  var schedInput = document.getElementById('missionSchedule');
  if (schedInput && !schedInput.value) {
    var now = new Date();
    now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
    schedInput.value = now.toISOString().slice(0, 16);
  }
  var fieldMap = { missionType: 'type', missionSkill: 'skill', missionMaxParticipants: 'maxParticipants', missionSchedule: 'schedule', missionTokenPrize: 'tokenPrize' };
  ['missionType', 'missionSkill', 'missionMaxParticipants', 'missionSchedule', 'missionTokenPrize'].forEach(function(id) {
    var el = document.getElementById(id);
    var f = fieldMap[id];
    if (el && f) {
      el.addEventListener('change', function() {
        creatorValidateField(f, this.value);
        creatorValidateForm();
      });
      el.addEventListener('blur', function() {
        creatorValidateField(f, this.value);
      });
    }
  });
  var mpEl = document.getElementById('missionMaxParticipants');
  if (mpEl) mpEl.addEventListener('input', forgeDebounce(function() { creatorValidateField('maxParticipants', mpEl.value); creatorValidateForm(); }, 200));
  var tokEl = document.getElementById('missionTokenPrize');
  if (tokEl) tokEl.addEventListener('input', forgeDebounce(function() { creatorValidateField('tokenPrize', tokEl.value); creatorValidateForm(); }, 200));

  var hiddenGame = document.getElementById('missionGame');
  if (hiddenGame) hiddenGame.addEventListener('change', function() { creatorValidateForm(); updateCreatorEstimate(); });

  // Estimado en vivo (tiempo + tope de tokens) dentro del creador.
  function updateCreatorEstimate() {
    if (!window.PlayzoneSmart) return;
    var box = document.getElementById('creatorSmartEstimate');
    if (!box) return;
    var est = PlayzoneSmart.estimate({
      game: (document.getElementById('missionGame') || {}).value,
      type: (document.getElementById('missionType') || {}).value,
      skill: (document.getElementById('missionSkill') || {}).value,
      maxParticipants: (document.getElementById('missionMaxParticipants') || {}).value
    });
    box.innerHTML = '<i class="fas fa-stopwatch"></i> Duración estimada: <strong>' +
      PlayzoneSmart.formatDuration(est.estMinutes) + '</strong>' +
      ' &nbsp;·&nbsp; <i class="fas fa-coins"></i> Recompensa: <strong>5 tokens/jugador</strong>';
  }
  if (window.PlayzoneSmart && !document.getElementById('creatorSmartEstimate')) {
    var estBox = document.createElement('div');
    estBox.id = 'creatorSmartEstimate';
    estBox.className = 'creator-smart-estimate';
    estBox.style.cssText = 'margin:10px 0;padding:8px 12px;border-radius:8px;font-size:0.85rem;color:#ddd;background:rgba(255,59,59,0.08);border:1px solid rgba(255,59,59,0.25);';
    var launchBtn = form.querySelector('.launch-mission-btn');
    if (launchBtn && launchBtn.parentNode) launchBtn.parentNode.insertBefore(estBox, launchBtn);
    else form.appendChild(estBox);
    form.addEventListener('input', updateCreatorEstimate);
    form.addEventListener('change', updateCreatorEstimate);
    updateCreatorEstimate();
  }

  document.getElementById('creatorSaveDraft')?.addEventListener('click', creatorSaveDraft);
  document.getElementById('creatorRestoreDraft')?.addEventListener('click', creatorRestoreDraft);
  document.getElementById('creatorPreviewBtn')?.addEventListener('click', creatorShowPreview);
  document.getElementById('creatorPreviewClose')?.addEventListener('click', creatorClosePreview);
  document.getElementById('creatorPreviewEdit')?.addEventListener('click', function() { creatorClosePreview(); });
  document.getElementById('creatorPreviewConfirm')?.addEventListener('click', function() {
    creatorClosePreview();
    form.dispatchEvent(new Event('submit', { cancelable: true }));
  });

  if (localStorage.getItem(CREATOR_DRAFT_KEY)) {
    var wrap = document.getElementById('creatorDraftActions');
    if (wrap) wrap.style.display = 'block';
  }
  creatorValidateForm();
  creatorUpdateProgress();
  creatorSetCharCountClasses();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!currentUser || !currentUserData) {
      showFloatingMessage('error', 'Debes estar logueado.');
      return;
    }

    if (creatorIsQuickMode()) {
      creatorSyncQuickSchedule();
      var tplId = (document.getElementById('creatorPremadeTemplate') || {}).value;
      var tpl = CREATOR_PREMADE_TEMPLATES[tplId];
      if (tpl) creatorApplyPremadeFields(tpl, (document.getElementById('missionQuickComment') || {}).value || '');
      if (!creatorValidateForm()) {
        showFloatingMessage('error', 'Elige un horario válido para lanzar la misión.');
        return;
      }
    }

    const submitBtn = form.querySelector('.launch-mission-btn');
    const maxParticipants = parseInt(document.getElementById('missionMaxParticipants').value) || 5;
    const missionTypeVal = document.getElementById('missionType').value;
    const missionGameVal = document.getElementById('missionGame').value;
    const isFriendsCs2 = missionTypeVal === 'Friends' && String(missionGameVal).toLowerCase().indexOf('counter-strike') !== -1;

    let appliedTokenPrize = 0;
    const rewardPerPlayer = 5;
    let smartEst = null;
    if (window.PlayzoneSmart) {
      smartEst = PlayzoneSmart.estimate({
        game: document.getElementById('missionGame').value,
        type: document.getElementById('missionType').value,
        skill: document.getElementById('missionSkill').value,
        maxParticipants: maxParticipants
      });
    }

    if (isFriendsCs2) {
      // Sin costo al crear; 5 tokens/jugador al verificar la partida (Studiosgamesrs).
    }

    submitBtn.disabled = true;
    submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Creando...';

    const creatorInfo = {
        nick: currentUserData.nick || 'Usuario',
        photoURL: currentUserData.photoURL || 'dragon_profile_studiosgamesrs.png',
        joinedAt: firebase.database.ServerValue.TIMESTAMP,
        rank: currentUserData.rango || 'Tribal Warrior'
    };

    const missionData = {
      game: document.getElementById('missionGame').value,
      type: document.getElementById('missionType').value,
      skill: document.getElementById('missionSkill').value,
      title: document.getElementById('missionTitle').value,
      schedule: document.getElementById('missionSchedule').value,
      description: document.getElementById('missionDescription').value,
      maxParticipants: maxParticipants,
      tokenPrize: appliedTokenPrize,
      estMinutes: smartEst ? smartEst.estMinutes : null,
      estDifficulty: smartEst ? smartEst.difficulty : null,
      recommendedTokens: smartEst ? smartEst.recommendedTokens : null,
      tokenCap: smartEst ? smartEst.tokenCap : null,
      status: 'pending',
      platform: 'PC', // POR DEFECTO: Asumimos PC por ahora (se puede mejorar después)
      creatorUid: currentUser.uid,
      creatorNick: currentUserData.nick || 'Usuario',
      creatorAvatar: currentUserData.photoURL || 'dragon_profile_studiosgamesrs.png',
      createdAt: firebase.database.ServerValue.TIMESTAMP,
      participants: { [currentUser.uid]: creatorInfo },
      commentsCount: 0,
      sponsoredReward: true,
      rewardPerPlayer: rewardPerPlayer
    };

    if (isFriendsCs2) {
      missionData.verificationMode = 'cs2_steam';
      missionData.rewardPerPlayer = rewardPerPlayer;
      missionData.friendsOnly = true;
      missionData.sponsoredReward = true;
      missionData.tokenPrize = 0;
      missionData.platform = 'Steam';
      missionData.displayTitle = CS2_FRIENDS_DISPLAY_TITLE;
    }
    if (creatorIsQuickMode()) {
      missionData.premadeTemplate = (document.getElementById('creatorPremadeTemplate') || {}).value || null;
      missionData.quickCreate = true;
    }
    if (missionData.type === 'Cooperativo' || missionData.premadeTemplate === 'coop_openworld') {
      missionData.missionModule = 'coop';
    }

    try {
      const missionsRef = db.ref('missions');
      const newMissionRef = await missionsRef.push(missionData);

      showFloatingMessage('success', '¡Misión lanzada!');
      if (window.dispatchEvent) window.dispatchEvent(new CustomEvent('playzone-mission-created', { detail: { missionId: newMissionRef.key } }));
      try { localStorage.removeItem(CREATOR_DRAFT_KEY); } catch (e) {}
      var draftWrap = document.getElementById('creatorDraftActions');
      if (draftWrap) draftWrap.style.display = 'none';
      form.reset();
      document.getElementById('missionGame').value = '';
      var trig = document.getElementById('creatorGameTrigger');
      var st = document.getElementById('creatorGameSelected');
      var si = document.getElementById('creatorGameSelectedImg');
      if (trig) trig.classList.remove('has-selection');
      if (st) st.innerHTML = '<i class="fas fa-gamepad"></i> Selecciona un juego';
      if (si) si.style.display = 'none';
      creatorShowError('creatorGameErr', '');
      creatorShowError('creatorMaxErr', '');
      creatorShowError('creatorTitleErr', '');
      creatorShowError('creatorScheduleErr', '');
      creatorShowError('creatorTokenErr', '');
      document.querySelectorAll('#missionCreator input, #missionCreator select, #missionCreator textarea').forEach(function(inp) {
        inp.classList.remove('creator-valid', 'creator-invalid');
      });
      document.querySelectorAll('.creator-section').forEach(function(s) { s.classList.remove('creator-has-error'); });
      if (schedInput && !schedInput.value) {
        var now = new Date();
        now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
        schedInput.value = now.toISOString().slice(0, 16);
      }
      if (typeof setupCreatorGameCards === 'function') setupCreatorGameCards();
      if (typeof updateCreatorTokensBadge === 'function') updateCreatorTokensBadge();
      if (typeof creatorValidateForm === 'function') creatorValidateForm();
      if (typeof creatorUpdateProgress === 'function') creatorUpdateProgress();
      if (typeof updateCreatorEstimate === 'function') updateCreatorEstimate();
      var tc2 = document.getElementById('titleCharCount');
      var dc2 = document.getElementById('descCharCount');
      if (tc2) tc2.textContent = '0/60';
      if (dc2) dc2.textContent = '0/200';
      var qcc = document.getElementById('quickCommentCharCount');
      if (qcc) qcc.textContent = '0/120';
      var qComment = document.getElementById('missionQuickComment');
      if (qComment) qComment.value = '';
      creatorExitQuickMode();
      userHasActiveMission = true;
      currentMissionId = newMissionRef.key;
      var activeTabBtn = document.getElementById('tabActiveMission');
      if (activeTabBtn) {
        activeTabBtn.style.display = 'block';
        activeTabBtn.innerHTML = '<i class="fas fa-satellite-dish fa-pulse"></i> Misión Activa';
        activeTabBtn.click();
      }

    } catch (error) {
      console.error("Error:", error);
      showFloatingMessage('error', 'Error: ' + error.message);
    } finally {
      submitBtn.disabled = false;
      submitBtn.innerHTML = creatorIsQuickMode()
        ? '<i class="fas fa-bolt"></i> Lanzar misión rápida'
        : '<i class="fas fa-rocket"></i> Lanzar Misión';
    }
  });
}

// === 8. CARGAR Y FILTRAR MISIONES ===
function isCooperativeMission(mission) {
  if (!mission) return false;
  if (mission.missionModule === 'coop') return true;
  if (mission.type === 'Cooperativo' || mission.type === 'Friends') return true;
  if (mission.verificationMode === 'cs2_steam') return true;
  return false;
}

function setMissionsBrowseMode(mode) {
  missionsBrowseMode = (mode === 'coop') ? 'coop' : 'all';
  var promo = document.getElementById('missionsCoopPromo');
  var header = document.getElementById('missionsCoopHeader');
  var typeFilter = document.getElementById('filterMissionType');
  var typeFilterWrap = typeFilter ? typeFilter.closest('.filters-bar') : null;
  if (promo) promo.style.display = missionsBrowseMode === 'coop' ? 'none' : '';
  if (header) header.style.display = missionsBrowseMode === 'coop' ? 'flex' : 'none';
  if (typeFilter) {
    if (missionsBrowseMode === 'coop') {
      typeFilter.value = '';
      typeFilter.disabled = true;
      typeFilter.title = 'Filtrado automático: solo misiones cooperativas';
    } else {
      typeFilter.disabled = false;
      typeFilter.title = '';
    }
  }
  if (typeFilterWrap) typeFilterWrap.classList.toggle('coop-mode-active', missionsBrowseMode === 'coop');
  try {
    var url = new URL(window.location.href);
    if (missionsBrowseMode === 'coop') url.searchParams.set('view', 'coop');
    else url.searchParams.delete('view');
    window.history.replaceState({}, '', url.pathname + url.search + url.hash);
  } catch (eUrl) {}
  if (typeof renderFilteredMissions === 'function') renderFilteredMissions();
}

function setupMissionsCoopBrowse() {
  var btnCoop = document.getElementById('btnBrowseCoopMissions');
  var btnBack = document.getElementById('btnBackToAllMissions');
  var btnCreate = document.getElementById('btnCreateCoopMission');
  if (btnCoop) btnCoop.addEventListener('click', function() { setMissionsBrowseMode('coop'); });
  if (btnBack) btnBack.addEventListener('click', function() { setMissionsBrowseMode('all'); });
  if (btnCreate) btnCreate.addEventListener('click', function() {
    var createTab = document.getElementById('tabCreateMission');
    if (createTab) createTab.click();
    if (typeof applyPremadeTemplate === 'function') applyPremadeTemplate('coop_openworld');
    else {
      var typeEl = document.getElementById('missionType');
      if (typeEl) typeEl.value = 'Cooperativo';
    }
  });
  try {
    var params = new URLSearchParams(window.location.search);
    if (params.get('view') === 'coop') setMissionsBrowseMode('coop');
  } catch (e) {}
}

function loadMissions() {
  const missionsRef = db.ref('missions').orderByChild('createdAt').limitToLast(50);

  missionsRef.on('value', (snapshot) => {
    allMissionsData = []; 
    snapshot.forEach(childSnapshot => {
      allMissionsData.push({
        id: childSnapshot.key,
        ...childSnapshot.val()
      });
    });
    allMissionsData.reverse();
    renderFilteredMissions(); 
  });
}

function renderFilteredMissions() {
  const container = document.getElementById('missionsList');
  if (!container) return;

  const gameFilter = document.getElementById('filterMissionGame').value;
  const typeFilter = document.getElementById('filterMissionType').value;
  const skillFilter = document.getElementById('filterMissionSkill').value;

  let filteredMissions = allMissionsData.filter(mission => {
    const gameMatch = !gameFilter || mission.game === gameFilter;
    const typeMatch = !typeFilter || mission.type === typeFilter;
    const skillMatch = !skillFilter || skillFilter === 'Cualquiera' || mission.skill === skillFilter || mission.skill === 'Cualquiera';
    const coopMatch = missionsBrowseMode !== 'coop' || isCooperativeMission(mission);
    return gameMatch && typeMatch && skillMatch && coopMatch;
  });

  var sortMode = (window.PlayzoneMechanics && PlayzoneMechanics.getSortMode) ? PlayzoneMechanics.getSortMode() : 'default';
  if (window.PlayzoneMechanics && typeof PlayzoneMechanics.applySort === 'function') {
    filteredMissions = PlayzoneMechanics.applySort(filteredMissions, sortMode);
  }

  var countEl = document.getElementById('mechanics-missions-count');
  if (countEl) { countEl.textContent = filteredMissions.length + ' misiones'; countEl.style.display = 'inline-block'; }
  var streakEl = document.getElementById('mechanics-streak-badge');
  if (streakEl && streakEl.style.display !== 'inline-flex') streakEl.style.display = 'inline-flex';

  container.innerHTML = '';

  if (filteredMissions.length === 0) {
    var emptyMsg = missionsBrowseMode === 'coop'
      ? 'No hay misiones cooperativas disponibles ahora mismo.'
      : 'No hay misiones que coincidan con tus filtros.';
    var cta = '<p style="color: #aaa; text-align: center; grid-column: 1 / -1;">' + emptyMsg + '</p>';
    if (window.PlayzoneMechanics) {
      var ctaBtn = missionsBrowseMode === 'coop'
        ? '<button type="button" onclick="document.getElementById(\'btnCreateCoopMission\').click()"><i class="fas fa-handshake"></i> Crear misión cooperativa</button>'
        : '<button type="button" onclick="document.getElementById(\'tabCreateMission\').click()"><i class="fas fa-plus"></i> Crear Misión</button>';
      cta += '<div class="mechanics-cta-create"><strong>¿Quieres ser el primero?</strong><br>Crea una misión y otros jugadores podrán unirse.<br>' + ctaBtn + '</div>';
    }
    container.innerHTML = cta;
    return;
  }

  var mainGame = (currentUserData && currentUserData.mainGame) ? currentUserData.mainGame : '';
  filteredMissions.forEach(function(mission, idx) {
    var card = renderMissionCard(mission);
    if (isCooperativeMission(mission)) card.classList.add('coop-mission-card');
    card.classList.add('forge-entering', 'mechanics-card-stagger');
    card.style.animationDelay = (idx * 0.06) + 's';
    if ((mission.status === 'RECLUTANDO' || !mission.status) && (Object.keys(mission.participants || {}).length < (mission.maxParticipants || 5))) {
      card.classList.add('active-mission');
    }
    var maxP = mission.maxParticipants || 5;
    var current = Object.keys(mission.participants || {}).length;
    if (maxP - current === 1 && !mission.isTournament) card.classList.add('mechanics-one-slot');
    if (idx === 0) card.classList.add('mechanics-mission-of-day');
    if (mainGame && mission.game === mainGame) card.classList.add('mechanics-recommended');
    container.appendChild(card);
  });

  pzFrameApply(container);
  pzFramePrune();
}

function renderMissionCard(mission) {
  const card = document.createElement('div');
  card.className = 'mission-card';

  let scheduleDate = 'No especificado';
  if (mission.schedule) {
    try {
      scheduleDate = new Date(mission.schedule).toLocaleString('es-ES', {
        day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit'
      });
    } catch (e) { }
  }

  const gameImage = getFeaturedGameImage(mission.game);
  const participants = mission.participants || {};
  const participantUIDs = Object.keys(participants);
  const participantCount = participantUIDs.length;

  // PZ-008: escape seguro (texto y atributos) vía el helper compartido pzEsc/pzSanitizeAvatarUrl.
  const escHtml = pzEsc;

  let participantsHTML = participantUIDs.map(uid => {
      const participant = participants[uid];
      if (!participant) return ''; 
      const isLeader = (uid === mission.creatorUid);
      const nick = escHtml(participant.nick || 'Jugador');
      const avatar = escHtml(pzSanitizeAvatarUrl(participant.photoURL));
      return `
          <div class="participant-avatar" title="${nick}" onclick="viewProfile('${uid}')">
              <img src="${avatar}" alt="${nick}">
              ${isLeader ? '<i class="fas fa-crown leader-icon"></i>' : ''}
          </div>
      `;
  }).join('');

  var DESC_LIMIT = 80;
  var fullDesc = (mission.description || '').trim() || null;
  var shortDesc = fullDesc ? escHtml(fullDesc.length > DESC_LIMIT ? fullDesc.slice(0, DESC_LIMIT) + '…' : fullDesc) : '<i>Sin descripción.</i>';
  var showSaberMas = fullDesc && fullDesc.length > DESC_LIMIT;
  
  // Anfitrión de la misión: avatar destacado, aquí sí lleva marco.
  var hostUid = mission.creatorUid || '';
  var hostParticipant = (hostUid && participants[hostUid]) ? participants[hostUid] : null;
  var hostNick = escHtml(mission.creatorNick || (hostParticipant && hostParticipant.nick) || 'Anfitrión');
  var hostAvatar = escHtml(pzSanitizeAvatarUrl(mission.creatorAvatar || (hostParticipant && hostParticipant.photoURL)));
  var hostHTML = hostUid
    ? '<div class="mission-host-badge" title="Anfitrión: ' + hostNick + '">' +
      pzFrameWrapOpen(hostUid, 'mission-host-avatar-wrap') +
      '<img src="' + hostAvatar + '" class="mission-host-avatar" alt=""></div>' +
      '<span class="mission-host-nick">' + hostNick + '</span></div>'
    : '';

  var cardTitle = escHtml(isCs2FriendsMission(mission) ? (mission.displayTitle || CS2_FRIENDS_DISPLAY_TITLE) : mission.title);
  var safeGame = escHtml(mission.game);
  var safeSkill = escHtml(mission.skill);
  var safeType = escHtml(mission.type);

  card.innerHTML = `
    <div class="card-header" style="background-image: url('${gameImage}');">
      <span class="card-game-tag">${safeGame}</span>
      ${hostHTML}
    </div>
    <div class="card-body">
      <h3 class="card-title">${cardTitle}</h3>
      <div class="card-description-block">
        <p class="card-description">${shortDesc}</p>
        ${showSaberMas ? '<button type="button" class="card-saber-mas" data-mission-id="' + mission.id + '"><i class="fas fa-info-circle"></i> Saber más</button>' : ''}
      </div>
      <div class="card-bottom-info">
        <div class="card-participants">
          <span class="participants-label">Participantes (${participantCount}/${mission.maxParticipants || 0}):</span>
          <div class="participant-avatars-list">${participantsHTML}</div>
        </div>
        <div class="card-meta">
          <span><i class="fas fa-clock"></i> ${scheduleDate}</span>
          <span><i class="fas fa-signal"></i> ${safeSkill}</span>
          <span><i class="fas fa-crosshairs"></i> ${safeType}</span>
          ${window.PlayzoneSmart ? `<span><i class="fas fa-stopwatch"></i> ${PlayzoneSmart.formatDuration((typeof mission.estMinutes === 'number') ? mission.estMinutes : PlayzoneSmart.estimate(mission).estMinutes)}</span>` : ''}
        </div>
      </div>
    </div>
    <div class="card-footer">
      <span class="card-comments"><i class="fas fa-coins"></i> ${missionRewardLabel(mission)}</span>
      <button class="card-join-btn" id="join-${mission.id}" data-forge-tooltip="Unirse a la misión">Unirse</button>
    </div>
  `;

const joinBtn = card.querySelector(`#join-${mission.id}`);

  var hostBadge = card.querySelector('.mission-host-badge');
  if (hostBadge && hostUid) {
    hostBadge.addEventListener('click', function(e) {
      e.stopPropagation();
      viewProfile(hostUid);
    });
  }

  var saberMasBtn = card.querySelector('.card-saber-mas');
  if (saberMasBtn) {
    saberMasBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      if (typeof showMissionDetailModal === 'function') showMissionDetailModal(mission);
    });
  }
  // Lógica especial para Torneos
  if (mission.isTournament) {
      joinBtn.textContent = 'Ver Torneo';
      joinBtn.classList.add('tournament-btn'); // Clase para estilo dorado si quieres
      joinBtn.addEventListener('click', () => {
          // Redirigir a la página de detalles del torneo
          window.location.href = `/tournament-details?id=${mission.tournamentId}`;
      });
  } 
  // Lógica normal de Misiones (existente)
  else if (currentUser && mission.participants && mission.participants[currentUser.uid]) {
      joinBtn.textContent = 'Ya estás unido';
      joinBtn.disabled = true;
  } else if (participantCount >= (mission.maxParticipants || 5)) {
      joinBtn.textContent = 'Misión Llena';
      joinBtn.disabled = true;
  } else {
      joinBtn.addEventListener('click', function() {
        if (joinBtn.dataset.forgeJoining === '1') return;
        joinBtn.dataset.forgeJoining = '1';
        joinBtn.disabled = true;
        var orig = joinBtn.textContent;
        joinBtn.textContent = 'Uniendo...';
        joinMission(mission.id).catch(function() {
          joinBtn.dataset.forgeJoining = '';
          joinBtn.disabled = false;
          joinBtn.textContent = orig;
        }).finally(function() {
          joinBtn.dataset.forgeJoining = '';
        });
      });
  }

  return card;
}

function showMissionDetailModal(mission) {
  var modal = document.getElementById('missionDetailModal');
  var body = document.getElementById('missionDetailBody');
  var joinBtn = document.getElementById('missionDetailJoinBtn');
  if (!modal || !body) return;
  var scheduleDate = 'No especificado';
  if (mission.schedule) {
    try {
      scheduleDate = new Date(mission.schedule).toLocaleString('es-ES', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
    } catch (e) {}
  }
  var participantCount = Object.keys(mission.participants || {}).length;
  function esc(s) { if (!s) return ''; var d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
  body.innerHTML = '<div class="mission-detail-row"><strong>Juego</strong><span>' + esc(mission.game) + '</span></div>' +
    '<div class="mission-detail-row"><strong>Título</strong><span>' + esc(mission.title) + '</span></div>' +
    '<div class="mission-detail-row"><strong>Descripción</strong><p class="mission-detail-desc">' + (mission.description ? esc(mission.description) : '<i>Sin descripción.</i>') + '</p></div>' +
    '<div class="mission-detail-row"><strong>Horario</strong><span>' + esc(scheduleDate) + '</span></div>' +
    '<div class="mission-detail-row"><strong>Tipo</strong><span>' + esc(mission.type) + '</span></div>' +
    '<div class="mission-detail-row"><strong>Nivel</strong><span>' + esc(mission.skill) + '</span></div>' +
    '<div class="mission-detail-row"><strong>Participantes</strong><span>' + participantCount + ' / ' + (mission.maxParticipants || 5) + '</span></div>' +
    (window.PlayzoneSmart ? '<div class="mission-detail-row"><strong>Duración estimada</strong><span>' + esc(PlayzoneSmart.formatDuration((typeof mission.estMinutes === 'number') ? mission.estMinutes : PlayzoneSmart.estimate(mission).estMinutes)) + '</span></div>' : '') +
    '<div class="mission-detail-row"><strong>Premio</strong><span>' + missionRewardLabel(mission) + '</span></div>';
  modal.style.display = 'flex';
  document.body.style.overflow = 'hidden';
  modal.dataset.missionId = mission.id;
  joinBtn.style.display = 'block';
  joinBtn.disabled = false;
  joinBtn.textContent = '';
  joinBtn.innerHTML = '<i class="fas fa-user-plus"></i> Unirse';
  if (currentUser && mission.participants && mission.participants[currentUser.uid]) {
    joinBtn.innerHTML = 'Ya estás unido';
    joinBtn.disabled = true;
  } else if (participantCount >= (mission.maxParticipants || 5)) {
    joinBtn.innerHTML = 'Misión llena';
    joinBtn.disabled = true;
  }
  var closeModal = function() {
    modal.style.display = 'none';
    document.body.style.overflow = '';
  };
  var oldJoin = joinBtn.onclick;
  joinBtn.onclick = function() {
    if (joinBtn.disabled) return;
    closeModal();
    joinMission(mission.id);
  };
  modal.querySelector('.mission-detail-backdrop').onclick = closeModal;
  modal.querySelector('.mission-detail-close').onclick = closeModal;
  modal.querySelector('.mission-detail-close-btn').onclick = closeModal;
}


function missionRewardLabel() {
  return '5 tokens/jugador';
}


window.joinMission = async (missionId) => {
  if (!currentUser) return;
  
  // VERIFICACIÓN: Si ya hay una misión activa, bloquea la unión.
  if (userHasActiveMission) {
      showFloatingMessage('error', 'Ya tienes una misión activa. Abandónala primero.');
      return;
  }
  
  const joinBtn = document.getElementById(`join-${missionId}`);
  if(joinBtn) { 
      joinBtn.disabled = true; 
      joinBtn.textContent = 'Uniéndose...'; 
  }

  try {
    const missionSnap = await db.ref('missions/' + missionId).once('value');
    const missionMeta = missionSnap.val() || {};
    if (missionMeta.verificationMode === 'cs2_steam') {
      const hasSteam = !!(currentUserData.steamID || (currentUserData.steam && currentUserData.steam.steamid));
      if (!hasSteam) {
        showFloatingMessage('error', 'Vincula Steam en el dashboard para unirte a misiones CS2 con amigos.');
        if (joinBtn) { joinBtn.disabled = false; joinBtn.textContent = 'Unirse'; }
        return;
      }
    }

    // PZ-010: comprobación amable en el cliente antes de llamar al servidor;
    // solo evita una llamada innecesaria, el cupo real lo hace cumplir la
    // Cloud Function joinMission con una transacción atómica sobre participants
    // (las reglas RTDB no pueden contar hijos, así que ya no basta con .validate
    // y el cliente ya no puede escribir participants/{uid} directamente).
    const existingCount = Object.keys(missionMeta.participants || {}).length;
    const maxSlots = missionMeta.maxParticipants || 5;
    if (existingCount >= maxSlots) {
      showFloatingMessage('error', 'Esta misión ya está llena.');
      if (joinBtn) { joinBtn.disabled = false; joinBtn.textContent = 'Unirse'; }
      return;
    }

    if (typeof firebase === 'undefined' || !firebase.functions) {
      showFloatingMessage('error', 'Servicio no disponible, intenta de nuevo.');
      if (joinBtn) { joinBtn.disabled = false; joinBtn.textContent = 'Unirse'; }
      return;
    }
    const joinFn = firebase.functions().httpsCallable('joinMission');
    await joinFn({ missionId: missionId });

    var isFirst = window.PlayzoneMechanics && typeof PlayzoneMechanics.isFirstJoinEver === 'function' && PlayzoneMechanics.isFirstJoinEver();
    if (window.PlayzoneMechanics && typeof PlayzoneMechanics.onJoinSuccess === 'function') PlayzoneMechanics.onJoinSuccess(isFirst);

    userHasActiveMission = true;
    currentMissionId = missionId;

    await checkUserMissionStatus(); 
    
    // Forzamos la carga de la misión antes de cambiar de pestaña
    loadActiveMission(); 
    
    // Ahora sí, cambiamos de pestaña
    document.getElementById('tabActiveMission').click();

  } catch (error) {
    // PZ-010: joinMission (Cloud Function) devuelve un mensaje ya pensado para
    // mostrarse al usuario ("Esta misión ya está llena.", etc.) vía error.message.
    var msg = (error && error.message) ? error.message : 'Error al unirse.';
    showFloatingMessage('error', msg);
    console.error(error);
    // 4. RESTABLECER BOTÓN en caso de fallo
    if(joinBtn) { 
        joinBtn.disabled = false; 
        joinBtn.textContent = 'Unirse'; 
    }
  }
}

// === 9. CARGAR Y FILTRAR JUGADORES ===
// PZ-017: users tiene .read restringido a Commander/Boss para evitar que
// cualquiera vuelque el padrón completo; esta lista de "Jugadores" ahora lee
// publicProfiles/{uid}, el espejo con solo los campos que ya se mostraban.
function loadPlayers() {
  const usersRef = db.ref('publicProfiles').orderByChild('playZoneOnboardingComplete').equalTo(true);

  usersRef.on('value', (snapshot) => {
    allPlayersData = []; 
    if (!snapshot.exists()) { renderFilteredPlayers(); return; }

    snapshot.forEach(childSnapshot => {
        const userData = childSnapshot.val();
        const uid = childSnapshot.key;
        if (currentUser && uid === currentUser.uid) return;
        allPlayersData.push({ uid, ...userData });
    });
    allPlayersData.reverse();
    renderFilteredPlayers(); 
  });
}

function renderFilteredPlayers() {
  const container = document.getElementById('playersList');
  if (!container) return;

  const gameFilter = document.getElementById('filterPlayerGame').value;
  const styleFilter = document.getElementById('filterPlayerStyle').value;
  const timezoneFilter = document.getElementById('filterPlayerTimezone').value;

  const filteredPlayers = allPlayersData.filter(player => {
    const playerGames = [player.mainGame, ...(player.secondaryGames || [])];
    const gameMatch = !gameFilter || playerGames.includes(gameFilter);

    let styleMatch = true;
    if (styleFilter) { 
        if (styleFilter === 'Competitive') styleMatch = (player.playStyle === 'Competitive' || player.playStyle === 'Both');
        else if (styleFilter === 'Casual') styleMatch = (player.playStyle === 'Casual' || player.playStyle === 'Both');
    }
    const timezoneMatch = !timezoneFilter || player.timezone === timezoneFilter;
    return gameMatch && styleMatch && timezoneMatch;
  });

  container.innerHTML = ''; 
  if (filteredPlayers.length === 0) {
    container.innerHTML = '<p style="color: #aaa; text-align: center;">No se encontraron jugadores.</p>';
    return;
  }

  filteredPlayers.forEach(player => {
    container.appendChild(renderPlayerCard(player.uid, player));
  });

  pzFrameApply(container);
  pzFramePrune();
}

function renderPlayerCard(uid, user) {
  const card = document.createElement('div');
  card.className = 'player-card';
  const mainGames = user.mainGame ? [user.mainGame] : (user.mainGames || ['N/A']);
  const gameImageUrl = getFeaturedGameImage(mainGames[0]);
  const inviteDisabled = !userHasActiveMission;
  const inviteTitle = inviteDisabled ? 'Debes estar en una misión activa' : 'Invitar a misión';

  // PZ-009: valores reales (sin escapar) para usarlos como argumentos de función;
  // ya no se interpolan en atributos onclick="...", así que no hace falta escaparlos
  // para eso. Solo se escapan las versiones que se muestran como HTML/atributos.
  const rawNick = user.nick || 'Usuario';
  const rawAvatar = pzSanitizeAvatarUrl(user.photoURL);

  const safeNick = pzEsc(rawNick);
  const safeAvatar = pzEsc(rawAvatar);
  const safeMainGame = pzEsc(mainGames[0]);
  const safeRango = pzEsc(user.rango ? user.rango.replace('_', ' ') : 'Tribal Warrior');
  const safePlayStyle = pzEsc(user.playStyle || 'N/A');
  const safeTimezone = pzEsc(user.timezone || 'N/A');

  card.innerHTML = `
    <div class="player-card-header">
      ${pzFrameWrapOpen(uid, 'player-avatar-wrap')}<img src="${safeAvatar}" class="player-avatar"></div>
      <div class="player-info">
        <h3 class="player-nick">${safeNick}</h3>
        <span class="player-rank">${safeRango}</span>
      </div>
    </div>
    <div class="player-card-body">
      <span class="player-meta-tag"><i class="fas fa-gamepad"></i> ${safePlayStyle}</span>
      <span class="player-meta-tag"><i class="fas fa-clock"></i> ${safeTimezone}</span>
    </div>
    <div class="player-card-clip">
      <strong>Featured: ${safeMainGame}</strong>
      <div class="game-image-placeholder"><img src="${gameImageUrl}" alt="${safeMainGame}" /></div>
    </div>
    <div class="player-card-actions">
      <button type="button" class="player-action-btn invite" ${inviteDisabled ? 'disabled' : ''} title="${pzEsc(inviteTitle)}">
        <i class="fas fa-envelope"></i> Invite
      </button>
      <button type="button" class="player-action-btn chat">
        <i class="fas fa-comment-dots"></i> Chat
      </button>
    </div>
  `;

  // PZ-009: sin onclick inline. Los handlers reciben los valores reales por
  // closure, así un nick con comillas o etiquetas ya no puede romper el HTML.
  card.querySelector('.player-avatar').addEventListener('click', () => viewProfile(uid));
  card.querySelector('.player-nick').addEventListener('click', () => viewProfile(uid));
  card.querySelector('.player-action-btn.invite').addEventListener('click', () => inviteToMission(uid, rawNick));
  card.querySelector('.player-action-btn.chat').addEventListener('click', () => handleChatAction(uid, rawNick, rawAvatar));

  return card;
}

// === 10. ACCIONES GLOBALES ===
window.handleChatAction = async (targetUid, targetNick, photoURL) => {
    if (!currentUser) return;
    var gate = await getSocialGateStatus(targetUid);
    if (gate.step === 'friend') {
        if (typeof openFriendRequestModal === 'function') openFriendRequestModal(targetUid, targetNick);
        return;
    }
    if (gate.step === 'chat') {
        if (typeof openChatRequestModal === 'function') openChatRequestModal(targetUid, targetNick);
        return;
    }
    const chatState = activeChats[targetUid];
    if (chatState && chatState.chatRoomID) {
        if (typeof openPrivateChat === 'function') openPrivateChat(targetUid, targetNick, photoURL);
    } else {
        if (typeof openHubDmWithPlayer === 'function' && userHasActiveMission && currentMissionId) {
            openHubDmWithPlayer(targetUid, targetNick, photoURL);
        } else if (typeof openPrivateChat === 'function') {
            openPrivateChat(targetUid, targetNick, photoURL);
        }
    }
};

window.inviteToMission = async (userId, userNick) => {
  if (!userHasActiveMission || !currentMissionId) {
    showFloatingMessage('error', 'Crea o únete a una misión primero.');
    return;
  }
  var gate = await getSocialGateStatus(userId);
  if (gate.step === 'friend') {
    openFriendRequestModal(userId, userNick);
    showFloatingMessage('info', 'Primero deben ser amigos para invitar a una misión.');
    return;
  }
  if (gate.step === 'chat') {
    openChatRequestModal(userId, userNick);
    showFloatingMessage('info', 'Envía una petición de juego antes de invitar.');
    return;
  }
  try {
    var missionSnap = await db.ref('missions/' + currentMissionId).once('value');
    var mission = missionSnap.val();
    if (!mission) return;
    if (mission.participants && mission.participants[userId]) {
      showFloatingMessage('info', userNick + ' ya está en la misión.');
      return;
    }
    if (typeof firebase === 'undefined' || !firebase.functions) {
      showFloatingMessage('error', 'Servicio no disponible, intenta de nuevo.');
      return;
    }
    // PZ-012: el remitente y el límite de envíos se resuelven en el servidor
    // (Cloud Function sendMissionInvite), el cliente ya no puede firmar la
    // invitación con datos propios ni escribir directo en missionInvites.
    const sendInviteFn = firebase.functions().httpsCallable('sendMissionInvite');
    await sendInviteFn({ targetUid: userId, missionId: currentMissionId });
    showFloatingMessage('success', 'Invitación a la misión enviada a ' + userNick + '.');
  } catch (e) {
    var inviteMsg = (e && e.message) ? e.message : 'No se pudo enviar la invitación.';
    showFloatingMessage('error', inviteMsg);
  }
};

window.viewProfile = (userId) => { window.location.href = `/dashboard?uid=${userId}`; };
/* --- FIN PARTE 2 --- */
/* ======== CÓDIGO PARA playzone.js - PARTE 3 DE 3 (FIXED HUB) ======== */

// =======================================================
// =======================================================
// === 11. LÓGICA DEL HUB DE MISIÓN ACTIVA (CORE Y CHAT) ===
// =======================================================

// Variable global para el intervalo del reloj (para poder detenerlo luego)
let missionTimerInterval = null;

// playzone (18).js

var STALE_MISSION_MS = 60 * 60 * 1000;

function shouldAutoCloseStaleMission(mission) {
    if (!mission || mission.status !== 'pending') return false;
    var createdAt = typeof mission.createdAt === 'number' ? mission.createdAt : null;
    if (!createdAt) return false;
    return (Date.now() - createdAt) >= STALE_MISSION_MS;
}

async function autoCloseStaleMission(missionId, mission) {
    if (!missionId || !mission || !shouldAutoCloseStaleMission(mission) || !currentUser) return false;
    try {
        if (mission.creatorUid === currentUser.uid) {
            await db.ref('missions/' + missionId).remove();
        } else if (mission.participants && mission.participants[currentUser.uid]) {
            await db.ref('missions/' + missionId + '/participants/' + currentUser.uid).remove();
            try { await db.ref('missions/' + missionId + '/cs2Ready/' + currentUser.uid).remove(); } catch (e) {}
        }
        showFloatingMessage('warning', 'El hub se cerró: la misión no se inició en 1 hora.');
        exitHubLogic();
        return true;
    } catch (e) {
        console.error('autoCloseStaleMission:', e);
        return false;
    }
}

function loadActiveMission() {
    if (!currentUser) return;
    if (!currentMissionId) {
        return;
    }

    const missionRef = db.ref('missions/' + currentMissionId);
    
    // 1. Limpiar SOLO el monitor de esta misión (evita duplicados) sin apagar
    //    el listener general de la lista de misiones (loadMissions).
    if (currentMissionListener) {
        missionRef.off('value', currentMissionListener);
        currentMissionListener = null;
    }

    // 2. Encender el monitor en tiempo real
    currentMissionListener = missionRef.on('value', (snapshot) => {
        const mission = snapshot.val();
        
        // Si la misión fue borrada por el líder
        if (!mission) {
            handleMissionDeleted();
            return;
        }

        // VERIFICACIÓN CRÍTICA: ¿Sigo siendo participante?
        if (!mission.participants || !mission.participants[currentUser.uid]) {
            // Solo salimos si el estado global dice que deberíamos estar dentro
            if (userHasActiveMission) {
                handleKickedFromMission();
            }
            return;
        }

        if (shouldAutoCloseStaleMission(mission)) {
            autoCloseStaleMission(currentMissionId, mission);
            return;
        }

        // Si todo está bien, dibujamos la interfaz del Hub
        renderHubUI(mission);
        setupHubControls(mission, currentMissionId);
        
        // Cargar el chat solo una vez por misión
        if (!hubChatInitializedFor || hubChatInitializedFor !== currentMissionId) {
            setupHubChatSystem(currentMissionId);
        }
    });
}

function renderHubUI(mission) {
    const els = {
        bg: document.getElementById('hubHeaderBackground'),
        emblem: document.getElementById('hubEmblemIcon'),
        emblemLabel: document.getElementById('hubEmblemLabel'),
        title: document.getElementById('hubTitle'),
        statusBadge: document.getElementById('hubStatusBadge'),
        game: document.getElementById('hubGame'),
        type: document.getElementById('hubType'),
        creator: document.getElementById('hubCreator'),
        timer: document.getElementById('hubCountdown'), // El div donde va la hora
        prize: document.getElementById('hubTokenPrize'),
        playerCount: document.getElementById('hubPlayerCount'),
        maxPlayers: document.getElementById('hubMaxPlayers'),
        playerSlots: document.getElementById('hubPlayerSlots')
    };

    if (!els.bg) return; 

    // Fondo e Imagen
    const gameImg = getFeaturedGameImage(mission.game);
    els.bg.style.backgroundImage = `linear-gradient(rgba(0,0,0,0.2), rgba(0,0,0,0.8)), url('${gameImg}')`;
    
    // Emblema
    const smartEmblem = getSmartMissionEmblem(mission.type, mission.skill);
    els.emblem.innerHTML = `<i class="fas ${smartEmblem.icon}"></i>`;
    els.emblem.style.borderColor = smartEmblem.color;
    els.emblem.style.color = smartEmblem.color;
    els.emblemLabel.textContent = mission.skill;
    
    // Textos Básicos
    els.title.textContent = isCs2FriendsMission(mission)
      ? (mission.displayTitle || CS2_FRIENDS_DISPLAY_TITLE)
      : mission.title;
    var hubPlatform = isCs2FriendsMission(mission) ? 'Steam' : (mission.platform || 'PC');
    const platformHTML = getPlatformIconsHTML(hubPlatform);
    els.game.innerHTML = `${platformHTML} <span style="margin-left:8px; vertical-align:middle;">${mission.game}</span>`;
    els.type.textContent = isCs2FriendsMission(mission) ? 'Cooperativa CS2' : mission.type;
    els.creator.textContent = `By ${mission.creatorNick}`;
    els.prize.textContent = '5';

    // --- LÓGICA DEL RELOJ Y ESTADO (CORREGIDO) ---
    clearInterval(missionTimerInterval); // Limpiamos cualquier reloj anterior para evitar conflictos

    let statusText = "ESPERANDO";
    let statusColor = "#444";
    
    if (mission.status === 'active') { 
        statusText = "EN PROGRESO"; statusColor = "#4caf50";
        els.timer.style.color = "#fff";
        if (typeof mission.startedAt === 'number') {
            var updateElapsed = function() {
                els.timer.textContent = formatHubElapsed(Date.now() - mission.startedAt);
            };
            updateElapsed();
            missionTimerInterval = setInterval(updateElapsed, 1000);
        } else {
            els.timer.textContent = "En progreso";
        }
    } else if (mission.status === 'finished') {
        statusText = "TERMINADA"; statusColor = "#2196f3"; 
        els.timer.textContent = "FINALIZADA";
        els.timer.style.color = "#2196f3";
    } else {
        // Estado Pendiente: Iniciamos la cuenta regresiva dinámica
        statusText = "ESPERANDO";
        els.timer.style.color = "#fff";
        
        if (mission.schedule) {
            const targetDate = new Date(mission.schedule).getTime();
            
            // Función que actualiza el texto cada segundo
            const updateClock = () => {
                const now = new Date().getTime();
                const diff = targetDate - now;

                if (diff > 0) {
                    const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
                    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
                    const seconds = Math.floor((diff % (1000 * 60)) / 1000);
                    
                    // Formato HH:MM:SS para que se vea activo
                    const hStr = hours < 10 ? "0"+hours : hours;
                    const mStr = minutes < 10 ? "0"+minutes : minutes;
                    const sStr = seconds < 10 ? "0"+seconds : seconds;
                    
                    els.timer.textContent = `${hStr}:${mStr}:${sStr}`;
                } else {
                    els.timer.textContent = "En progreso";
                    els.timer.style.color = "#4caf50";
                    clearInterval(missionTimerInterval);
                }
            };
            
            updateClock(); // Ejecutar inmediatamente
            missionTimerInterval = setInterval(updateClock, 1000); // Repetir cada segundo
        } else {
            els.timer.textContent = "--:--";
        }
    }
    
    els.statusBadge.textContent = statusText;
    els.statusBadge.style.background = statusColor;

    // Participantes
    const pKeys = Object.keys(mission.participants || {});
    els.playerCount.textContent = pKeys.length;
    els.maxPlayers.textContent = mission.maxParticipants;

    refreshHubFriendsCache().then(function() {
        renderHubPlayerSlots(mission);
    });

    updateNexusVerifyUI(mission);
    updateCs2FriendsUI(mission);
}

function getSortedParticipantUids(mission) {
    var participants = mission.participants || {};
    var uids = Object.keys(participants);
    uids.sort(function(a, b) {
        if (a === mission.creatorUid) return -1;
        if (b === mission.creatorUid) return 1;
        var ja = (participants[a] && participants[a].joinedAt) || 0;
        var jb = (participants[b] && participants[b].joinedAt) || 0;
        return ja - jb;
    });
    return uids;
}

// === SOCIAL: AMISTAD, COMUNICACIÓN E INVITACIONES ===
var hubSlotInviteSelected = null;
var hubFriendsByUid = {};

function refreshHubFriendsCache() {
    if (!currentUser) {
        hubFriendsByUid = {};
        return Promise.resolve();
    }
    return db.ref('sgFriends/' + currentUser.uid).once('value').then(function(snap) {
        hubFriendsByUid = snap.val() || {};
    }).catch(function() {
        hubFriendsByUid = {};
    });
}

function formatHubElapsed(ms) {
    var totalSec = Math.max(0, Math.floor(ms / 1000));
    var hours = Math.floor(totalSec / 3600);
    var minutes = Math.floor((totalSec % 3600) / 60);
    var seconds = totalSec % 60;
    var pad = function(n) { return n < 10 ? '0' + n : String(n); };
    return pad(hours) + ':' + pad(minutes) + ':' + pad(seconds);
}
var hubSlotInviteSearchTimer = null;
var hubSlotInviteMissionCache = null;

function getSgDmRoomId(partnerUid) {
    if (!currentUser || !partnerUid) return null;
    return [currentUser.uid, partnerUid].sort().join('_');
}

async function isSgFriend(targetUid) {
    if (!currentUser || !targetUid) return false;
    var snap = await db.ref('sgFriends/' + currentUser.uid + '/' + targetUid).once('value');
    return snap.exists();
}

async function hasSgChatLink(targetUid) {
    if (!currentUser || !targetUid) return false;
    var linkSnap = await db.ref('sgChatLinks/' + currentUser.uid + '/' + targetUid).once('value');
    if (linkSnap.val() === true) return true;
    var roomId = getSgDmRoomId(targetUid);
    if (!roomId) return false;
    var msgSnap = await db.ref('privateChats/' + roomId + '/messages').limitToFirst(1).once('value');
    return msgSnap.exists();
}

async function getSocialGateStatus(targetUid) {
    var isFriend = await isSgFriend(targetUid);
    if (!isFriend) return { step: 'friend', isFriend: false, hasChat: false };
    var hasChat = await hasSgChatLink(targetUid);
    if (!hasChat) return { step: 'chat', isFriend: true, hasChat: false };
    return { step: 'ok', isFriend: true, hasChat: true };
}

function getSocialStatusLabel(step) {
    if (step === 'friend') return 'Requiere solicitud de amistad';
    if (step === 'chat') return 'Requiere petición de juego';
    return 'Listo para invitar';
}

async function handleHubPlayerMsgClick(partnerUid, partnerNick, partnerPhotoURL) {
    if (!currentUser || !partnerUid || partnerUid === currentUser.uid) return;
    var gate = await getSocialGateStatus(partnerUid);
    if (gate.step === 'friend') {
        openFriendRequestModal(partnerUid, partnerNick);
        showFloatingMessage('info', 'Envía una solicitud de amistad a ' + partnerNick + ' antes de chatear.');
        return;
    }
    if (gate.step === 'chat') {
        openChatRequestModal(partnerUid, partnerNick);
        showFloatingMessage('info', 'Envía una petición de juego/comunicación a ' + partnerNick + '.');
        return;
    }
    openHubDmWithPlayer(partnerUid, partnerNick, partnerPhotoURL);
}

function setupFriendRequestModal() {
    var modal = document.getElementById('friendRequestModal');
    var closeBtn = document.getElementById('closeFriendRequestModal');
    if (closeBtn) closeBtn.addEventListener('click', function() { if (modal) modal.style.display = 'none'; });
}

window.openFriendRequestModal = function(targetUid, targetNick) {
    if (!currentUser) return;
    var modal = document.getElementById('friendRequestModal');
    var subtitle = document.getElementById('friendRequestSubTitle');
    var form = document.getElementById('friendRequestForm');
    var textarea = document.getElementById('friendRequestMessage');
    if (!modal || !form) return;
    if (subtitle) subtitle.textContent = 'Envía una solicitud de amistad a ' + (targetNick || 'este jugador') + '. Si acepta, podrán verse en el sitio, chatear e intercambiar ítems únicos.';
    if (textarea) textarea.value = '';
    modal.style.display = 'flex';
    form.onsubmit = function(e) { return handleFriendRequestSubmit(e, targetUid, targetNick); };
};

async function handleFriendRequestSubmit(e, targetUid, targetNick) {
    e.preventDefault();
    if (!currentUser || !currentUserData) return false;
    var textarea = document.getElementById('friendRequestMessage');
    var message = (textarea && textarea.value || '').trim();
    if (!message) {
        showFloatingMessage('error', 'Escribe un mensaje para tu solicitud de amistad.');
        return false;
    }
    var btn = document.getElementById('sendFriendRequestBtn');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Enviando...'; }
    try {
        var existing = await db.ref('sgFriends/' + currentUser.uid + '/' + targetUid).once('value');
        if (existing.exists()) {
            showFloatingMessage('info', 'Ya son amigos.');
            document.getElementById('friendRequestModal').style.display = 'none';
            return false;
        }
        await db.ref('friendRequests/' + targetUid + '/' + currentUser.uid).set({
            senderUid: currentUser.uid,
            senderNick: currentUserData.nick || 'Usuario',
            senderAvatar: currentUserData.photoURL || 'dragon_profile_studiosgamesrs.png',
            message: message,
            timestamp: firebase.database.ServerValue.TIMESTAMP
        });
        showFloatingMessage('success', 'Solicitud de amistad enviada a ' + (targetNick || 'jugador') + '.');
        document.getElementById('friendRequestModal').style.display = 'none';
    } catch (err) {
        showFloatingMessage('error', 'No se pudo enviar la solicitud de amistad.');
    } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = '<span>Enviar solicitud</span> <i class="fas fa-user-plus"></i>'; }
    }
    return false;
}

var friendRequestToastTimers = {};
var friendRequestToastSeen = {};

function listenForFriendRequests() {
    if (!currentUser) return;
    db.ref('friendRequests/' + currentUser.uid).on('value', function(snapshot) {
        if (window.SGNotifications && typeof window.SGNotifications.refresh === 'function') {
            window.SGNotifications.refresh();
        } else {
            renderHeaderFriendRequests(snapshot);
        }
        // Toasts en vivo los maneja SGNotifications en todas las páginas.
        if (window.SGNotifications && window.SGNotifications.handlesLiveToasts) return;
        var currentKeys = {};
        snapshot.forEach(function(child) {
            var senderUid = child.key;
            var data = child.val();
            if (!data || !senderUid) return;
            currentKeys[senderUid] = true;
            if (!friendRequestToastSeen[senderUid]) {
                friendRequestToastSeen[senderUid] = true;
                showFriendRequestToast(Object.assign({ senderUid: senderUid }, data));
            }
        });
        Object.keys(friendRequestToastSeen).forEach(function(uid) {
            if (!currentKeys[uid]) delete friendRequestToastSeen[uid];
        });
    });
}

function dismissFriendToast(senderUid) {
    if (friendRequestToastTimers[senderUid]) {
        clearTimeout(friendRequestToastTimers[senderUid]);
        delete friendRequestToastTimers[senderUid];
    }
    var el = document.getElementById('friend-req-' + senderUid);
    if (el) {
        el.classList.add('friend-toast-dismissing');
        setTimeout(function() { if (el.parentNode) el.remove(); }, 350);
    }
}

function showFriendRequestToast(requestData) {
    var container = document.getElementById('friendRequestNotificationContainer');
    if (!container) return;
    var notifId = 'friend-req-' + requestData.senderUid;
    if (document.getElementById(notifId)) return;

    var notification = document.createElement('div');
    notification.className = 'notification-item success';
    notification.id = notifId;
    notification.innerHTML =
        '<i class="fas fa-user-plus" style="color:#66c0f4;"></i>' +
        '<div style="flex:1;">' +
        '<strong>' + pzEsc(requestData.senderNick || 'Jugador') + '</strong> quiere ser tu amigo:' +
        '<p style="font-style:italic;margin:5px 0 10px;opacity:0.9;">"' + pzEsc(requestData.message || '') + '"</p>' +
        '<div style="display:flex;gap:10px;justify-content:flex-end;">' +
        '<button type="button" class="request-accept-btn friend-accept-btn">Aceptar</button>' +
        '<button type="button" class="request-decline-btn friend-decline-btn">Rechazar</button>' +
        '</div></div>';
    container.appendChild(notification);

    function onInteract() {
        dismissFriendToast(requestData.senderUid);
    }

    notification.querySelector('.friend-accept-btn').onclick = function() {
        onInteract();
        acceptFriendRequest(requestData);
    };
    notification.querySelector('.friend-decline-btn').onclick = function() {
        onInteract();
        declineFriendRequest(requestData.senderUid);
    };

    friendRequestToastTimers[requestData.senderUid] = setTimeout(function() {
        dismissFriendToast(requestData.senderUid);
    }, 30000);
}

function setupHeaderNotifications() {
    var toggle = document.getElementById('notificationsToggleBtn');
    var panel = document.getElementById('headerNotificationsPanel');
    if (!toggle || !panel) return;

    toggle.addEventListener('click', function(e) {
        e.stopPropagation();
        var open = panel.style.display === 'block';
        panel.style.display = open ? 'none' : 'block';
        toggle.setAttribute('aria-expanded', open ? 'false' : 'true');
    });

    document.addEventListener('click', function(e) {
        if (!panel.contains(e.target) && !toggle.contains(e.target)) {
            panel.style.display = 'none';
            toggle.setAttribute('aria-expanded', 'false');
        }
    });
}

function renderHeaderFriendRequests(snapshot) {
    var list = document.getElementById('headerNotificationsList');
    var badge = document.getElementById('headerNotifBadge');
    if (!list) return;

    var items = [];
    if (snapshot && snapshot.exists()) {
        snapshot.forEach(function(child) {
            var data = child.val();
            if (data) items.push(Object.assign({ senderUid: child.key }, data));
        });
    }

    if (badge) {
        if (items.length > 0) {
            badge.style.display = 'inline-flex';
            badge.textContent = String(items.length);
        } else {
            badge.style.display = 'none';
            badge.textContent = '0';
        }
    }

    if (!items.length) {
        list.innerHTML = '<p class="header-notif-empty">No tienes notificaciones pendientes.</p>';
        return;
    }

    list.innerHTML = '';
    items.forEach(function(req) {
        var row = document.createElement('div');
        row.className = 'header-notif-item';
        row.id = 'header-friend-req-' + req.senderUid;
        row.innerHTML =
            '<strong><i class="fas fa-user-plus"></i> ' + pzEsc(req.senderNick || 'Jugador') + '</strong>' +
            '<p>Solicitud de amistad: "' + pzEsc(req.message || '') + '"</p>' +
            '<div class="header-notif-actions">' +
            '<button type="button" class="header-notif-btn accept">Aceptar</button>' +
            '<button type="button" class="header-notif-btn decline">Rechazar</button>' +
            '</div>';
        row.querySelector('.accept').onclick = function() { acceptFriendRequest(req); };
        row.querySelector('.decline').onclick = function() { declineFriendRequest(req.senderUid); };
        list.appendChild(row);
    });
}

async function declineFriendRequest(senderUid) {
    if (!currentUser || !senderUid) return;
    try {
        await db.ref('friendRequests/' + currentUser.uid + '/' + senderUid).remove();
        dismissFriendToast(senderUid);
        showFloatingMessage('info', 'Solicitud de amistad rechazada.');
    } catch (e) {
        console.error(e);
        showFloatingMessage('error', 'No se pudo rechazar la solicitud.');
    }
}

async function acceptFriendRequest(requestData) {
    if (!currentUser || !currentUserData) return;
    var senderUid = requestData.senderUid;
    if (!senderUid) return;
    var ts = firebase.database.ServerValue.TIMESTAMP;
    try {
        await db.ref('sgFriends/' + currentUser.uid + '/' + senderUid).set({
            nick: requestData.senderNick || 'Usuario',
            photoURL: requestData.senderAvatar || 'dragon_profile_studiosgamesrs.png',
            since: ts
        });
        await db.ref('sgFriends/' + senderUid + '/' + currentUser.uid).set({
            nick: currentUserData.nick || 'Usuario',
            photoURL: currentUserData.photoURL || 'dragon_profile_studiosgamesrs.png',
            since: ts
        });
        await db.ref('friendRequests/' + currentUser.uid + '/' + senderUid).remove();
        dismissFriendToast(senderUid);
        showFloatingMessage('success', '¡Ahora son amigos! Ya pueden chatear e intercambiar ítems únicos.');
    } catch (e) {
        console.error('acceptFriendRequest:', e);
        showFloatingMessage('error', 'Error al aceptar la solicitud de amistad.');
    }
}

function listenForMissionInvites() {
    if (!currentUser) return;
    // Panel + toasts unificados en SGNotifications (todas las páginas).
    if (window.SGNotifications && window.SGNotifications.handlesLiveToasts) return;
    db.ref('missionInvites/' + currentUser.uid).on('child_added', function(snapshot) {
        var data = snapshot.val();
        var missionId = snapshot.key;
        if (data && missionId) showMissionInviteNotification(missionId, data);
    });
    db.ref('missionInvites/' + currentUser.uid).on('child_removed', function(snapshot) {
        var el = document.getElementById('mission-invite-' + snapshot.key);
        if (el) el.remove();
    });
}

function showMissionInviteNotification(missionId, data) {
    var container = document.getElementById('privateChatNotificationContainer');
    if (!container) return;
    var notifId = 'mission-invite-' + missionId;
    if (document.getElementById(notifId)) return;
    var notification = document.createElement('div');
    notification.className = 'notification-item success';
    notification.id = notifId;
    notification.innerHTML =
        '<i class="fas fa-envelope" style="color:#ffd873;"></i>' +
        '<div style="flex:1;">' +
        '<strong>' + pzEsc(data.fromNick || 'Jugador') + '</strong> te invita a una misión:' +
        '<p style="margin:5px 0 10px;opacity:0.9;">' + pzEsc(data.missionTitle || 'Misión') + '</p>' +
        '<div style="display:flex;gap:10px;justify-content:flex-end;">' +
        '<button class="request-accept-btn mission-invite-view-btn">Ver misión</button>' +
        '<button class="request-decline-btn mission-invite-dismiss-btn">Cerrar</button>' +
        '</div></div>';
    container.appendChild(notification);
    notification.querySelector('.mission-invite-view-btn').onclick = function() {
        db.ref('missionInvites/' + currentUser.uid + '/' + missionId).remove();
        notification.remove();
        if (typeof joinMission === 'function') joinMission(missionId);
        else {
            var findTab = document.getElementById('tabFindMissions');
            if (findTab) findTab.click();
        }
    };
    notification.querySelector('.mission-invite-dismiss-btn').onclick = function() {
        db.ref('missionInvites/' + currentUser.uid + '/' + missionId).remove();
        notification.remove();
    };
}

function setupHubSlotInviteModal() {
    var modal = document.getElementById('hubSlotInviteModal');
    var closeBtn = document.getElementById('closeHubSlotInviteModal');
    var backdrop = document.getElementById('hubSlotInviteBackdrop');
    var searchInput = document.getElementById('hubSlotInviteSearch');
    if (!modal) return;
    function closeModal() {
        modal.classList.remove('is-open');
        modal.style.display = 'none';
        document.body.style.overflow = '';
        hubSlotInviteSelected = null;
        var action = document.getElementById('hubSlotInviteAction');
        if (action) { action.style.display = 'none'; action.innerHTML = ''; }
        var results = document.getElementById('hubSlotInviteResults');
        if (results) results.innerHTML = '';
        if (searchInput) searchInput.value = '';
    }
    if (closeBtn) closeBtn.addEventListener('click', closeModal);
    if (backdrop) backdrop.addEventListener('click', closeModal);
    if (searchInput) {
        searchInput.addEventListener('input', function() {
            clearTimeout(hubSlotInviteSearchTimer);
            var q = (this.value || '').trim().toLowerCase();
            if (q.length < 2) {
                var results = document.getElementById('hubSlotInviteResults');
                if (results) results.innerHTML = '<div class="hub-slot-invite-result"><span class="hub-slot-invite-result-status">Escribe al menos 2 caracteres...</span></div>';
                return;
            }
            hubSlotInviteSearchTimer = setTimeout(function() { searchHubUsersForInvite(q); }, 300);
        });
    }
    window._closeHubSlotInviteModal = closeModal;
}

window.openHubSlotInviteModal = async function() {
    if (!currentUser || !currentMissionId) {
        showFloatingMessage('error', 'Debes estar en una misión activa.');
        return;
    }
    var modal = document.getElementById('hubSlotInviteModal');
    if (!modal) return;
    var snap = await db.ref('missions/' + currentMissionId).once('value');
    hubSlotInviteMissionCache = snap.val();
    hubSlotInviteSelected = null;
    modal.style.display = 'flex';
    modal.classList.add('is-open');
    document.body.style.overflow = 'hidden';
    var results = document.getElementById('hubSlotInviteResults');
    if (results) results.innerHTML = '<div class="hub-slot-invite-result"><span class="hub-slot-invite-result-status">Busca un jugador por nick...</span></div>';
};

async function searchHubUsersForInvite(query) {
    var results = document.getElementById('hubSlotInviteResults');
    if (!results) return;
    results.innerHTML = '<div class="hub-slot-invite-result"><i class="fas fa-spinner fa-spin"></i> Buscando...</div>';
    try {
        var participants = (hubSlotInviteMissionCache && hubSlotInviteMissionCache.participants) || {};
        // PZ-017: solo se necesitan nick/avatar para el buscador de invitación,
        // así que se lee publicProfiles en vez de descargar users entero.
        var snap = await db.ref('publicProfiles').once('value');
        var html = '';
        var count = 0;
        snap.forEach(function(child) {
            var uid = child.key;
            var user = child.val() || {};
            var nick = (user.nick || '').toLowerCase();
            if (uid === currentUser.uid) return;
            if (participants[uid]) return;
            if (!nick.includes(query)) return;
            count++;
            html += '<div class="hub-slot-invite-result" data-uid="' + pzEsc(uid) + '" data-nick="' + pzEsc(user.nick || 'Usuario') + '" data-photo="' + pzEsc(user.photoURL || 'dragon_profile_studiosgamesrs.png') + '">' +
                '<img src="' + pzEsc(user.photoURL || 'dragon_profile_studiosgamesrs.png') + '" alt="">' +
                '<div class="hub-slot-invite-result-info">' +
                '<div class="hub-slot-invite-result-nick">' + pzEsc(user.nick || 'Usuario') + '</div>' +
                '<div class="hub-slot-invite-result-status">Pulsa para ver opciones</div>' +
                '</div></div>';
        });
        results.innerHTML = count ? html : '<div class="hub-slot-invite-result"><span class="hub-slot-invite-result-status">No se encontraron jugadores.</span></div>';
        results.querySelectorAll('.hub-slot-invite-result[data-uid]').forEach(function(row) {
            row.addEventListener('click', function() {
                results.querySelectorAll('.hub-slot-invite-result').forEach(function(r) { r.classList.remove('selected'); });
                row.classList.add('selected');
                hubSlotInviteSelected = {
                    uid: row.getAttribute('data-uid'),
                    nick: row.getAttribute('data-nick'),
                    photoURL: row.getAttribute('data-photo')
                };
                renderHubSlotInviteAction(hubSlotInviteSelected);
            });
        });
    } catch (e) {
        results.innerHTML = '<div class="hub-slot-invite-result"><span class="hub-slot-invite-result-status">Error al buscar.</span></div>';
    }
}

async function renderHubSlotInviteAction(user) {
    var action = document.getElementById('hubSlotInviteAction');
    if (!action || !user) return;
    action.style.display = 'block';
    var gate = await getSocialGateStatus(user.uid);
    var hint = '';
    var btnHtml = '';
    if (gate.step === 'friend') {
        hint = '<p class="hub-slot-invite-step-hint"><strong>Paso 1:</strong> ' + pzEsc(user.nick) + ' aún no es tu amigo. Envía una solicitud de amistad (una sola vez). Después podrán chatear, intercambiar ítems y jugar juntos.</p>';
        btnHtml = '<button type="button" class="electric-btn hub-slot-action-btn" id="hubSlotFriendBtn"><i class="fas fa-user-plus"></i> Enviar solicitud de amistad</button>';
    } else if (gate.step === 'chat') {
        hint = '<p class="hub-slot-invite-step-hint"><strong>Paso 2:</strong> Ya son amigos. Envía una petición de juego/comunicación antes de invitarlo a la misión.</p>';
        btnHtml = '<button type="button" class="electric-btn hub-slot-action-btn" id="hubSlotChatBtn"><i class="fas fa-gamepad"></i> Enviar petición de juego</button>';
    } else {
        hint = '<p class="hub-slot-invite-step-hint"><strong>Listo:</strong> Puedes invitar a ' + pzEsc(user.nick) + ' a unirse a este slot de la misión.</p>';
        btnHtml = '<button type="button" class="electric-btn hub-slot-action-btn" id="hubSlotMissionBtn"><i class="fas fa-envelope"></i> Invitar a la misión</button>';
    }
    action.innerHTML = hint + btnHtml;
    var friendBtn = document.getElementById('hubSlotFriendBtn');
    if (friendBtn) friendBtn.onclick = function() {
        openFriendRequestModal(user.uid, user.nick);
        if (window._closeHubSlotInviteModal) window._closeHubSlotInviteModal();
    };
    var chatBtn = document.getElementById('hubSlotChatBtn');
    if (chatBtn) chatBtn.onclick = function() {
        openChatRequestModal(user.uid, user.nick);
        if (window._closeHubSlotInviteModal) window._closeHubSlotInviteModal();
    };
    var missionBtn = document.getElementById('hubSlotMissionBtn');
    if (missionBtn) missionBtn.onclick = function() {
        inviteToMission(user.uid, user.nick);
        if (window._closeHubSlotInviteModal) window._closeHubSlotInviteModal();
    };
}

function renderHubPlayerSlots(mission) {
    var container = document.getElementById('hubPlayerSlots');
    if (!container) return;
    var maxSlots = parseInt(mission.maxParticipants, 10) || 5;
    var sortedUids = getSortedParticipantUids(mission);
    var isLeader = currentUser && mission.creatorUid === currentUser.uid;
    container.innerHTML = '';

    for (var i = 0; i < maxSlots; i++) {
        var slot = document.createElement('div');
        if (i < sortedUids.length) {
            var uid = sortedUids[i];
            var p = mission.participants[uid];
            var isHost = uid === mission.creatorUid;
            var isPartner = uid !== currentUser.uid && hubFriendsByUid[uid];
            slot.className = 'hub-player-slot filled' + (isHost ? ' is-leader' : '') + (isPartner ? ' is-partner' : '');
            // Perfil primero; botones absolutos DESPUÉS en el DOM + z-index alto
            // para que no los tape el hit de perfil (antes el click abría el perfil).
            slot.innerHTML =
                '<div class="hub-slot-profile-hit">' +
                '<img src="' + pzEsc(p.photoURL || 'dragon_profile_studiosgamesrs.png') + '" class="hub-slot-avatar" alt="">' +
                '<span class="hub-slot-nick">' + pzEsc(p.nick || 'Usuario') + '</span>' +
                '<span class="hub-slot-rank">' + pzEsc(p.rank || 'Tribal Warrior') + '</span>' +
                '</div>' +
                (isHost ? '<span class="hub-slot-leader-badge" title="Anfitrión"><i class="fas fa-crown"></i></span>' : '') +
                (isPartner ? '<span class="hub-slot-partner-badge" title="Partner de PlayZone"><i class="fas fa-handshake"></i> Partner</span>' : '') +
                (uid !== currentUser.uid
                    ? '<button type="button" class="hub-slot-msg-btn" title="Enviar mensaje privado" aria-label="Mensaje privado"><i class="fas fa-comment-dots"></i></button>'
                    : '') +
                (isLeader && uid !== currentUser.uid
                    ? '<button type="button" class="hub-slot-kick-btn" title="Expulsar jugador" aria-label="Expulsar jugador"><i class="fas fa-user-times"></i></button>'
                    : '');

            (function(slotUid, slotP) {
                var profileHit = slot.querySelector('.hub-slot-profile-hit');
                if (profileHit) profileHit.onclick = function() { viewProfile(slotUid); };
                var msgBtn = slot.querySelector('.hub-slot-msg-btn');
                if (msgBtn) {
                    msgBtn.onclick = function(e) {
                        e.preventDefault();
                        e.stopPropagation();
                        handleHubPlayerMsgClick(slotUid, slotP.nick || 'Usuario', slotP.photoURL || 'dragon_profile_studiosgamesrs.png');
                    };
                }
                var kickBtn = slot.querySelector('.hub-slot-kick-btn');
                if (kickBtn) {
                    kickBtn.onclick = function(e) {
                        e.preventDefault();
                        e.stopPropagation();
                        kickPlayerFromMission(currentMissionId, slotUid, slotP.nick || 'Usuario');
                    };
                }
            })(uid, p);
        } else {
            slot.className = 'hub-player-slot empty';
            slot.innerHTML = '<div class="hub-slot-plus"><i class="fas fa-plus"></i></div><span class="hub-slot-empty-label">Invitar jugador</span>';
            slot.onclick = function() {
                if (typeof openHubSlotInviteModal === 'function') openHubSlotInviteModal();
            };
        }
        container.appendChild(slot);
    }
}

function isCs2FriendsMission(mission) {
    return mission && mission.verificationMode === 'cs2_steam';
}

function updateCs2FriendsUI(mission) {
    const card = document.getElementById('hubCs2FriendsCard');
    const statusEl = document.getElementById('hubCs2FriendsStatus');
    const btnReady = document.getElementById('btnCs2Ready');
    const btnVerify = document.getElementById('btnCs2Verify');
    if (!card || !statusEl) return;

    if (!isCs2FriendsMission(mission) || !currentUser || !mission.participants || !mission.participants[currentUser.uid]) {
        card.style.display = 'none';
        return;
    }

    card.style.display = 'block';
    const pKeys = Object.keys(mission.participants || {});
    const ready = mission.cs2Ready || {};
    const chips = pKeys.map(function(uid) {
        var p = mission.participants[uid];
        var ok = ready[uid] === true;
        return '<span style="display:inline-block;margin:4px 6px 0 0;padding:4px 8px;border-radius:8px;font-size:0.8rem;background:' +
            (ok ? 'rgba(102,192,244,0.25)' : 'rgba(255,255,255,0.08)') + ';border:1px solid ' + (ok ? '#66c0f4' : '#444') + ';">' +
            (p.nick || 'Usuario') + (ok ? ' ✓ listo' : '') + '</span>';
    }).join('');

    if (mission.nexusVerifiedComplete || (mission.cs2Verification && mission.cs2Verification.status === 'passed')) {
        statusEl.innerHTML = '<span style="color:#81c784;"><i class="fas fa-check-circle"></i> Partida verificada — tokens en camino.</span>';
        if (btnReady) btnReady.style.display = 'none';
        if (btnVerify) btnVerify.style.display = 'none';
        return;
    }

    statusEl.innerHTML = '<div style="font-size:0.75rem;color:#888;margin-bottom:6px;">Listos para jugar</div>' + chips;

    if (btnReady) {
        if (mission.status === 'pending' && ready[currentUser.uid] !== true) {
            btnReady.style.display = 'block';
            btnReady.onclick = function() { markCs2Ready(mission); };
        } else {
            btnReady.style.display = 'none';
        }
    }

    if (btnVerify) {
        if (mission.status === 'active') {
            btnVerify.style.display = 'block';
            btnVerify.disabled = false;
            btnVerify.onclick = function() { verifyCs2FriendsMatch(mission); };
        } else {
            btnVerify.style.display = 'none';
        }
    }
}

async function markCs2Ready(mission) {
    if (!currentMissionId || !currentUser) return;
    try {
        await db.ref('missions/' + currentMissionId + '/cs2Ready/' + currentUser.uid).set(true);
        showFloatingMessage('success', 'Marcado como listo. Espera a que el equipo complete.');
    } catch (e) {
        showFloatingMessage('error', 'No se pudo marcar listo.');
    }
}

async function verifyCs2FriendsMatch(mission) {
    if (!currentMissionId || typeof firebase === 'undefined' || !firebase.functions) {
        showFloatingMessage('error', 'Verificación no disponible.');
        return;
    }
    const btn = document.getElementById('btnCs2Verify');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Verificando...'; }
    try {
        const fn = firebase.functions().httpsCallable('verifyCs2FriendsMission');
        const res = await fn({ missionId: currentMissionId });
        const data = res.data || {};
        if (data.success && data.allPassed) {
            showFloatingMessage('success', '¡Partida verificada! El equipo recibirá 5 tokens cada uno.');
        } else if (data.results) {
            var pending = Object.keys(data.results).filter(function(uid) { return !data.results[uid].passed; }).length;
            var reasons = Object.keys(data.results).map(function(uid) { return data.results[uid].reason; });
            var msg;
            if (reasons.indexOf('not_same_match') !== -1) {
                msg = 'Las últimas partidas registradas no coinciden entre todo el equipo (parece que no jugaron la misma partida). Jueguen una partida CS2 juntos y vuelvan a verificar.';
            } else if (reasons.indexOf('match_too_short') !== -1) {
                msg = 'La última partida registrada fue muy corta (calentamiento o abandono). Jueguen una partida CS2 completa y vuelvan a verificar.';
            } else if (reasons.indexOf('no_new_match') !== -1) {
                msg = 'Steam aún no registra una partida nueva desde que empezó la misión. Si ya jugaron, esperen un par de minutos (Steam tarda en actualizar) y vuelvan a intentar.';
            } else if (reasons.indexOf('no_stats') !== -1 || reasons.indexOf('no_steam') !== -1 || reasons.indexOf('no_baseline') !== -1) {
                msg = 'No se pudieron leer las estadísticas de CS2 de algún jugador (' + pending + ' pendiente(s)). Verifica que el perfil de Steam y el detalle del juego sean públicos.';
            } else {
                msg = 'Aún faltan jugadores por completar una partida nueva (' + pending + ' pendiente(s)).';
            }
            showFloatingMessage('info', msg);
        } else {
            showFloatingMessage('info', data.message || 'Verificación en proceso.');
        }
    } catch (e) {
        var msg = (e && e.message) ? e.message : 'Error al verificar.';
        showFloatingMessage('error', msg);
    } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-shield-alt"></i> Verificar partida CS2'; }
    }
}

/**
 * Verificación colaborativa: cada participante confirma; al estar todos, se marca nexusVerifiedComplete
 * y la partida aparece en el historial del dashboard.
 */
function updateNexusVerifyUI(mission) {
    const card = document.getElementById('hubNexusVerifyCard');
    const statusEl = document.getElementById('hubNexusVerifyStatus');
    const btn = document.getElementById('btnConfirmMissionComplete');
    if (!card || !statusEl || !btn) return;

    if (isCs2FriendsMission(mission)) {
        card.style.display = 'none';
        return;
    }

    if (!currentUser || !mission || !mission.participants || !mission.participants[currentUser.uid]) {
        card.style.display = 'none';
        return;
    }

    card.style.display = 'block';
    const conf = mission.completionConfirmations || {};
    const pKeys = Object.keys(mission.participants || {});

    if (mission.nexusVerifiedComplete) {
        var rewardLine = '';
        if (mission.tokensAwarded) {
            var mine = (mission.awardedPayouts && currentUser) ? mission.awardedPayouts[currentUser.uid] : undefined;
            if (typeof mine === 'number') {
                rewardLine = mine > 0
                    ? '<div style="margin-top:6px;color:#ffd166;"><i class="fas fa-coins"></i> Recibiste ' + mine + ' token' + (mine === 1 ? '' : 's') + '.</div>'
                    : '<div style="margin-top:6px;color:#888;">Esta misión no otorgó tokens.</div>';
            } else if (typeof mission.awardedAmount === 'number' && mission.awardedAmount > 0) {
                rewardLine = '<div style="margin-top:6px;color:#ffd166;"><i class="fas fa-coins"></i> Recompensa entregada: ' + mission.awardedAmount + ' tokens.</div>';
            }
        } else {
            rewardLine = '<div style="margin-top:6px;color:#888;font-size:0.8rem;"><i class="fas fa-hourglass-half"></i> Procesando recompensa…</div>';
        }
        statusEl.innerHTML = '<span class="nexus-verify-done" style="color:#81c784;"><i class="fas fa-check-circle"></i> Verificado por Nexus — visible en el historial del dashboard.</span>' + rewardLine;
        btn.style.display = 'none';
        return;
    }

    const chips = pKeys.map(function(uid) {
        var p = mission.participants[uid];
        var ok = conf[uid] === true;
        return '<span style="display:inline-block;margin:4px 6px 0 0;padding:4px 8px;border-radius:8px;font-size:0.8rem;background:' +
            (ok ? 'rgba(76,175,80,0.25)' : 'rgba(255,255,255,0.08)') + ';border:1px solid ' + (ok ? '#4caf50' : '#444') + ';">' +
            (p.nick || 'Usuario') + (ok ? ' ✓' : '') + '</span>';
    }).join('');
    statusEl.innerHTML = '<div style="font-size:0.75rem;color:#888;margin-bottom:6px;">Confirmaciones de equipo</div>' + chips;

    // Estimación (tiempo y recompensa sugerida) para mostrar al equipo.
    if (window.PlayzoneSmart) {
        var est = PlayzoneSmart.estimate(mission);
        var estMin = (typeof mission.estMinutes === 'number') ? mission.estMinutes : est.estMinutes;
        statusEl.innerHTML =
            '<div style="font-size:0.75rem;color:#888;margin-bottom:6px;">' +
            '<i class="fas fa-stopwatch"></i> Duración estimada: ' + PlayzoneSmart.formatDuration(estMin) +
            ' &nbsp;·&nbsp; <i class="fas fa-coins"></i> ' + missionRewardLabel(mission) +
            '</div>' + statusEl.innerHTML;
    }

    if (conf[currentUser.uid] === true) {
        btn.style.display = 'none';
        statusEl.innerHTML += '<p style="margin:10px 0 0;color:#ff8a80;font-size:0.85rem;"><i class="fas fa-hourglass-half"></i> Esperando a que el resto confirme…</p>';
    } else {
        btn.style.display = 'block';
        // Anti-abuso: no permitir confirmar antes del tiempo mínimo (mitad del estimado).
        var timeCheck = window.PlayzoneSmart ? PlayzoneSmart.checkMinTime(mission) : { ok: true };
        if (!timeCheck.ok) {
            var notStarted = timeCheck.reason === 'not-started';
            var remainingMin = Math.ceil(timeCheck.remainingMs / 60000);
            var blockedMsg = notStarted
                ? 'La misión todavía no se ha iniciado. El líder debe pulsar «Iniciar Misión» para que cuente el tiempo y haya premio.'
                : 'Aún es pronto para marcarla completa. Espera ~' + PlayzoneSmart.formatDuration(remainingMin) + ' más.';
            btn.disabled = true;
            btn.style.opacity = '0.6';
            btn.style.cursor = 'not-allowed';
            statusEl.innerHTML += '<p style="margin:10px 0 0;color:#ffb74d;font-size:0.85rem;">' +
                '<i class="fas fa-lock"></i> ' + blockedMsg + '</p>';
            btn.onclick = function() {
                showFloatingMessage('info', notStarted
                    ? 'El líder debe iniciar la misión antes de poder completarla.'
                    : 'Todavía no ha pasado el tiempo mínimo de la misión.');
            };
        } else {
            btn.disabled = false;
            btn.style.opacity = '';
            btn.style.cursor = '';
            btn.onclick = function() {
                if (!currentMissionId) return;
                window.confirmNexusMissionComplete(currentMissionId);
            };
        }
    }
}

window.confirmNexusMissionComplete = async function(missionId) {
    if (!currentUser || !missionId || typeof db === 'undefined') return;
    try {
        // Guardia de tiempo mínimo (re-lee la misión para evitar saltarse la regla).
        if (window.PlayzoneSmart) {
            var chkSnap = await db.ref('missions/' + missionId).once('value');
            var chkMission = chkSnap.val();
            if (chkMission) {
                var chk = PlayzoneSmart.checkMinTime(chkMission);
                if (!chk.ok) {
                    showFloatingMessage('error', 'Todavía no ha pasado el tiempo mínimo de la misión.');
                    return;
                }
            }
        }
        await db.ref('missions/' + missionId + '/completionConfirmations/' + currentUser.uid).set(true);
        // PZ-013: nexusVerifiedComplete ya no lo puede escribir el cliente
        // (database.rules.json lo puso en .write:false). El sellado real lo
        // hace en servidor la Cloud Function awardMissionTokens en cuanto ve
        // que TODOS los participantes confirmaron, así nadie puede fabricar
        // una "misión verificada" a mano sin que el resto haya confirmado.
        showFloatingMessage('success', 'Gracias. Cuando todos confirmen, el servidor la sellará y quedará en tu historial del dashboard.');
    } catch (e) {
        console.error(e);
        showFloatingMessage('error', 'No se pudo guardar la confirmación. Revisa conexión o reglas de Firebase.');
    }
};

function setupHubControls(mission, missionId) {
    const isLeader = (currentUser.uid === mission.creatorUid);
    
    const btnStart = document.getElementById('btnStartMission');
    const btnLeave = document.getElementById('btnLeaveMission');
    const btnDelete = document.getElementById('btnDeleteMission');
    const controlsCard = document.getElementById('hubControlsCard');
    
    if (!btnStart || !btnLeave || !btnDelete) return;

    if (controlsCard) controlsCard.style.display = 'block';

    // Ocultar todos por defecto
    btnStart.style.display = 'none';
    btnLeave.style.display = 'none';
    btnDelete.style.display = 'none';

    if (isLeader) {
        // LÓGICA LÍDER
        if (mission.status === 'pending') {
            btnStart.style.display = 'block';
            btnStart.innerHTML = '<i class="fas fa-play"></i> Iniciar Misión';
            btnStart.onclick = function() { startMissionWithChecks(missionId); };
        } else if (mission.status === 'active') {
            btnStart.style.display = 'block';
            btnStart.innerHTML = '<i class="fas fa-flag-checkered"></i> Finalizar Misión';
            btnStart.onclick = () => changeMissionStatus(missionId, 'finished');
        }
        
        btnDelete.style.display = 'block';
        btnDelete.onclick = () => deleteMission(missionId);

    } else {
        // LÓGICA MIEMBRO (BOTÓN ABANDONAR)
        btnLeave.style.display = 'block';
        btnLeave.onclick = () => leaveMission(missionId);
    }
}

// --- Acciones de Control ---
async function startMissionWithChecks(missionId) {
    try {
        const snap = await db.ref('missions/' + missionId).once('value');
        const mission = snap.val();
        if (!mission) return;
        if (isCs2FriendsMission(mission)) {
            const pIds = Object.keys(mission.participants || {});
            if (pIds.length < 2) {
                showFloatingMessage('error', 'Se necesitan al menos 2 jugadores para CS2 con amigos.');
                return;
            }
            const ready = mission.cs2Ready || {};
            var allReady = pIds.every(function(uid) { return ready[uid] === true; });
            if (!allReady) {
                showFloatingMessage('error', 'Todos deben pulsar "Estoy listo para jugar" antes de iniciar.');
                return;
            }
        }
        await changeMissionStatus(missionId, 'active');
    } catch (e) {
        console.error(e);
        showFloatingMessage('error', 'No se pudo iniciar la misión.');
    }
}

async function changeMissionStatus(missionId, newStatus) {
    try {
        const updates = { status: newStatus };
        // Al iniciar, guardamos el momento de arranque para poder validar el tiempo mínimo.
        if (newStatus === 'active') {
            updates.startedAt = firebase.database.ServerValue.TIMESTAMP;
        }
        await db.ref(`missions/${missionId}`).update(updates);
        showFloatingMessage('success', `Estado actualizado a: ${newStatus}`);
    } catch (e) { console.error(e); showFloatingMessage('error', 'Error al actualizar estado'); }
}

async function deleteMission(missionId) {
    if (!confirm("¿Cancelar misión? Se eliminará para todos.")) return;
    try {
        await db.ref(`missions/${missionId}`).remove();
    } catch (e) { console.error(e); showFloatingMessage('error', 'Error al borrar misión'); }
}

async function leaveMission(missionId) {
    await db.ref(`missions/${missionId}/participants/${currentUser.uid}`).remove();
    try { await db.ref('missions/' + missionId + '/cs2Ready/' + currentUser.uid).remove(); } catch (e) {}
    showFloatingMessage('info', 'Has abandonado la misión.');
    exitHubLogic();
}

async function kickPlayerFromMission(missionId, targetUid, targetNick) {
    if (!missionId || !targetUid || !currentUser) return;
    if (targetUid === currentUser.uid) return;
    try {
        var snap = await db.ref('missions/' + missionId).once('value');
        var mission = snap.val();
        if (!mission) {
            showFloatingMessage('error', 'La misión ya no existe.');
            return;
        }
        if (mission.creatorUid !== currentUser.uid) {
            showFloatingMessage('error', 'Solo el anfitrión puede expulsar a otro jugador.');
            return;
        }
        if (targetUid === mission.creatorUid) {
            showFloatingMessage('error', 'No se puede expulsar al anfitrión.');
            return;
        }
        if (!mission.participants || !mission.participants[targetUid]) {
            showFloatingMessage('info', 'Ese jugador ya no está en la misión.');
            return;
        }
        if (!confirm('¿Expulsar a ' + (targetNick || 'este jugador') + ' de la misión?')) return;

        // Preferir Cloud Function (Admin SDK) para no depender de reglas/cliente.
        if (typeof firebase !== 'undefined' && firebase.functions) {
            try {
                var kickFn = firebase.functions().httpsCallable('kickMissionParticipant');
                await kickFn({ missionId: missionId, targetUid: targetUid });
                showFloatingMessage('success', (targetNick || 'Jugador') + ' fue expulsado de la misión.');
                return;
            } catch (cfErr) {
                console.warn('kickMissionParticipant CF falló, intentando borrado directo:', cfErr);
                // Si la CF aún no está desplegada, caer al borrado directo.
                var cfCode = (cfErr && (cfErr.code || (cfErr.details && cfErr.details.code))) || '';
                if (String(cfCode).indexOf('not-found') === -1 && String(cfCode).indexOf('unimplemented') === -1) {
                    var cfMsg = (cfErr && cfErr.message) ? String(cfErr.message) : 'No se pudo expulsar al jugador.';
                    showFloatingMessage('error', cfMsg.replace(/^.*?:\s*/, '') || 'No se pudo expulsar al jugador.');
                    return;
                }
            }
        }

        await db.ref('missions/' + missionId + '/participants/' + targetUid).remove();
        try { await db.ref('missions/' + missionId + '/cs2Ready/' + targetUid).remove(); } catch (e) {}
        try { await db.ref('missions/' + missionId + '/completionConfirmations/' + targetUid).remove(); } catch (e) {}
        showFloatingMessage('success', (targetNick || 'Jugador') + ' fue expulsado de la misión.');
    } catch (e) {
        console.error(e);
        var errMsg = (e && e.message) ? String(e.message) : '';
        if (/PERMISSION_DENIED/i.test(errMsg)) {
            showFloatingMessage('error', 'Permiso denegado al expulsar. Recarga la página e inténtalo de nuevo.');
        } else {
            showFloatingMessage('error', 'No se pudo expulsar al jugador.');
        }
    }
}

function handleMissionDeleted() {
    showFloatingMessage('error', 'La misión ha terminado o fue cancelada.');
    exitHubLogic(); // <-- Asegúrate de que esta línea esté aquí
}

function handleKickedFromMission() {
    showFloatingMessage('info', 'Has sido expulsado de la misión.');
    exitHubLogic();
}

function exitHubLogic() {
    // 1. Limpiar listeners de Firebase (misión específica y chat del hub)
    if (currentMissionId) {
        if (currentMissionListener) {
            db.ref(`missions/${currentMissionId}`).off('value', currentMissionListener);
        } else {
            db.ref(`missions/${currentMissionId}`).off();
        }
    }
    teardownHubChatListeners();
    currentMissionListener = null;

    // 2. Detener cronómetros
    clearInterval(missionTimerInterval);
    missionTimerInterval = null;

    // 3. DESBLOQUEO CRÍTICO: Resetear variables de estado (permite volver a unirse)
    userHasActiveMission = false;
    currentMissionId = null;

    // 4. Actualizar Interfaz
    const activeTabBtn = document.getElementById('tabActiveMission');
    if (activeTabBtn) {
        activeTabBtn.style.display = 'none';
        activeTabBtn.innerHTML = '<i class="fas fa-satellite-dish"></i> Misión Activa';
    }

    // 5. Ocultar tarjeta verificación Nexus
    var nexusVerifyCard = document.getElementById('hubNexusVerifyCard');
    if (nexusVerifyCard) nexusVerifyCard.style.display = 'none';

    // 6. Forzar refresco de los botones "Unirse" en la lista
    if (typeof renderFilteredMissions === 'function') renderFilteredMissions();

    // 7. Volver a la pestaña principal
    var findTab = document.getElementById('tabFindMissions');
    if (findTab) findTab.click();
}
// --- Chat del Hub (CORREGIDO - SIN DUPLICADOS) ---

function getHubDmRoomId(partnerUid) {
    if (!currentUser || !partnerUid) return null;
    return [currentUser.uid, partnerUid].sort().join('_');
}

function teardownHubChatListeners() {
    if (hubChatInitializedFor) {
        if (hubChatTeamListener) {
            db.ref('missions/' + hubChatInitializedFor + '/chat').off('child_added', hubChatTeamListener);
        }
        if (hubChatDmListener && hubChatDmListenerRoom) {
            db.ref('missions/' + hubChatInitializedFor + '/dm/' + hubChatDmListenerRoom + '/messages').off('child_added', hubChatDmListener);
        }
    }
    hubChatTeamListener = null;
    hubChatDmListener = null;
    hubChatDmListenerRoom = null;
    currentHubChatListener = null;
    hubChatInitializedFor = null;
    hubChatActiveTab = 'team';
    hubChatDmPartnerUid = null;
    hubChatDmTabs = {};
}

function renderHubChatTabs() {
    var tabsEl = document.getElementById('hubChatTabs');
    if (!tabsEl) return;
    tabsEl.innerHTML = '';

    var teamBtn = document.createElement('button');
    teamBtn.type = 'button';
    teamBtn.className = 'hub-chat-tab' + (hubChatActiveTab === 'team' ? ' active' : '');
    teamBtn.setAttribute('role', 'tab');
    teamBtn.innerHTML = '<i class="fas fa-users"></i> Equipo';
    teamBtn.onclick = function() { switchHubChatTab('team'); };
    tabsEl.appendChild(teamBtn);

    Object.keys(hubChatDmTabs).forEach(function(partnerUid) {
        var tabData = hubChatDmTabs[partnerUid];
        var dmBtn = document.createElement('button');
        dmBtn.type = 'button';
        dmBtn.className = 'hub-chat-tab' + (hubChatActiveTab === 'dm' && hubChatDmPartnerUid === partnerUid ? ' active' : '');
        dmBtn.setAttribute('role', 'tab');
        dmBtn.innerHTML = '<i class="fas fa-user-lock"></i> ' + pzEsc(tabData.nick || 'Jugador');
        dmBtn.onclick = function() { switchHubChatTab('dm', partnerUid); };
        tabsEl.appendChild(dmBtn);
    });
}

function openHubDmWithPlayer(partnerUid, partnerNick, partnerPhotoURL) {
    if (!currentUser || !partnerUid || partnerUid === currentUser.uid) return;
    hubChatDmTabs[partnerUid] = {
        nick: partnerNick || 'Jugador',
        photoURL: partnerPhotoURL || 'dragon_profile_studiosgamesrs.png'
    };
    renderHubChatTabs();
    switchHubChatTab('dm', partnerUid);
    showFloatingMessage('info', 'Canal privado abierto con ' + (partnerNick || 'jugador') + '.');
}

function switchHubChatTab(mode, partnerUid) {
    hubChatActiveTab = mode;
    hubChatDmPartnerUid = partnerUid || null;
    renderHubChatTabs();

    var chatWindow = document.getElementById('hubChatWindow');
    var input = document.getElementById('hubChatInput');
    if (!chatWindow || !hubChatInitializedFor) return;

    if (hubChatDmListener && hubChatDmListenerRoom) {
        db.ref('missions/' + hubChatInitializedFor + '/dm/' + hubChatDmListenerRoom + '/messages').off('child_added', hubChatDmListener);
        hubChatDmListener = null;
        hubChatDmListenerRoom = null;
    }
    if (hubChatTeamListener && mode !== 'team') {
        db.ref('missions/' + hubChatInitializedFor + '/chat').off('child_added', hubChatTeamListener);
        hubChatTeamListener = null;
        currentHubChatListener = null;
    }

    if (mode === 'team') {
        if (input) input.placeholder = 'Mensaje al equipo... (Enter para enviar)';
        loadHubTeamMessages(hubChatInitializedFor);
        return;
    }

    if (mode === 'dm' && partnerUid) {
        var nick = (hubChatDmTabs[partnerUid] && hubChatDmTabs[partnerUid].nick) || 'jugador';
        if (input) input.placeholder = 'Mensaje privado a ' + nick + '...';
        loadHubDmMessages(hubChatInitializedFor, partnerUid);
    }
}

function loadHubTeamMessages(missionId) {
    var chatWindow = document.getElementById('hubChatWindow');
    if (!chatWindow) return;
    chatWindow.innerHTML = '<div class="system-message">Canal seguro del equipo establecido.</div>';

    var chatRef = db.ref('missions/' + missionId + '/chat').limitToLast(50);
    if (hubChatTeamListener) chatRef.off('child_added', hubChatTeamListener);

    hubChatTeamListener = chatRef.on('child_added', function(snapshot) {
        if (hubChatActiveTab !== 'team') return;
        renderHubChatMessage(snapshot.val(), chatWindow);
    });
    currentHubChatListener = hubChatTeamListener;
}

function loadHubDmMessages(missionId, partnerUid) {
    var chatWindow = document.getElementById('hubChatWindow');
    if (!chatWindow) return;
    var roomId = getHubDmRoomId(partnerUid);
    if (!roomId) return;

    chatWindow.innerHTML = '<div class="system-message">Canal privado dentro del Mission Comm Link.</div>';

    var chatRef = db.ref('missions/' + missionId + '/dm/' + roomId + '/messages').limitToLast(50);
    if (hubChatDmListener && hubChatDmListenerRoom) {
        db.ref('missions/' + missionId + '/dm/' + hubChatDmListenerRoom + '/messages').off('child_added', hubChatDmListener);
    }

    hubChatDmListenerRoom = roomId;
    hubChatDmListener = chatRef.on('child_added', function(snapshot) {
        if (hubChatActiveTab !== 'dm' || hubChatDmPartnerUid !== partnerUid) return;
        renderHubChatMessage(snapshot.val(), chatWindow);
    });
}

function bindHubChatForm(missionId) {
    var chatForm = document.getElementById('hubChatForm');
    if (!chatForm) return;

    var newChatForm = chatForm.cloneNode(true);
    chatForm.parentNode.replaceChild(newChatForm, chatForm);

    newChatForm.addEventListener('submit', function(e) {
        e.preventDefault();
        var input = document.getElementById('hubChatInput');
        var text = (input && input.value || '').trim();
        if (!text || !currentUser || !currentUserData) return;

        var msgData = {
            senderUid: currentUser.uid,
            nick: currentUserData.nick,
            photoURL: currentUserData.photoURL || 'dragon_profile_studiosgamesrs.png',
            text: text,
            timestamp: firebase.database.ServerValue.TIMESTAMP
        };

        if (hubChatActiveTab === 'dm' && hubChatDmPartnerUid) {
            var roomId = getHubDmRoomId(hubChatDmPartnerUid);
            if (!roomId) return;
            msgData.recipientUid = hubChatDmPartnerUid;
            db.ref('missions/' + missionId + '/dm/' + roomId + '/messages').push(msgData);
        } else {
            db.ref('missions/' + missionId + '/chat').push(msgData);
        }

        if (input) { input.value = ''; input.focus(); }
    });
}

function setupHubChatSystem(missionId) {
    teardownHubChatListeners();
    hubChatInitializedFor = missionId;
    hubChatActiveTab = 'team';
    hubChatDmPartnerUid = null;
    hubChatDmTabs = {};
    renderHubChatTabs();
    bindHubChatForm(missionId);
    switchHubChatTab('team');
}

// Alias legacy
function loadHubChat(missionId) {
    setupHubChatSystem(missionId);
}

function renderHubChatMessage(msg, container) {
    if(!msg) return;
    const isMine = msg.senderUid === currentUser.uid;
    const div = document.createElement('div');
    div.className = `message-item ${isMine ? 'mine' : 'theirs'}`;
    div.style.marginBottom = "8px";

    // PZ-015: msg.photoURL viene del perfil del remitente (users/{uid}/photoURL,
    // controlado por él mismo) y se insertaba crudo dentro de src="...". Un valor
    // como `x" onerror="alert(1)` rompía el atributo y ejecutaba script en el
    // navegador de TODO el equipo al abrir el chat del hub. Ahora se exige el
    // mismo esquema permitido para avatares (sprite local o https) y encima se
    // escapa antes de interpolar, como defensa adicional por si el esquema fuera
    // válido pero la URL trajera comillas.
    const safeAvatar = pzEsc(pzSanitizeAvatarUrl(msg.photoURL));

    div.innerHTML = `
        ${!isMine ? `<img src="${safeAvatar}" class="message-avatar" style="width:25px;height:25px;">` : ''}
        <div class="message-bubble" style="padding: 6px 10px; font-size: 0.9rem;">
            ${!isMine ? `<span class="message-author" style="font-size:0.75rem;color:#4bdfff;">${pzEsc(msg.nick)}</span>` : ''}
            ${pzEsc(msg.text)}
        </div>
    `;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
}

// =======================================================
// === 12. SISTEMA DE CHAT 1-a-1 (MANTENER IGUAL) ===
// ... (El resto del código de la parte 12 se mantiene igual, no lo borres si no quieres, 
// pero como pedí borrar hasta el final, asegúrate de que tu archivo original tenía la parte 12.
// SI TU ARCHIVO ORIGINAL TENÍA LA PARTE 12 AL FINAL, NECESITAS PEGARLA AQUÍ ABAJO TAMBIÉN.
// SI NO ESTÁS SEGURO, TE LA DEJO AQUÍ ABAJO RESUMIDA PARA QUE COPIES TODO EL BLOQUE)
// =======================================================

function setupChatRequestModal() {
  const modal = document.getElementById('chatRequestModal');
  const closeBtn = document.getElementById('closeChatRequestModal');
  if(closeBtn) closeBtn.addEventListener('click', () => modal.style.display = 'none');
}

window.openChatRequestModal = (targetUid, targetNick) => {
  if (!currentUser) return;
  if (targetUid === currentUser.uid) return; 

  const modal = document.getElementById('chatRequestModal');
  const title = document.getElementById('chatRequestModalTitle');
  const subtitle = document.getElementById('chatRequestSubTitle');
  const form = document.getElementById('chatRequestForm');
  const textarea = document.getElementById('chatRequestMessage');
  const sendBtn = document.getElementById('sendChatRequestBtn');
  
  if (title) title.innerHTML = '<i class="fas fa-gamepad"></i> Petición de juego';
  if (subtitle) subtitle.textContent = 'Envía una petición de comunicación a ' + targetNick + '. Solo después podrán chatear e invitarse a partidas.';
  if (textarea) textarea.value = ''; 
  if (sendBtn) {
    sendBtn.disabled = false;
    sendBtn.innerHTML = '<span>Enviar petición</span> <i class="fas fa-paper-plane"></i>';
  }
  
  modal.style.display = 'flex';
  form.onsubmit = (e) => handleChatRequestSubmit(e, targetUid, targetNick);
};

async function handleChatRequestSubmit(e, targetUid, targetNick) {
  e.preventDefault();
  if (!currentUser) return;

  if (!(await isSgFriend(targetUid))) {
    showFloatingMessage('error', 'Primero deben ser amigos antes de enviar una petición de juego.');
    document.getElementById('chatRequestModal').style.display = 'none';
    openFriendRequestModal(targetUid, targetNick);
    return;
  }
  
  const textarea = document.getElementById('chatRequestMessage');
  const message = textarea.value.trim();
  if (!message) {
    showFloatingMessage('error', 'Escribe un mensaje para tu petición.');
    return;
  }
  
  const sendBtn = document.getElementById('sendChatRequestBtn');
  sendBtn.disabled = true;
  sendBtn.innerHTML = '<span>Sending...</span> <i class="fas fa-spinner fa-spin"></i>';

  const requestRef = db.ref(`privateChatRequests/${targetUid}/${currentUser.uid}`);
  const requestData = {
    senderUid: currentUser.uid,
    senderNick: currentUserData.nick || 'A player',
    senderAvatar: currentUserData.photoURL || 'dragon_profile_studiosgamesrs.png',
    initialMessage: message,
    timestamp: firebase.database.ServerValue.TIMESTAMP
  };

  try {
    await requestRef.set(requestData);
    showFloatingMessage('success', 'Petición de juego enviada a ' + targetNick + '!');
    document.getElementById('chatRequestModal').style.display = 'none';
  } catch (error) {
    console.error("Error sending chat request:", error);
    showFloatingMessage('error', 'Failed to send chat request.');
    sendBtn.disabled = false;
  }
}

function listenForChatRequests() {
  if (!currentUser) return;
  // Panel + toasts unificados en SGNotifications (todas las páginas).
  if (window.SGNotifications && window.SGNotifications.handlesLiveToasts) return;
  const requestsRef = db.ref(`privateChatRequests/${currentUser.uid}`);
  
  requestsRef.on('child_added', (snapshot) => {
    const requestData = snapshot.val();
    const senderUid = snapshot.key;
    if (requestData && senderUid) {
      showChatRequestNotification({ ...requestData, senderUid });
    }
  });

  requestsRef.on('child_removed', (snapshot) => {
     const notifId = `chat-req-${snapshot.key}`;
     const notifElement = document.getElementById(notifId);
     if (notifElement) notifElement.remove();
  });
}

function showChatRequestNotification(requestData) {
  const container = document.getElementById('privateChatNotificationContainer');
  const notifId = `chat-req-${requestData.senderUid}`;
  if (document.getElementById(notifId)) return;

  const notification = document.createElement('div');
  notification.className = 'notification-item success'; 
  notification.id = notifId;
  notification.style.animation = 'slideInNotification 0.5s forwards';

  notification.innerHTML = `
    <i class="fas fa-comment-dots" style="color: #4caf50;"></i>
    <div style="flex: 1;">
      <strong>${requestData.senderNick}</strong> sent you a chat request:
      <p style="font-style: italic; margin: 5px 0 10px; opacity: 0.9;">"${requestData.initialMessage}"</p>
      <div style="display: flex; gap: 10px; justify-content: flex-end;">
        <button class="request-accept-btn">Accept</button>
        <button class="request-decline-btn">Decline</button>
      </div>
    </div>
  `;

  container.appendChild(notification);
  const acceptBtn = notification.querySelector('.request-accept-btn');
  const declineBtn = notification.querySelector('.request-decline-btn');
  const partnerPhotoURL = requestData.senderAvatar || 'dragon_profile_studiosgamesrs.png';

  acceptBtn.onclick = async () => {
    acceptBtn.disabled = true;
    declineBtn.disabled = true;
    try {
      await db.ref(`privateChatRequests/${currentUser.uid}/${requestData.senderUid}`).remove();
      await db.ref('sgChatLinks/' + currentUser.uid + '/' + requestData.senderUid).set(true);
      await db.ref('sgChatLinks/' + requestData.senderUid + '/' + currentUser.uid).set(true);
      openPrivateChat(requestData.senderUid, requestData.senderNick, partnerPhotoURL);
      notification.remove();
    } catch (error) { console.error(error); showFloatingMessage('error', 'Error accepting.'); }
  };
  
  declineBtn.onclick = async () => {
    acceptBtn.disabled = true;
    declineBtn.disabled = true;
    try {
      await db.ref(`privateChatRequests/${currentUser.uid}/${requestData.senderUid}`).remove();
      showFloatingMessage('success', 'Request declined.');
      notification.remove();
    } catch (error) { console.error(error); }
  };
}

function setupPrivateChatWindow() {
  const closeBtn = document.getElementById('closePrivateChatBtn');
  const chatForm = document.getElementById('privateChatForm');
  const imageUpload = document.getElementById('privateChatImageUpload');
  
  if(closeBtn) closeBtn.onclick = minimizePrivateChat;
  if(chatForm) chatForm.onsubmit = (e) => e.preventDefault(); 
  if(imageUpload) imageUpload.onchange = handlePrivateChatImageUpload;
}

function openPrivateChat(partnerUid, partnerNick, partnerPhotoURL) {
  const chatWindow = document.getElementById('privateChatWindow');
  const partnerNameEl = document.getElementById('privateChatPartnerName');
  const chatForm = document.getElementById('privateChatForm');
  
  if (!currentUser || !chatWindow) return;

  if (currentPrivateChatRoomID && activeChats[partnerUid] && activeChats[partnerUid].chatRoomID !== currentPrivateChatRoomID) {
      if(chatWindow.classList.contains('visible')) {
          const previousPartnerUid = Object.keys(activeChats).find(uid => activeChats[uid].isMinimized === false);
          if (previousPartnerUid) minimizePrivateChat();
      }
  }
  
  const newChatRoomID = [currentUser.uid, partnerUid].sort().join('_');
  currentPrivateChatRoomID = newChatRoomID;
  
  activeChats[partnerUid] = {
      partnerUid: partnerUid,
      nick: partnerNick,
      photoURL: partnerPhotoURL,
      chatRoomID: newChatRoomID,
      isMinimized: false
  };
  
  partnerNameEl.textContent = partnerNick;
  chatForm.onsubmit = (e) => handlePrivateChatSubmit(e, currentPrivateChatRoomID);
  chatWindow.style.display = 'flex';
  chatWindow.classList.add('visible');
  
  const minimizedTab = document.getElementById(`minimized-chat-${partnerUid}`);
  if (minimizedTab) minimizedTab.style.display = 'none';

  if (window.SGNotifications && typeof window.SGNotifications.markPrivateChatRead === 'function') {
    window.SGNotifications.markPrivateChatRead(partnerUid);
    window.SGNotifications.setActivePrivateChat(partnerUid);
  }

  loadPrivateChatMessages(currentPrivateChatRoomID);
}

function loadPrivateChatMessages(chatRoomID) {
  const messagesList = document.getElementById('privateChatMessagesList');
  let isInitialLoad = true;
  const messagesRef = db.ref(`privateChats/${chatRoomID}/messages`).limitToLast(30);
  
  if (currentPrivateChatListener) messagesRef.off('child_added', currentPrivateChatListener);
  
  currentPrivateChatListener = messagesRef.on('child_added', (snapshot) => {
    const msgData = snapshot.val();
    if (!msgData) return;

    if (isInitialLoad) { messagesList.innerHTML = ''; isInitialLoad = false; }
    renderPrivateChatMessage(msgData, messagesList);
  });
}

function renderPrivateChatMessage(msgData, container) {
  const isMine = msgData.userId === currentUser.uid;
  const item = document.createElement('div');
  item.className = `message-item ${isMine ? 'mine' : 'theirs'} ${msgData.type || 'text'}`;
  if (msgData.imageUrl && !msgData.text) item.classList.add('image-only');

  // PZ-016: photoURL e imageUrl viajaban crudos dentro de src="...". photoURL
  // sale del perfil del remitente (igual que PZ-015) e imageUrl, aunque hoy solo
  // lo escribe handlePrivateChatImageUpload con una URL de Storage, es un campo
  // sin ningún esquema en las reglas (ver PZ-021/PZ-018): cualquiera puede
  // empujar un mensaje directo a privateChats con un valor arbitrario. Ahora el
  // avatar exige el mismo esquema que en el resto de Play Zone (sprite local o
  // https) y la imagen del chat exige además que el host sea el de Firebase
  // Storage; si no cumple, sencillamente no se dibuja ninguna imagen rota.
  const safeAvatar = pzEsc(pzSanitizeAvatarUrl(msgData.photoURL));
  const safeImageUrl = pzSanitizeChatImageUrl(msgData.imageUrl);

  item.innerHTML = `
    ${!isMine ? `<img src="${safeAvatar}" class="message-avatar">` : ''}
    <div class="message-bubble">
      ${!isMine ? `<span class="message-author">${pzEsc(msgData.nick)}</span>` : ''}
      <div class="message-content">
        ${msgData.text ? `<div>${pzEsc(msgData.text)}</div>` : ''}
        ${safeImageUrl ? `<img src="${pzEsc(safeImageUrl)}" class="message-image">` : ''}
      </div>
    </div>
  `;
  container.appendChild(item);
  container.scrollTop = container.scrollHeight;
}

function handlePrivateChatSubmit(e, chatRoomID) {
  e.preventDefault();
  const input = document.getElementById('privateChatMessageInput');
  const text = input.value.trim();
  if (!text) return;

  const messageData = {
    userId: currentUser.uid,
    nick: currentUserData.nick,
    photoURL: currentUserData.photoURL,
    text: text,
    type: 'text',
    timestamp: firebase.database.ServerValue.TIMESTAMP
  };

  db.ref(`privateChats/${chatRoomID}/messages`).push(messageData);
  input.value = ''; 
}

async function handlePrivateChatImageUpload(e) {
  const file = e.target.files[0];
  if (!file || !currentUser || !currentPrivateChatRoomID) return;
  
  showFloatingMessage('success', 'Uploading image...');
  try {
    const storageRef = firebase.storage().ref(`private_chat_images/${currentPrivateChatRoomID}/${Date.now()}_${file.name}`);
    const snapshot = await storageRef.put(file);
    const downloadURL = await snapshot.ref.getDownloadURL();
    
    const messageData = {
      userId: currentUser.uid,
      nick: currentUserData.nick,
      photoURL: currentUserData.photoURL,
      type: 'image',
      imageUrl: downloadURL,
      timestamp: firebase.database.ServerValue.TIMESTAMP
    };
    await db.ref(`privateChats/${currentPrivateChatRoomID}/messages`).push(messageData);
  } catch (error) { console.error(error); showFloatingMessage("error", "Failed to upload image."); }
  finally { e.target.value = null; }
}

function minimizePrivateChat() {
  const chatWindow = document.getElementById('privateChatWindow');
  const partnerUid = Object.keys(activeChats).find(uid => activeChats[uid].isMinimized === false);

  if (partnerUid) {
      activeChats[partnerUid].isMinimized = true;
      renderMinimizedChatTab(activeChats[partnerUid]);
  }
  if (window.SGNotifications && typeof window.SGNotifications.setActivePrivateChat === 'function') {
      window.SGNotifications.setActivePrivateChat(null);
  }
  chatWindow.classList.remove('visible');
  setTimeout(() => chatWindow.style.display = 'none', 300);
}

function renderMinimizedChatTab(chatData) {
    const container = document.getElementById('minimizedChatContainer');
    const tabId = `minimized-chat-${chatData.partnerUid}`;
    let tab = document.getElementById(tabId);

    if (!tab) {
        tab = document.createElement('div');
        tab.className = 'minimized-chat-tab';
        tab.id = tabId;
        tab.onclick = () => openPrivateChat(chatData.partnerUid, chatData.nick, chatData.photoURL);
        tab.innerHTML = `
            <img src="${chatData.photoURL}" class="tab-avatar">
            <span class="tab-nick">${chatData.nick}</span>
            <button class="tab-close-btn" onclick="event.stopPropagation(); closePrivateChatCompletely('${chatData.partnerUid}')">&times;</button>
        `;
        container.appendChild(tab);
    }
    tab.style.display = 'flex';
}

window.closePrivateChatCompletely = (partnerUid) => {
    const chatData = activeChats[partnerUid];
    if (!chatData) return;
    if (window.SGNotifications && typeof window.SGNotifications.setActivePrivateChat === 'function') {
        window.SGNotifications.setActivePrivateChat(null);
    }
    
    const chatWindow = document.getElementById('privateChatWindow');
    if (chatData.chatRoomID === currentPrivateChatRoomID && chatWindow.classList.contains('visible')) {
        chatWindow.classList.remove('visible');
        setTimeout(() => chatWindow.style.display = 'none', 300);
        if (currentPrivateChatListener) db.ref(`privateChats/${currentPrivateChatRoomID}/messages`).off('child_added', currentPrivateChatListener);
    }
    
    const tab = document.getElementById(`minimized-chat-${partnerUid}`);
    if (tab) tab.remove();
    
    delete activeChats[partnerUid];
}

/* === FORGE: Modo Teatro + Partículas Ceniza === */
function initForgeExtras() {
    var theaterBtn = document.getElementById('forgeTheaterBtn');
    if (theaterBtn && !theaterBtn.dataset.forgeInited) {
        theaterBtn.dataset.forgeInited = '1';
        theaterBtn.addEventListener('click', function() {
            document.body.classList.toggle('theater-mode');
            theaterBtn.classList.toggle('active', document.body.classList.contains('theater-mode'));
        });
    }
    var bgAnimated = document.getElementById('forgeBgAnimated');
    if (bgAnimated && bgAnimated.children.length === 0) {
        for (var i = 0; i < 24; i++) {
            var p = document.createElement('div');
            p.className = 'forge-bg-particle';
            p.style.left = (Math.random() * 100) + '%';
            p.style.animationDelay = (Math.random() * 12) + 's';
            p.style.animationDuration = (8 + Math.random() * 8) + 's';
            bgAnimated.appendChild(p);
        }
    }
    var ashLayer = document.getElementById('forgeAshLayer');
    if (ashLayer && ashLayer.children.length === 0) {
        for (var j = 0; j < 12; j++) {
            var ap = document.createElement('div');
            ap.className = 'forge-ash-particle';
            ap.style.left = (Math.random() * 100) + '%';
            ap.style.animationDelay = (Math.random() * 10) + 's';
            ap.style.animationDuration = (12 + Math.random() * 6) + 's';
            ashLayer.appendChild(ap);
        }
    }
}

/* --- FIN DEL ARCHIVO --- */