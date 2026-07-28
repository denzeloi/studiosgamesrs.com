/* ======== CÓDIGO PARA dashboard-logic.js (COMPLETO Y CORREGIDO v5 CON REALTIME PLAYZONE) ======== */

// Firebase: sg-firebase-init.js (SEC-022)

// Default profile image as SVG data URI
// FIX CRÍTICO: Se ha corregido la sintaxis de la constante para evitar que la página falle al cargar.
const DEFAULT_PROFILE_IMAGE = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxMjAiIGhlaWdodD0iMTIwIiB2aWV3Qm94PSIwIDAgMTIwIDEyMCI+PGNpcmNsZSBjeD0iNjAiIGN5PSI2MCIgcj0iNjAiIGZpbGw9IiMzMzMiLz48Y2lyY2xlIGN4PSI2MCIgY3k9IjQ1IiByPSIyMCIgZmlsbD0iIzY2NiIvPjxjaXJjbGUgY3g9IjYwIiBjeT0iOTAiIHI9IjMwIiBmaWxsPSIjNjY2Ii8+PC9zdmc+";

// Initialize Firebase (init en dashboard.html vía sgInitFirebaseApp)
if (typeof firebase !== 'undefined' && typeof sgInitFirebaseApp === 'function') {
  try { sgInitFirebaseApp(); } catch (e) { console.warn(e); }
} else if (typeof firebase !== 'undefined' && window.SG_FIREBASE_CONFIG && (!firebase.apps || !firebase.apps.length)) {
  firebase.initializeApp(window.SG_FIREBASE_CONFIG);
}
if (typeof firebase !== 'undefined' && firebase.firestore) {
  const db = firebase.firestore();
}

// ==================================================================
// --- INICIO: GLOBALES AÑADIDAS PARA CHAT Y DEPENDENCIAS (EXPANDIDO) ---
// ==================================================================
let currentUserData = null; // Hecho global para que el chat pueda acceder a él
// --- Globales para el Chat de Equipo ---
let currentChatListener = null;
let currentChatMessagesRef = null; // Referencia al nodo de mensajes para apagar el listener
let currentChatTeamId = null; // ID del chat actualmente abierto
let currentChatRoster = null; // Roster del chat actual
let currentChatFirebaseNode = 'teamChats'; // 'teamChats' | 'missionChats' | 'globalChat' (para avatar por defecto)
let currentTeamChatId = null; // ID del chat de EQUIPO (para botón flotante)
let currentTeamChatName = null;
let currentTeamChatRoster = null;
let popupTimeout; // Timeout for hiding the user popup card
let teamPopupTimeout; // Timeout for hiding the team popup card
// --- Globales para PlayZone (MODIFICADAS) ---
let currentMissionId = null; // ID de la misión activa
let playZoneCountdownInterval = null;
let playZoneChatBadgeListener = null;
let currentPlayZoneMissionChatId = null;
let currentPlayZoneMissionChatTitle = null;
let missionDataListener = null;
// ==================================================================
// --- FIN: GLOBALES AÑADIDAS ---
// ==================================================================


function registerUserReferralCode(uid) {
    if (!uid || typeof firebase === 'undefined') return;
    var fn = (firebase.functions && firebase.functions()) ? firebase.functions() : null;
    if (!fn) {
        console.warn('Referral code: Cloud Functions no disponibles.');
        return;
    }
    fn.httpsCallable('ensureUserReferralCode')({})
        .then(function() {
            firebase.database().ref('users/' + uid + '/referrals').on('value', function(snap) {
                const count = snap.exists() ? snap.numChildren() : 0;
                const el = document.getElementById('nexus-widget-referrals');
                if (el) el.textContent = count;
            });
        })
        .catch(function(e) { console.warn('Referral code registration:', e); });
}

// Helper function to remove skeleton loading effect
// Envoltorio defensivo para Motion (motion.dev, cargado vía CDN en dashboard.html):
// si la librería no cargó, el dashboard sigue funcionando igual, simplemente sin
// esa animación puntual.
function motionFx(el, keyframes, opts) {
  if (!el || typeof window.Motion === 'undefined' || !window.Motion.animate) return null;
  try { return window.Motion.animate(el, keyframes, opts); } catch (e) { return null; }
}

// Anima un número desde 0 hasta targetValue (conteo ascendente), usando
// Motion cuando está disponible. Si no, simplemente escribe el valor final.
function motionCountUp(el, targetValue, duration) {
  if (!el) return;
  var target = Number(targetValue) || 0;
  if (typeof window.Motion !== 'undefined' && window.Motion.animate) {
    try {
      window.Motion.animate(0, target, {
        duration: duration || 0.9,
        ease: 'easeOut',
        onUpdate: function (latest) { el.textContent = Math.round(latest).toLocaleString(); }
      });
      return;
    } catch (e) { /* cae al valor estático */ }
  }
  el.textContent = target.toLocaleString();
}

function removeSkeleton(element) {
  if (element) {
    var wasLoading = element.classList.contains('skeleton');
    element.classList.remove('skeleton', 'skeleton-circle', 'skeleton-text', 'skeleton-short', 'skeleton-medium', 'skeleton-long');
    // El contenido real reemplaza al shimmer gris: un fade-in corto evita que
    // "aparezca de golpe" en las decenas de campos del dashboard que usan
    // este mismo punto de salida del estado de carga.
    if (wasLoading) motionFx(element, { opacity: [0, 1] }, { duration: 0.35, ease: 'easeOut' });
  }
}

function setTextIfExists(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function setQueryTextIfExists(selector, text) {
  const el = document.querySelector(selector);
  if (el) el.textContent = text;
}

// Pequeño "pulso" (Motion) al hacer clic en los botones sociales/acción clave
// del perfil. Delegado a nivel document para no tener que tocar cada handler
// individual, y en fase de captura para que funcione sin importar qué haga
// después el propio listener del botón (incluido stopPropagation).
(function setupDashboardButtonPulse() {
  var PULSE_SELECTOR = '#profileRecommendBtn, #profileAddFriendBtn, #profileDmChatBtn, ' +
    '#nicknameSaveBtn, #photoUploadBtn, #photoDeleteBtn';
  document.addEventListener('click', function (e) {
    var btn = e.target && e.target.closest ? e.target.closest(PULSE_SELECTOR) : null;
    if (!btn) return;
    motionFx(btn, { scale: [1, 0.86, 1] }, { duration: 0.22, ease: 'easeOut' });
  }, true);
})();

// Fade-in de la foto de perfil cada vez que cambia (subida nueva, borrado a
// default, cambio de perfil visitado, etc.). Un solo listener 'load' cubre
// todas las asignaciones de profilePic.src del archivo sin tener que tocarlas
// una por una.
(function setupProfilePicRevealAnim() {
  var pic = document.getElementById('profilePic');
  if (!pic) return;
  pic.addEventListener('load', function () {
    motionFx(pic, { opacity: [0, 1], scale: [0.92, 1] }, { duration: 0.35, ease: 'easeOut' });
  });
})();

let dashboardWidgetsCollapseInit = false;
function initDashboardWidgetCollapsibles() {
  if (dashboardWidgetsCollapseInit) return;
  document.querySelectorAll('[data-widget-toggle]').forEach(function(toggleBtn) {
    const id = toggleBtn.getAttribute('data-widget-toggle');
    const widget = document.getElementById(id);
    if (!widget) return;

    const storageKey = 'dashboard_widget_collapsed_' + id;
    const stored = localStorage.getItem(storageKey);
    const shouldCollapse = stored === null ? true : stored === '1';
    widget.classList.toggle('collapsed', shouldCollapse);
    toggleBtn.setAttribute('aria-expanded', shouldCollapse ? 'false' : 'true');

    toggleBtn.addEventListener('click', function () {
      const isCollapsed = widget.classList.toggle('collapsed');
      toggleBtn.setAttribute('aria-expanded', isCollapsed ? 'false' : 'true');
      localStorage.setItem(storageKey, isCollapsed ? '1' : '0');
    });
  });
  dashboardWidgetsCollapseInit = true;
}

// ======== LÓGICA DEL WIDGET COMPETITIVO (SE MANTIENE IGUAL) ========

// Variables para almacenar el estado en tiempo real
let competitiveTeamId = null;
let competitiveTeamName = "Sin equipo";
let competitiveRole = "Sin rol";
let competitiveInvitesCount = 0;
let competitiveJoinRequestsCount = 0; // Para capitanes
let competitiveMatchData = {
    opponent: "Ninguno",
    tournament: "Ninguno",
    time: "N/A"
};
let teamDataListener = null; // Para guardar la referencia al listener del equipo
let teamJoinRequestsListener = null; // Listener para solicitudes
let teamInvitesListener = null; // Listener para invitaciones

/**
 * 1. Función para renderizar con los datos combinados.
 * Esta función se llama cada vez que CUALQUIER dato (invitaciones, solicitudes, equipo, partida) cambia.
 */
function updateCompetitiveWidgetView() {
    const data = {
        team: competitiveTeamName,
        role: competitiveRole,
        invites: competitiveInvitesCount,
        joinRequests: competitiveJoinRequestsCount,
        match: competitiveMatchData
    };
    renderCompetitiveWidget(data);
}

/**
 * 2. La función de renderizado original (MODIFICADA).
 * Esta función solo se encarga de MOSTRAR los datos en el HTML.
 */
function renderCompetitiveWidget(data) {
    const teamSpan = document.getElementById("competitiveTeamEnhanced");
    const roleSpan = document.getElementById("competitiveRoleEnhanced");
    const invitesSpan = document.getElementById("competitiveInvitesEnhanced");
    const matchDetailsDiv = document.getElementById("upcomingMatchDetailsEnhanced");
    const matchTournamentDiv = document.getElementById("upcomingMatchTournamentEnhanced");
    const matchTimeDiv = document.getElementById("upcomingMatchTimeEnhanced");
    const dashboardButton = document.getElementById("competitiveWidgetDashboardBtn"); // El botón

    // Si algún elemento no existe, muestra una advertencia y se detiene.
    if (!teamSpan || !roleSpan || !invitesSpan || !matchDetailsDiv) {
        console.warn("Faltan elementos del DOM para el widget competitivo. Deteniendo renderizado.");
        return;
    }
    
    // Si no hay datos, muestra un mensaje por defecto y quita el skeleton
    if (!data) {
        teamSpan.textContent = "Sin equipo";
        roleSpan.textContent = "Sin rol";
        invitesSpan.textContent = "0";
        matchDetailsDiv.textContent = "No hay partidas próximas.";
        matchTournamentDiv.textContent = "";
        matchTimeDiv.textContent = "";
        if (dashboardButton) dashboardButton.style.display = 'none';
        
        [teamSpan, roleSpan, invitesSpan, matchDetailsDiv].forEach(el => removeSkeleton(el));
        return;
    }

    // Lógica del equipo
    const hasTeam = data.team && data.team !== "Sin equipo";
    teamSpan.textContent = data.team || "Sin equipo";
    teamSpan.classList.toggle("competitive-team-active", hasTeam);
    teamSpan.classList.toggle("competitive-team-inactive", !hasTeam);

    // Lógica del rol
    roleSpan.textContent = data.role || "Sin rol";

    // --- INICIO DE LÓGICA MODIFICADA (INVITACIONES/SOLICITUDES) ---
    const invitesContainer = invitesSpan.closest('.competitive-row');
    const invitesLabel = invitesContainer ? invitesContainer.querySelector('.competitive-label') : null;
    
    if (data.role === 'Captain') {
        // Mostrar Solicitudes de Equipo
        const requests = data.joinRequests || 0;
        invitesSpan.textContent = requests;
        if (invitesLabel) invitesLabel.textContent = requests === 1 ? 'Solicitud:' : 'Solicitudes:';
        invitesSpan.classList.toggle("competitive-invites-pending", requests > 0);
    } else {
        // Mostrar Invitaciones Personales
        const invites = data.invites || 0;
        invitesSpan.textContent = invites;
        if (invitesLabel) invitesLabel.textContent = invites === 1 ? 'Invitación:' : 'Invitaciones:';
        invitesSpan.classList.toggle("competitive-invites-pending", invites > 0);
    }
    // --- FIN DE LÓGICA MODIFICADA ---

    // Lógica de la partida
    if (data.match && data.match.opponent && data.match.opponent !== "Ninguno") {
        matchDetailsDiv.textContent = "VS " + data.match.opponent;
        matchTournamentDiv.textContent = "Torneo: " + (data.match.tournament || "N/A");
        matchTimeDiv.textContent = data.match.time || "N/A";
        matchTimeDiv.classList.add("competitive-match-time-active");
        matchDetailsDiv.classList.remove("competitive-match-warning");
        if (window.StudiosGamesRS && typeof window.StudiosGamesRS.playAmbientForLiveMatch === 'function') {
            window.StudiosGamesRS.playAmbientForLiveMatch();
        }
    } else {
        matchDetailsDiv.textContent = "No hay partidas próximas.";
        matchDetailsDiv.classList.add("competitive-match-warning");
        matchTournamentDiv.textContent = "";
        matchTimeDiv.textContent = "";
        matchTimeDiv.classList.remove("competitive-match-time-active");
    }

// --- Lógica del botón "Team Dashboard" ---
if (dashboardButton) {
    dashboardButton.style.display = 'block'; // <-- CAMBIO: Siempre se muestra

    // CAMBIO: Siempre asigna el clic, tenga o no equipo
    dashboardButton.onclick = () => { window.location.href = '/competition-hub'; }; 
}
// --- FIN DE LÓGICA DEL BOTÓN ---

    // Quita el efecto "cargando" de todos los elementos
    [teamSpan, roleSpan, invitesSpan, matchDetailsDiv, matchTournamentDiv, matchTimeDiv].forEach(el => el && removeSkeleton(el));
}

/**
 * 3. La nueva función principal de escucha (CON LÓGICA DE AUTOREPARACIÓN).
 * Configura todos los listeners de Firebase Realtime.
 */
function listenForCompetitiveData(userId) {
    if (!userId) return;
    
    const db = firebase.database();
    const authUser = firebase.auth().currentUser; // Se necesita para el chat

    // --- INICIO: Listener 1 (Invitaciones) ---
    const invitesRef = db.ref(`teamInvites/${userId}`);
    teamInvitesListener = invitesRef.on('value', (snapshot) => {
        if (competitiveRole !== 'Captain') { // Solo actualiza si NO es capitán
             competitiveInvitesCount = snapshot.exists() ? snapshot.numChildren() : 0;
             updateCompetitiveWidgetView();
        }
    }, (error) => {
        console.error("Error al cargar invitaciones:", error);
        competitiveInvitesCount = 0;
        updateCompetitiveWidgetView();
    });
    // --- FIN: Listener 1 ---

    // --- INICIO: Listener 2 (Datos del Usuario) ---
    const userRef = db.ref(`users/${userId}`);
    userRef.on('value', (snapshot) => {
        const userData = snapshot.val();
        const newTeamId = userData ? userData.teamId : null;
        
        // Actualizar datos de partida
        if (userData && userData.competitive && userData.competitive.match) {
            competitiveMatchData = userData.competitive.match;
        } else {
            competitiveMatchData = { opponent: "Ninguno", tournament: "Ninguno", time: "N/A" };
        }

        // Comprobar si el teamId ha cambiado
        if (newTeamId !== competitiveTeamId) {
            // Si ha cambiado, detener los listeners de equipo anteriores
            if (teamDataListener) {
                db.ref(`teams/${competitiveTeamId}`).off('value', teamDataListener);
                teamDataListener = null;
            }
            if (teamJoinRequestsListener) {
                db.ref(`teamJoinRequests/${competitiveTeamId}`).off('value', teamJoinRequestsListener);
                teamJoinRequestsListener = null;
            }
            
            competitiveTeamId = newTeamId; // Actualizar el ID del equipo

            if (newTeamId) {
                // Si hay un NUEVO teamId, crear un NUEVO listener para él
                const teamRef = db.ref(`teams/${newTeamId}`);
                teamDataListener = teamRef.on('value', (teamSnapshot) => {
                    const teamData = teamSnapshot.val();
                    let userRole = "Sin rol";
                    
                    // --- INICIO DE LÓGICA DE AUTOREPARACIÓN ---
                    if (teamData && teamData.roster && teamData.roster[userId]) {
                        // Caso 1: Todo OK
                        competitiveTeamName = teamData.name || "Equipo sin nombre";
                        userRole = teamData.roster[userId].role || "Miembro";
                    } else {
                        // Caso 2: Data corrupta (teamId existe pero no estamos en el roster, o el equipo fue borrado)
                        console.warn(`Corrigiendo estado: El usuario ${userId} tiene el teamId ${newTeamId} pero no se encontró en el roster o el equipo no existe. Limpiando teamId.`);
                        db.ref(`users/${userId}/teamId`).remove(); 
                        // Al borrar el teamId, el listener 'userRef.on('value', ...)' se disparará de nuevo,
                        // esta vez con newTeamId = null, y se limpiará todo correctamente.
                        // No necesitamos hacer más nada aquí.
                        return; // Salimos de la función para evitar más procesamiento.
                    }
                    // --- FIN DE LÓGICA DE AUTOREPARACIÓN ---

                    competitiveRole = userRole; // Actualiza el rol global

                    // ==========================================================
                    // --- INICIO: AÑADIDO PARA INICIALIZAR EL CHAT FLOTANTE ---
                    if (authUser) { // Asegurarse de que el usuario de auth esté listo
                        // MODIFICADO: Se pasa teamData completo en lugar de teamData.name
                        const chatData = { name: teamData.name, emblemUrl: teamData.emblemUrl || 'dragon_profile_studiosgamesrs.png' };
                        initializeFloatingChat(authUser, newTeamId, chatData, teamData.roster);
                    }
                    // --- FIN: AÑADIDO PARA INICIALIZAR EL CHAT FLOTANTE ---
                    // ==========================================================

                    // --- INICIO: LÓGICA DE CAPITÁN/MIEMBRO ---
                    if (userRole === 'Captain') {
                        // Es Capitán: apaga el listener de invitaciones y enciende el de solicitudes
                        if (teamInvitesListener) {
                            invitesRef.off('value', teamInvitesListener);
                            teamInvitesListener = null;
                            competitiveInvitesCount = 0; // Limpia el contador
                        }
                        if (!teamJoinRequestsListener) { // Si no está escuchando, que escuche
                            const requestsRef = db.ref(`teamJoinRequests/${newTeamId}`);
                            teamJoinRequestsListener = requestsRef.on('value', (requestSnapshot) => {
                                competitiveJoinRequestsCount = requestSnapshot.exists() ? requestSnapshot.numChildren() : 0;
                                updateCompetitiveWidgetView();
                            });
                        }
                    } else {
                        // Es Miembro: apaga el listener de solicitudes y enciende el de invitaciones
                        if (teamJoinRequestsListener) {
                            db.ref(`teamJoinRequests/${newTeamId}`).off('value', teamJoinRequestsListener);
                            teamJoinRequestsListener = null;
                            competitiveJoinRequestsCount = 0; // Limpia el contador
                        }
                        if (!teamInvitesListener) { // Si no está escuchando, que escuche
                            teamInvitesListener = invitesRef.on('value', (snapshot) => {
                                competitiveInvitesCount = snapshot.exists() ? snapshot.numChildren() : 0;
                                updateCompetitiveWidgetView();
                            });
                        }
                    }
                    // --- FIN: LÓGICA DE CAPITÁN/MIEMBRO ---
                    
                    updateCompetitiveWidgetView(); // Actualiza la vista
                }, (error) => {
                    console.error("Error al cargar datos del equipo:", error);
                    competitiveTeamName = "Error";
                    competitiveRole = "Error";
                    updateCompetitiveWidgetView();
                });
            } else {
                // Si NO hay teamId (el usuario dejó el equipo)
                competitiveTeamName = "Sin equipo";
                competitiveRole = "Sin rol";
                competitiveJoinRequestsCount = 0; // Limpia el contador
                
                // ========================================================
                // --- INICIO: AÑADIDO PARA APAGAR EL CHAT FLOTANTE ---
                shutdownFloatingChat();
                // --- FIN: AÑADIDO PARA APAGAR EL CHAT FLOTANTE ---
                // ========================================================

                // Asegurarse de que el listener de invitaciones esté encendido
                 if (!teamInvitesListener) {
                    teamInvitesListener = invitesRef.on('value', (snapshot) => {
                        competitiveInvitesCount = snapshot.exists() ? snapshot.numChildren() : 0;
                        updateCompetitiveWidgetView();
                    });
                }
                updateCompetitiveWidgetView(); // Actualiza la vista
            }
        } else {
            // Si el teamId no cambió, no hacemos nada con el listener del equipo,
            // pero actualizamos la vista por si cambió la partida
            updateCompetitiveWidgetView(); 
        }
    }, (error) => {
        console.error("Error al cargar datos del usuario:", error);
        // Resetear todo a por defecto en caso de error
        if (teamDataListener) db.ref(`teams/${competitiveTeamId}`).off('value', teamDataListener);
        if (teamJoinRequestsListener) db.ref(`teamJoinRequests/${competitiveTeamId}`).off('value', teamJoinRequestsListener);
        if (teamInvitesListener) invitesRef.off('value', teamInvitesListener);
        
        // ========================================================
        // --- INICIO: AÑADIDO PARA APAGAR EL CHAT FLOTANTE ---
        shutdownFloatingChat();
        // --- FIN: AÑADIDO PARA APAGAR EL CHAT FLOTANTE ---
        // ========================================================

        competitiveTeamId = null;
        competitiveTeamName = "Sin equipo";
        competitiveRole = "Sin rol";
        competitiveJoinRequestsCount = 0;
        competitiveInvitesCount = 0;
        competitiveMatchData = { opponent: "Ninguno", tournament: "Ninguno", time: "N/A" };
        updateCompetitiveWidgetView();
    });
    // --- FIN: Listener 2 ---
}
// ======== FIN DE LÓGICA DEL WIDGET COMPETITIVO ========
/**
 * NEXUS DASHBOARD WIDGET - INTEGRACIÓN CON CREATOR NEXUS
 * Sincroniza datos con Firebase/localStorage y muestra info del jugador
 */

class NexusDashboardWidget {
    constructor() {
        this.state = {
            xp: 0,
            level: 1,
            rank: 'NOVATO',
            referrals: 0,
            badges: 0,
            totalBadges: 10,
            nextRank: 'APRENDIZ',
            xpNeeded: 500,
            rankColor: '#ff3b3b',
            badgesListData: []
        };
        
        this.badgesList = [
            { id: 'loyalty_trial', name: 'Lealtad', icon: 'fa-heart', unlocked: false },
            { id: 'first_steps', name: 'Primeros Pasos', icon: 'fa-shoe-prints', unlocked: false },
            { id: 'social', name: 'Social', icon: 'fa-share-alt', unlocked: false },
            { id: 'badge_elite', name: 'Élite', icon: 'fa-certificate', unlocked: false },
            { id: 'referral', name: 'Referidos', icon: 'fa-users', unlocked: false },
            { id: 'streak', name: 'Racha', icon: 'fa-fire', unlocked: false },
            { id: 'xp_collector', name: 'Coleccionista', icon: 'fa-coins', unlocked: false },
            { id: 'legend', name: 'Leyenda', icon: 'fa-crown', unlocked: false },
            { id: 'designer', name: 'Diseñador', icon: 'fa-paint-brush', unlocked: false },
            { id: 'community', name: 'Comunidad', icon: 'fa-hands-helping', unlocked: false },
            { id: 'daily', name: 'Diario', icon: 'fa-calendar-alt', unlocked: false },
            { id: 'easter', name: 'Secretos', icon: 'fa-egg', unlocked: false }
        ];
        this.state.totalBadges = this.badgesList.length;
        
        this.init();
    }
    
    async init() {
        console.log('🚀 Iniciando Nexus Dashboard Widget...');

        await this.loadFromFirebase();

        this.loadFromLocalStorage();
        
        // Inicializar UI
        this.updateUI();
        
        // Configurar eventos
        this.initEvents();
    }
    
    loadFromLocalStorage() {
        try {
            /* SEC-021: XP/nivel/logros no se restauran desde localStorage */
            this.calculateRank();
        } catch (error) {
            console.warn('⚠️ Error cargando datos locales:', error);
        }
    }
    
    async loadFromFirebase() {
        if (typeof firebase === 'undefined') return;
        try {
            const userId = firebase.auth().currentUser?.uid || localStorage.getItem('nexus_user_id');
            if (!userId) return;
            const statsSnap = await firebase.database().ref(`nexus/users/${userId}/stats`).once('value');
            const stats = statsSnap.val();
            if (stats) {
                this.state.xp = stats.xp || this.state.xp;
                this.state.level = stats.level || this.state.level;
                this.state.referrals = stats.verifiedReferrals || this.state.referrals;
                this.calculateRank();
            }
            const userSnap = await firebase.database().ref(`users/${userId}/achievements`).once('value');
            const achievements = userSnap.val();
            if (achievements) {
                this.badgesList.forEach(badge => {
                    badge.unlocked = !!achievements[badge.id];
                });
                Object.keys(achievements).forEach(id => {
                    const known = this.badgesList.find(b => b.id === id);
                    if (!known && achievements[id]) {
                        this.state.badgesListData = this.state.badgesListData || [];
                        if (this.state.badgesListData.indexOf(id) === -1) {
                            this.state.badgesListData.push(id);
                        }
                    }
                });
            }
        } catch (error) {
            console.warn('⚠️ Firebase no disponible:', error);
        }
    }
    
    calculateRank() {
        const ranks = [
            { level: 1, name: 'NOVATO', xp: 0, color: '#ff3b3b', next: 'APRENDIZ' },
            { level: 2, name: 'APRENDIZ', xp: 500, color: '#ff4d4d', next: 'EXPLORADOR' },
            { level: 3, name: 'EXPLORADOR', xp: 1500, color: '#ff6666', next: 'GUERRERO' },
            { level: 4, name: 'GUERRERO', xp: 3000, color: '#ff8080', next: 'CAMPEÓN' },
            { level: 5, name: 'CAMPEÓN', xp: 6000, color: '#ff9999', next: 'MAESTRO' },
            { level: 6, name: 'MAESTRO', xp: 10000, color: '#ffb3b3', next: 'LEYENDA' },
            { level: 7, name: 'LEYENDA', xp: 20000, color: '#ffcccc', next: 'MAX' }
        ];
        
        let currentRank = ranks[0];
        let nextRank = ranks[1];
        
        for (let i = ranks.length - 1; i >= 0; i--) {
            if (this.state.xp >= ranks[i].xp) {
                currentRank = ranks[i];
                nextRank = ranks[i + 1] || ranks[i];
                break;
            }
        }
        
        this.state.rank = currentRank.name;
        this.state.rankColor = currentRank.color;
        this.state.nextRank = nextRank.name;
        this.state.xpNeeded = nextRank.xp;
        
        if (nextRank === currentRank) {
            this.state.nextRank = 'RANGO MÁXIMO';
            this.state.xpNeeded = currentRank.xp;
        }
    }
    
    updateUI() {
        // Actualizar badges
        const rankBadge = document.getElementById('nexus-widget-rank');
        if (rankBadge) {
            rankBadge.textContent = this.state.rank;
            rankBadge.style.background = `rgba(255, 59, 59, 0.2)`;
            rankBadge.style.borderColor = `rgba(255, 59, 59, 0.3)`;
            rankBadge.style.color = `#ff3b3b`;
        }
        
        // Stats principales
        this.updateElement('nexus-widget-level', this.state.level);
        this.updateElement('nexus-widget-referrals', this.state.referrals);
        this.updateElement('nexus-widget-badges', `${this.state.badges}/${this.state.totalBadges}`);

        const profileLevelDisplay = document.getElementById('profileLevelDisplay');
        if (profileLevelDisplay) {
            profileLevelDisplay.textContent = `LEVEL (${this.state.level})`;
        }
        
        // XP y progreso
        const xpElement = document.getElementById('nexus-widget-xp');
        if (xpElement) {
            xpElement.textContent = `${this.state.xp.toLocaleString()} / ${this.state.xpNeeded.toLocaleString()} XP`;
        }
        
        const progress = ((this.state.xp - this.getRankXp()) / (this.state.xpNeeded - this.getRankXp())) * 100;
        const progressBar = document.getElementById('nexus-widget-progress');
        if (progressBar) {
            progressBar.style.width = `${Math.min(progress, 100)}%`;
        }
        
        const nextRank = document.getElementById('nexus-widget-next-rank');
        if (nextRank) {
            nextRank.textContent = this.state.nextRank || 'Cargando...';
        }
        
        if (this.state.badgesListData && this.state.badgesListData.length) {
            this.badgesList.forEach(badge => {
                if (this.state.badgesListData.includes(badge.id)) badge.unlocked = true;
            });
        }
        
        // Contador de badges
        const badgesCount = document.getElementById('nexus-badges-count');
        if (badgesCount) {
            badgesCount.textContent = `${this.state.badges}/${this.state.totalBadges}`;
        }
        
        // Renderizar badges
        this.renderBadges();
        // Solo repinta la tira del perfil propio: si estamos mirando a otro
        // usuario, no debemos sobrescribir sus insignias con las del visitante.
        if (typeof isViewingOwnProfile === 'undefined' || isViewingOwnProfile) {
          renderProfileNexusBadges(window.currentUserData || {}, firebase.auth().currentUser && firebase.auth().currentUser.uid);
        }
    }
    
    getRankXp() {
        const ranks = [0, 500, 1500, 3000, 6000, 10000, 20000];
        return ranks[this.state.level - 1] || 0;
    }
    
    renderBadges() {
        const container = document.getElementById('nexus-badges-container');
        if (!container) return;
        
        container.innerHTML = '';
        
        this.badgesList.forEach(badge => {
            const badgeEl = document.createElement('div');
            badgeEl.className = `nexus-badge-item ${badge.unlocked ? '' : 'locked'}`;
            badgeEl.innerHTML = `
                <i class="fas ${badge.unlocked ? badge.icon : 'fa-lock'}"></i>
                ${badge.name}
            `;
            container.appendChild(badgeEl);
        });
    }
    
    toggleBadges() {
        const container = document.getElementById('nexus-badges-container');
        const arrow = document.getElementById('nexus-badges-arrow');
        
        if (container && arrow) {
            container.classList.toggle('expanded');
            arrow.className = container.classList.contains('expanded') ? 
                'fas fa-chevron-up' : 'fas fa-chevron-down';
        }
    }
    
    copyReferralCode() {
        // Usar SIEMPRE el código de Firebase (users/uid/referralCode) o la misma fórmula que registerUserReferralCode
        // NUNCA usar localStorage (puede tener código viejo de Nexus anónimo nx_xxx)
        let code = null;
        if (typeof firebase !== 'undefined' && firebase.auth && firebase.auth().currentUser) {
            const uid = firebase.auth().currentUser.uid;
            code = 'NEXUS-' + (uid || '').replace(/^nx_/, '').slice(0, 8).toUpperCase();
        }
        if (!code) code = 'NEXUS-XXXX';
        const base = (typeof window !== 'undefined' && window.location && window.location.origin)
            ? window.location.origin
            : 'https://studiosgamesrs.com';
        const fullLink = base + '/login?ref=' + encodeURIComponent(code);
        navigator.clipboard.writeText(fullLink).then(() => {
            this.showToast('¡Link de referido copiado! Comparte el enlace para que se registren.', 'success');
        }).catch(() => {
            this.showToast('Error al copiar', 'error');
        });
    }
    
    generateReferralCode() {
        if (typeof firebase !== 'undefined' && firebase.auth && firebase.auth().currentUser) {
            const uid = firebase.auth().currentUser.uid || '';
            return 'NEXUS-' + uid.replace(/^nx_/, '').slice(0, 8).toUpperCase();
        }
        return 'NEXUS-XXXX';
    }
    
    showToast(message, type = 'info') {
        // Verificar si existe el sistema de toasts de Nexus
        if (window.Nexus && window.Nexus.showToast) {
            window.Nexus.showToast(message, type);
            return;
        }
        
        // Sistema de toast simple por si no existe Nexus
        const toast = document.createElement('div');
        toast.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            background: linear-gradient(135deg, #ff3b3b, #ff6b6b);
            color: white;
            padding: 12px 24px;
            border-radius: 8px;
            font-family: 'Orbitron', sans-serif;
            font-size: 12px;
            z-index: 10000;
            box-shadow: 0 4px 20px rgba(255, 59, 59, 0.3);
            animation: slideIn 0.3s ease;
        `;
        
        toast.textContent = message;
        document.body.appendChild(toast);
        
        setTimeout(() => {
            toast.style.animation = 'slideOut 0.3s ease forwards';
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    }
    
    updateElement(id, value) {
        const el = document.getElementById(id);
        if (el) el.textContent = value;
    }
    
    initEvents() {
        // Escuchar cambios en localStorage (sincronización con Nexus)
        window.addEventListener('storage', (e) => {
            if (e.key === 'nexus_state') {
                this.loadFromLocalStorage();
                this.updateUI();
            }
        });
        
        // Actualizar cada 30 segundos
        setInterval(() => {
            this.loadFromFirebase();
            this.updateUI();
        }, 30000);
    }
}

// Inicializar cuando el DOM esté listo
document.addEventListener('DOMContentLoaded', () => {
    window.NexusWidget = new NexusDashboardWidget();
    window.addEventListener('playzone-mission-created', function() {
        var u = firebase.auth().currentUser;
        if (u && typeof listenForPlayZoneData === 'function') listenForPlayZoneData(u.uid);
    });
});

// Funciones globales
function toggleBadges() {
    if (window.NexusWidget) {
        window.NexusWidget.toggleBadges();
    }
}

function copyReferralCode() {
    if (window.NexusWidget && window.NexusWidget.copyReferralCode) {
        window.NexusWidget.copyReferralCode();
        return;
    }
    let code = 'NEXUS-XXXX';
    if (typeof firebase !== 'undefined' && firebase.auth && firebase.auth().currentUser) {
        const uid = firebase.auth().currentUser.uid || '';
        code = 'NEXUS-' + uid.replace(/^nx_/, '').slice(0, 8).toUpperCase();
    }
    const base = (window.location && window.location.origin) ? window.location.origin : 'https://studiosgamesrs.com';
    const fullLink = base + '/login?ref=' + encodeURIComponent(code);
    navigator.clipboard.writeText(fullLink).then(() => {
        if (window.NexusWidget && window.NexusWidget.showToast)
            window.NexusWidget.showToast('¡Link de referido copiado!', 'success');
        else alert('Link de referido copiado. Comparte el enlace para que se registren.');
    }).catch(() => {
        alert('Usa el siguiente link para invitar amigos: ' + fullLink);
    });
}

function showReferralInfo() {
    var existing = document.getElementById('referralActionsPopover');
    if (existing) return;

    var backdrop = document.createElement('div');
    backdrop.className = 'referral-popover-backdrop';
    backdrop.id = 'referralActionsBackdrop';

    var pop = document.createElement('div');
    pop.className = 'referral-actions-popover';
    pop.id = 'referralActionsPopover';
    pop.innerHTML =
      '<h4>Sistema de Referidos</h4>' +
      '<p>Elige una acción rápida para gestionar tus referidos.</p>' +
      '<div class="referral-row">' +
        '<button type="button" id="goToReferralsBtn"><i class="fas fa-users"></i> Ir a tus referidos</button>' +
        '<button type="button" id="copyReferralLinkBtn"><i class="fas fa-link"></i> Copia tu enlace de referido</button>' +
      '</div>';

    function closeReferralPopover() {
      var p = document.getElementById('referralActionsPopover');
      var b = document.getElementById('referralActionsBackdrop');
      if (p && p.parentNode) p.parentNode.removeChild(p);
      if (b && b.parentNode) b.parentNode.removeChild(b);
    }

    backdrop.addEventListener('click', closeReferralPopover);
    document.body.appendChild(backdrop);
    document.body.appendChild(pop);

    var goBtn = document.getElementById('goToReferralsBtn');
    var copyBtn = document.getElementById('copyReferralLinkBtn');
    if (goBtn) {
      goBtn.addEventListener('click', function() {
        closeReferralPopover();
        window.location.href = '/nexus#referrals';
      });
    }
    if (copyBtn) {
      copyBtn.addEventListener('click', function() {
        closeReferralPopover();
        copyReferralCode();
      });
    }
}

function showRewards() {
    window.open('/nexus#rewards', '_blank');
}

// ==================================================================
// --- INICIO: LÓGICA DEL WIDGET PLAYZONE (ACTUALIZADA A REALTIME) ---
// ==================================================================

/**
 * Widget sin misión activa: solo el botón de acceso.
 */
function renderPlayZoneIdleView() {
    const contentDiv = document.getElementById("playZoneContent");
    const playZoneWidget = document.getElementById('playZoneWidget');
    if (!contentDiv || !playZoneWidget) return;

    shutdownPlayZoneChat();

    contentDiv.innerHTML = `
        <div class="playzone-idle-container">
            <a href="/playzone" class="playzone-redirect-btn playzone-redirect-btn--solo">
                <i class="fas fa-flag-checkered"></i> Go to PlayZone
            </a>
        </div>
    `;
    playZoneWidget.style.display = 'block';
    const conn = document.getElementById('unifiedWidgetConnector');
    if (conn) conn.style.display = 'block';
}

/** @deprecated Usar renderPlayZoneIdleView */
function renderPlayZoneWelcomeView() {
    renderPlayZoneIdleView();
}

/**
 * 2. Renderiza el widget en estado de Misión Activa.
 * MODIFICADO: Roster clickeable y botones de acción unificados.
 */
function formatPlayZoneElapsed(ms) {
    const totalSec = Math.max(0, Math.floor(ms / 1000));
    const hours = Math.floor(totalSec / 3600);
    const minutes = Math.floor((totalSec % 3600) / 60);
    const seconds = totalSec % 60;
    const pad = (n) => (n < 10 ? '0' + n : String(n));
    return pad(hours) + ':' + pad(minutes) + ':' + pad(seconds);
}

function normalizePlayZoneChatMessage(messageData) {
    if (!messageData) return messageData;
    if (!messageData.userId && messageData.senderUid) messageData.userId = messageData.senderUid;
    return messageData;
}

const PLAYZONE_STALE_MISSION_MS = 60 * 60 * 1000;

function shouldAutoClosePlayZoneMission(mission) {
    if (!mission || mission.status !== 'pending') return false;
    const createdAt = typeof mission.createdAt === 'number' ? mission.createdAt : null;
    if (!createdAt) return false;
    return (Date.now() - createdAt) >= PLAYZONE_STALE_MISSION_MS;
}

async function autoCloseStalePlayZoneMission(missionId, mission) {
    if (!missionId || !mission || !shouldAutoClosePlayZoneMission(mission)) return false;
    const authUser = firebase.auth().currentUser;
    if (!authUser) return false;
    try {
        if (mission.creatorUid === authUser.uid) {
            await firebase.database().ref('missions/' + missionId).remove();
        } else if (mission.participants && mission.participants[authUser.uid]) {
            await firebase.database().ref('missions/' + missionId + '/participants/' + authUser.uid).remove();
            try { await firebase.database().ref('missions/' + missionId + '/cs2Ready/' + authUser.uid).remove(); } catch (e) {}
        }
        showFloatingMessage('warning', 'El hub se cerró: la misión no se inició en 1 hora.');
        return true;
    } catch (e) {
        console.error('autoCloseStalePlayZoneMission:', e);
        return false;
    }
}

function getChatMessagesRef(chatId, firebaseNode) {
    if (firebaseNode === 'playzoneMission') {
        return firebase.database().ref('missions/' + chatId + '/chat');
    }
    if (firebaseNode === 'privateChat') {
        return firebase.database().ref('privateChats/' + chatId + '/messages');
    }
    if (firebaseNode === 'globalChat') {
        return firebase.database().ref('globalChat/main/messages');
    }
    return firebase.database().ref(firebaseNode + '/' + chatId + '/messages');
}

function shutdownPlayZoneFloatingChat() {
    currentPlayZoneMissionChatId = null;
    currentPlayZoneMissionChatTitle = null;
    const btn = document.getElementById('floatingPlayZoneChatButton');
    if (btn) btn.style.display = 'none';
}

function initializePlayZoneMissionChat(missionId, missionTitle, participants) {
    const chatButton = document.getElementById('floatingPlayZoneChatButton');
    const chatEmblem = document.getElementById('floatingPlayZoneChatEmblem');
    const chatWindow = document.getElementById('teamChatWindow');
    if (!chatButton || !chatEmblem || !chatWindow) return;

    currentPlayZoneMissionChatId = missionId;
    currentPlayZoneMissionChatTitle = missionTitle || 'Misión PlayZone';
    chatEmblem.src = '/dragon_profile_studiosgamesrs.png';
    chatEmblem.onerror = function() { this.src = 'dragon_profile_studiosgamesrs.png'; };

    if (isViewingOwnProfile) {
        chatButton.style.display = 'flex';
    }

    chatButton.onclick = () => {
        const isChatVisible = chatWindow.classList.contains('visible');
        if (isChatVisible && currentChatFirebaseNode === 'playzoneMission') {
            chatWindow.classList.remove('visible');
            chatWindow.style.display = 'none';
            closeTeamChat();
            if (isViewingOwnProfile) chatButton.style.display = 'flex';
            return;
        }
        openTeamChat(missionId, currentPlayZoneMissionChatTitle, participants || {}, 'playzoneMission');
    };
}

function renderPlayZoneMissionView(missionData) {
    const contentDiv = document.getElementById("playZoneContent");
    const playZoneWidget = document.getElementById('playZoneWidget');
    if (!contentDiv || !playZoneWidget || !missionData || !currentMissionId) return;

    if (shouldAutoClosePlayZoneMission(missionData)) {
        autoCloseStalePlayZoneMission(currentMissionId, missionData);
        return;
    }

    if (playZoneCountdownInterval) {
        clearInterval(playZoneCountdownInterval);
        playZoneCountdownInterval = null;
    }

    const createdAt = typeof missionData.createdAt === 'number' ? missionData.createdAt : null;
    const participantCount = Object.keys(missionData.participants || {}).length;

    contentDiv.innerHTML = `
        <div class="mission-detail">
            <span class="mission-label">Mission:</span>
            <span class="mission-value">${missionData.title || 'Untitled mission'}</span>
        </div>
        <div class="mission-detail">
            <span class="mission-label">Game:</span>
            <span class="mission-value">${missionData.game || 'N/A'}</span>
        </div>
        <div class="mission-detail">
            <span class="mission-label">Participants:</span>
            <a href="#" class="mission-value" onclick="openMissionRosterModal(${currentMissionId}); return false;">
                ${participantCount}
            </a>
        </div>

        <div class="countdown-container">
            <div class="countdown-label">Tiempo del hub:</div>
            <div id="missionCountdownDisplay" class="countdown-display">00:00:00</div>
        </div>

        <a href="/playzone?tab=active" class="playzone-redirect-btn">
            Go to PlayZone
        </a>
        `;

    if (createdAt) {
        startPlayZoneHubElapsedTimer(createdAt);
    } else {
        const countdownEl = document.getElementById('missionCountdownDisplay');
        if (countdownEl) countdownEl.textContent = '—';
    }

    initializePlayZoneMissionChat(currentMissionId, missionData.title, missionData.participants);

    playZoneWidget.style.display = 'block';
    const conn = document.getElementById('unifiedWidgetConnector');
    if (conn) conn.style.display = 'block';
}

function startPlayZoneHubElapsedTimer(createdAt) {
    const display = document.getElementById('missionCountdownDisplay');
    if (!display || typeof createdAt !== 'number') return;

    const updateElapsed = () => {
        display.textContent = formatPlayZoneElapsed(Date.now() - createdAt);
        display.classList.remove('competitive-match-warning');
        display.classList.add('countdown-display');
    };

    if (playZoneCountdownInterval) clearInterval(playZoneCountdownInterval);
    updateElapsed();
    playZoneCountdownInterval = setInterval(updateElapsed, 1000);
}

/**
 * 3. Inicia la cuenta regresiva (basada en Server Time / Unix Timestamp).
 * MODIFICADO: Añadida lógica para el mensaje "This mission has already begun." (17 minutos).
 */
function startPlayZoneCountdown(ingressTime) {
    const display = document.getElementById('missionCountdownDisplay');
    if (!display) return;
    
    // Constante de retraso de 17 minutos
    const MAX_DELAY_MS = 17 * 60 * 1000; 

    // Función de actualización
    const updateCountdown = () => {
        const now = Date.now();
        const distance = ingressTime - now;

        if (distance < -MAX_DELAY_MS) {
            // Si han pasado más de 17 minutos - misión finalizada
            display.textContent = 'Completed';
            display.classList.remove('countdown-display', 'competitive-match-time-active');
            display.classList.add('competitive-match-warning');
            clearInterval(playZoneCountdownInterval);
            playZoneCountdownInterval = null;
            return;
        } else if (distance < 0 && distance > -MAX_DELAY_MS) {
            // Entre el inicio y los 17 minutos - es hora de entrar
            display.textContent = '¡ES HORA DE ENTRAR!';
            display.classList.remove('countdown-display', 'competitive-match-warning');
            display.classList.add('competitive-match-time-active');
            return; 
        }

        const hours = Math.floor((distance % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
        const minutes = Math.floor((distance % (1000 * 60 * 60)) / (1000 * 60));
        const seconds = Math.floor((distance % (1000 * 60)) / 1000);

        display.textContent = 
            `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
            
        display.classList.add('countdown-display');
        display.classList.remove('competitive-match-time-active', 'competitive-match-warning');
    };

    // Detener cualquier intervalo anterior
    if (playZoneCountdownInterval) {
        clearInterval(playZoneCountdownInterval);
    }
    
    // Ejecutar la primera vez inmediatamente y luego cada segundo
    updateCountdown();
    playZoneCountdownInterval = setInterval(updateCountdown, 1000);
}

/**
 * NUEVA FUNCIÓN: Busca la misión activa del usuario y establece un listener en tiempo real.
 */
/**
 * BUSCA LA MISIÓN ACTIVA EN TIEMPO REAL (REEMPLAZO COMPLETO)
 */
function findUserActiveMission(userId) {
    const missionsRef = firebase.database().ref('missions');
    
    // IMPORTANTE: Detener CUALQUIER escucha previa en el nodo de misiones
    // Esto evita que datos de misiones anteriores se mezclen
    missionsRef.off(); 

    // Iniciamos la escucha en tiempo real
    missionDataListener = missionsRef.on('value', (snapshot) => {
        let activeMissionData = null;
        let activeMissionId = null;

        if (snapshot.exists()) {
            snapshot.forEach(childSnapshot => {
                const mission = childSnapshot.val();
                // Verificamos si el usuario es parte de los participantes actuales
                if (mission.participants && mission.participants[userId]) {
                    activeMissionId = childSnapshot.key;
                    activeMissionData = mission;
                    return true; 
                }
            });
        }

        const playZoneWidget = document.getElementById('playZoneWidget');

        if (activeMissionId && activeMissionData) {
            if (shouldAutoClosePlayZoneMission(activeMissionData)) {
                autoCloseStalePlayZoneMission(activeMissionId, activeMissionData).then((closed) => {
                    if (closed) return;
                });
                return;
            }
            currentMissionId = activeMissionId;
            renderPlayZoneMissionView(activeMissionData);
            if (playZoneWidget) playZoneWidget.style.display = 'block';
            const conn = document.getElementById('unifiedWidgetConnector');
            if (conn) conn.style.display = 'block';
        } else {
            // Caso: El usuario ya no está en ninguna misión
            console.log("Dashboard: Limpiando widget, no se encontró misión activa.");
            currentMissionId = null;
            
            // Limpiamos los badges y chats
            shutdownPlayZoneChat(); 
            
            // Mostramos la vista de bienvenida/búsqueda
            renderPlayZoneIdleView();
        }
    }, (error) => {
        console.error("Error en tiempo real:", error);
    });
}

/**
 * 4. Escucha el estado del PlayZone del usuario.
 */
function listenForPlayZoneData(userId) {
    if (!userId || !currentUserData) {
        renderPlayZoneIdleView();
        return;
    }
    
    // Si no es mi propio perfil, se oculta (lógica anterior correcta para otros perfiles)
    if (!isViewingOwnProfile) {
        const playZoneWidget = document.getElementById('playZoneWidget');
        const conn = document.getElementById('unifiedWidgetConnector');
        if (playZoneWidget) playZoneWidget.style.display = 'none';
        if (conn) conn.style.display = 'none';
        shutdownPlayZoneChat(); 
        return;
    }

    const playZoneWidget = document.getElementById('playZoneWidget');
    const conn = document.getElementById('unifiedWidgetConnector');
    if (playZoneWidget) playZoneWidget.style.display = 'block';
    if (conn) conn.style.display = 'block'; 

    const isOnboardingComplete = currentUserData.playZoneOnboardingComplete || false; 

    if (isOnboardingComplete) {
        findUserActiveMission(userId);
    } else {
        renderPlayZoneIdleView();
    }
}

/**
 * 5. Nueva Función para el Modal del Roster de Misión.
 */
window.openMissionRosterModal = async function(missionId) {
    const modal = document.getElementById('missionRosterModal');
    const closeBtn = document.getElementById('closeMissionRosterModal');
    const rosterList = document.getElementById('modalRosterList');
    const rosterTitle = document.getElementById('missionRosterTitle');

    if (!modal || !rosterList) return;

    modal.style.display = 'flex';
    rosterList.innerHTML = '<p style="color: #ccc; text-align: center;">Cargando participantes...</p>';
    
    try {
        const missionRef = firebase.database().ref(`missions/${missionId}`);
        const missionSnapshot = await missionRef.once('value');
        const missionData = missionSnapshot.val();

        if (!missionData || !missionData.participants) {
            rosterTitle.textContent = "Participantes de Misión";
            rosterList.innerHTML = '<p style="color: #ccc; text-align: center;">No se encontraron participantes.</p>';
            return;
        }
        
        rosterTitle.textContent = `Participantes: ${missionData.title || 'Misión'}`;
        const participantUids = Object.keys(missionData.participants);
        
        // Cargar datos de todos los usuarios
        const userPromises = participantUids.map(uid => firebase.database().ref(`users/${uid}`).once('value'));
        const userSnapshots = await Promise.all(userPromises);
        
        rosterList.innerHTML = '';
        let listHTML = '';

        userSnapshots.forEach(snap => {
            const userData = snap.val();
            const uid = snap.key;
            const isCreator = missionData.creatorId === uid;
            
            const roleText = isCreator ? 'Creator' : 'Member';
            const roleClass = isCreator ? 'captain' : 'member';

            listHTML += `
                <div class="roster-member-item" onclick="navigateToProfile('${uid}')" style="cursor: pointer;">
                    <img src="${userData?.photoURL || DEFAULT_PROFILE_IMAGE}" alt="${userData?.nick || 'User'}" />
                    <span class="roster-name">${userData?.nick || 'Unknown User'}</span>
                    <span class="roster-member-role ${roleClass}">${roleText}</span>
                </div>
            `;
        });

        rosterList.innerHTML = listHTML;

    } catch (error) {
        console.error("Error loading mission roster:", error);
        rosterList.innerHTML = '<p style="color: #e53935; text-align: center;">Error al cargar el roster de la misión.</p>';
    }

    // Listener para cerrar el modal
    closeBtn.onclick = () => modal.style.display = 'none';
    window.addEventListener('click', (event) => {
        if (event.target == modal) {
            modal.style.display = 'none';
        }
    });
}


/**
 * 6. Listener para el Badge de Invitaciones de Chat de Misión
 */
function listenForMissionChatInvites(userId, missionId) {
    const badge = document.getElementById('chatInviteBadgePlayZone');
    if (!badge || !userId) return;

    // Apagar listener anterior si existe
    if (playZoneChatBadgeListener) {
        firebase.database().ref(`playzoneChatInvites/${userId}`).off('value', playZoneChatBadgeListener);
    }
    
    // El nodo guarda las invitaciones pendientes para CHATS de MISIÓN (que pueden ser varias)
    const invitesRef = firebase.database().ref(`playzoneChatInvites/${userId}`); 
    
    playZoneChatBadgeListener = invitesRef.on('value', (snapshot) => {
        const count = snapshot.exists() ? snapshot.numChildren() : 0; 
        badge.textContent = count;
        badge.style.display = count > 0 ? 'block' : 'none';
        
        // Actualizar el badge del botón flotante general (sumando el de equipo)
        const floatingBadge = document.getElementById('chatNotificationBadge');
        if(floatingBadge) {
             // competitiveInvitesCount es la variable global del widget competitivo
             // Si el chat está en modo MISIÓN, el badge del chat flotante DEBE reflejar SOLO las invitaciones de chat de misión (si las hubiera)
             // y el badge general de invitaciones (competitiveInvitesCount)
             const totalBadges = count + competitiveInvitesCount;
             floatingBadge.textContent = totalBadges;
             floatingBadge.style.display = totalBadges > 0 ? 'block' : 'none';
        }
    });
}

/**
 * 7. Apaga el Chat de Misión (Llamado al salir/sin misión)
 */
function shutdownPlayZoneChat() {
    if (playZoneCountdownInterval) {
        clearInterval(playZoneCountdownInterval);
        playZoneCountdownInterval = null;
    }

    shutdownPlayZoneFloatingChat();
}

// ==================================================================
// --- FIN: LÓGICA DEL WIDGET PLAYZONE (ACTUALIZADA A REALTIME) ---
// ==================================================================

// --- A PARTIR DE AQUÍ ESTÁ TODO TU CÓDIGO ORIGINAL, CON CAMBIOS DE REFACTORIZACIÓN EN EL BLOQUE DE CHAT ---

function getTranslations(lang) {
  // ... (Se mantiene igual)
  return {
    dashboardTitle: lang === "es" ? "Dashboard del Usuario" : "User Dashboard",
    logout: lang === "es" ? "Cerrar Sesión" : "Log Out",
    daysLabel: lang === "es" ? "Días desde tu registro:" : "Days since registration:",
    createdLabel: lang === "es" ? "(creado el " : "(created on ",
    countryLabel: lang === "es" ? "País de registro:" : "Registered country:",
    thoughtLabel: lang === "es" ? "Tu pensamiento de hoy:" : "Your thought today:",
    thoughtPlaceholder: lang === "es" ? "Escribe tu pensamiento..." : "Write your thought...",
    verified: lang === "es" ? "Tu cuenta está verificada" : "Your account is verified",
    notVerified: lang === "es" ? "Usuario no verificado" : "User not verified",
    backHome: lang === "es" ? "← Volver al Home" : "← Back to Home",
    updatePhotoSuccess: lang === "es" ? "¡Su imagen fue subida exitosamente!" : "Your image was uploaded successfully!",
    updatePhotoError: lang === "es" ? "Error al actualizar foto." : "Error updating photo.",
    saveThoughtSuccess: lang === "es" ? "¡Pensamiento guardado!" : "Thought saved!",
    saveThoughtError: lang === "es" ? "Error al guardar pensamiento." : "Error saving thought.",
    uploadTypeError: lang === "es" ? "Solo imágenes JPG, PNG, o WEBP" : "Only JPG, PNG, or WEBP images allowed.",
    uploadSizeError: lang === "es" ? "Imagen muy grande (máx 3MB)" : "Image too large (max 3MB).",
    countryDetectError: lang === "es" ? "Desconocido" : "Unknown",
    thoughtSaveBtn: lang === "es" ? "Guardar pensamiento" : "Save thought",
    charCount: lang === "es" ? "caracteres restantes" : "characters left",
    deleteThought: lang === "es" ? "Eliminar pensamiento" : "Delete thought"
  };
}

let floatingMessageHideTimer = null;
function showFloatingMessage(type, text) {
  const msg = document.getElementById("floatingMessage");
  if (!msg) return;
  if (floatingMessageHideTimer) { clearTimeout(floatingMessageHideTimer); floatingMessageHideTimer = null; }

  msg.textContent = text;
  msg.className = "floating-message" + (type === "error" ? " error" : "");
  msg.style.display = "block";
  motionFx(msg, { opacity: [0, 1], y: [-14, 0], scale: [0.96, 1] }, { duration: 0.28, ease: 'easeOut' });

  floatingMessageHideTimer = setTimeout(() => {
    const anim = motionFx(msg, { opacity: [1, 0], y: [0, -14] }, { duration: 0.22, ease: 'easeIn' });
    if (anim && anim.finished) {
      anim.finished.then(() => { msg.style.display = "none"; }).catch(() => { msg.style.display = "none"; });
    } else {
      msg.style.display = "none";
    }
  }, 3000);
}

function validateImage(file) {
  // ... (Se mantiene igual)
  const allowedTypes = ["image/jpeg", "image/png", "image/webp"];
  const maxSize = 3 * 1024 * 1024; // 3MB
  if (!allowedTypes.includes(file.type)) return "type";
  if (file.size > maxSize) return "size";
  return "";
}

// Profile picture management functions   
// Delete old profile images from Firebase Storage
function deleteOldProfileImage(userId, extension) {
  // ... (Se mantiene igual)
  if (!userId || !extension) return; // Necesitamos saber la extensión real

  const storageRef = firebase.storage().ref();
  const fileRef = storageRef.child(`profile_images/${userId}/foto.${extension}`);

  // Solo intentamos borrar la foto actual, sin getMetadata ni múltiples requests
  fileRef.delete().catch(error => {
    if (error.code !== 'storage/object-not-found') {
      console.error(`Error deleting profile image:`, error);
    }
  });
}

function deleteUserProfilePhoto(userId, isCurrentUser = false) {
  // ... (Se mantiene igual)
  if (!userId) return;

  const defaultImageUrl = DEFAULT_PROFILE_IMAGE;
  let currentPhotoURL = "";

  // Get current photo URL
  if (typeof firebase !== 'undefined' && firebase.auth) {
    const currentUser = firebase.auth().currentUser;
    currentPhotoURL = isCurrentUser ? (currentUser ? currentUser.photoURL : "") : "";
  } else {
    // Demo mode - check current image src
    const profilePic = document.getElementById("profilePic");
    currentPhotoURL = profilePic ? profilePic.src : "";
  }

  // Check if user is already using default image
  if (!currentPhotoURL || currentPhotoURL === defaultImageUrl || currentPhotoURL.includes('dragon_profile_studiosgamesrs.png') || currentPhotoURL.includes('data:image/svg+xml')) {
    showFloatingMessage("info", "Ya estás usando la imagen predeterminada");
    togglePhotoEditMode(false);
    return;
  }

  const confirmMessage = isCurrentUser ?
    "¿Seguro que quieres eliminar tu foto de perfil?" :
    "¿Seguro que quieres eliminar la foto de este usuario?";

  if (!confirm(confirmMessage)) return;

  try {
    if (typeof firebase !== 'undefined' && firebase.auth) {
      // Firebase mode
      // Delete old images from storage (only if not default)
      deleteOldProfileImage(userId);

      if (isCurrentUser) {
        // Update current user's profile
        firebase.auth().currentUser.updateProfile({
          photoURL: defaultImageUrl
        }).then(() => {
          const profilePic = document.getElementById("profilePic");
          if (profilePic) {
            profilePic.src = defaultImageUrl; // <-- clave: usar imagen predeterminada
            removeSkeleton(profilePic);
          }
          showFloatingMessage("success", "Foto de perfil eliminada exitosamente");
          togglePhotoEditMode(false); // Exit edit mode
        }).catch(error => {
          console.error("Error updating profile:", error);
          showFloatingMessage("error", "Error al eliminar la foto de perfil");
        });
      } else {
        // Update other user's profile in database (commanders only)
        const userRef = firebase.database().ref(`users/${userId}`);
        userRef.update({
          photoURL: defaultImageUrl
        }).then(() => {
          showFloatingMessage("success", "Foto de perfil eliminada exitosamente");
          // Refresh the page to update any displayed photos
          setTimeout(() => location.reload(), 1000);
        }).catch(error => {
          console.error("Error updating user data:", error);
          showFloatingMessage("error", "Error al eliminar la foto de perfil");
        });
      }
    } else {
      // Demo mode
      document.getElementById("profilePic").src = defaultImageUrl;
      removeSkeleton(document.getElementById("profilePic"));
      showFloatingMessage("success", "Foto de perfil eliminada exitosamente (modo demo)");
      togglePhotoEditMode(false);
    }
  } catch (error) {
    console.error("Error deleting profile photo:", error);
    showFloatingMessage("error", "Error al eliminar la foto de perfil");
  }
}

function togglePhotoEditMode(enable = null) {
  // ... (Se mantiene igual)
  const container = document.getElementById("profileImageContainer");
  const editMode = document.getElementById("photoEditMode");

  if (enable === null) {
    enable = !container.classList.contains("edit-mode");
  }

  if (enable) {
    container.classList.add("edit-mode");
  } else {
    container.classList.remove("edit-mode");
  }
}

function initializeProfilePhotoManagement(user, userData) {
  // ... (Se mantiene igual)
  const profilePic = document.getElementById("profilePic");
  const photoDeleteBtn = document.getElementById("photoDeleteBtn");
  const photoUploadBtn = document.getElementById("photoUploadBtn");
  const commanderDeleteBtn = document.getElementById("commanderDeleteBtn");
  const commanderDeleteContainer = document.getElementById("commanderDeleteContainer");

  if (!profilePic) return;

  const userRank = userData?.rango || "tribal_warrior";
  const permissions = getPermisosRango(userRank);
  const isCommander = permissions.accesoTotal; // Commander has accesoTotal: true

  // Click on profile picture to upload new photo or toggle edit mode
  profilePic.addEventListener('click', function () {
    if (isCommander) {
      // Commanders always get file input for functionality priority
      document.getElementById('photoInput').click();
    } else {
      // Regular users toggle edit mode for better aesthetics
      togglePhotoEditMode();
    }
  });

  // Upload button for current user (in edit mode)
  if (photoUploadBtn) {
    photoUploadBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      document.getElementById('photoInput').click();
    });
  }

  // Delete button for current user (in edit mode)
  if (photoDeleteBtn) {
    photoDeleteBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      deleteUserProfilePhoto(user.uid, true);
    });
  }

  // Commander delete button (for other users' profiles - not implemented in current view)
  if (commanderDeleteBtn && isCommander) {
    commanderDeleteBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      // This would be used when viewing other users' profiles
      // For now, it's prepared for future implementation
    });
  }

  // Hide edit mode when clicking outside
  document.addEventListener('click', function (e) {
    if (!e.target.closest('.profile-image-container')) {
      togglePhotoEditMode(false);
    }
  });

  document.getElementById("photoInput").addEventListener("change", function (event) {
    const file = event.target.files[0];
    if (!file) return;

    const user = firebase.auth().currentUser;
    if (!user) {
      showFloatingMessage("error", "Debes estar autenticado");
      return;
    }

    const userId = user.uid;
    const extension = file.name.split('.').pop().toLowerCase();
    const storageRef = firebase.storage().ref(`profile_images/${userId}/foto.${extension}`);

    deleteOldProfileImage(userId);

    storageRef.put(file).then(snapshot => snapshot.ref.getDownloadURL())
      .then(downloadURL => {
        return user.updateProfile({
          photoURL: downloadURL
        }).then(() => {
          const profilePic = document.getElementById("profilePic");
          if (profilePic) {
            profilePic.src = downloadURL;
            removeSkeleton(profilePic);
          }

          showFloatingMessage("success", "Foto de perfil actualizada exitosamente");
          togglePhotoEditMode(false);
        });
      }).catch(error => {
        console.error("Error al subir la foto:", error);
        showFloatingMessage("error", "Error al subir la foto de perfil");
      });
  });
}

async function getCountryByIP() {
  // ... (Se mantiene igual)
  try {
    const resp = await fetch("https://ipapi.co/json/");
    if (!resp.ok) return null;
    const data = await resp.json();
    return {
      name: data.country_name || "Desconocido",
      code: data.country_code || "",
      flag: data.country_code ? String.fromCodePoint(...[...data.country_code].map(c => 0x1F1E6 + c.charCodeAt(0) - 65)) : "",
    };
  } catch {
    return null;
  }
}

// Permisos base por rango
function getPermisosRango(rango) {
  // ... (Se mantiene igual)
  if (!rango) return {};
  rango = rango.toLowerCase().replace(/\s+/g, '_');
  if (rango === "boss_of_the_state") {
    return {
      puedeEliminarPensamiento: true,
      puedeConcederTokens: true,
      puedeCrearEventos: true,
      votoValido: 99,
      puedeEliminarPensamientoPropio: true,
      puedeEliminarPensamientoOtros: true,
      puedeComentar: true,
      accesoTotal: true,
      prioridad: 99,
    };
  }
  if (rango === "commander") {
    return {
      puedeEliminarPensamiento: true,
      puedeConcederTokens: true,
      puedeCrearEventos: true,
      votoValido: 2,
      puedeEliminarPensamientoPropio: true,
      puedeEliminarPensamientoOtros: true,
      puedeComentar: true,
      accesoTotal: true,
      prioridad: 3,
    };
  }
  if (rango === "divisional_commander") {
    return {
      puedeEliminarPensamiento: true,
      puedeConcederTokens: false,
      puedeCrearEventos: true,
      votoValido: 2,
      puedeEliminarPensamientoPropio: true,
      puedeEliminarPensamientoOtros: true,
      puedeComentar: true,
      accesoTotal: false,
      prioridad: 2,
    };
  }
  if (rango === "tribal_warrior") {
    return {
      puedeEliminarPensamiento: true,
      puedeConcederTokens: false,
      puedeCrearEventos: false,
      votoValido: 1,
      puedeEliminarPensamientoPropio: true,
      puedeEliminarPensamientoOtros: false,
      puedeComentar: true,
      accesoTotal: false,
      prioridad: 1,
    };
  }
  return {};
}

// Muestra el botón del Panel de Commander a commander, divisional_commander y Boss of the State.
function updateCommanderPanelButton(rango) {
  var btn = document.getElementById('commanderPanelBtn');
  if (!btn) return;
  var r = (rango || '').toLowerCase().replace(/\s+/g, '_');
  var isCommander = (r === 'commander' || r === 'divisional_commander' || r === 'boss_of_the_state');
  btn.style.display = isCommander ? '' : 'none';
}

// Visualización de badge según rango
function getBadgeRango(rango) {
  // ... (Se mantiene igual)
  if (!rango) return "";
  rango = rango.toLowerCase().replace(/\s+/g, '_');
  if (rango === "boss_of_the_state") {
    return `<span class="badge-rango badge-boss">Boss of the State</span>`;
  }
  if (rango === "commander") {
    return `<span class="badge-rango badge-commander">Commander</span>`;
  }
  if (rango === "divisional_commander") {
    return `<span class="badge-rango badge-divisional">Divisional Commander</span>`;
  }
  if (rango === "tribal_warrior") {
    return `<span class="badge-rango badge-tribal">Tribal Warrior</span>`;
  }
  return "";
}

// Pensamientos con paginación y prioridad de rango
function cargarPensamientosPublicosRealtime(userActual) {
  // ... (Se mantiene igual)
  const wall = document.getElementById("thoughtsWall");
  const paginador = document.getElementById("thoughtsPaginator");
  if (!wall) return;

  // Obtener referencia a la base de datos Realtime
  const database = firebase.database();
  // PZ-017: users solo lo lee Commander/Boss; el muro de pensamientos públicos
  // (que ya se muestra a todo el mundo) lee publicProfiles, que replica
  // nick/photoURL/rango/thought/steam-avatar para cada usuario.
  const usersRef = database.ref('publicProfiles');

  let todosPensamientos = [];

  usersRef.on('value', (snapshot) => {
    todosPensamientos = [];
    const usersData = snapshot.val();

    if (usersData) {
      // Construir array de pensamientos con rango y prioridad
      Object.entries(usersData).forEach(([userId, userData]) => {
        if (userData.thought && userData.thought.trim().length > 0) {
          const rango = userData.rango ? userData.rango : "tribal_warrior";
          const permisos = getPermisosRango(rango);
          todosPensamientos.push({
            userId,
            nick: userData.nick || userId || "User",
            photoURL: getPreferredAvatarFromUserData(userData, DEFAULT_PROFILE_IMAGE),
            thought: userData.thought,
            rango,
            prioridad: permisos.prioridad || 1,
          });
        }
      });
    }

    // Separar pensamiento del usuario actual y otros pensamientos
    let currentUserThought = null;
    let otherThoughts = [];

    todosPensamientos.forEach(pensamiento => {
      if (userActual && pensamiento.userId === userActual.uid) {
        currentUserThought = pensamiento;
      } else {
        otherThoughts.push(pensamiento);
      }
    });

    // Ordenar otros pensamientos por prioridad de rango
    otherThoughts.sort((a, b) => b.prioridad - a.prioridad);

    // Reorganizar: primero el pensamiento del usuario actual (si existe), luego otros
    let pensamientosOrganizados = [];
    if (currentUserThought) {
      pensamientosOrganizados.push(currentUserThought);
    }
    pensamientosOrganizados = pensamientosOrganizados.concat(otherThoughts);

    // Paginación modificada: máximo 3 pensamientos por página
    let currentPage = 1;
    const pensamientosPorPagina = 3;
    const totalPages = Math.ceil(pensamientosOrganizados.length / pensamientosPorPagina);

    function renderPagina(pagina) {
      wall.innerHTML = "";
      let startIdx = (pagina - 1) * pensamientosPorPagina;
      let endIdx = startIdx + pensamientosPorPagina;
      let pensamientosPagina = pensamientosOrganizados.slice(startIdx, endIdx);

      if (pensamientosPagina.length === 0) {
        wall.innerHTML = "<span style='color:#aaa;'>No user thoughts yet.</span>";
        return;
      }

      pensamientosPagina.forEach(pensamiento => {
        let badge = getBadgeRango(pensamiento.rango);
        let permisos = getPermisosRango(pensamiento.rango);
        let puedeEliminar = false;
        // ¿El usuario actual puede eliminar este pensamiento?
        if (userActual) {
          const permisosActual = getPermisosRango(userActual.rango);
          // Commander puede eliminar cualquier pensamiento
          // Divisional Commander puede eliminar cualquiera excepto commander
          // Tribal solo el suyo
          if (userActual.uid === pensamiento.userId && permisosActual.puedeEliminarPensamientoPropio) {
            puedeEliminar = true;
          } else if (permisosActual.puedeEliminarPensamientoOtros) {
            if (permisosActual.accesoTotal) { // Commander
              puedeEliminar = true;
            } else if (permisosActual.prioridad === 2 && pensamiento.rango !== "commander") { // Divisional Commander
              puedeEliminar = true;
            }
          }
        }

        wall.innerHTML += `
        <div class="thoughts-wall-user">
          <img class="thoughts-wall-user-img" 
               src="${pensamiento.photoURL}" 
               alt="User"
               onclick="navigateToProfile('${pensamiento.userId}')"
               title="View ${pensamiento.nick}'s profile">
          <div style="flex:1;">
            <div class="thoughts-wall-user-nick" 
                 onclick="navigateToProfile('${pensamiento.userId}')"
                 title="View ${pensamiento.nick}'s profile">
              ${pensamiento.nick}${badge}
            </div>
            <div class="thoughts-wall-user-thought">
              ${pensamiento.thought}
            </div>
          </div>
          ${puedeEliminar ? `<button class="delete-btn" title="Eliminar pensamiento" onclick="eliminarPensamientoUsuario('${pensamiento.userId}')">&#128465;</button>` : ""}
        </div>`;
      });

      // Render paginador
      if (paginador && totalPages > 1) {
          paginador.innerHTML = `
            <button class="paginator-btn" id="btnPrev" ${currentPage === 1 ? "disabled" : ""}>&lt;</button>
            <span class="paginator-page">${currentPage} / ${totalPages}</span>
            <button class="paginator-btn" id="btnNext" ${currentPage === totalPages ? "disabled" : ""}>&gt;</button>
          `;

          // Acciones de los botones
          if (document.getElementById("btnPrev")) {
            document.getElementById("btnPrev").onclick = function () {
              if (currentPage > 1) {
                currentPage--;
                renderPagina(currentPage);
              }
            };
          }
          if (document.getElementById("btnNext")) {
            document.getElementById("btnNext").onclick = function () {
              if (currentPage < totalPages) {
                currentPage++;
                renderPagina(currentPage);
              }
            };
          }
      } else if (paginador) {
          paginador.innerHTML = '';
      }
    }

    // Mostrar primera página
    renderPagina(currentPage);

  }, (error) => {
    console.error("Error loading thoughts:", error);
    wall.innerHTML = "<span style='color:#f55;'>Error loading thoughts.</span>";
  });
}

// Eliminar pensamiento de usuario
window.eliminarPensamientoUsuario = function (uid) {
  // ... (Se mantiene igual)
  if (!uid) return;
  // Confirmación
  if (!confirm("¿Seguro que deseas eliminar el pensamiento de este usuario?")) return;
  const userRef = firebase.database().ref(`users/${uid}`);
  userRef.update({
      thought: ""
    })
    .then(() => {
      showFloatingMessage("success", "Pensamiento eliminado.");
    })
    .catch(() => {
      showFloatingMessage("error", "Error al eliminar pensamiento.");
    });
};

// Nickname editing functionality
function getNicknameChangeLimits(rango) {
  // ... (Se mantiene igual)
  if (!rango) rango = "tribal_warrior";
  rango = rango.toLowerCase();

  switch (rango) {
    case "boss_of_the_state":
      return {
        limit: -1,
        name: "Boss of the State"
      };
    case "commander":
      return {
        limit: -1,
        name: "Commander"
      }; // unlimited
    case "divisional_commander":
      return {
        limit: 3,
        name: "Divisional Commander"
      };
    case "tribal_warrior":
    default:
      return {
        limit: 1,
        name: "Tribal Warrior"
      };
  }
}

function validateNickname(nickname) {
  // ... (Se mantiene igual)
  if (!nickname || nickname.length === 0) {
    return "Nickname cannot be empty";
  }
  if (nickname.length > 18) {
    return "Nickname cannot exceed 18 characters";
  }

  // Basic profanity filter (add more words as needed)
  const profanityWords = ['fuck', 'shit', 'damn', 'bitch', 'ass', 'hell', 'crap', 'piss', 'bastard', 'whore'];
  const lowerNickname = nickname.toLowerCase();

  for (const word of profanityWords) {
    if (lowerNickname.includes(word)) {
      return "Nickname contains inappropriate language";
    }
  }

  return null; // valid
}

async function checkNicknameChangesThisMonth(userId) {
  // ... (Se mantiene igual)
  try {
    const now = new Date();
    const currentMonth = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');

    const changesRef = firebase.database().ref(`nicknameChanges/${userId}/${currentMonth}`);
    const snapshot = await changesRef.once('value');
    const data = snapshot.val();

    if (!data) {
      return {
        count: 0,
        lastChange: null
      };
    }

    return {
      count: data.count || 0,
      lastChange: data.lastChange ? new Date(data.lastChange) : null
    };
  } catch (error) {
    console.error("Error checking nickname changes:", error);
    return {
      count: 0,
      lastChange: null
    };
  }
}

async function recordNicknameChange(userId) {
  // ... (Se mantiene igual)
  try {
    const now = new Date();
    const currentMonth = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');

    const changesRef = firebase.database().ref(`nicknameChanges/${userId}/${currentMonth}`);
    const snapshot = await changesRef.once('value');
    const currentData = snapshot.val() || {};

    await changesRef.set({
      count: (currentData.count || 0) + 1,
      lastChange: now.toISOString()
    });
  } catch (error) {
    console.error("Error recording nickname change:", error);
  }
}

function calculateTimeUntilNextChange(lastChangeDate) {
  // ... (Se mantiene igual)
  if (!lastChangeDate) return null;

  const nextMonth = new Date(lastChangeDate);
  nextMonth.setMonth(nextMonth.getMonth() + 1);
  nextMonth.setDate(1);
  nextMonth.setHours(0, 0, 0, 0);

  const now = new Date();
  const timeDiff = nextMonth - now;

  if (timeDiff <= 0) return null;

  const days = Math.floor(timeDiff / (1000 * 60 * 60 * 24));
  const hours = Math.floor((timeDiff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));

  return {
    days,
    hours
  };
}

function initializeNicknameEditing(user, userData) {
  // ... (Se mantiene igual)
  const editBtn = document.getElementById("nicknameEditBtn");
  const viewMode = document.getElementById("nicknameViewMode");
  const editMode = document.getElementById("nicknameEditMode");
  const nicknameInput = document.getElementById("nicknameInput");
  const saveBtn = document.getElementById("nicknameSaveBtn");
  const cancelBtn = document.getElementById("nicknameCancelBtn");
  const messageDiv = document.getElementById("nicknameMessage");
  const profileNickname = document.getElementById("profileNickname");

  if (!editBtn || !viewMode || !editMode) return;
  const safeShowMessage = (text, type) => { if (messageDiv) { messageDiv.textContent = text; messageDiv.className = 'nickname-message ' + type; messageDiv.style.display = 'block'; } };
  const safeHideMessage = () => { if (messageDiv) messageDiv.style.display = 'none'; };

  let isEditMode = false;
  const userRank = userData?.rango || "tribal_warrior";
  const rankLimits = getNicknameChangeLimits(userRank);

  // For demo purposes, if Firebase is not available, use demo data
  const isFirebaseAvailable = typeof firebase !== 'undefined' && firebase.database;

  function showMessage(text, type = 'warning') {
    safeShowMessage(text, type);
    if (type === 'success' && messageDiv) {
      setTimeout(() => { messageDiv.style.display = 'none'; }, 3000);
    }
  }

  function hideMessage() { safeHideMessage(); }

  // Toggle edit mode
  async function toggleEditMode() {
    if (isEditMode) {
      // Cancel edit
      viewMode.style.display = 'flex';
      editMode.style.display = 'none';
      editMode.classList.remove('active');
      hideMessage();
      isEditMode = false;
      return;
    }

    // For demo purposes, simulate checking limits
    let changes = {
      count: 0,
      lastChange: null
    };

    if (isFirebaseAvailable) {
      changes = await checkNicknameChangesThisMonth(user.uid);
    } else {
      // Demo data - simulate a tribal warrior with 0 changes used
      changes = {
        count: 0,
        lastChange: null
      };
    }

    if (rankLimits.limit > 0 && changes.count >= rankLimits.limit) {
      // Show countdown if changes exhausted
      const timeLeft = calculateTimeUntilNextChange(changes.lastChange);
      if (timeLeft) {
        showMessage(
          `You have used all ${rankLimits.limit} nickname changes allowed this month for ${rankLimits.name} rank. Next change available in ${timeLeft.days} days and ${timeLeft.hours} hours.`,
          'warning'
        );
      } else {
        showMessage(
          `You have used all ${rankLimits.limit} nickname changes allowed this month for ${rankLimits.name} rank.`,
          'warning'
        );
      }
      return;
    }

    // Show edit mode
    viewMode.style.display = 'none';
    editMode.style.display = 'flex';
    editMode.classList.add('active');
    nicknameInput.value = profileNickname.textContent;
    nicknameInput.focus();
    nicknameInput.select();

    // Show warning about limits
    if (rankLimits.limit > 0) {
      const remaining = rankLimits.limit - changes.count;
      showMessage(
        `${rankLimits.name} rank: You have ${remaining} nickname changes remaining this month.`,
        'warning'
      );
    } else {
      showMessage(
        `${rankLimits.name} rank: You have unlimited nickname changes.`,
        'warning'
      );
    }

    isEditMode = true;
  }

  // Save nickname
  async function saveNickname() {
    const newNickname = nicknameInput.value.trim();
    const validationError = validateNickname(newNickname);

    if (validationError) {
      showMessage(validationError, 'warning');
      return;
    }

    if (newNickname === profileNickname.textContent) {
      toggleEditMode(); // No change, just cancel
      return;
    }

    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';

    try {
      if (isFirebaseAvailable) {
        // Update nickname in Firebase
        const userRef = firebase.database().ref(`users/${user.uid}`);
        await userRef.update({
          nick: newNickname
        });

        // Update display name in Firebase Auth
        await user.updateProfile({
          displayName: newNickname
        });

        // Record the change
        await recordNicknameChange(user.uid);
      } else {
        // Demo mode - simulate successful save
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      // Update UI
      profileNickname.textContent = newNickname;
      showMessage('Your nickname was changed successfully', 'success');

      // Exit edit mode
      viewMode.style.display = 'flex';
      editMode.style.display = 'none';
      editMode.classList.remove('active');
      isEditMode = false;

    } catch (error) {
      console.error("Error saving nickname:", error);
      showMessage('Error saving nickname. Please try again.', 'warning');
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save';
    }
  }

  // Event listeners
  editBtn.addEventListener('click', toggleEditMode);
  cancelBtn.addEventListener('click', toggleEditMode);
  saveBtn.addEventListener('click', saveNickname);

  // Enter key to save, Escape to cancel
  nicknameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      saveNickname();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      toggleEditMode();
    }
  });

  // Real-time validation
  nicknameInput.addEventListener('input', () => {
    const nickname = nicknameInput.value.trim();
    const error = validateNickname(nickname);
    saveBtn.disabled = !!error || nickname === profileNickname.textContent;

    if (error && nickname.length > 0) {
      showMessage(error, 'warning');
    } else if (!error && nickname !== profileNickname.textContent) {
      hideMessage();
    }
  });
}

// ================== NEW FUNCTION FOR THOUGHT POSTER (MODIFIED) ==================
function initializeThoughtPoster(user, translations) {
  // ... (Se mantiene igual)
  const thoughtsWallSection = document.getElementById('thoughtsWallSection');
  if (!thoughtsWallSection) return;

  // Create the "Write Thought" button
  const thoughtPromptBtn = document.createElement('button');
  thoughtPromptBtn.className = 'thought-prompt-btn';
  thoughtPromptBtn.textContent = '¡Escribe hoy tu pensamiento!';

  // Create the thought box container (initially hidden)
  const thoughtBox = document.createElement("div");
  thoughtBox.className = "thought-box";
  thoughtBox.style.display = 'none'; // Hidden by default
  thoughtBox.innerHTML = `
        <label for="thoughtArea">${translations.thoughtLabel}</label>
        <textarea class="thought-area" id="thoughtArea" maxlength="60" placeholder="${translations.thoughtPlaceholder}" aria-label="${translations.thoughtPlaceholder}"></textarea>
        <div class="thought-char-count" id="thoughtCharCount">60 ${translations.charCount}</div>
        <button class="thought-save-btn" id="thoughtSaveBtn">${translations.thoughtSaveBtn}</button>
        <div class="thought-message success" id="thoughtSuccess"></div>
        <div class="thought-message error" id="thoughtError"></div>
    `;

  // Add button and hidden box to the page AT THE END of the section
  thoughtsWallSection.appendChild(thoughtPromptBtn);
  thoughtsWallSection.appendChild(thoughtBox);

  // Add click event to the button to toggle the thought box
  thoughtPromptBtn.addEventListener('click', () => {
    const isVisible = thoughtBox.style.display === 'flex';
    thoughtBox.style.display = isVisible ? 'none' : 'flex';
  });

  // Functionality for the thought poster
  const thoughtArea = document.getElementById("thoughtArea");
  const thoughtCharCount = document.getElementById("thoughtCharCount");
  const thoughtSaveBtn = document.getElementById("thoughtSaveBtn");
  const thoughtSuccess = document.getElementById("thoughtSuccess");
  const thoughtError = document.getElementById("thoughtError");

  function updateCharCount() {
    if (!thoughtArea || !thoughtCharCount) return;
    let left = 60 - thoughtArea.value.length;
    thoughtCharCount.textContent = left + " " + translations.charCount;
    thoughtSaveBtn.disabled = (left < 0 || left === 60 || !thoughtArea.value.trim());
  }

  if (thoughtArea) {
    thoughtArea.addEventListener('input', updateCharCount);
  }
  updateCharCount(); // Initial call

  if (thoughtSaveBtn) {
    thoughtSaveBtn.onclick = async function () {
      const thought = thoughtArea.value.trim();
      if (!thought || thought.length > 60) return;
      thoughtSaveBtn.disabled = true;
      thoughtSuccess.style.display = "none";
      thoughtError.style.display = "none";

      try {
        const database = firebase.database();
        const userRef = database.ref(`users/${user.uid}`);
        await userRef.update({
          thought: thought,
          photoURL: user.photoURL || DEFAULT_PROFILE_IMAGE,
          nick: user.displayName || user.email?.split('@')[0] || "User"
        });

        thoughtArea.value = ""; // Clear input
        thoughtSuccess.textContent = translations.saveThoughtSuccess;
        thoughtSuccess.style.display = "block";
        setTimeout(() => {
          thoughtSuccess.style.display = "none"
        }, 2000);
        updateCharCount();

        // Hide the box after successful save
        setTimeout(() => {
          thoughtBox.style.display = 'none';
        }, 1000);

      } catch (err) {
        console.error("Error saving thought:", err);
        thoughtError.textContent = translations.saveThoughtError;
        thoughtError.style.display = "block";
        setTimeout(() => {
          thoughtError.style.display = "none"
        }, 2500);
      } finally {
        thoughtSaveBtn.disabled = false;
      }
    };
  }
}

// ================== NEWS & EVENTS WIDGET LOGIC (MODIFIED) ==================
function initializeWidget(userData) {
  // ... (Se mantiene igual)
  const addContentBtn = document.getElementById('addContentBtn');
  if (!addContentBtn) return;

  // 1. Show the add button if the user is a Commander
  const userRank = userData?.rango || "tribal_warrior";
  const permissions = getPermisosRango(userRank);
  if (permissions.accesoTotal) {
    addContentBtn.style.display = 'flex';
  }

  // 2. Load content from Firebase, passing permissions
  loadWidgetContent(permissions);

  // 3. Modal logic for Commanders
  const modal = document.getElementById('contentModal');
  const closeModal = document.getElementById('closeModal');
  const saveContentBtn = document.getElementById('saveContentBtn');

  if (modal && closeModal && saveContentBtn) {
    addContentBtn.addEventListener('click', () => {
      modal.style.display = 'flex';
    });
    closeModal.addEventListener('click', () => {
      modal.style.display = 'none';
    });
    window.addEventListener('click', (event) => {
      if (event.target == modal) {
        modal.style.display = 'none';
      }
    });
    saveContentBtn.addEventListener('click', saveWidgetContent);
  }
}

async function saveWidgetContent() {
  // ... (Se mantiene igual)
  const type = document.getElementById('contentType').value;
  const title = document.getElementById('contentTitle').value.trim();
  const date = document.getElementById('contentDate').value;
  const description = document.getElementById('contentDescription').value.trim();
  const link = document.getElementById('contentLink').value.trim();

  if (!title || !date || !description) {
    showFloatingMessage('error', 'Título, fecha y descripción son obligatorios.');
    return;
  }

  const contentData = {
    type,
    title,
    date,
    description,
    link: link || null,
    createdAt: Date.now()
  };

  try {
    const contentRef = firebase.database().ref('news_events');
    await contentRef.push(contentData);
    if (typeof pushSiteActivity === 'function') {
        const safe = (s) => (s || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        pushSiteActivity(contentData.type === 'event' ? 'dashboard_event' : 'dashboard_news', `<strong>Nuevo ${contentData.type === 'event' ? 'evento' : 'anuncio'}:</strong> ${safe(contentData.title)}`);
    }
    showFloatingMessage('success', 'Contenido guardado exitosamente.');
    document.getElementById('contentModal').style.display = 'none';
    
    // Clear the form
    document.getElementById('contentTitle').value = '';
    document.getElementById('contentDate').value = '';
    document.getElementById('contentDescription').value = '';
    document.getElementById('contentLink').value = '';
  } catch (error) {
    console.error("Error al guardar contenido:", error);
    showFloatingMessage('error', 'No se pudo guardar el contenido.');
  }
}

const DASHBOARD_FRIENDS_PER_PAGE = 4;
const DASHBOARD_RANK_SORT = {
  boss_of_the_state: 5,
  commander: 4,
  divisional_commander: 3,
  tribal_warrior: 2
};
let dashboardFriendsCache = [];
let dashboardFriendsPage = 0;
let dashboardFriendsListenerBound = false;
let dashboardFriendRequestsCache = {};
let dashboardFriendRequestsRef = null;
let dashboardFriendRequestsListener = null;
let dashboardFriendSeenData = {};

function getDashboardRankSortScore(rango) {
  if (!rango) return 1;
  const key = String(rango).toLowerCase().replace(/\s+/g, '_');
  return DASHBOARD_RANK_SORT[key] || 1;
}

function getDashboardFriendLevel(userData) {
  if (!userData) return 1;
  if (userData.stats && typeof userData.stats.level === 'number') return userData.stats.level;
  if (typeof userData.level === 'number') return userData.level;
  return 1;
}

function getDashboardFriendRankLabel(rango) {
  const key = (rango || 'tribal_warrior').toLowerCase().replace(/\s+/g, '_');
  if (key === 'boss_of_the_state') return 'Boss';
  if (key === 'commander') return 'Commander';
  if (key === 'divisional_commander') return 'Divisional';
  return 'Tribal';
}

function escapeDashboardHtml(value) {
  if (value == null) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function getDashboardFriendSeenMap(userData) {
  return (userData && userData.notificationSeen && userData.notificationSeen.friends) || dashboardFriendSeenData || {};
}

function countUnreadDashboardFriendRequests(userData) {
  const seen = getDashboardFriendSeenMap(userData);
  return Object.keys(dashboardFriendRequestsCache).filter(function(senderUid) {
    return !seen[senderUid];
  }).length;
}

function updateDashboardFriendsBadge(userData) {
  const countEl = document.getElementById('dashboardFriendsCount');
  if (!countEl) return;
  const unread = countUnreadDashboardFriendRequests(userData);
  if (unread > 0) {
    countEl.textContent = String(unread);
    countEl.style.display = 'inline-flex';
    countEl.classList.add('dashboard-widget-count--alert');
  } else {
    countEl.textContent = '';
    countEl.style.display = 'none';
    countEl.classList.remove('dashboard-widget-count--alert');
  }
}

function renderDashboardFriendRequests(userData) {
  const box = document.getElementById('dashboardFriendsRequests');
  if (!box) return;
  const pending = Object.keys(dashboardFriendRequestsCache).map(function(senderUid) {
    return Object.assign({ senderUid: senderUid }, dashboardFriendRequestsCache[senderUid] || {});
  });
  if (!pending.length) {
    box.style.display = 'none';
    box.innerHTML = '';
    return;
  }
  box.style.display = 'block';
  const seen = getDashboardFriendSeenMap(userData);
  box.innerHTML = '<div class="dashboard-friends-requests-title"><i class="fas fa-user-plus"></i> Solicitudes de amistad</div>' +
    pending.map(function(req) {
      const nick = escapeDashboardHtml(req.senderNick || 'Jugador');
      const msg = req.message ? '<p class="dashboard-friend-request-msg">' + escapeDashboardHtml(req.message) + '</p>' : '';
      const isNew = !seen[req.senderUid];
      return '<div class="dashboard-friend-request-card' + (isNew ? ' is-new' : '') + '" data-sender="' + escapeDashboardHtml(req.senderUid) + '">' +
        '<div class="dashboard-friend-request-head"><strong>' + nick + '</strong><span>' + (isNew ? 'Nueva solicitud' : 'Solicitud pendiente') + '</span></div>' +
        msg +
        '<div class="dashboard-friend-request-actions">' +
        '<button type="button" class="dashboard-friend-request-btn accept" data-friend-accept="' + escapeDashboardHtml(req.senderUid) + '">Aceptar</button>' +
        '<button type="button" class="dashboard-friend-request-btn decline" data-friend-decline="' + escapeDashboardHtml(req.senderUid) + '">Rechazar</button>' +
        '</div></div>';
    }).join('');
  box.querySelectorAll('[data-friend-accept]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      const uid = btn.getAttribute('data-friend-accept');
      acceptFriendRequest(Object.assign({ senderUid: uid }, dashboardFriendRequestsCache[uid] || {}));
    });
  });
  box.querySelectorAll('[data-friend-decline]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      declineFriendRequest(btn.getAttribute('data-friend-decline'));
    });
  });
}

function listenDashboardFriendRequests(uid, userData) {
  if (!uid || typeof firebase === 'undefined' || !firebase.database) return;
  if (dashboardFriendRequestsRef && dashboardFriendRequestsListener) {
    dashboardFriendRequestsRef.off('value', dashboardFriendRequestsListener);
  }
  dashboardFriendSeenData = getDashboardFriendSeenMap(userData);
  dashboardFriendRequestsRef = firebase.database().ref('friendRequests/' + uid);
  dashboardFriendRequestsListener = function(snap) {
    dashboardFriendRequestsCache = snap.val() || {};
    updateDashboardFriendsBadge(currentUserData);
    renderDashboardFriendRequests(currentUserData);
    if (typeof window.SGNotifications !== 'undefined' && window.SGNotifications.render) {
      window.SGNotifications.render();
    }
  };
  dashboardFriendRequestsRef.on('value', dashboardFriendRequestsListener);
}

async function acceptFriendRequest(requestData) {
  const authUser = firebase.auth().currentUser;
  if (!authUser || !requestData || !requestData.senderUid) return;
  const senderUid = requestData.senderUid;
  const ts = firebase.database.ServerValue.TIMESTAMP;
  const myData = currentUserData || {};
  try {
    await firebase.database().ref('sgFriends/' + authUser.uid + '/' + senderUid).set({
      nick: requestData.senderNick || 'Usuario',
      photoURL: requestData.senderAvatar || '/dragon_profile_studiosgamesrs.png',
      since: ts
    });
    await firebase.database().ref('sgFriends/' + senderUid + '/' + authUser.uid).set({
      nick: myData.nick || authUser.displayName || 'Usuario',
      photoURL: myData.photoURL || authUser.photoURL || '/dragon_profile_studiosgamesrs.png',
      since: ts
    });
    await firebase.database().ref('friendRequests/' + authUser.uid + '/' + senderUid).remove();
    await firebase.database().ref('users/' + authUser.uid + '/notificationSeen/friends/' + senderUid).set(Date.now());
    if (currentUserData) {
      if (!currentUserData.notificationSeen) currentUserData.notificationSeen = {};
      if (!currentUserData.notificationSeen.friends) currentUserData.notificationSeen.friends = {};
      currentUserData.notificationSeen.friends[senderUid] = Date.now();
    }
    showFloatingMessage('success', '¡Ahora son amigos!');
    loadDashboardFriendsList(authUser.uid);
  } catch (e) {
    console.error('acceptFriendRequest:', e);
    showFloatingMessage('error', 'Error al aceptar la solicitud de amistad.');
  }
}

async function declineFriendRequest(senderUid) {
  const authUser = firebase.auth().currentUser;
  if (!authUser || !senderUid) return;
  try {
    await firebase.database().ref('friendRequests/' + authUser.uid + '/' + senderUid).remove();
    await firebase.database().ref('users/' + authUser.uid + '/notificationSeen/friends/' + senderUid).set(Date.now());
    if (currentUserData) {
      if (!currentUserData.notificationSeen) currentUserData.notificationSeen = {};
      if (!currentUserData.notificationSeen.friends) currentUserData.notificationSeen.friends = {};
      currentUserData.notificationSeen.friends[senderUid] = Date.now();
    }
    showFloatingMessage('info', 'Solicitud de amistad rechazada.');
  } catch (e) {
    console.error('declineFriendRequest:', e);
    showFloatingMessage('error', 'No se pudo rechazar la solicitud.');
  }
}

function normalizeBadgeList(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw.filter(function(id) { return typeof id === 'string' && id; });
  }
  if (typeof raw === 'object') {
    return Object.keys(raw).reduce(function(list, key) {
      var val = raw[key];
      if (val === true || val === 1) list.push(key);
      else if (typeof val === 'string' && val) list.push(val);
      return list;
    }, []);
  }
  return [];
}

function getProfileAchievementsMerged(userData, options) {
  const opts = options || {};
  const merged = {};
  const fromUser = (userData && userData.achievements) || {};
  Object.keys(fromUser).forEach(function(key) {
    if (fromUser[key]) merged[key] = fromUser[key];
  });
  normalizeBadgeList(userData && userData.badges).forEach(function(id) {
    merged[id] = true;
  });
  // El widget Nexus solo refleja al usuario logueado: al mirar otro perfil
  // no debe mezclarse o se verían (o se ocultarían) las insignias incorrectas.
  if (opts.includeViewerWidget !== false && window.NexusWidget && Array.isArray(window.NexusWidget.badgesList)) {
    window.NexusWidget.badgesList.forEach(function(badge) {
      if (badge.unlocked) merged[badge.id] = true;
    });
  }
  return merged;
}

// Insignia de la campaña de bienvenida (welcomeReward.js la otorga). Va aparte
// del catálogo Nexus porque usa imagen propia y se muestra siempre delante.
const LOYALTY_PROFILE_BADGE = {
  id: 'loyalty_trial',
  name: 'Lealtad',
  image: '/badges/lealtad-320.png',
  description: 'Reconoce el honor de haberte registrado entre los primeros de StudiosGamesRS.'
};

const NEXUS_PROFILE_BADGES_DISPLAY = [
  { id: 'first_steps', name: 'Primeros Pasos', icon: 'fa-shoe-prints', description: 'Completaste tu primera misión en Nexus.' },
  { id: 'social_butterfly', name: 'Social', icon: 'fa-share-alt', aliases: ['social'], description: 'Completaste 5 misiones sociales.' },
  { id: 'referral_master', name: 'Referidos', icon: 'fa-users', aliases: ['referral'], description: 'Invitaste jugadores que se quedaron en el sitio.' },
  { id: 'streak_keeper', name: 'Racha', icon: 'fa-fire', aliases: ['streak'], description: 'Mantuviste una racha de días activos.' },
  { id: 'legendary', name: 'Leyenda', icon: 'fa-crown', aliases: ['legend', 'badge_elite'], description: 'Alcanzaste el rango legendario de Nexus.' }
];

function isNexusProfileBadgeUnlocked(achievements, badge) {
  if (achievements[badge.id]) return true;
  const aliases = badge.aliases || [];
  for (let i = 0; i < aliases.length; i++) {
    if (achievements[aliases[i]]) return true;
  }
  return false;
}

function getUnlockedNexusBadgesForProfile(userData, options) {
  const achievements = getProfileAchievementsMerged(userData, options);
  return NEXUS_PROFILE_BADGES_DISPLAY.filter(function(badge) {
    return isNexusProfileBadgeUnlocked(achievements, badge);
  });
}

function getPrimaryNexusBadgeForProfile(userData, options) {
  const achievements = getProfileAchievementsMerged(userData, options);
  const unlocked = NEXUS_PROFILE_BADGES_DISPLAY.find(function(badge) {
    return isNexusProfileBadgeUnlocked(achievements, badge);
  });
  return unlocked || NEXUS_PROFILE_BADGES_DISPLAY[0];
}

function buildProfileBadgeChip(badge, unlocked, index) {
  const core = badge.image
    ? '<img class="profile-nexus-badge-chip-img" src="' + escapeDashboardHtml(badge.image) + '" alt="" loading="lazy" ' +
        'onerror="this.onerror=null;this.src=\'https://studiosgamesrs.web.app' + escapeDashboardHtml(badge.image) + '\';">'
    : '<i class="fas ' + escapeDashboardHtml(unlocked ? badge.icon : 'fa-lock') + '"></i>';
  const tip = badge.description
    ? '<span class="profile-nexus-badge-tip" role="tooltip">' +
        '<strong>' + escapeDashboardHtml(badge.name) + '</strong>' +
        escapeDashboardHtml(badge.description) +
      '</span>'
    : '';
  return '<div class="profile-nexus-badge-chip' + (unlocked ? ' is-unlocked' : ' is-locked') +
      (badge.image ? ' has-image' : '') + '" style="--badge-delay:' + (index * 0.09) + 's" tabindex="0" ' +
      'aria-label="' + escapeDashboardHtml(badge.name + (unlocked ? '' : ' (bloqueada)')) + '">' +
    '<span class="profile-nexus-badge-chip-ring" aria-hidden="true"></span>' +
    '<span class="profile-nexus-badge-chip-core">' + core + '</span>' +
    '<span class="profile-nexus-badge-chip-label">' + escapeDashboardHtml(badge.name) + '</span>' +
    tip +
    '</div>';
}

/**
 * Pinta la tira de insignias del perfil. profileUid es el dueño del perfil
 * que se está mirando; si no es el usuario logueado, solo se muestran
 * insignias públicas ya desbloqueadas (nunca el estado del widget Nexus).
 */
function renderProfileNexusBadges(userData, profileUid) {
  const row = document.getElementById('profile-nexus-badges-row');
  const strip = document.getElementById('profileNexusBadgesStrip');
  if (!row || !strip) return;

  const viewerUid = (firebase.auth().currentUser && firebase.auth().currentUser.uid) || null;
  const targetUid = profileUid || viewerUid;
  const isOwn = !!(viewerUid && targetUid && viewerUid === targetUid);
  const mergeOpts = { includeViewerWidget: isOwn };
  const data = userData || {};
  const achievements = getProfileAchievementsMerged(data, mergeOpts);
  const chips = [];

  if (achievements[LOYALTY_PROFILE_BADGE.id]) {
    chips.push(buildProfileBadgeChip(LOYALTY_PROFILE_BADGE, true, 0));
  }

  if (isOwn) {
    const badge = getPrimaryNexusBadgeForProfile(data, mergeOpts);
    chips.push(buildProfileBadgeChip(badge, isNexusProfileBadgeUnlocked(achievements, badge), chips.length));
  } else {
    // En perfiles ajenos solo se muestran insignias públicas desbloqueadas.
    getUnlockedNexusBadgesForProfile(data, mergeOpts).forEach(function(badge) {
      chips.push(buildProfileBadgeChip(badge, true, chips.length));
    });
  }

  if (!chips.length) {
    strip.style.display = isOwn ? 'flex' : 'none';
    row.innerHTML = '';
    return;
  }

  strip.style.display = 'flex';
  row.innerHTML = chips.join('');
}

/**
 * Carga insignias públicas del perfil (users/{uid}/badges + publicProfiles)
 * y pinta la tira. Así al mirar a otro usuario no dependemos de que el
 * snapshot completo traiga badges, ni del widget Nexus del visitante.
 */
function loadAndRenderProfileBadges(profileUid, seedUserData) {
  const data = Object.assign({}, seedUserData || {});
  if (!profileUid || typeof firebase === 'undefined' || !firebase.database) {
    renderProfileNexusBadges(data, profileUid);
    return Promise.resolve();
  }

  const db = firebase.database();
  return Promise.all([
    db.ref('users/' + profileUid + '/badges').once('value').catch(function() { return null; }),
    db.ref('publicProfiles/' + profileUid + '/badges').once('value').catch(function() { return null; })
  ]).then(function(snaps) {
    const fromUser = snaps[0] && snaps[0].val ? snaps[0].val() : null;
    const fromPublic = snaps[1] && snaps[1].val ? snaps[1].val() : null;
    const merged = {};
    normalizeBadgeList(data.badges).forEach(function(id) { merged[id] = true; });
    normalizeBadgeList(fromUser).forEach(function(id) { merged[id] = true; });
    normalizeBadgeList(fromPublic).forEach(function(id) { merged[id] = true; });
    data.badges = Object.keys(merged);
    renderProfileNexusBadges(data, profileUid);
  }).catch(function() {
    renderProfileNexusBadges(data, profileUid);
  });
}

/** Repinta la tira tras otorgar una insignia (lo usa el overlay de bienvenida). */
window.refreshProfileNexusBadges = function() {
  const uid = firebase.auth().currentUser && firebase.auth().currentUser.uid;
  if (!uid) return;
  loadAndRenderProfileBadges(uid, window.currentUserData || {});
};

window.acceptFriendRequest = acceptFriendRequest;
window.declineFriendRequest = declineFriendRequest;

function renderDashboardFriendsPage() {
  const grid = document.getElementById('dashboardFriendsGrid');
  const pager = document.getElementById('dashboardFriendsPager');
  const pageLabel = document.getElementById('dashboardFriendsPageLabel');
  const prevBtn = document.getElementById('dashboardFriendsPrev');
  const nextBtn = document.getElementById('dashboardFriendsNext');
  if (!grid) return;

  const total = dashboardFriendsCache.length;
  updateDashboardFriendsBadge(currentUserData);

  if (!total) {
    grid.innerHTML = '<p class="dashboard-friends-empty">Aún no tienes amigos. Búscalos en Comunidad o PlayZone.</p>';
    if (pager) pager.style.display = 'none';
    return;
  }

  const totalPages = Math.max(1, Math.ceil(total / DASHBOARD_FRIENDS_PER_PAGE));
  if (dashboardFriendsPage >= totalPages) dashboardFriendsPage = totalPages - 1;
  if (dashboardFriendsPage < 0) dashboardFriendsPage = 0;

  const start = dashboardFriendsPage * DASHBOARD_FRIENDS_PER_PAGE;
  const slice = dashboardFriendsCache.slice(start, start + DASHBOARD_FRIENDS_PER_PAGE);

  grid.innerHTML = slice.map(function(friend) {
    const rankClass = (friend.rango || 'tribal_warrior').toLowerCase().replace(/\s+/g, '_');
    return '<a class="dashboard-friend-card" href="/dashboard?uid=' + encodeURIComponent(friend.uid) + '" title="Ver perfil de ' + escapeDashboardHtml(friend.nick) + '">' +
      '<img src="' + escapeDashboardHtml(friend.photo) + '" alt="" loading="lazy" onerror="this.src=\'/dragon_profile_studiosgamesrs.png\'">' +
      '<span class="dashboard-friend-info">' +
        '<span class="dashboard-friend-nick">' + escapeDashboardHtml(friend.nick) + '</span>' +
        '<span class="dashboard-friend-meta">Nv. ' + friend.level + '</span>' +
      '</span>' +
      '<span class="dashboard-friend-rank dashboard-friend-rank--' + escapeDashboardHtml(rankClass) + '">' + escapeDashboardHtml(friend.rankLabel) + '</span>' +
      '</a>';
  }).join('');

  if (pager) pager.style.display = totalPages > 1 ? 'flex' : 'none';
  if (pageLabel) pageLabel.textContent = (dashboardFriendsPage + 1) + ' / ' + totalPages;
  if (prevBtn) prevBtn.disabled = dashboardFriendsPage <= 0;
  if (nextBtn) nextBtn.disabled = dashboardFriendsPage >= totalPages - 1;
}

function bindDashboardFriendsPager() {
  if (dashboardFriendsListenerBound) return;
  const prevBtn = document.getElementById('dashboardFriendsPrev');
  const nextBtn = document.getElementById('dashboardFriendsNext');
  if (prevBtn) {
    prevBtn.addEventListener('click', function() {
      if (dashboardFriendsPage > 0) {
        dashboardFriendsPage -= 1;
        renderDashboardFriendsPage();
      }
    });
  }
  if (nextBtn) {
    nextBtn.addEventListener('click', function() {
      const totalPages = Math.ceil(dashboardFriendsCache.length / DASHBOARD_FRIENDS_PER_PAGE);
      if (dashboardFriendsPage < totalPages - 1) {
        dashboardFriendsPage += 1;
        renderDashboardFriendsPage();
      }
    });
  }
  dashboardFriendsListenerBound = true;
}

async function loadDashboardFriendsList(uid) {
  const grid = document.getElementById('dashboardFriendsGrid');
  if (!grid || !uid) return;
  bindDashboardFriendsPager();
  grid.innerHTML = '<p class="dashboard-friends-empty">Cargando amigos…</p>';

  try {
    const snap = await firebase.database().ref('sgFriends/' + uid).once('value');
    if (!snap.exists()) {
      dashboardFriendsCache = [];
      dashboardFriendsPage = 0;
      renderDashboardFriendsPage();
      return;
    }

    const uids = Object.keys(snap.val() || {});
    const profiles = await Promise.all(uids.map(async function(friendUid) {
      const userSnap = await firebase.database().ref('users/' + friendUid).once('value');
      const data = userSnap.val() || {};
      const rango = data.rango || 'tribal_warrior';
      return {
        uid: friendUid,
        nick: data.nick || data.nickname || 'Jugador',
        photo: data.photoURL || '/dragon_profile_studiosgamesrs.png',
        rango: rango,
        rankLabel: getDashboardFriendRankLabel(rango),
        rankScore: getDashboardRankSortScore(rango),
        level: getDashboardFriendLevel(data)
      };
    }));

    dashboardFriendsCache = profiles.sort(function(a, b) {
      if (b.rankScore !== a.rankScore) return b.rankScore - a.rankScore;
      if (b.level !== a.level) return b.level - a.level;
      return String(a.nick).localeCompare(String(b.nick), 'es', { sensitivity: 'base' });
    });
    dashboardFriendsPage = 0;
    renderDashboardFriendsPage();
  } catch (err) {
    console.error('loadDashboardFriendsList:', err);
    grid.innerHTML = '<p class="dashboard-friends-empty">No se pudo cargar la lista de amigos.</p>';
  }
}

function loadWidgetContent(permissions) { // <-- CAMBIO: Acepta permisos
  // ... (Se mantiene igual)
    const eventsList = document.getElementById('eventsList');
    const newsList = document.getElementById('newsList');
    const contentRef = firebase.database().ref('news_events').orderByChild('date');

    contentRef.on('value', (snapshot) => {
        eventsList.innerHTML = '';
        newsList.innerHTML = '';

        const allContent = [];
        snapshot.forEach(childSnapshot => {
            // CAMBIO: Guardar el item y su clave única
            allContent.push({ key: childSnapshot.key, ...childSnapshot.val() });
        });

        const sortedContent = allContent.sort((a, b) => new Date(b.date) - new Date(a.date));

        let hasEvents = false;
        let hasNews = false;
        
        const canDelete = permissions && permissions.accesoTotal;

        sortedContent.forEach(item => {
            const listContainer = item.type === 'event' ? eventsList : newsList;
            if (item.type === 'event') hasEvents = true;
            if (item.type === 'news') hasNews = true;

            if (!item.date) return;
            const itemDate = new Date(item.date);
            const correctedDate = new Date(itemDate.getTime() + itemDate.getTimezoneOffset() * 60000);
            const day = correctedDate.getUTCDate();
            const month = correctedDate.toLocaleString('es-ES', { month: 'short' }).toUpperCase().replace('.', '');

            const linkButton = item.link ? `<button class="news-btn register" onclick="window.open('${item.link}', '_blank')">Ver más</button>` : '';
            // CAMBIO: Añadir botón de eliminar si el usuario es commander
            const deleteButton = canDelete ? `<button class="news-delete-btn" onclick="deleteWidgetContent('${item.key}')" title="Eliminar">&times;</button>` : '';

            const itemElement = document.createElement('div');
            itemElement.className = 'news-item';
            itemElement.innerHTML = `
                ${deleteButton}
                <div class="news-date-tag">${day} ${month}</div>
                <div class="news-content">
                    <h3 class="news-title">${item.title}</h3>
                    <p class="news-description">${item.description}</p>
                    <div class="news-actions">${linkButton}</div>
                </div>`;
            listContainer.appendChild(itemElement);
        });

        if (!hasEvents) {
            eventsList.innerHTML = '<p style="color: #aaa; font-size: 0.9rem; text-align: center;">No hay eventos próximos.</p>';
        }
        if (!hasNews) {
            newsList.innerHTML = '<p style="color: #aaa; font-size: 0.9rem; text-align: center;">No hay noticias recientes.</p>';
        }
    });
}

// ======== NUEVA FUNCIÓN PARA ELIMINAR CONTENIDO DEL WIDGET ========
window.deleteWidgetContent = function(key) {
  // ... (Se mantiene igual)
    if (!key) return;
    if (confirm('¿Seguro que quieres eliminar este elemento?')) {
        firebase.database().ref('news_events/' + key).remove()
            .then(() => {
                showFloatingMessage('success', 'Elemento eliminado correctamente.');
            })
            .catch(err => {
                console.error("Error al eliminar elemento del widget:", err);
                showFloatingMessage('error', 'Error al eliminar el elemento.');
            });
    }
}
// ======== FIN DE NUEVA FUNCIÓN ========

// ======== CONTRIBUTIONS (Nexus trumpet-call helps) ========
function _aportesEscapeHtml(s) {
    if (s == null || s === '') return '';
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function getSteamAvatarFromUserData(userData) {
    if (!userData || !userData.steam) return '';
    const steam = userData.steam || {};
    return steam.avatarfull || steam.avatarmedium || steam.avatar || '';
}

function getPreferredAvatarFromUserData(userData, fallback) {
    const baseFallback = fallback || DEFAULT_PROFILE_IMAGE;
    if (!userData) return baseFallback;
    const steamAvatar = getSteamAvatarFromUserData(userData);
    const preferSteam = userData.preferSteamAvatar === true || userData.avatarSource === 'steam';
    if (preferSteam && steamAvatar) return steamAvatar;
    return userData.photoURL || steamAvatar || baseFallback;
}


function displayRecognitions(userData) {
    const countEl = document.getElementById('aportesTrumpetHelpsCount');
    if (!countEl) return;

    const readNumeric = (...vals) => {
        for (const v of vals) {
            const n = Number(v);
            if (Number.isFinite(n) && n >= 0) return Math.floor(n);
        }
        return null;
    };

    const directCount = readNumeric(
        userData?.nexusTrumpetHelps,
        userData?.trumpetHelps,
        userData?.battleCallHelps,
        userData?.helpedBattleCalls,
        userData?.contributions,
        userData?.stats?.nexusTrumpetHelps,
        userData?.stats?.trumpetHelps,
        userData?.stats?.battleCallHelps
    );
    if (directCount !== null) {
        countEl.textContent = String(directCount);
        return;
    }

    // Fallback: infer helps from battle-call threads where user appears as helper.
    const profileUid = userData?.uid || userData?.id || userData?.userId || null;
    if (!profileUid || typeof firebase === 'undefined' || !firebase.database) {
        countEl.textContent = '0';
        return;
    }

    firebase.database().ref('forumThreads').once('value').then((snap) => {
        let helps = 0;
        if (snap && snap.exists()) {
            snap.forEach((ch) => {
                const t = ch.val() || {};
                if (!t.isHelpRequest || t.authorId === profileUid) return;

                const helpers = t.helpers || t.helpedBy || t.supporters || t.assists || t.participants;
                if (helpers && typeof helpers === 'object') {
                    if (helpers[profileUid]) helps++;
                    return;
                }

                const replies = t.replies;
                if (replies && typeof replies === 'object') {
                    let helpedHere = false;
                    Object.keys(replies).forEach((rk) => {
                        const r = replies[rk] || {};
                        if (!helpedHere && (r.authorId === profileUid || r.uid === profileUid || r.userId === profileUid)) {
                            helpedHere = true;
                        }
                    });
                    if (helpedHere) helps++;
                }
            });
        }
        countEl.textContent = String(helps);
    }).catch(() => {
        countEl.textContent = '0';
    });
}

/** Limpieza de listeners del historial de partidas (cambio de perfil / salida) */
let profileMatchHistoryCleanup = null;

function renderProfileMatchHistoryRows(items) {
    const listEl = document.getElementById('profileMatchHistoryList');
    if (!listEl) return;
    const isEs = (navigator.language || '').toLowerCase().startsWith('es');
    if (!items.length) {
        listEl.innerHTML = `
            <div class="profile-match-empty">
                <i class="fas fa-clipboard-list"></i>
                <p>${isEs ? 'Aún no hay partidas verificadas.' : 'No verified matches yet.'}</p>
            </div>`;
        return;
    }
    listEl.innerHTML = items.map((row, i) => {
        const d = new Date(row.at);
        const ds = Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString(isEs ? 'es-ES' : 'en-US', { day: 'numeric', month: 'short', year: 'numeric' });
        const game = row.game ? `<span class="profile-match-game">${_aportesEscapeHtml(row.game)}</span>` : '';
        return `
            <article class="profile-match-row" data-index="${i}">
                <div class="profile-match-type">${_aportesEscapeHtml(row.type || (isEs ? 'Partida' : 'Match'))}</div>
                <div class="profile-match-title">${_aportesEscapeHtml(row.title || (isEs ? 'Sin título' : 'Untitled'))}</div>
                <div class="profile-match-meta"><time datetime="">${ds}</time>${game}</div>
            </article>`;
    }).join('');
}

/**
 * Últimas 5 partidas: misiones con nexusVerifiedComplete + users/{uid}/extraVerifiedMatches (campeonatos, etc.)
 */
function initProfileMatchHistory(profileUserId) {
    if (typeof profileMatchHistoryCleanup === 'function') {
        try { profileMatchHistoryCleanup(); } catch (e) { /* noop */ }
        profileMatchHistoryCleanup = null;
    }
    const listEl = document.getElementById('profileMatchHistoryList');
    const isEs = (navigator.language || '').toLowerCase().startsWith('es');
    if (!listEl || !profileUserId || typeof firebase === 'undefined' || !firebase.database) {
        if (listEl) {
            listEl.innerHTML = `<div class="profile-match-empty"><p>${isEs ? 'No se pudo cargar el historial.' : 'Could not load match history.'}</p></div>`;
        }
        return;
    }

    let missionsSnap = null;
    let extraSnap = null;

    const mergeAndRender = () => {
        const items = [];
        // Los registros permanentes (extraVerifiedMatches) mandan: si ya existe uno
        // con su missionId, no volvemos a agregar la misión viva (evita duplicados).
        const seenMissionIds = {};
        if (extraSnap && extraSnap.exists()) {
            extraSnap.forEach((ch) => {
                const v = ch.val();
                if (v && typeof v.at === 'number' && v.title) {
                    if (v.missionId) seenMissionIds[v.missionId] = true;
                    items.push({
                        at: v.at,
                        title: v.title,
                        type: v.type || (isEs ? 'Torneo / evento' : 'Tournament / event'),
                        game: v.game || ''
                    });
                }
            });
        }
        if (missionsSnap && missionsSnap.exists()) {
            missionsSnap.forEach((ch) => {
                const m = ch.val();
                if (!m || !m.participants || !m.participants[profileUserId] || !m.nexusVerifiedComplete) return;
                if (seenMissionIds[ch.key]) return; // ya está como registro permanente
                items.push({
                    at: typeof m.nexusVerifiedComplete === 'number' ? m.nexusVerifiedComplete : Date.now(),
                    title: m.title || (isEs ? 'Misión' : 'Mission'),
                    type: isEs ? 'Misión Nexus' : 'Nexus Mission',
                    game: m.game || ''
                });
            });
        }
        items.sort((a, b) => b.at - a.at);
        renderProfileMatchHistoryRows(items.slice(0, 5));
    };

    const mRef = firebase.database().ref('missions');
    const mCb = (snap) => { missionsSnap = snap; mergeAndRender(); };
    mRef.on('value', mCb);

    const eRef = firebase.database().ref(`users/${profileUserId}/extraVerifiedMatches`);
    const eCb = (snap) => { extraSnap = snap; mergeAndRender(); };
    eRef.on('value', eCb);

    profileMatchHistoryCleanup = () => {
        mRef.off('value', mCb);
        eRef.off('value', eCb);
    };
}

const BEST_MOMENTS_PREVIEW_COUNT = 2;
let _bestMomentsAll = [];

function _bestMomentCardHtml(m, isEs) {
    const url = _aportesEscapeHtml(m.url || '');
    const isVideo = !!m.isVideo;
    const tag = isVideo ? 'Video' : (isEs ? 'Foto' : 'Photo');
    const media = isVideo
        ? `<video src="${url}" preload="metadata" muted playsinline></video>`
        : `<img src="${url}" alt="Moment" loading="lazy">`;
    const href = m.link ? _aportesEscapeHtml(m.link) : url;
    return `<a class="profile-moment-card" href="${href}" target="_blank" rel="noopener noreferrer">${media}<span class="profile-moment-badge">${tag}</span></a>`;
}

function renderBestMoments(profileUserId, rows) {
    const listEl = document.getElementById('profileBestMomentsList');
    if (!listEl) return;
    const isEs = (navigator.language || '').toLowerCase().startsWith('es');
    _bestMomentsAll = Array.isArray(rows) ? rows.slice() : [];
    if (!_bestMomentsAll.length) {
        listEl.innerHTML = `<div class="profile-moment-empty">${isEs ? 'Aún no hay mejores momentos.' : 'No best moments yet.'}</div>`;
        return;
    }
    const preview = _bestMomentsAll.slice(0, BEST_MOMENTS_PREVIEW_COUNT);
    const extra = _bestMomentsAll.length - preview.length;
    let html = preview.map((m) => _bestMomentCardHtml(m, isEs)).join('');
    if (extra > 0) {
        html += `<button type="button" class="profile-moment-card profile-moment-more" id="profileMomentsMoreBtn" ` +
            `title="${isEs ? 'Ver todos los momentos' : 'View all moments'}" ` +
            `aria-label="${isEs ? 'Ver todos los momentos' : 'View all moments'}">` +
            `<span class="profile-moment-more-plus">+</span>` +
            `<span class="profile-moment-more-count">${extra}</span>` +
            `</button>`;
    }
    listEl.innerHTML = html;
    const moreBtn = document.getElementById('profileMomentsMoreBtn');
    if (moreBtn) moreBtn.addEventListener('click', openBestMomentsGallery);
}

function closeBestMomentsGallery() {
    const overlay = document.getElementById('bestMomentsGalleryOverlay');
    if (overlay) overlay.classList.remove('open');
    document.body.classList.remove('moments-gallery-open');
}

function openBestMomentsGallery() {
    if (!_bestMomentsAll.length) return;
    const isEs = (navigator.language || '').toLowerCase().startsWith('es');
    let overlay = document.getElementById('bestMomentsGalleryOverlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'bestMomentsGalleryOverlay';
        overlay.className = 'moments-gallery-overlay';
        overlay.innerHTML =
            '<div class="moments-gallery-panel" role="dialog" aria-modal="true" aria-label="' +
            (isEs ? 'Todos los momentos' : 'All moments') + '">' +
            '<div class="moments-gallery-head">' +
            '<h3 class="moments-gallery-title"><i class="fas fa-photo-video"></i> <span></span></h3>' +
            '<button type="button" class="moments-gallery-close" aria-label="Cerrar">&times;</button>' +
            '</div>' +
            '<div class="moments-gallery-grid"></div>' +
            '</div>';
        document.body.appendChild(overlay);
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay || e.target.closest('.moments-gallery-close')) closeBestMomentsGallery();
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') closeBestMomentsGallery();
        });
    }
    const titleSpan = overlay.querySelector('.moments-gallery-title span');
    if (titleSpan) {
        titleSpan.textContent = (isEs ? 'Mejores momentos' : 'Best moments') + ' (' + _bestMomentsAll.length + ')';
    }
    const grid = overlay.querySelector('.moments-gallery-grid');
    if (grid) grid.innerHTML = _bestMomentsAll.map((m) => _bestMomentCardHtml(m, isEs)).join('');
    overlay.classList.add('open');
    document.body.classList.add('moments-gallery-open');
}

function initBestMoments(profileUserId) {
    const listEl = document.getElementById('profileBestMomentsList');
    if (!listEl) return;
    if (!profileUserId || typeof firebase === 'undefined' || !firebase.database) {
        renderBestMoments(profileUserId, []);
        return;
    }
    const db = firebase.database();
    Promise.all([
        db.ref('communityImages').orderByChild('timestamp').limitToLast(80).once('value'),
        db.ref(`users/${profileUserId}/bestMoments`).once('value')
    ]).then(([communitySnap, ownSnap]) => {
        const items = [];
        if (communitySnap && communitySnap.exists()) {
            communitySnap.forEach((ch) => {
                const d = ch.val() || {};
                const byOwner = d.userId === profileUserId || d.uid === profileUserId || d.authorId === profileUserId;
                const taggedObj = d.taggedUsers && typeof d.taggedUsers === 'object' ? d.taggedUsers : null;
                const taggedArr = Array.isArray(d.taggedUserIds) ? d.taggedUserIds : [];
                const tagged = (taggedObj && !!taggedObj[profileUserId]) || taggedArr.includes(profileUserId);
                if (!byOwner && !tagged) return;
                const url = d.videoURL || d.videoUrl || d.mediaURL || d.mediaUrl || d.imageURL || d.imageUrl || '';
                if (!url) return;
                const lower = String(url).toLowerCase();
                const isVideo = !!(d.type === 'video' || d.mediaType === 'video' || /\.(mp4|webm|mov)(\?|$)/.test(lower));
                items.push({
                    at: Number(d.timestamp || Date.now()),
                    url,
                    isVideo,
                    link: url
                });
            });
        }
        if (ownSnap && ownSnap.exists()) {
            ownSnap.forEach((ch) => {
                const d = ch.val() || {};
                const url = d.url || d.videoURL || d.imageURL || '';
                if (!url) return;
                const lower = String(url).toLowerCase();
                items.push({
                    at: Number(d.at || d.timestamp || Date.now()),
                    url,
                    isVideo: !!(d.type === 'video' || /\.(mp4|webm|mov)(\?|$)/.test(lower)),
                    link: d.link || url
                });
            });
        }
        items.sort((a, b) => b.at - a.at);
        renderBestMoments(profileUserId, items);
    }).catch(() => renderBestMoments(profileUserId, []));
}

function initBestMomentsUploader(authUser, profileUserId) {
    const addBtn = document.getElementById('addBestMomentBtn');
    const modal = document.getElementById('bestMomentModal');
    const fileInput = document.getElementById('bestMomentFileInput');
    const taggedInput = document.getElementById('bestMomentTaggedInput');
    const captionInput = document.getElementById('bestMomentCaptionInput');
    const saveBtn = document.getElementById('bestMomentSaveBtn');
    const cancelBtn = document.getElementById('bestMomentCancelBtn');
    if (!addBtn || !modal || !saveBtn || !cancelBtn) return;

    const isOwner = !!(authUser && authUser.uid && authUser.uid === profileUserId);
    addBtn.style.display = isOwner ? '' : 'none';
    if (!isOwner) return;

    const open = () => { modal.style.display = 'flex'; };
    const close = () => { modal.style.display = 'none'; };

    addBtn.onclick = open;
    cancelBtn.onclick = close;
    modal.addEventListener('click', (e) => { if (e.target === modal) close(); });

    saveBtn.onclick = async () => {
        if (!fileInput || !fileInput.files || !fileInput.files[0]) {
            showFloatingMessage('error', 'Select an image or video first.');
            return;
        }
        const file = fileInput.files[0];
        const isVideo = String(file.type || '').startsWith('video/');
        const isImage = String(file.type || '').startsWith('image/');
        if (!isVideo && !isImage) {
            showFloatingMessage('error', 'File must be image or video.');
            return;
        }
        saveBtn.disabled = true;
        const originalText = saveBtn.textContent;
        saveBtn.textContent = 'Uploading...';
        try {
            const storageRef = firebase.storage().ref(`best_moments/${authUser.uid}/${Date.now()}_${file.name}`);
            const snap = await storageRef.put(file);
            const downloadURL = await snap.ref.getDownloadURL();
            const taggedUserIds = String((taggedInput && taggedInput.value) || '')
                .split(',')
                .map((s) => s.trim())
                .filter((s) => !!s);
            const payload = {
                userId: authUser.uid,
                imageURL: isImage ? downloadURL : '',
                videoURL: isVideo ? downloadURL : '',
                mediaURL: downloadURL,
                mediaType: isVideo ? 'video' : 'image',
                title: (captionInput && captionInput.value ? captionInput.value.trim().slice(0, 120) : ''),
                taggedUserIds: taggedUserIds,
                timestamp: Date.now()
            };

            await firebase.database().ref('communityImages').push(payload);
            await firebase.database().ref(`users/${authUser.uid}/bestMoments`).push({
                at: payload.timestamp,
                url: downloadURL,
                type: payload.mediaType,
                caption: payload.title || '',
                taggedUserIds: taggedUserIds
            });
            showFloatingMessage('success', 'Moment uploaded successfully.');
            if (fileInput) fileInput.value = '';
            if (taggedInput) taggedInput.value = '';
            if (captionInput) captionInput.value = '';
            close();
            initBestMoments(profileUserId);
        } catch (e) {
            console.error('Error uploading best moment:', e);
            showFloatingMessage('error', 'Could not upload moment.');
        } finally {
            saveBtn.disabled = false;
            saveBtn.textContent = originalText;
        }
    };
}
// ======== END CONTRIBUTIONS / MATCH HISTORY ========

async function registerProfileVisit(viewerUser, viewedProfileId, viewerProfileData) {
    if (!viewerUser || !viewerUser.uid || !viewedProfileId) return;
    if (viewerUser.uid === viewedProfileId) return;
    if (typeof firebase === 'undefined' || !firebase.database) return;
    try {
        const db = firebase.database();
        const nick = (viewerProfileData && (viewerProfileData.nick || viewerProfileData.nickname))
            || viewerUser.displayName
            || (viewerUser.email ? String(viewerUser.email).split('@')[0] : 'User');
        const photo = getPreferredAvatarFromUserData(viewerProfileData, viewerUser.photoURL || '');
        const visitedAt = Date.now();

        await db.ref(`users/${viewedProfileId}/profileVisitors/${viewerUser.uid}`).set({
            visitorUid: viewerUser.uid,
            nick: String(nick || 'User').slice(0, 40),
            photoURL: photo || '',
            visitedAt: visitedAt
        });

        // Anti-spam: only push one explicit notification per viewer every 12 hours.
        const gateRef = db.ref(`users/${viewedProfileId}/profileVisitNoticeGate/${viewerUser.uid}`);
        const gateSnap = await gateRef.once('value');
        const lastNotified = Number(gateSnap.val() || 0);
        const cooldownMs = 12 * 60 * 60 * 1000;
        if (!lastNotified || (visitedAt - lastNotified) >= cooldownMs) {
            await db.ref(`users/${viewedProfileId}/notifications`).push({
                text: `${String(nick || 'Someone')} visited your profile`,
                icon: '👀',
                link: `/dashboard?uid=${viewerUser.uid}`,
                read: false,
                timestamp: visitedAt,
                type: 'profile_visit'
            });
            await gateRef.set(visitedAt);
        }
    } catch (e) {
        console.warn('Profile visit tracking failed:', e);
    }
}

// ======== LÓGICA STEAM: Vincula tu cuenta, persistencia Firebase, redirección ========

// Un SteamID64 son exactamente 17 dígitos. Un personaname suelto o un objeto
// steam a medias no prueban nada, así que solo este identificador cuenta como
// cuenta vinculada de verdad.
function extractSteamId64(userData) {
  if (!userData || typeof userData !== 'object') return '';
  const raw = (userData.steamID != null && userData.steamID !== '')
    ? userData.steamID
    : (userData.steam && userData.steam.steamid != null ? userData.steam.steamid : '');
  const id = String(raw || '').trim();
  return /^\d{17}$/.test(id) ? id : '';
}

// Guarda steam en users/{uid}/steam Y el índice users/{uid}/steamID (necesario para login con Steam).
// Las reglas dejan escribir users/{otroUid} a los rangos de mando, así que la
// escritura se ancla al usuario autenticado: vincular Steam siempre es una
// acción sobre la propia cuenta, nunca sobre el perfil que se está visitando.
async function persistSteamLink(uid, steamData) {
  if (!uid || !steamData || typeof firebase === 'undefined') return;
  const authUser = firebase.auth().currentUser;
  if (!authUser || authUser.uid !== uid) return;
  const steamId = extractSteamId64({ steam: steamData });
  if (!steamId) return;
  await firebase.database().ref('users/' + uid).update({ steam: steamData, steamID: steamId });
}

async function userHasSteamLinked(uid) {
  if (!uid || typeof firebase === 'undefined') return false;
  try {
    const snap = await firebase.database().ref('users/' + uid).once('value');
    return !!extractSteamId64(snap.val());
  } catch (e) {
    return false;
  }
}

async function updateSteamUI(user, isViewingOwnProfile, profileUserId, profileUserData) {
  const steamStatusBadge = document.getElementById('steamStatusBadge');
  const steamStatusText = document.getElementById('steamStatusText');
  const steamMissingAlert = document.getElementById('steamMissingAlert');

  // 1. Si hay ?steam= en URL (callback de vinculación), guardar y limpiar
  const urlParams = new URLSearchParams(window.location.search);
  const steamParam = urlParams.get('steam');
  if (steamParam && isViewingOwnProfile && user) {
    try {
      const decoded = JSON.parse(atob(steamParam));
      if (decoded.steamid || decoded.personaname) {
        localStorage.setItem('usuario_steam', JSON.stringify(decoded));
        await persistSteamLink(user.uid, decoded);
        window.history.replaceState({}, '', window.location.pathname + (window.location.hash || ''));
      }
    } catch (e) { console.warn('Error parsing steam param:', e); }
  }

  // 2. Steam del perfil que se está viendo (nunca mezclar con localStorage en perfiles ajenos)
  let steamData = null;
  if (isViewingOwnProfile) {
    try {
      const local = localStorage.getItem('usuario_steam');
      if (local) steamData = JSON.parse(local);
    } catch (e) {}
  }

  // El sello se decide únicamente con el registro del perfil visitado leído de
  // la base de datos, para que la sesión del visitante no pinte nunca el estado
  // de Steam de otra cuenta.
  let profileRecord = profileUserData || null;
  if (!profileRecord && profileUserId && typeof firebase !== 'undefined') {
    try {
      const snap = await firebase.database().ref(`users/${profileUserId}`).once('value');
      profileRecord = snap.val();
    } catch (e) {}
  }
  const profileSteamId = extractSteamId64(profileRecord);
  if (profileSteamId && profileRecord.steam) {
    steamData = profileRecord.steam;
    if (isViewingOwnProfile && user && profileUserId === user.uid) {
      try { localStorage.setItem('usuario_steam', JSON.stringify(profileRecord.steam)); } catch (e) {}
    }
  }

  // 3. Persistir a Firebase si tenemos en localStorage y es perfil propio (+ índice steamID)
  if (steamData && isViewingOwnProfile && user && typeof firebase !== 'undefined') {
    try {
      await persistSteamLink(user.uid, steamData);
    } catch (e) {}
  }

  // 4. Actualizar badge y alerta: solo mostrar "Vincula tu cuenta" cuando es perfil propio y NO hay Steam
  // En el perfil propio también cuenta la vinculación recién hecha en este
  // mismo paso, que todavía no estaba en el registro leído al abrir la página.
  const ownSteamId = (isViewingOwnProfile && user) ? extractSteamId64({ steam: steamData }) : '';
  const hasSteam = !!(profileSteamId || ownSteamId);
  if (steamStatusBadge) {
    // En un perfil ajeno el sello solo existe si la vinculación es real; el
    // aviso rojo de "No vinculado" es una llamada a la acción para el dueño.
    steamStatusBadge.style.display = (hasSteam || isViewingOwnProfile) ? '' : 'none';
    steamStatusBadge.classList.toggle('disconnected', !hasSteam);
    steamStatusBadge.title = hasSteam ? 'Steam vinculado' : 'No vinculado';
    if (steamStatusText) steamStatusText.innerText = hasSteam ? 'Steam vinculado' : 'No vinculado';
  }
  if (steamMissingAlert) {
    steamMissingAlert.style.display = (isViewingOwnProfile && !hasSteam) ? 'flex' : 'none';
  }

  // 5. Aplicar datos Steam a foto, nickname, país (solo si tenemos steam y es perfil propio)
  if (hasSteam && isViewingOwnProfile && steamData) {
    const picEl = document.getElementById('profilePic');
    if (picEl && steamData.avatarfull) {
      picEl.src = steamData.avatarfull;
      picEl.classList.remove('skeleton');
      picEl.style.border = '2px solid #4caf50';
    }
    const nameEl = document.getElementById('profileNickname');
    if (nameEl && steamData.personaname) {
      nameEl.innerText = steamData.personaname;
      nameEl.classList.remove('skeleton');
    }
    if (steamData.loccountrycode) {
      const cf = document.getElementById('countryFlag');
      if (cf) { cf.textContent = steamData.loccountrycode; cf.classList.remove('skeleton'); }
    }
    try {
      const preferredAvatar = steamData.avatarfull || steamData.avatarmedium || steamData.avatar || '';
      if (preferredAvatar && user) {
        await firebase.database().ref(`users/${user.uid}`).update({
          photoURL: preferredAvatar,
          avatarSource: 'steam',
          preferSteamAvatar: true
        });
        if (typeof user.updateProfile === 'function') {
          await user.updateProfile({ photoURL: preferredAvatar });
        }
      }
    } catch (e) {
      console.warn('Could not sync Steam avatar as primary:', e);
    }
  }

  // 6. Actualizar href del botón VINCULAR con uid para que el backend pueda vincular
  if (isViewingOwnProfile && user) {
    const steamBtn = document.getElementById('steamLinkBtn');
    if (steamBtn) steamBtn.dataset.href = '/steam_login.php?intent=link';
  }

  // 7. Recuadro de estadísticas de CS2 (K/D + última partida) vía Steam
  try { loadCs2StatsCard(profileUserId, hasSteam, profileRecord); } catch (e) { console.warn('CS2 card:', e); }

  // 8. Logout: se unifica en la función global logout() más abajo
}

// Rellena el recuadro de CS2 llamando a la Cloud Function getSteamCs2Stats.
function setCs2Text(id, val) { const el = document.getElementById(id); if (el) el.textContent = val; }

function applyCs2SummaryToCard(d) {
  const body = document.getElementById('cs2StatsBody');
  const msg = document.getElementById('cs2StatsMsg');
  if (!d || !d.available) {
    if (body) body.style.display = 'none';
    if (msg) { msg.style.display = 'block'; msg.textContent = (d && d.message) ? d.message : 'Estadísticas de CS2 no disponibles.'; }
    return;
  }
  if (body) body.style.display = 'flex';
  if (msg) msg.style.display = 'none';
  setCs2Text('cs2KdText', (d.kd != null ? d.kd : '-'));
  setCs2Text('cs2WinsText', (d.wins != null ? Number(d.wins).toLocaleString() : '-'));
  const lm = d.lastMatch || {};
  const resultEl = document.getElementById('cs2LastMatchResult');
  const lastWrap = document.getElementById('cs2LastMatchWrap');
  if (lm && lm.available && lm.result && lm.result !== 'unknown') {
    if (lastWrap) lastWrap.style.display = 'flex';
    if (resultEl) {
      resultEl.className = 'cs2-last-badge ' + lm.result;
      resultEl.textContent = 'Última: ' + (lm.result === 'win' ? 'Ganó' : (lm.result === 'loss' ? 'Perdió' : 'Empate'));
    }
    setCs2Text('cs2LastKdText', (lm.kd != null ? lm.kd : '-'));
  } else if (lastWrap) {
    lastWrap.style.display = 'none';
  }
}

async function loadCs2StatsCard(profileUserId, hasSteam, profileUserData) {
  const card = document.getElementById('cs2StatsCard');
  const section = document.getElementById('aportesSection');
  if (!card) return;

  const ownerHasSteam = !!extractSteamId64(profileUserData);
  if (!ownerHasSteam || !profileUserId || typeof firebase === 'undefined' || !firebase.functions) {
    card.style.display = 'none';
    if (section) section.classList.add('profile-cs2-unavailable');
    return;
  }
  card.style.display = '';
  if (section) section.classList.remove('profile-cs2-unavailable');

  const cachedSummary = profileUserData && profileUserData.cs2Stats && profileUserData.cs2Stats.summary;
  if (cachedSummary && cachedSummary.available) {
    applyCs2SummaryToCard(cachedSummary);
  } else {
    setCs2Text('cs2KdText', '...');
    setCs2Text('cs2WinsText', '...');
  }

  try {
    const fn = firebase.functions().httpsCallable('getSteamCs2Stats');
    const res = await fn({ uid: profileUserId });
    const d = (res && res.data) ? res.data : {};
    applyCs2SummaryToCard(d);
  } catch (e) {
    console.warn('No se pudieron cargar stats CS2:', e);
    if (!cachedSummary || !cachedSummary.available) {
      const body = document.getElementById('cs2StatsBody');
      const msg = document.getElementById('cs2StatsMsg');
      if (body) body.style.display = 'none';
      if (msg) { msg.style.display = 'block'; msg.textContent = 'No se pudieron cargar las estadísticas de CS2.'; }
    }
  }
}
// ======== FIN LÓGICA STEAM ========

// Parse URL parameters to check if viewing another user's profile
function getURLParameter(name) {
  // ... (Se mantiene igual)
  const urlParams = new URLSearchParams(window.location.search);
  return urlParams.get(name);
}

// Navigation function (global scope for onclick access)
window.navigateToProfile = function (userId) {
  // ... (Se mantiene igual)
  if (userId) {
    window.location.href = `/dashboard?uid=${userId}`;
  }
};

// Check if viewing another user's profile
const viewingUserId = getURLParameter('uid');
let isViewingOwnProfile = true;
let isViewingAsCommander = false;

// ================== LÓGICA PARA USAR TOKENS (VARIABLE GLOBAL) ==================
// Se define aquí para que esté disponible en el listener de abajo.
let useTokenForAction = async () => { 
  showFloatingMessage("error", "Error: La función de token no se ha inicializado correctamente.");
};

document.addEventListener("DOMContentLoaded", function () {
  const brandingEl = document.querySelector('.branding');
  if (brandingEl) {
    brandingEl.addEventListener('click', function () { window.location.href = 'https://studiosgamesrs.com/home/'; });
  }

  // Check if Firebase is available
  if (typeof firebase === 'undefined') {
    // Demo mode
    return;
  }

  firebase.auth().onAuthStateChanged(async user => {
    try {
      if (!user) {
        window.location.href = "/login";
        return;
      }

      // === COMMANDER PANEL IS TOP AUTHORITY: blocked users cannot use the site ===
      const blockedSnap = await firebase.database().ref('users/' + user.uid + '/blocked').once('value');
      if (blockedSnap.val() === true) {
        await firebase.auth().signOut();
        window.location.href = "/login?blocked=1";
        return;
      }

      // === NUEVO GUARDIA DE SEGURIDAD VIP (SOFT GATING) ===
      if (!user.emailVerified) {
        try {
            const hasSteamAccount = await userHasSteamLinked(user.uid);
            
            if (hasSteamAccount) {
                console.log("🛡️ Usuario Steam detectado. Activando modo restringido (Soft Gating).");
                
                // --- INICIO NUEVO: AUTO-RESUME DESPUÉS DE RE-AUTENTICAR ---
                const pendingEmail = localStorage.getItem('pending_steam_email');
                if (pendingEmail && !user.email) {
                    console.log("Intentando auto-vincular email tras sesión fresca...");
                    user.verifyBeforeUpdateEmail(pendingEmail).then(() => {
                        alert("¡Sesión recargada con éxito!\n\nFirebase acaba de enviar el correo de seguridad a " + pendingEmail + ".\n\nVe a tu bandeja, haz clic en el enlace y luego recarga esta página.");
                        localStorage.removeItem('pending_steam_email'); // Limpiamos
                    }).catch(err => {
                        console.error("Error en auto-resume:", err);
                        localStorage.removeItem('pending_steam_email');
                    });
                }
                // --- FIN NUEVO ---

                activarModoRestringido(user);
            } else {
                console.log("⛔ Usuario sin verificar detectado. Expulsando...");
                await firebase.auth().signOut();
                window.location.href = "/login";
                return;
            }
        } catch (error) {
            console.error("Error al validar el nivel de confianza: ", error);
        }
      } else {
          // El usuario está verificado. Actualizamos el UI si es su propio perfil.
          if (!viewingUserId || viewingUserId === user.uid) {
              setTimeout(() => {
                const statusBadge = document.getElementById('verifiedStatusBadge');
                if (statusBadge) {
                  statusBadge.classList.remove('not-verified');
                  statusBadge.classList.add('verified');
                  statusBadge.innerHTML = '<i class="fas fa-check-circle"></i><span class="account-badge-text" aria-hidden="true">Verificado</span>';
                  statusBadge.title = 'Verificado';
                }
              }, 500); // Pequeño delay para asegurar que el DOM cargó
          }
      }
      // === FIN NUEVO GUARDIA DE SEGURIDAD ===

      // ... el resto del código continúa igual a partir de aquí

      const profileUserId = viewingUserId || user.uid;
      isViewingOwnProfile = profileUserId === user.uid;
      updateProfileViewMode();
      const competitiveWidget = document.getElementById('competitiveWidget');
      const dashboardSideModules = document.getElementById('dashboardSideModules');
      const playZoneWidget = document.getElementById('playZoneWidget'); // Obtener el nuevo widget

      const unifiedPanel = document.getElementById('unifiedCommandPanel');
      if (isViewingOwnProfile) {
        if (competitiveWidget) competitiveWidget.style.display = 'flex';
        if (dashboardSideModules) dashboardSideModules.style.display = 'flex';
        if (unifiedPanel) unifiedPanel.style.display = 'flex';
        initDashboardWidgetCollapsibles();
        loadDashboardFriendsList(user.uid);
      } else {
        if (playZoneWidget) playZoneWidget.style.display = 'none';
        if (dashboardSideModules) dashboardSideModules.style.display = 'none';
        if (unifiedPanel) unifiedPanel.style.display = 'none';
      }
      
      // =====> ¡AQUÍ ESTÁ LA INTEGRACIÓN CLAVE! <=====
      // Llama a las nuevas funciones de escucha.
      listenForCompetitiveData(profileUserId);
      
      // --- MODIFICACIÓN CLAVE: Cargar datos del usuario actual y PlayZone ---
      currentUserData = null; // Reiniciar
      window.currentUserData = null;
      let currentUserRank = 'tribal_warrior';
      let currentUserPermissions = getPermisosRango(currentUserRank);
      try {
        const currentUserRef = firebase.database().ref(`users/${user.uid}`);
        const currentUserSnapshot = await currentUserRef.once('value');
        currentUserData = currentUserSnapshot.val() || {}; // Asignar al global (usar {} si es null)
        currentUserData.uid = user.uid; // Para shared-header (Carta de Jugador, etc.)
        window.currentUserData = currentUserData;
        // SIMULACIÓN: Añadir bandera de PlayZone para la prueba
        currentUserData.hasUsedPlayZone = currentUserData.hasUsedPlayZone || false; 
        // AÑADIDO: Asegurar que el campo de onboarding exista
        // *** IMPORTANTE: CAMBIAR A 'true' EN PRODUCCIÓN PARA DESBLOQUEAR PLAYZONE SI YA LO USÓ ***
        currentUserData.playZoneOnboardingComplete = currentUserData.playZoneOnboardingComplete || false; 
        
        currentUserRank = currentUserData?.rango || 'tribal_warrior';
        currentUserPermissions = getPermisosRango(currentUserRank);
        if (isViewingOwnProfile) {
          listenDashboardFriendRequests(user.uid, currentUserData);
          updateDashboardFriendsBadge(currentUserData);
          renderDashboardFriendRequests(currentUserData);
        }
        updateCommanderPanelButton(currentUserRank);
        if (user && user.uid) {
          /* Tribunal overlay se inicializa vía shared-header (bootAuth) */
        }
      } catch (error) {
        console.error("Error al cargar datos del usuario actual:", error);
      }
      isViewingAsCommander = currentUserPermissions.accesoTotal;
      
      if (isViewingOwnProfile) {
          listenForPlayZoneData(profileUserId);
          registerUserReferralCode(user.uid);
      }
      // =============================================

      const dashboardReturnBtn = document.getElementById('dashboardReturnBtn');
      if (dashboardReturnBtn) {
        dashboardReturnBtn.style.display = isViewingOwnProfile ? 'none' : 'inline-block';
      }
      const floatingGlobalChatBtn = document.getElementById('floatingGlobalChatButton');
      if (floatingGlobalChatBtn) floatingGlobalChatBtn.style.display = isViewingOwnProfile ? 'flex' : 'none';

      initializeWidget(currentUserData); // Inicializa el nuevo widget
      if (isViewingOwnProfile) initializeGlobalChatButton();
      maybeOpenDashboardDmFromUrl();
      if (typeof initBattleCallListenerDashboard === 'function') initBattleCallListenerDashboard();
      if (typeof initPresenceDashboard === 'function') initPresenceDashboard();

      // ================== LÓGICA PARA USAR TOKENS (VERSIÓN CORREGIDA CON FETCH v4 - Syntax Fix Definitivo) ==================
      /**
       * Llama a la Cloud Function usando fetch y el token de autorización manual.
       */
      useTokenForAction = async function() {
        const useTokenBtn = document.getElementById('useTokenBtn');
        // Asegúrate que 'user' (definido en onAuthStateChanged) esté disponible
        if (!useTokenBtn || typeof user === 'undefined' || !user) {
            console.error("Botón o usuario no disponible para useTokenForAction.");
            showFloatingMessage("error", "Error: No se pudo iniciar la acción. Refresca la página.");
            return;
        }

        // Deshabilitar el botón para evitar clics múltiples
        useTokenBtn.disabled = true;
        useTokenBtn.textContent = 'Procesando...';

        try { // <<<--- INICIO DEL TRY PRINCIPAL
          // 1. Obtenemos el token de autenticación del usuario actual.
          const idToken = await user.getIdToken();

          // 2. Usamos 'fetch' para llamar a la URL directa de la Cloud Function.
          const functionUrl = 'https://us-central1-studiosgamesrs.cloudfunctions.net/useTokenForAction';

          const response = await fetch(functionUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              // 3. Añadimos la cabecera de autorización.
              'Authorization': `Bearer ${idToken}`
            }, // <<<--- COMA IMPORTANTE
            // 4. Añadimos el cuerpo esperado por las funciones onCall
            body: JSON.stringify({ data: {} })
          }); // <<<--- FIN DE LAS OPCIONES DEL FETCH

          // 5. Procesamos la respuesta del servidor.
          // Cualquier error aquí (incluido si la respuesta no es JSON)
          // será capturado por el bloque catch principal.
          let result = await response.json();

          // 6. Verificamos si la respuesta HTTP fue exitosa (status 2xx)
          if (!response.ok) {
            // Si no fue OK, buscamos el mensaje de error devuelto por la función onCall
            const errorMessage = result?.error?.message || result.error || `Error del servidor (Status: ${response.status})`;
            throw new Error(errorMessage); // Lanza al catch principal
          }

          // 7. Si fue OK, accedemos al resultado real (envuelto en 'result' por onCall)
          const functionResult = result.result;
          if (!functionResult || !functionResult.success) {
            // Si la función devolvió un error lógico interno
             throw new Error(functionResult?.message || 'La función indicó un error inesperado.'); // Lanza al catch principal
          }

          // 8. Mostramos el mensaje de éxito
          showFloatingMessage("success", functionResult.message || "¡Token usado exitosamente!");

          // Opcional: Actualizar UI con tokens restantes
          if (functionResult.remainingTokens !== undefined) {
            const tokensValue = document.getElementById('tokensValue');
            if (tokensValue) {
              tokensValue.textContent = functionResult.remainingTokens;
              tokensValue.style.color = functionResult.remainingTokens === 0 ? "#ff2222" : "#58f658";
              // Refresca los datos del usuario localmente
              if (typeof currentUserData !== 'undefined' && currentUserData) {
                  currentUserData.tokens = functionResult.remainingTokens;
              }
            }
          }

          console.log("Respuesta de la Cloud Function:", functionResult);

        } catch (error) { // <<<--- INICIO DEL CATCH PRINCIPAL
          // 9. Manejamos CUALQUIER error que ocurra en el bloque try.
          console.error("Error al llamar a la Cloud Function 'useTokenForAction':", error);
          showFloatingMessage("error", `Error: ${error.message}`);
        } finally { // <<<--- INICIO DEL FINALLY PRINCIPAL
          // 10. Reactivamos el botón (se ejecuta siempre, haya error o no).
      useTokenBtn.disabled = false;
      useTokenBtn.textContent = 'Usar Token';
    } // <<<--- FIN DEL FINALLY PRINCIPAL
  }
  // ================== FIN DE LÓGICA DE TOKENS ==================

  // =====> ¡ESTE ES EL CÓDIGO CORREGIDO QUE FALTABA! <=====
  // Asigna la función 'useTokenForAction' al clic del botón
  const useTokenBtn = document.getElementById('useTokenBtn');
  if (useTokenBtn) {
      useTokenBtn.addEventListener('click', useTokenForAction);
  }
  // ===============================================

  const lang = navigator.language.startsWith('es') ? 'es' : 'en';
  const t = getTranslations(lang);

      const subtitle = document.querySelector('.dashboard-subtitle');
      if (subtitle) {
        subtitle.textContent = isViewingOwnProfile ?
          (lang === "es" ? "/ Dashboard del usuario" : "/ User Dashboard") :
          (lang === "es" ? "/ Perfil de usuario" : "/ User Profile");
      }
      setQueryTextIfExists('.logout-btn', t.logout);
      setQueryTextIfExists('.back-button', t.backHome);
      setTextIfExists('communityCardTitle', lang === 'es' ? 'Comunidad' : 'Community');
      setTextIfExists('rankCardTitle', lang === 'es' ? 'Rango' : 'Rank');
      setTextIfExists('latestMatchesTitle', lang === 'es' ? 'Últimas partidas verificadas' : 'Latest Verified Matches');
      setTextIfExists('contributionsTitle', lang === 'es' ? 'Aportes' : 'Contributions');
      setTextIfExists('contributionsHint', lang === 'es'
        ? 'Veces que este jugador ayudó en una Llamada a batalla de Comunidad (Consejo de Guerra / Al toque de corneta).'
        : 'Times this player helped in a Community battle call (War Council / trumpet call).');
      setTextIfExists('trumpetHelpsLabel', lang === 'es' ? 'Ayudas en Llamadas a batalla' : 'Battle call helps');
      setTextIfExists('tokensLabel', lang === 'es' ? 'TOKENS' : 'TOKENS');
      setTextIfExists('referralsLabel', lang === 'es' ? 'REFERIDOS' : 'REFERRALS');
      const tokensHelpLink = document.getElementById('tokensHelp');
      if (tokensHelpLink) tokensHelpLink.title = lang === 'es' ? '¿Qué son los Tokens?' : 'What are Tokens?';
      setTextIfExists('bestMomentsTitle', lang === 'es' ? 'Mejores momentos' : 'Best Moments');
      setTextIfExists('profilePanelTabMomentsLabel', lang === 'es' ? 'Mejores momentos' : 'Best moments');
      setTextIfExists('profilePanelTabStatsLabel', lang === 'es' ? 'Estadísticas' : 'Statistics');
      setTextIfExists('bestMomentModalTitle', lang === 'es' ? 'Agregar mejor momento' : 'Add best moment');
      setTextIfExists('bestMomentModalHint', lang === 'es'
        ? 'Sube foto/video y etiqueta jugadores por UID opcionalmente.'
        : 'Upload image/video and optionally tag players by UID.');
      setTextIfExists('addBestMomentBtn', lang === 'es' ? '+ Agregar' : '+ Add');
      const bestMomentTaggedInput = document.getElementById('bestMomentTaggedInput');
      if (bestMomentTaggedInput) bestMomentTaggedInput.placeholder = lang === 'es'
        ? 'UIDs etiquetados (separados por coma)'
        : 'Tagged user UIDs (comma separated)';
      const bestMomentCaptionInput = document.getElementById('bestMomentCaptionInput');
      if (bestMomentCaptionInput) bestMomentCaptionInput.placeholder = lang === 'es'
        ? 'Descripción (opcional)'
        : 'Caption (optional)';
      setTextIfExists('bestMomentCancelBtn', lang === 'es' ? 'Cancelar' : 'Cancel');
      setTextIfExists('bestMomentSaveBtn', lang === 'es' ? 'Subir' : 'Upload');

      const verifiedBadge = document.getElementById('verifiedStatusBadge');
      if (verifiedBadge) {
        if (isViewingOwnProfile) {
          const span = verifiedBadge.querySelector('span');
          if (span) span.textContent = user.emailVerified ? t.verified : t.notVerified;
          verifiedBadge.title = user.emailVerified ? t.verified : t.notVerified;
          verifiedBadge.classList.toggle('verified', !!user.emailVerified);
          verifiedBadge.classList.toggle('not-verified', !user.emailVerified);
          verifiedBadge.style.display = '';
        } else {
          verifiedBadge.style.display = 'none';
        }
      }

      let profileUserData = null;
      try {
        const profileUserRef = firebase.database().ref(`users/${profileUserId}`);
        const profileSnapshot = await profileUserRef.once('value');
        profileUserData = profileSnapshot.val();
      } catch (error) {
        console.error("Error al cargar el perfil de usuario:", error);
        document.querySelector('.profile-card').innerHTML = '<p style="color: #f55; text-align: center;">Error al cargar perfil.</p>';
      }

      if (!isViewingOwnProfile && !profileUserData) {
        document.querySelector('.profile-card').innerHTML = '<p style="color: #f55; text-align: center;">User not found</p>';
        return;
      }

      if (!isViewingOwnProfile) {
        registerProfileVisit(user, profileUserId, currentUserData);
      }
      
      // ======== Paneles del perfil: momentos/aportes + CS2/partidas ========
      initProfileMatchHistory(profileUserId);
      displayRecognitions(profileUserData);
      initBestMoments(profileUserId);
      if (isViewingOwnProfile) {
        initBestMomentsUploader(user, profileUserId);
      } else {
        const addMomentBtn = document.getElementById('addBestMomentBtn');
        if (addMomentBtn) addMomentBtn.style.display = 'none';
      }
      initProfilePanelTabs(profileUserId, profileUserData);
      updateProfileViewMode();
      initializeProfileSocialActions(profileUserId, profileUserData);

      const profilePic = document.getElementById("profilePic");
      if (profilePic) {
        profilePic.src = getPreferredAvatarFromUserData(
          isViewingOwnProfile ? currentUserData : profileUserData,
          (isViewingOwnProfile ? user.photoURL : profileUserData?.photoURL) || DEFAULT_PROFILE_IMAGE
        );
        profilePic.onload = () => removeSkeleton(profilePic);
        profilePic.onerror = () => {
          removeSkeleton(profilePic);
          profilePic.src = DEFAULT_PROFILE_IMAGE;
        };
      }

      const profileNickname = document.getElementById("profileNickname");
      if (profileNickname) {
        profileNickname.textContent = profileUserData?.nick || (isViewingOwnProfile ? (user.displayName || user.email?.split('@')[0]) : "User");
        removeSkeleton(profileNickname);
      }

      // Steam: persistencia Firebase, alerta "Vincula tu cuenta" (solo si Email/Google sin Steam), aplicación de datos
      await updateSteamUI(user, isViewingOwnProfile, profileUserId, profileUserData);
      
      if (typeof initializeNicknameEditing === 'function' && (isViewingOwnProfile || isViewingAsCommander)) {
          initializeNicknameEditing(isViewingOwnProfile ? user : { uid: profileUserId }, isViewingOwnProfile ? currentUserData : profileUserData);
      } else {
          const editBtn = document.getElementById("nicknameEditBtn");
          if (editBtn) editBtn.style.display = 'none';
      }
      
      if (typeof initializeProfilePhotoManagement === 'function' && (isViewingOwnProfile || isViewingAsCommander)) {
          initializeProfilePhotoManagement(isViewingOwnProfile ? user : { uid: profileUserId }, isViewingOwnProfile ? currentUserData : profileUserData);
      }

      // Frase de estado eliminada por diseño.

      // Mostrar rango de comunidad (Commander, Divisional Commander, Tribal Warrior)
      const rangoDisplay = document.getElementById('userRangoDisplay');
      if (rangoDisplay) {
          const rango = profileUserData?.rango || 'tribal_warrior';
          const rangoNames = { commander: 'Commander', divisional_commander: 'Divisional Commander', tribal_warrior: 'Tribal Warrior' };
          rangoDisplay.textContent = rangoNames[rango.toLowerCase()] || rango;
      }
      const rankAndLevelCard = document.getElementById('rankAndLevelCard');
      if (rankAndLevelCard) {
          rankAndLevelCard.classList.remove('rank-commander', 'rank-divisional_commander', 'rank-tribal_warrior');
          const rk = String(profileUserData?.rango || 'tribal_warrior').toLowerCase();
          if (rk === 'commander' || rk === 'divisional_commander' || rk === 'tribal_warrior') {
              rankAndLevelCard.classList.add('rank-' + rk);
          }
      }

      const favoriteGameText = document.getElementById('favoriteGameText');
      if (favoriteGameText) {
          const mainGame = profileUserData?.mainGame || profileUserData?.profile?.mainGame || 'N/A';
          favoriteGameText.textContent = mainGame;
      }

      loadAndRenderProfileBadges(profileUserId, isViewingOwnProfile ? currentUserData : profileUserData);
      setTimeout(function() {
        loadAndRenderProfileBadges(profileUserId, isViewingOwnProfile ? currentUserData : profileUserData);
      }, 800);

      const honorText = document.getElementById('communityHonorText');
      if (honorText) {
          const honorValue = Number(profileUserData?.communityHonor || 0);
          motionCountUp(honorText, honorValue);
      }

      const globalRankPositionText = document.getElementById('globalRankPositionText');
      if (globalRankPositionText && typeof firebase !== 'undefined' && firebase.database) {
          globalRankPositionText.textContent = '#...';
          // PZ-017: el ranking de honor se calcula sobre publicProfiles, no sobre users.
          firebase.database().ref('publicProfiles').orderByChild('communityHonor').once('value').then(function(allSnap) {
              var list = [];
              allSnap.forEach(function(child) {
                  var v = child.val() || {};
                  list.push({ uid: child.key, honor: Number(v.communityHonor || 0) });
              });
              list.sort(function(a, b) { return b.honor - a.honor; });
              var pos = list.findIndex(function(it) { return it.uid === profileUserId; });
              globalRankPositionText.textContent = pos >= 0 ? ('#' + (pos + 1)) : '#-';
          }).catch(function() {
              globalRankPositionText.textContent = '#-';
          });
      }

      // Profile customization (frames, backgrounds, "View as another user", customize button, dashboard theme)
      if (typeof initProfileCustomization === 'function') {
          initProfileCustomization(profileUserId, profileUserData, isViewingOwnProfile, typeof firebase !== 'undefined' ? firebase.database() : null, user ? user.uid : null);
      }

      // ... el resto de tu código de onAuthStateChanged ...
       // (El resto del código desde la línea 1315 hasta el final es el mismo que tenías y no necesita cambios)
      
      // Get country information independently - with error handling
    // ============================================================
    // VISUALIZACIÓN DE BANDERAS (AUTOMÁTICA UNIVERSAL)
    // ============================================================
    try {
        const countryFlagElement = document.getElementById("countryFlag");
        
        if (countryFlagElement) {
            // 1. OBTENER DATOS DEL USUARIO
            let datosUsuario = null;
            if (typeof isViewingOwnProfile !== 'undefined' && isViewingOwnProfile) {
                datosUsuario = (typeof currentUserData !== 'undefined') ? currentUserData : null;
            } else {
                datosUsuario = (typeof profileUserData !== 'undefined') ? profileUserData : ((typeof userData !== 'undefined') ? userData : null);
            }

            // 2. OBTENER CÓDIGO LIMPIO
            let countryCode = "UNK";
            let displayName = "Desconocido";

            if (datosUsuario && datosUsuario.country) {
                // Quitamos espacios y aseguramos mayúsculas
                let raw = datosUsuario.country.trim().toUpperCase();
                
                // Correcciones de nombres antiguos (por si quedaron usuarios viejos)
                const legacyFixes = { "VENEZUELA": "VE", "USA": "US", "EEUU": "US", "RUSSIA": "RU", "RUSIA": "RU" };
                if (legacyFixes[raw]) raw = legacyFixes[raw];

                // Si tiene 2 letras, asumimos que es código ISO válido
                if (raw.length === 2) {
                    countryCode = raw;
                } else {
                    // Si no son 2 letras, lo mostramos como texto
                    displayName = datosUsuario.country;
                }
            }

            // 3. TRADUCTOR AUTOMÁTICO DE NOMBRES (La Magia)
            if (countryCode !== "UNK") {
                try {
                    // Esto usa el diccionario interno del navegador para traducir "RU" -> "Rusia"
                    // Detectamos el idioma preferido del usuario o forzamos español
                    const lang = localStorage.getItem('lang') || 'es'; 
                    const regionNames = new Intl.DisplayNames([lang], { type: 'region' });
                    displayName = regionNames.of(countryCode);
                } catch (err) {
                    // Si el código es inválido (ej: "XX"), usamos el código como nombre
                    displayName = countryCode;
                }
            }

            // 4. RENDERIZAR (Bandera + Nombre Traducido)
            if (countryCode !== "UNK" && countryCode.length === 2) {
                const flagUrl = `https://flagcdn.com/24x18/${countryCode.toLowerCase()}.png`;
                
                countryFlagElement.innerHTML = `
                    <img src="${flagUrl}" 
                         alt="${countryCode}" 
                         style="vertical-align: middle; margin-right: 6px; border-radius: 2px; box-shadow: 0 1px 3px rgba(0,0,0,0.3);">
                    ${displayName}
                `;
            } else {
                // Fallback solo texto
                countryFlagElement.textContent = "🏳️ " + displayName;
            }

            // 5. QUITAR CARGANDO
            if (typeof removeSkeleton === 'function') {
                removeSkeleton(countryFlagElement);
            } else {
                countryFlagElement.classList.remove('skeleton', 'skeleton-text');
            }
        }
    } catch (e) {
        console.error("Error mostrando bandera:", e);
    }

    const tokensValue = document.getElementById("tokensValue");
    const tokensHelp = document.getElementById("tokensHelp");
    const tokensRow = document.getElementById("tokensRow");

    // Hide private information (tokens/customization actions) for other users
    if (!isViewingOwnProfile) {
      if (tokensRow) tokensRow.style.display = 'none';
      const profileHudCompactRow = document.getElementById('profileHudCompactRow');
      if (profileHudCompactRow) profileHudCompactRow.style.display = 'none';
      const nexusActionsRow = document.getElementById("nexusActionsRow");
      if (nexusActionsRow) nexusActionsRow.style.display = 'none';
      const nexusBadgesBtnContainer = document.getElementById("nexusBadgesBtnContainer");
      if (nexusBadgesBtnContainer) nexusBadgesBtnContainer.style.display = 'none';
      const daysEl = document.getElementById("daysRegistered");
      if (daysEl && daysEl.parentElement) daysEl.parentElement.style.display = 'none';
      const countryEl = document.getElementById("countryFlag");
      if (countryEl && countryEl.parentElement) countryEl.parentElement.style.display = 'none';
      const customizeBtn = document.getElementById('customizeProfileBtn');
      if (customizeBtn) customizeBtn.style.display = 'none';
      const appearanceActions = document.getElementById('profileAppearanceActions');
      if (appearanceActions) appearanceActions.style.display = 'none';
    } else {
        const profileHudCompactRow = document.getElementById('profileHudCompactRow');
        if (profileHudCompactRow) profileHudCompactRow.style.display = '';
        if (tokensRow) tokensRow.style.display = '';
        const customizeBtn = document.getElementById('customizeProfileBtn');
        if (customizeBtn) customizeBtn.style.display = '';
        const appearanceActions = document.getElementById('profileAppearanceActions');
        if (appearanceActions) appearanceActions.style.display = '';
        // This block now ONLY handles displaying tokens for authorized viewers
        tokensValue.textContent = "...";
        const userRef = firebase.database().ref(`users/${profileUserId}`);
        userRef.once('value').then(snapshot => {
            const userData = snapshot.val();
            let tokens = 0;
            if (userData && typeof userData.tokens === "number") {
                tokens = userData.tokens;
            }
            tokensValue.textContent = tokens;
            tokensValue.style.color = tokens === 0 ? "#ff2222" : "#58f658";
            removeSkeleton(tokensValue);
        }).catch(err => {
            console.error("Error loading tokens:", err);
            tokensValue.textContent = "0";
            tokensValue.style.color = "#ff2222";
            removeSkeleton(tokensValue);
        });
    }

    // Load thoughts wall for EVERYONE, regardless of rank.
    try {
        cargarPensamientosPublicosRealtime({ uid: user.uid, rango: currentUserRank });
    } catch (err) {
        console.error("Error preparing for thoughts wall:", err);
        cargarPensamientosPublicosRealtime({ uid: user.uid, rango: "tribal_warrior" });
    }

// ============================================================
    // CORRECCIÓN FECHA DE REGISTRO (UNIVERSAL)
    // ============================================================
    try {
        const daysElement = document.getElementById("daysRegistered");
        
        if (daysElement) {
            // 1. Determinar qué datos usar (Tus datos o los del perfil visitado)
            // Usamos las variables que ya existen en tu código: currentUserData o profileUserData
            let targetData = null;
            if (typeof isViewingOwnProfile !== 'undefined' && isViewingOwnProfile) {
                targetData = (typeof currentUserData !== 'undefined') ? currentUserData : null;
            } else {
                targetData = (typeof profileUserData !== 'undefined') ? profileUserData : null;
            }

            let fechaBase = null;

            // 2. Prioridad: Fecha manual de la BD (campo 'registro')
            if (targetData && targetData.registro) {
                fechaBase = targetData.registro;
            } 
            // 3. Fallback: Metadata de Auth (Solo si es tu propio perfil y no hay fecha en BD)
            else if (isViewingOwnProfile && user && user.metadata && user.metadata.creationTime) {
                fechaBase = user.metadata.creationTime;
            }

            // 4. Calcular Días
            if (fechaBase) {
                const creationDate = new Date(fechaBase);
                const today = new Date();
                const diffTime = Math.abs(today - creationDate);
                const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));

                if (!isNaN(diffDays)) {
                    // Detección de idioma segura
                    const currentLang = localStorage.getItem('lang') || 'es';
                    const isEs = (currentLang === 'es');

                    if (diffDays === 0) {
                        daysElement.textContent = isEs ? "¡Nuevo hoy!" : "Joined today!";
                    } else if (diffDays === 1) {
                         daysElement.textContent = isEs ? "1 día" : "1 day";
                    } else {
                        daysElement.textContent = diffDays + (isEs ? " días" : " days");
                    }
                } else {
                    daysElement.textContent = "N/A";
                }
            } else {
                daysElement.textContent = "N/A";
            }

            // 5. IMPORTANTE: Quitar la animación de carga SIEMPRE
            if (typeof removeSkeleton === 'function') {
                removeSkeleton(daysElement);
            } else {
                daysElement.classList.remove('skeleton', 'skeleton-text');
            }
        }
    } catch (e) {
        console.error("Error mostrando fecha:", e);
        // Limpieza de emergencia para que no se quede cargando
        const el = document.getElementById("daysRegistered");
        if(el) { el.textContent = "N/A"; el.classList.remove('skeleton', 'skeleton-text'); }
    }
    // ============================================================

    // Photo upload functionality - only for own profile or commanders
    if (isViewingOwnProfile || isViewingAsCommander) {
      // Imagen nueva, soporta extension real
      document.getElementById("photoInput").addEventListener("change", function (e) {
        const file = e.target.files[0];
        if (!file) return;
        const validationError = validateImage(file);
        if (validationError === "type") {
          showFloatingMessage("error", t.uploadTypeError);
          return;
        }
        if (validationError === "size") {
          showFloatingMessage("error", t.uploadSizeError);
          return;
        }

        // Delete old images before uploading new one
        deleteOldProfileImage(profileUserId);

        let ext = "jpg";
        if (file.type === "image/png") ext = "png";
        else if (file.type === "image/webp") ext = "webp";
        const storageRef = firebase.storage().ref();
        const fileRef = storageRef.child(`profile_images/${profileUserId}/foto.${ext}`);
        fileRef.put(file)
          .then(snapshot => fileRef.getDownloadURL())
          .then(url => {
            if (isViewingOwnProfile) {
              return user.updateProfile({ photoURL: url }).then(() => url);
            } else {
              return url;
            }
          })
          .then(url => {
              profilePic.src = url;
              showFloatingMessage("success", t.updatePhotoSuccess);
              // Update database with new photo URL
              const userRef = firebase.database().ref(`users/${profileUserId}`);
              userRef.update({ photoURL: url });

              // **** ¡AQUÍ ESTÁ LA LÍNEA QUE DEBES AGREGAR! ****
              if (currentUserData && isViewingOwnProfile) {
                currentUserData.photoURL = url;
              }
              // *************************************************

              // Exit edit mode after successful upload
              togglePhotoEditMode(false);
            })
          .catch(err => {
            showFloatingMessage("error", t.updatePhotoError);
            console.error(err);
          });
      });
    }

    // Initialize the new interactive thought poster IF user is on their own profile
    if (isViewingOwnProfile) {
        initializeThoughtPoster(user, t);
    }

    // Initialize search and recommendations functionality - moved here so Firebase is available
    if (typeof firebase !== 'undefined' && firebase.auth && firebase.database) {
      initializeUserSearch();
      initializeRecommendations();
      initializeTabSwitching();
    }

    // Accesibilidad foto perfil
    if (profilePic) {
      profilePic.setAttribute('tabindex', '0');
      profilePic.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          const userData = currentUserData || {};
          const userRank = userData.rango || "tribal_warrior";
          const permissions = getPermisosRango(userRank);
          const isCommander = permissions.accesoTotal;

          if (isCommander) {
            const photoInput = document.getElementById('photoInput');
            if (photoInput) photoInput.click();
          } else {
            togglePhotoEditMode();
          }
        }
      });
    }
    } catch (error) {
      console.error("Critical error in authentication state change:", error);
      const profileCard = document.querySelector('.profile-card');
      if (profileCard) {
        profileCard.innerHTML = `<div style="text-align: center; color: #f55; padding: 2rem;"><h3>Error de Carga</h3><p>Hubo un problema al cargar el dashboard. Por favor, recarga la página.</p><button onclick="location.reload()" style="margin-top: 1rem; padding: 0.5rem 1rem; background: #58aaff; color: white; border: none; border-radius: 4px; cursor: pointer;">Recargar Página</button></div>`;
      }
      try { initializeTabSwitching(); } catch (initError) { console.error("Error initializing basic functionality:", initError); }
    }
  });
});

// User search functionality
function initializeUserSearch() {
  // ... (Se mantiene igual)
  const searchInput = document.getElementById('userSearchInput');
  const searchResults = document.getElementById('searchResults');
  let searchTimeout = null;

  if (!searchInput || !searchResults) return;

  searchInput.addEventListener('input', function() {
    const query = this.value.trim().toLowerCase();
    if (searchTimeout) clearTimeout(searchTimeout);
    if (query.length < 2) {
      searchResults.style.display = 'none';
      return;
    }
    searchTimeout = setTimeout(() => {
      searchUsers(query);
    }, 300);
  });

  document.addEventListener('click', function(e) {
    if (!e.target.closest('.search-input-container')) {
      searchResults.style.display = 'none';
    }
  });

  async function searchUsers(query) {
    try {
      if (typeof firebase === 'undefined' || !firebase.database) {
        searchResults.innerHTML = '<div class="search-result-item">Search unavailable in demo mode</div>';
        searchResults.style.display = 'block';
        return;
      }
      // PZ-017: el buscador global del dashboard lee publicProfiles (nick/photoURL/rango), no users.
      const usersRef = firebase.database().ref('publicProfiles');
      const snapshot = await usersRef.once('value');
      const users = snapshot.val();
      if (!users) {
        searchResults.innerHTML = '<div class="search-result-item">No users found</div>';
        searchResults.style.display = 'block';
        return;
      }
      const results = [];
      Object.entries(users).forEach(([uid, userData]) => {
        const nick = userData.nick || uid;
        if (nick.toLowerCase().includes(query) || uid.toLowerCase().includes(query)) {
          results.push({ uid, nick, photoURL: getPreferredAvatarFromUserData(userData, DEFAULT_PROFILE_IMAGE), rango: userData.rango || 'tribal_warrior' });
        }
      });
      if (results.length === 0) {
        searchResults.innerHTML = '<div class="search-result-item">No users found</div>';
      } else {
        searchResults.innerHTML = results.map(user => `<div class="search-result-item" onclick="navigateToProfile('${user.uid}')"><img src="${user.photoURL}" alt="${user.nick}" class="search-result-img"><div class="search-result-info"><div class="search-result-nick">${user.nick}</div><div class="search-result-rank">${user.rango}</div></div></div>`).join('');
      }
      searchResults.style.display = 'block';
    } catch (error) {
      console.error('Error searching users:', error);
      searchResults.innerHTML = '<div class="search-result-item">Error searching users</div>';
      searchResults.style.display = 'block';
    }
  }
}

// Recommendations functionality
let profileSocialFriendsRef = null;
let profileSocialFriendsListener = null;
let profileSocialTargetUid = null;
let profileSocialTargetData = null;

function shutdownProfileSocialListeners() {
    if (profileSocialFriendsRef && profileSocialFriendsListener) {
        profileSocialFriendsRef.off('value', profileSocialFriendsListener);
    }
    profileSocialFriendsRef = null;
    profileSocialFriendsListener = null;
    profileSocialTargetUid = null;
    profileSocialTargetData = null;
}

function getDashboardPrivateChatRoomId(partnerUid) {
    const authUser = firebase.auth().currentUser;
    if (!authUser || !partnerUid) return null;
    return [authUser.uid, partnerUid].sort().join('_');
}

function setupDashboardFriendModal() {
    const modal = document.getElementById('dashboardFriendRequestModal');
    const backdrop = document.getElementById('dashboardFriendRequestBackdrop');
    const closeBtn = document.getElementById('closeDashboardFriendRequestModal');
    const close = () => { if (modal) modal.style.display = 'none'; };
    if (closeBtn) closeBtn.onclick = close;
    if (backdrop) backdrop.onclick = close;
}

function openDashboardFriendRequestModal(targetUid, targetNick) {
    const modal = document.getElementById('dashboardFriendRequestModal');
    const subtitle = document.getElementById('dashboardFriendRequestSubTitle');
    const form = document.getElementById('dashboardFriendRequestForm');
    const textarea = document.getElementById('dashboardFriendRequestMessage');
    if (!modal || !form) return;
    if (subtitle) subtitle.textContent = 'Envía una solicitud de amistad a ' + (targetNick || 'este jugador') + '. Si acepta, podrán chatear en el sitio.';
    if (textarea) textarea.value = '';
    modal.style.display = 'flex';
    form.onsubmit = (e) => handleDashboardFriendRequestSubmit(e, targetUid, targetNick);
}

async function handleDashboardFriendRequestSubmit(e, targetUid, targetNick) {
    e.preventDefault();
    const authUser = firebase.auth().currentUser;
    if (!authUser || !currentUserData || !targetUid) return false;
    const textarea = document.getElementById('dashboardFriendRequestMessage');
    const message = (textarea && textarea.value || '').trim();
    if (!message) {
        showFloatingMessage('error', 'Escribe un mensaje para tu solicitud de amistad.');
        return false;
    }
    const btn = document.getElementById('sendDashboardFriendRequestBtn');
    if (btn) { btn.disabled = true; }
    try {
        const existing = await firebase.database().ref('sgFriends/' + authUser.uid + '/' + targetUid).once('value');
        if (existing.exists()) {
            showFloatingMessage('info', 'Ya son amigos.');
            document.getElementById('dashboardFriendRequestModal').style.display = 'none';
            await refreshProfileSocialButtons(targetUid, profileSocialTargetData);
            return false;
        }
        await firebase.database().ref('friendRequests/' + targetUid + '/' + authUser.uid).set({
            senderUid: authUser.uid,
            senderNick: currentUserData.nick || 'Usuario',
            senderAvatar: currentUserData.photoURL || 'dragon_profile_studiosgamesrs.png',
            message: message,
            timestamp: firebase.database.ServerValue.TIMESTAMP
        });
        showFloatingMessage('success', 'Solicitud de amistad enviada a ' + (targetNick || 'jugador') + '.');
        document.getElementById('dashboardFriendRequestModal').style.display = 'none';
        await refreshProfileSocialButtons(targetUid, profileSocialTargetData);
    } catch (err) {
        showFloatingMessage('error', 'No se pudo enviar la solicitud de amistad.');
    } finally {
        if (btn) { btn.disabled = false; }
    }
    return false;
}

async function refreshProfileSocialButtons(targetUid, targetData) {
    const actions = document.getElementById('profileSocialActions');
    const friendBtn = document.getElementById('profileAddFriendBtn');
    const chatBtn = document.getElementById('profileDmChatBtn');
    const authUser = firebase.auth().currentUser;
    if (!actions || !friendBtn || !chatBtn || !authUser || !targetUid || targetUid === authUser.uid) {
        if (actions) actions.style.display = 'none';
        return;
    }

    actions.style.display = 'flex';
    const isEs = (navigator.language || '').toLowerCase().startsWith('es');
    const db = firebase.database();

    // Una lectura denegada aquí dejaba el botón congelado en "Agregar amigo":
    // cada estado se resuelve por separado y su fallo no bloquea a los demás.
    const readOrNull = (path) => db.ref(path).once('value').then((s) => s.val()).catch(() => null);
    const [friendData, sentData, incomingData] = await Promise.all([
        readOrNull('sgFriends/' + authUser.uid + '/' + targetUid),
        readOrNull('friendRequests/' + targetUid + '/' + authUser.uid),
        readOrNull('friendRequests/' + authUser.uid + '/' + targetUid)
    ]);

    friendBtn.className = 'profile-action-badge';
    friendBtn.disabled = false;
    friendBtn.onclick = () => openDashboardFriendRequestModal(targetUid, targetData?.nick || 'Usuario');

    if (friendData) {
        friendBtn.disabled = true;
        friendBtn.classList.add('profile-action-badge--friend');
        friendBtn.title = isEs ? 'Ya son amigos' : 'Already friends';
        friendBtn.innerHTML = '<i class="fas fa-user-check"></i>';
        chatBtn.style.display = 'inline-flex';
        chatBtn.title = isEs ? 'Chat privado' : 'Private chat';
        chatBtn.onclick = () => openProfilePrivateChat(targetUid, targetData);
    } else if (incomingData) {
        friendBtn.classList.add('profile-action-badge--pending');
        friendBtn.title = isEs ? 'Te envió una solicitud: acéptala' : 'They sent you a request: accept it';
        friendBtn.innerHTML = '<i class="fas fa-user-clock"></i>';
        friendBtn.onclick = () => acceptFriendRequest({
            senderUid: targetUid,
            senderNick: incomingData.senderNick || targetData?.nick || 'Usuario',
            senderAvatar: incomingData.senderAvatar || targetData?.photoURL || '/dragon_profile_studiosgamesrs.png'
        });
        chatBtn.style.display = 'none';
    } else if (sentData) {
        friendBtn.disabled = true;
        friendBtn.classList.add('profile-action-badge--pending');
        friendBtn.title = isEs ? 'Solicitud enviada' : 'Request sent';
        friendBtn.innerHTML = '<i class="fas fa-clock"></i>';
        chatBtn.style.display = 'none';
    } else {
        friendBtn.title = isEs ? 'Agregar amigo' : 'Add friend';
        friendBtn.innerHTML = '<i class="fas fa-user-plus"></i>';
        chatBtn.style.display = 'none';
    }
}

async function openProfilePrivateChat(targetUid, targetData) {
    const authUser = firebase.auth().currentUser;
    if (!authUser || !targetUid || !currentUserData) return;
    const friendSnap = await firebase.database().ref('sgFriends/' + authUser.uid + '/' + targetUid).once('value');
    if (!friendSnap.exists()) {
        showFloatingMessage('info', 'Deben ser amigos para chatear.');
        return;
    }
    const roomId = getDashboardPrivateChatRoomId(targetUid);
    if (!roomId) return;
    try {
        await firebase.database().ref('sgChatLinks/' + authUser.uid + '/' + targetUid).set(true);
        await firebase.database().ref('sgChatLinks/' + targetUid + '/' + authUser.uid).set(true);
    } catch (e) {}
    const nick = targetData?.nick || 'Usuario';
    if (window.SGNotifications && typeof window.SGNotifications.markPrivateChatRead === 'function') {
        window.SGNotifications.markPrivateChatRead(targetUid);
    }
    openTeamChat(roomId, nick, {}, 'privateChat');
}

/**
 * Abre el chat privado con un jugador sin pasar por su perfil: lo usa el aviso
 * de mensaje nuevo (shared-notifications) y el parámetro ?dm= de la URL.
 */
async function openDashboardPrivateChatWith(targetUid, partnerNick) {
    const authUser = firebase.auth().currentUser;
    if (!authUser || !targetUid || targetUid === authUser.uid) return;
    const roomId = getDashboardPrivateChatRoomId(targetUid);
    if (!roomId) return;
    let nick = partnerNick || '';
    if (!nick) {
        try {
            const snap = await firebase.database().ref('users/' + targetUid + '/nick').once('value');
            nick = snap.val() || 'Jugador';
        } catch (e) {
            nick = 'Jugador';
        }
    }
    if (window.SGNotifications && typeof window.SGNotifications.markPrivateChatRead === 'function') {
        window.SGNotifications.markPrivateChatRead(targetUid);
    }
    openTeamChat(roomId, nick, {}, 'privateChat');
}
window.openDashboardPrivateChatWith = openDashboardPrivateChatWith;

function maybeOpenDashboardDmFromUrl() {
    const dmUid = getURLParameter('dm');
    if (!dmUid) return;
    try {
        const url = new URL(window.location.href);
        url.searchParams.delete('dm');
        window.history.replaceState({}, '', url.pathname + url.search + url.hash);
    } catch (e) {}
    openDashboardPrivateChatWith(dmUid);
}

function initializeProfileSocialActions(targetUid, targetData) {
    shutdownProfileSocialListeners();
    profileSocialTargetUid = targetUid;
    profileSocialTargetData = targetData || null;
    setupDashboardFriendModal();

    const actions = document.getElementById('profileSocialActions');
    const recommendBtn = document.getElementById('profileRecommendBtn');
    if (!isViewingOwnProfile && targetUid) {
        if (actions) actions.style.display = 'flex';
        refreshProfileSocialButtons(targetUid, targetData);
        if (profileSocialFriendsRef) profileSocialFriendsRef.off('value', profileSocialFriendsListener);
        profileSocialFriendsRef = firebase.database().ref('sgFriends/' + firebase.auth().currentUser.uid);
        profileSocialFriendsListener = () => refreshProfileSocialButtons(targetUid, targetData);
        profileSocialFriendsRef.on('value', profileSocialFriendsListener);
    } else if (actions) {
        actions.style.display = 'none';
    }

    if (recommendBtn) {
        recommendBtn.onclick = () => {
            if (typeof window.dashboardRecommendUser === 'function') window.dashboardRecommendUser();
        };
    }
}

var profilePanelState = {
  active: 'moments',
  defaultPanel: 'moments',
  bound: false,
  profileUid: null
};

function normalizeProfilePanel(value) {
  return value === 'stats' ? 'stats' : 'moments';
}

function getProfilePanelLabels() {
  var lang = (typeof localStorage !== 'undefined' && localStorage.getItem('lang')) || 'es';
  var isEs = String(lang).toLowerCase().indexOf('en') !== 0;
  return {
    moments: isEs ? 'Mejores momentos' : 'Best moments',
    stats: isEs ? 'Estadísticas' : 'Statistics'
  };
}

function setProfilePanelTab(panelId) {
  var panel = normalizeProfilePanel(panelId);
  profilePanelState.active = panel;

  document.querySelectorAll('.profile-panel-tab').forEach(function(tab) {
    var active = tab.getAttribute('data-profile-panel') === panel;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', active ? 'true' : 'false');
  });

  document.querySelectorAll('[data-profile-panel-pane]').forEach(function(pane) {
    var active = pane.getAttribute('data-profile-panel-pane') === panel;
    pane.classList.toggle('active', active);
    if (active) pane.removeAttribute('hidden');
    else pane.setAttribute('hidden', '');
    pane.setAttribute('aria-hidden', active ? 'false' : 'true');
  });
}

function initProfilePanelTabs(profileUid, profileUserData) {
  profilePanelState.profileUid = profileUid || null;
  var cust = (profileUserData && profileUserData.profileCustomization) || {};
  profilePanelState.defaultPanel = normalizeProfilePanel(cust.defaultProfilePanel);

  var dual = document.getElementById('profileDualSections') || document.querySelector('.profile-dual-sections');
  if (dual) dual.classList.add('profile-panel-tabs-mode');

  if (!profilePanelState.bound) {
    profilePanelState.bound = true;
    document.querySelectorAll('.profile-panel-tab').forEach(function(tab) {
      tab.addEventListener('click', function() {
        setProfilePanelTab(tab.getAttribute('data-profile-panel'));
      });
    });
  }

  var tabMomentsLabel = document.getElementById('profilePanelTabMomentsLabel');
  var tabStatsLabel = document.getElementById('profilePanelTabStatsLabel');
  var labels = getProfilePanelLabels();
  if (tabMomentsLabel) tabMomentsLabel.textContent = labels.moments;
  if (tabStatsLabel) tabStatsLabel.textContent = labels.stats;

  setProfilePanelTab(profilePanelState.defaultPanel);
}

function updateProfileViewMode() {
    const profileCard = document.querySelector('.profile-card.enhanced-hud');
    const ownerOnlyBlocks = document.querySelectorAll('.profile-owner-only-block');

    if (profileCard) {
        profileCard.classList.toggle('viewing-other-profile', !isViewingOwnProfile);
    }
    ownerOnlyBlocks.forEach(function(block) {
        block.setAttribute('aria-hidden', isViewingOwnProfile ? 'false' : 'true');
    });
}

function initializeRecommendations() {
  if (typeof firebase === 'undefined' || !firebase.auth || !firebase.database) {
    console.log('Recommendations unavailable in demo mode');
    return;
  }
  const currentUser = firebase.auth().currentUser;
  if (!currentUser) return;
  const recommendBtn = document.getElementById('profileRecommendBtn');
  const recommendationCount = document.getElementById('recommendationCount');
  const recommendationsList = document.getElementById('recommendationsList');
  if (!recommendationCount || !recommendationsList) return;
  const targetUserId = viewingUserId || currentUser.uid;
  const isEs = (navigator.language || '').toLowerCase().startsWith('es');

  async function loadRecommendations() {
    try {
      const userId = targetUserId || currentUser.uid;
      const recommendationsRef = firebase.database().ref(`recommendations/${userId}`);
      const snapshot = await recommendationsRef.once('value');
      const recommendations = snapshot.val();
      if (!recommendations) {
        recommendationCount.textContent = '0';
        recommendationsList.innerHTML = '';
        if (recommendBtn) {
          recommendBtn.disabled = false;
          recommendBtn.classList.remove('profile-action-badge--recommended');
          recommendBtn.title = isEs ? 'Recomendar usuario' : 'Recommend user';
        }
        return;
      }
      const recommenderIds = Object.keys(recommendations);
      recommendationCount.textContent = recommenderIds.length.toString();
      const hasRecommended = recommenderIds.includes(currentUser.uid);
      if (recommendBtn && !isViewingOwnProfile) {
        recommendBtn.disabled = hasRecommended;
        recommendBtn.classList.toggle('profile-action-badge--recommended', hasRecommended);
        recommendBtn.title = hasRecommended
          ? (isEs ? 'Ya recomendaste a este usuario' : 'Already recommended')
          : (isEs ? 'Recomendar usuario' : 'Recommend user');
      }
      const recommenderPromises = recommenderIds.map(async (uid) => {
        const userRef = firebase.database().ref(`users/${uid}`);
        const userSnapshot = await userRef.once('value');
        const userData = userSnapshot.val();
        return { uid, nick: userData?.nick || uid, timestamp: recommendations[uid].timestamp };
      });
      const recommenders = await Promise.all(recommenderPromises);
      recommenders.sort((a, b) => b.timestamp - a.timestamp);
      if (isViewingOwnProfile) {
        recommendationsList.innerHTML = '';
      } else if (recommenders.length === 0) {
        recommendationsList.innerHTML = '';
      } else if (recommenders.length === 1) {
        recommendationsList.innerHTML = `<div class="recommendation-item"><span class="recommender-link" onclick="navigateToProfile('${recommenders[0].uid}')">${recommenders[0].nick}</span> ${isEs ? 'recomendó este perfil' : 'recommended this user'}</div>`;
      } else {
        const firstRecommender = recommenders[0];
        const remainingCount = recommenders.length - 1;
        const moreText = isEs ? `y ${remainingCount} más recomendaron este perfil` : `and ${remainingCount} more recommended this user`;
        recommendationsList.innerHTML = `<div class="recommendation-item"><span class="recommender-link" onclick="navigateToProfile('${firstRecommender.uid}')">${firstRecommender.nick}</span> ${isEs ? 'recomendó este perfil' : 'recommended this user'}, ${moreText}</div>`;
      }
    } catch (error) {
      console.error('Error loading recommendations:', error);
      recommendationCount.textContent = '0';
      recommendationsList.innerHTML = '<div class="recommendation-item">Error loading recommendations</div>';
    }
  }

  async function recommendUser() {
    if (!targetUserId || targetUserId === currentUser.uid) return;
    try {
      if (recommendBtn) recommendBtn.disabled = true;
      const recommendationRef = firebase.database().ref(`recommendations/${targetUserId}/${currentUser.uid}`);
      await recommendationRef.set({ timestamp: Date.now() });
      loadRecommendations();
      showFloatingMessage('success', isEs ? '¡Usuario recomendado!' : 'User recommended successfully!');
    } catch (error) {
      console.error('Error recommending user:', error);
      showFloatingMessage('error', isEs ? 'Error al recomendar' : 'Error recommending user');
      if (recommendBtn) recommendBtn.disabled = false;
    }
  }

  window.dashboardRecommendUser = recommendUser;
  loadRecommendations();
}

// Profile comments functionality
async function postComment(profileOwnerUid, text) {
  // ... (Se mantiene igual)
  try {
    const currentUser = firebase.auth().currentUser;
    if (!currentUser) { showFloatingMessage("error", "Debes estar autenticado para comentar"); return false; }
    if (profileOwnerUid === currentUser.uid) { showFloatingMessage("error", "No puedes comentar en tu propio perfil"); return false; }
    if (!text || text.trim().length === 0) { showFloatingMessage("error", "El comentario no puede estar vacío"); return false; }
    if (text.length > 200) { showFloatingMessage("error", "El comentario es muy largo (máximo 200 caracteres)"); return false; }
    const userRef = firebase.database().ref(`users/${currentUser.uid}`);
    const userSnapshot = await userRef.once('value');
    const userData = userSnapshot.val();
    const authorNick = userData?.nick || currentUser.displayName || currentUser.email?.split('@')[0] || 'Usuario';
    const commentData = { author_uid: currentUser.uid, author_nick: authorNick, author_photoURL: getPreferredAvatarFromUserData(userData, currentUser.photoURL || DEFAULT_PROFILE_IMAGE), text: text.trim(), timestamp: Date.now() };
    const commentsRef = firebase.database().ref(`profile_comments/${profileOwnerUid}`);
    await commentsRef.push(commentData);
    if (typeof pushSiteActivity === 'function') {
        const safe = (s) => (s || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        pushSiteActivity('dashboard_comment', `<strong>${safe(authorNick)}</strong> comentó en un perfil`);
    }
    showFloatingMessage("success", "Comentario agregado exitosamente");
    return true;
  } catch (error) {
    console.error("Error al agregar comentario:", error);
    showFloatingMessage("error", "Error al agregar el comentario");
    return false;
  }
}

async function loadProfileComments(profileOwnerUid) {
  // ... (Se mantiene igual)
  try {
    const commentsRef = firebase.database().ref(`profile_comments/${profileOwnerUid}`);
    commentsRef.on('value', (snapshot) => {
      const commentsData = snapshot.val();
      const commentsWall = document.getElementById("commentsWall");
      if (!commentsWall) return;
      if (!commentsData) {
        commentsWall.innerHTML = '<div style="text-align: center; color: #aaa; margin: 2rem 0;">No hay comentarios aún</div>';
        return;
      }
      const commentsArray = Object.entries(commentsData).map(([key, value]) => ({ id: key, ...value })).sort((a, b) => b.timestamp - a.timestamp);
      let commentsHTML = '';
      commentsArray.forEach(comment => {
        const timeAgo = getTimeAgo(comment.timestamp);
        const currentUser = firebase.auth().currentUser;
        const canDelete = currentUser && (comment.author_uid === currentUser.uid || isViewingAsCommander);
        commentsHTML += `<div class="profile-comment" data-comment-id="${comment.id}"><img class="comment-author-img" src="${comment.author_photoURL}" alt="${comment.author_nick}" onclick="navigateToProfile('${comment.author_uid}')" title="Ver perfil de ${comment.author_nick}"><div class="comment-content"><div class="comment-author" onclick="navigateToProfile('${comment.author_uid}')" title="Ver perfil de ${comment.author_nick}">${comment.author_nick}<span class="comment-time">${timeAgo}</span></div><div class="comment-text">${comment.text}</div></div>${canDelete ? `<button class="comment-delete-btn" onclick="deleteComment('${profileOwnerUid}', '${comment.id}')" title="Eliminar comentario">🗑️</button>` : ''}</div>`;
      });
      commentsWall.innerHTML = commentsHTML;
    });
  } catch (error) {
    console.error("Error al cargar comentarios:", error);
    const commentsWall = document.getElementById("commentsWall");
    if (commentsWall) {
      commentsWall.innerHTML = '<div style="text-align: center; color: #f55; margin: 2rem 0;">Error al cargar comentarios</div>';
    }
  }
}

window.deleteComment = async function(profileOwnerUid, commentId) {
  // ... (Se mantiene igual)
  if (!confirm("¿Seguro que deseas eliminar este comentario?")) return;
  try {
    const commentRef = firebase.database().ref(`profile_comments/${profileOwnerUid}/${commentId}`);
    await commentRef.remove();
    showFloatingMessage("success", "Comentario eliminado");
  } catch (error) {
    console.error("Error al eliminar comentario:", error);
    showFloatingMessage("error", "Error al eliminar el comentario");
  }
}

function getTimeAgo(timestamp) {
  // ... (Se mantiene igual)
  const now = Date.now();
  const diffMs = now - timestamp;
  const diffMinutes = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (diffMinutes < 1) return 'hace un momento';
  if (diffMinutes < 60) return `hace ${diffMinutes}m`;
  if (diffHours < 24) return `hace ${diffHours}h`;
  if (diffDays < 30) return `hace ${diffDays}d`;
  return new Date(timestamp).toLocaleDateString();
}

// Tab switching functionality
function initializeTabSwitching() {
  // ... (Se mantiene igual)
  const thoughtsToggleBtn = document.getElementById('thoughtsToggleBtn');
  const commentsToggleBtn = document.getElementById('commentsToggleBtn');
  const thoughtsWallSection = document.getElementById('thoughtsWallSection');
  const commentsWallSection = document.getElementById('commentsWallSection');
  const commentForm = document.getElementById('commentForm');
  const commentInput = document.getElementById('commentInput');
  const postCommentBtn = document.getElementById('postCommentBtn');
  const commentCharCount = document.getElementById('commentCharCount');
  if (!thoughtsToggleBtn || !commentsToggleBtn || !thoughtsWallSection || !commentsWallSection) {
    return;
  }
  function switchToThoughts() {
    thoughtsToggleBtn.classList.add('active');
    commentsToggleBtn.classList.remove('active');
    thoughtsWallSection.style.display = 'block';
    commentsWallSection.style.display = 'none';
  }
  function switchToComments() {
    thoughtsToggleBtn.classList.remove('active');
    commentsToggleBtn.classList.add('active');
    thoughtsWallSection.style.display = 'none';
    commentsWallSection.style.display = 'block';
    const profileUserId = viewingUserId || firebase.auth().currentUser?.uid;
    if (profileUserId) {
      loadProfileComments(profileUserId);
    }
    if (!isViewingOwnProfile && commentForm) {
      commentForm.style.display = 'block';
    } else if (commentForm) {
      commentForm.style.display = 'none';
    }
  }
  thoughtsToggleBtn.addEventListener('click', switchToThoughts);
  commentsToggleBtn.addEventListener('click', switchToComments);
  if (commentInput && commentCharCount && postCommentBtn) {
    function updateCharCount() {
      const remaining = 200 - commentInput.value.length;
      commentCharCount.textContent = remaining + ' caracteres restantes';
      commentCharCount.style.color = remaining < 20 ? '#e53935' : '#888';
      postCommentBtn.disabled = commentInput.value.trim().length === 0 || remaining < 0;
    }
    commentInput.addEventListener('input', updateCharCount);
    updateCharCount();
    postCommentBtn.addEventListener('click', async () => {
      const text = commentInput.value.trim();
      if (!text) return;
      const profileUserId = viewingUserId || firebase.auth().currentUser?.uid;
      if (!profileUserId) return;
      postCommentBtn.disabled = true;
      postCommentBtn.textContent = 'Publicando...';
      const success = await postComment(profileUserId, text);
      if (success) {
        commentInput.value = '';
        updateCharCount();
      }
      postCommentBtn.disabled = false;
      postCommentBtn.textContent = 'Publicar';
    });
    commentInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.ctrlKey) {
        e.preventDefault();
        postCommentBtn.click();
      }
    });
  }
}

// Global function assignments for window access
window.postComment = postComment;
window.loadProfileComments = loadProfileComments;
window.logout = logout;
window.returnToDashboard = returnToDashboard;

function logout() {
  // ... (Se mantiene igual)
  try {
    localStorage.removeItem('usuario_steam');
    if (typeof firebase !== 'undefined' && firebase.auth) {
      firebase.auth().signOut().then(() => {
        window.location.href = "/login";
      }).catch((error) => {
        console.error("Error during logout:", error);
        window.location.href = "/login";
      });
    } else {
      console.log("Demo mode: redirecting to login");
      window.location.href = "/login";
    }
  } catch (error) {
    console.error("Logout error:", error);
    window.location.href = "/login";
  }
}

// Alterna tema rojo (normal) / dorado. Usa la clase CSS ya existente.
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

(function restoreDashboardTheme() {
  try {
    if (localStorage.getItem('dashboard_theme') === 'gold') {
      document.body.classList.add('dashboard-theme-gold');
      const themeIcon = document.getElementById('theme-icon');
      if (themeIcon) themeIcon.className = 'fas fa-sun';
    }
  } catch (e) {}
})();

function returnToDashboard() {
  // ... (Se mantiene igual)
  const baseUrl = window.location.href.split('?')[0];
  window.location.href = baseUrl;
}

// ==================================================================
// --- INICIO: CÓDIGO DE CHAT Y DEPENDENCIAS (REFRACTORIZADO Y FLEXIBLE) ---
// ==================================================================

/**
 * Función adaptadora para usar el sistema de notificaciones del Dashboard.
 */
function showNotification(message, type = 'success') {
    showFloatingMessage(type, message); 
}

/**
 * Muestra la mini-tarjeta de usuario (HOVER).
 */
window.showUserPopup = async function(linkElement, userId) {
    // ... (Se mantiene igual)
    clearTimeout(popupTimeout);
    const popupCard = document.getElementById('userPopupCard');
    if (!popupCard || !userId) return;

    // Limpiar clases de rango anteriores
    popupCard.classList.remove('rank-commander', 'rank-divisional', 'rank-tribal');

    // Poner estado de carga
    document.getElementById('popupUserPhoto').src = 'dragon_profile_studiosgamesrs.png';
    document.getElementById('popupUserNick').textContent = 'Loading...';
    document.getElementById('popupUserGame').textContent = '...';
    document.getElementById('popupUserRank').textContent = 'Loading...';
    document.getElementById('popupUserStatus').textContent = '...';

    // Calcular posición
    const linkRect = linkElement.getBoundingClientRect();
    let top = window.scrollY + linkRect.bottom + 8;
    let left = window.scrollX + linkRect.left;
    popupCard.style.top = `${top}px`;
    popupCard.style.left = `${left}px`;
    popupCard.style.display = 'block';
    popupCard.classList.remove('visible');

    // Ajustar posición si se sale de la pantalla
    const popupRect = popupCard.getBoundingClientRect();
    if (popupRect.right > window.innerWidth - 10) {
         left = window.scrollX + linkRect.right - popupRect.width;
         if (left < 10) left = 10;
         popupCard.style.left = `${left}px`;
    }
    if (popupRect.bottom > window.innerHeight - 10) {
         top = window.scrollY + linkRect.top - popupRect.height - 8;
         if (top < window.scrollY + 10) top = window.scrollY + 10;
         popupCard.style.top = `${top}px`;
    }

    try {
        const userRef = firebase.database().ref(`users/${userId}`);
        const snapshot = await userRef.once('value');
        const userData = snapshot.val();

        if (userData) {
            document.getElementById('popupUserPhoto').src = getPreferredAvatarFromUserData(userData, 'dragon_profile_studiosgamesrs.png');
            document.getElementById('popupUserNick').textContent = userData.nick || 'Unknown User';
            
            // FIX: Cargar Main Game (prueba varios campos)
            document.getElementById('popupUserGame').textContent = userData.mainGame || userData.profile?.mainGame || 'N/A';
            
            // FIX: Cargar Rango y Status
            const rango = userData.rango || 'tribal_warrior';
            const rankEl = document.getElementById('popupUserRank');
            rankEl.textContent = getRankName(rango); // Usar helper
            document.getElementById('popupUserStatus').textContent = userData.teamId ? 'In a Team' : 'Applicant';

            // FIX: Añadir clases para CSS
            if (rango === 'commander') {
                popupCard.classList.add('rank-commander');
                rankEl.className = 'user-rank rank-commander';
            } else if (rango === 'divisional_commander') {
                popupCard.classList.add('rank-divisional');
                rankEl.className = 'user-rank rank-divisional';
            } else {
                popupCard.classList.add('rank-tribal');
                rankEl.className = 'user-rank rank-tribal';
            }
            
        } else {
            document.getElementById('popupUserNick').textContent = 'User not found';
            document.getElementById('popupUserGame').textContent = 'N/A';
            document.getElementById('popupUserRank').textContent = 'Error';
            document.getElementById('popupUserStatus').textContent = 'Error';
        }
        setTimeout(() => { popupCard.classList.add('visible'); }, 10);
    } catch (error) {
        console.error("Error showing user popup:", error);
        document.getElementById('popupUserNick').textContent = 'Error';
        document.getElementById('popupUserGame').textContent = 'N/A';
        document.getElementById('popupUserRank').textContent = 'Error';
        document.getElementById('popupUserStatus').textContent = 'Error';
         setTimeout(() => { popupCard.classList.add('visible'); }, 10);
    }
}

/**
 * HELPER: Devuelve el nombre legible del rango.
 */
function getRankName(rangoKey) {
    // ... (Se mantiene igual)
    switch(rangoKey) {
        case 'commander': return 'Commander';
        case 'divisional_commander': return 'Divisional';
        case 'tribal_warrior': return 'Tribal Warrior';
        default: return 'Tribal Warrior';
    }
}

/**
 * Oculta la mini-tarjeta de usuario.
 */
window.hideUserPopup = function() {
    // ... (Se mantiene igual)
     clearTimeout(popupTimeout);
    popupTimeout = setTimeout(() => {
        const popupCard = document.getElementById('userPopupCard');
        if (popupCard) {
            popupCard.classList.remove('visible');
             const transitionEndHandler = () => {
                 if (!popupCard.classList.contains('visible')) {
                     popupCard.style.display = 'none';
                 }
                 popupCard.removeEventListener('transitionend', transitionEndHandler);
             };
             if (window.getComputedStyle(popupCard).transitionProperty !== 'none') {
                popupCard.addEventListener('transitionend', transitionEndHandler);
             } else {
                 if (!popupCard.classList.contains('visible')) {
                     popupCard.style.display = 'none';
                 }
             }
        }
    }, 300);
}

/**
 * Muestra la mini-tarjeta de equipo al pasar el ratón.
 */
window.showTeamPopup = async function(linkElement, teamId) {
    // ... (Se mantiene igual)
    clearTimeout(teamPopupTimeout);
    const popupCard = document.getElementById('teamPopupCard');
    if (!popupCard || !teamId) return;

    // Set loading state (usar imagen predeterminada mientras carga)
    document.getElementById('popupTeamEmblem').src = 'dragon_profile_studiosgamesrs.png';
    document.getElementById('popupTeamName').textContent = 'Loading...';
    document.getElementById('popupTeamGame').textContent = '...';
    document.getElementById('popupTeamMembers').textContent = '...';
    document.getElementById('popupTeamWins').textContent = '...';

    // Calcular posición
    const linkRect = linkElement.getBoundingClientRect();
    let top = window.scrollY + linkRect.bottom + 8;
    let left = window.scrollX + linkRect.left;
    popupCard.style.top = `${top}px`;
    popupCard.style.left = `${left}px`;
    popupCard.style.display = 'block';
    popupCard.classList.remove('visible');
    
    // Ajustar posición
    const popupRect = popupCard.getBoundingClientRect();
    if (popupRect.right > window.innerWidth - 10) { left = window.scrollX + linkRect.right - popupRect.width; }
    if (popupRect.bottom > window.innerHeight - 10) { top = window.scrollY + linkRect.top - popupRect.height - 8; }
    popupCard.style.top = `${top}px`;
    popupCard.style.left = `${left}px`;

    try {
        const teamRef = firebase.database().ref(`teams/${teamId}`);
        const snapshot = await teamRef.once('value');
        const teamData = snapshot.val();

        if (teamData) {
            document.getElementById('popupTeamEmblem').src = teamData.emblemUrl || 'dragon_profile_studiosgamesrs.png';
            document.getElementById('popupTeamName').textContent = teamData.name || 'Unknown Team';
            document.getElementById('popupTeamGame').textContent = teamData.game || 'N/A';
            document.getElementById('popupTeamMembers').textContent = `${Object.keys(teamData.roster || {}).length} / 10`;
            document.getElementById('popupTeamWins').textContent = teamData.stats?.wins || 0;
        } else {
            document.getElementById('popupTeamName').textContent = 'Team not found';
        }
        setTimeout(() => { popupCard.classList.add('visible'); }, 10);
    } catch (error) {
        console.error("Error showing team popup:", error);
        document.getElementById('popupTeamName').textContent = 'Error';
    }
}

/**
 * Oculta la mini-tarjeta de equipo.
 */
window.hideTeamPopup = function() {
    // ... (Se mantiene igual)
    clearTimeout(teamPopupTimeout);
    teamPopupTimeout = setTimeout(() => {
        const popupCard = document.getElementById('teamPopupCard');
        if (popupCard) {
            popupCard.classList.remove('visible');
            popupCard.addEventListener('transitionend', () => {
                if (!popupCard.classList.contains('visible')) {
                    popupCard.style.display = 'none';
                }
            }, { once: true });
        }
    }, 300);
}

/**
 * Formatea un timestamp de Firebase a una fecha legible.
 */
function formatTimestamp(timestamp) {
    // ... (Se mantiene igual)
     if (!timestamp) return 'N/A';
    const date = new Date(timestamp);
    try {
        return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    } catch (e) {
        console.error("Invalid timestamp:", timestamp, e);
        return 'Invalid Date';
    }
}

/**
 * (ADAPTADO) Abre el perfil del equipo.
 */
window.openPublicTeamProfile = function(teamId) {
    // ... (Se mantiene igual)
    if (teamId) {
        // Redirige al hub de competición
        window.open('/competition-hub', '_blank');
    }
}

/**
 * Inicializa y muestra el botón flotante del chat.
 * MODIFICADO: Ahora puede usarse para Chat de Equipo o Chat de Misión
 */
function initializeFloatingChat(user, chatId, chatData, roster) {
    const chatButton = document.getElementById('floatingChatButton');
    const chatEmblem = document.getElementById('floatingChatEmblem'); 
    const chatWindow = document.getElementById('teamChatWindow');
    const closeChatBtn = document.getElementById('closeChatBtn');
    
    if (!chatButton || !chatWindow || !closeChatBtn || !chatEmblem) {
        console.error("No se encontraron los elementos del chat flotante.");
        return;
    }

    // --- Emblema: usar imagen predeterminada si el equipo no tiene foto ---
    chatEmblem.src = (chatData && chatData.emblemUrl) ? chatData.emblemUrl : 'dragon_profile_studiosgamesrs.png';
    chatEmblem.onerror = function() { this.src = 'dragon_profile_studiosgamesrs.png'; };
    
    // 1. Mostrar el botón flotante ("pestaña")
    if (isViewingOwnProfile) {
        chatButton.style.display = 'flex';
    }

    // 2. Guardar datos del CHAT DE EQUIPO (siempre usar estos para el botón flotante)
    currentTeamChatId = chatId;
    currentTeamChatName = chatData ? chatData.name : 'Equipo';
    currentTeamChatRoster = roster;

    // 3. Definir acción de MINIMIZAR (botón 'X')
    closeChatBtn.onclick = () => {
        chatWindow.classList.remove('visible');
        if (isViewingOwnProfile) chatButton.style.display = 'flex'; 
    };

    // 4. Definir acción de TOGGLE: el botón flotante SIEMPRE abre el chat de EQUIPO
    chatButton.onclick = () => {
        const isChatVisible = chatWindow.classList.contains('visible');
        if (isChatVisible) {
            chatWindow.classList.remove('visible');
        } else {
            if (currentTeamChatId && currentTeamChatName && currentTeamChatRoster) {
                openTeamChat(currentTeamChatId, currentTeamChatName, currentTeamChatRoster, 'teamChats');
            }
            chatWindow.style.display = 'flex';
            setTimeout(() => chatWindow.classList.add('visible'), 10);
        }
    };
}

/**
 * Inicializa el botón flotante del chat global (Fuego de Campamento). Misma ventana que el chat de equipo, imagen community.png.
 */
function initializeGlobalChatButton() {
    const globalBtn = document.getElementById('floatingGlobalChatButton');
    const globalEmblem = document.getElementById('floatingGlobalChatEmblem');
    if (!globalBtn || !globalEmblem) return;
    globalEmblem.src = '/dragon_profile_studiosgamesrs.png';
    globalEmblem.onerror = function() { this.src = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0MCIgaGVpZ2h0PSI0MCIgdmlld0JveD0iMCAwIDQwIDQwIj48Y2lyY2xlIGN4PSIyMCIgY3k9IjIwIiByPSIyMCIgZmlsbD0iIzMzMyIvPjxjaXJjbGUgY3g9IjIwIiBjeT0iMTUiIHI9IjYiIGZpbGw9IiM2NjYiLz48Y2lyY2xlIGN4PSIyMCIgY3k9IjMwIiByPSI5IiBmaWxsPSIjNjY2Ii8+PC9zdmc+'; };
    globalBtn.style.display = 'flex';
    globalBtn.onclick = function() {
        openGlobalChat();
    };
}

/**
 * Oculta y resetea el chat flotante cuando el usuario deja el equipo o la misión.
 */
function shutdownFloatingChat() {
    const chatButton = document.getElementById('floatingChatButton');
    const chatEmblem = document.getElementById('floatingChatEmblem'); 
    const chatWindow = document.getElementById('teamChatWindow');
    
    currentTeamChatId = null;
    currentTeamChatName = null;
    currentTeamChatRoster = null;
    if (chatButton) chatButton.style.display = 'none';
    if (chatEmblem) chatEmblem.src = 'dragon_profile_studiosgamesrs.png'; 
    if (chatWindow) {
         chatWindow.classList.remove('visible');
         chatWindow.style.display = 'none';
    }
    
    closeTeamChat(); 
}

/**
 * Abre la ventana del chat.
 * MODIFICADO: Ahora acepta un 'firebaseNode' para ser flexible (teamChats o missionChats).
 */
function openTeamChat(chatId, chatName, roster, firebaseNode = 'teamChats') {
    const authUser = firebase.auth().currentUser;
    if (!authUser || !currentUserData) return;

    currentChatTeamId = chatId;
    currentChatRoster = roster;
    currentChatFirebaseNode = firebaseNode;
    if (window.SGNotifications && typeof window.SGNotifications.setActivePrivateChat === 'function') {
        const dmPartnerUid = firebaseNode === 'privateChat'
            ? String(chatId).split('_').find(part => part && part !== authUser.uid)
            : null;
        window.SGNotifications.setActivePrivateChat(dmPartnerUid || null);
    }
    if (firebaseNode === 'teamChats') {
        currentTeamChatId = chatId;
        currentTeamChatName = chatName;
        currentTeamChatRoster = roster;
    } 

    const chatWindow = document.getElementById('teamChatWindow');
    const teamNameLink = document.getElementById('chatTeamNameLink');
    const chatForm = document.getElementById('teamChatForm');
    const imageUpload = document.getElementById('chatImageUpload');

    // Configurar encabezado 
    teamNameLink.textContent = chatName;
    // Enlace según tipo: equipo -> hub, misión -> PlayZone, global -> Comunidad.
    if (firebaseNode === 'globalChat') {
        teamNameLink.href = '/community';
    } else if (firebaseNode === 'playzoneMission') {
        teamNameLink.href = '/playzone?tab=active';
    } else if (firebaseNode === 'privateChat') {
        teamNameLink.href = '#';
        teamNameLink.onclick = (e) => e.preventDefault();
    } else {
        teamNameLink.href = firebaseNode === 'teamChats' ? '/competition-hub' : '/playzone';
    }
    teamNameLink.target = '_blank'; 

    // Asignar el formulario y subida de imagen con el nodo correcto
    if (chatForm) chatForm.onsubmit = (e) => handleChatFormSubmit(e, chatId, firebaseNode);
    if (imageUpload) imageUpload.onchange = (e) => handleImageUpload(e, chatId, firebaseNode);
    
    // Configurar el botón de emoji (simulado)
    const emojiBtn = document.getElementById('chatEmojiBtn'); 
    if (emojiBtn) emojiBtn.onclick = () => showFloatingMessage('success', "Función de Emojis próximamente!");

    // Configurar botón cerrar (siempre al abrir, para que funcione en chat de misión sin equipo)
    const closeChatBtn = document.getElementById('closeChatBtn');
    if (closeChatBtn) {
        closeChatBtn.onclick = () => {
            const cw = document.getElementById('teamChatWindow');
            if (cw) { cw.classList.remove('visible'); cw.style.display = 'none'; }
            const fb = document.getElementById('floatingChatButton');
            if (fb && isViewingOwnProfile) fb.style.display = 'flex';
            const fbGlobal = document.getElementById('floatingGlobalChatButton');
            if (fbGlobal) fbGlobal.style.display = 'flex';
            const fbPz = document.getElementById('floatingPlayZoneChatButton');
            if (fbPz && currentPlayZoneMissionChatId) fbPz.style.display = 'flex';
            closeTeamChat();
        };
    }

    // Mostrar ventana
    if (chatWindow) {
        chatWindow.style.display = 'flex';
        const chatButton = document.getElementById('floatingChatButton');
        const globalChatButton = document.getElementById('floatingGlobalChatButton');
        const playZoneChatButton = document.getElementById('floatingPlayZoneChatButton');
        if (firebaseNode === 'globalChat') {
            if (globalChatButton) globalChatButton.style.display = 'none';
            if (chatButton && isViewingOwnProfile) chatButton.style.display = 'flex';
            if (playZoneChatButton && currentPlayZoneMissionChatId) playZoneChatButton.style.display = 'flex';
            var statusWrap = document.getElementById('dashboardPlayerStatusWrap');
            if (statusWrap) { statusWrap.style.display = 'flex'; statusWrap.innerHTML = ''; }
            if (typeof initDashboardPlayerStatusInChat === 'function') initDashboardPlayerStatusInChat();
        } else if (firebaseNode === 'playzoneMission') {
            if (playZoneChatButton) playZoneChatButton.style.display = 'none';
            if (chatButton && isViewingOwnProfile) chatButton.style.display = 'flex';
            if (globalChatButton) globalChatButton.style.display = 'flex';
            var statusWrapPz = document.getElementById('dashboardPlayerStatusWrap');
            if (statusWrapPz) statusWrapPz.style.display = 'none';
        } else if (firebaseNode === 'privateChat') {
            if (playZoneChatButton && currentPlayZoneMissionChatId) playZoneChatButton.style.display = 'flex';
            if (chatButton && isViewingOwnProfile) chatButton.style.display = 'flex';
            if (globalChatButton && isViewingOwnProfile) globalChatButton.style.display = 'flex';
            var statusWrapDm = document.getElementById('dashboardPlayerStatusWrap');
            if (statusWrapDm) statusWrapDm.style.display = 'none';
        } else {
            if (chatButton) chatButton.style.display = 'none';
            if (globalChatButton) globalChatButton.style.display = 'flex';
            if (playZoneChatButton && currentPlayZoneMissionChatId) playZoneChatButton.style.display = 'flex';
            var statusWrapHide = document.getElementById('dashboardPlayerStatusWrap');
            if (statusWrapHide) statusWrapHide.style.display = 'none';
        }
        setTimeout(() => chatWindow.classList.add('visible'), 10);
    }
    
    // Cargar mensajes - PASAMOS EL NODO
    loadChatMessages(chatId, firebaseNode);
}

/**
 * Cierra la ventana del chat y limpia los listeners.
 */
function closeTeamChat() {
    if (window.SGNotifications && typeof window.SGNotifications.setActivePrivateChat === 'function') {
        window.SGNotifications.setActivePrivateChat(null);
    }
    if (currentChatMessagesRef && currentChatListener) {
        currentChatMessagesRef.off('value', currentChatListener);
    }
    currentChatListener = null;
    currentChatMessagesRef = null;
    currentChatTeamId = null;
    currentChatRoster = null;
    if (typeof stopGlobalChatBotTimerInDashboard === 'function') stopGlobalChatBotTimerInDashboard();

    // Limpiar lista de mensajes
    const chatList = document.getElementById('chatMessagesList');
    if (chatList) chatList.innerHTML = '';
}

/**
 * Abre el chat global (Fuego de Campamento) — mismo chat que en Community.
 */
function openGlobalChat() {
    if (!firebase.auth().currentUser || !currentUserData) {
        showFloatingMessage('info', 'Inicia sesión para usar el chat.');
        return;
    }
    openTeamChat('main', 'Fuego de Campamento', [], 'globalChat');
}

// --- Bot eventos Fuego de Campamento (compartido con Community) ---
const GLOBAL_CHAT_BOT_INTERVAL_MS = 5 * 60 * 1000;
const NEXUS_BOT_UID_GLOBAL = 'nexus_bot';
/** Pausado: no lanzar cofres/trivias aleatorias del Nexo Bot. */
const CAMPFIRE_BOT_EVENTS_ENABLED = false;
const TRIVIA_POOL_GLOBAL = [
    { q: '¿En qué mapa de CS:GO se juega "B" en un sitio con techo verde?', a: 'mirage' },
    { q: '¿Qué arma tiene el número 1 en el slot de rifle en CS:GO?', a: 'awp' },
    { q: '¿Cuántos jugadores por equipo en un match competitivo de Valorant?', a: '5' },
    { q: '¿Nombre del agente que pone humo con una flecha en Valorant?', a: 'sova' },
    { q: '¿En qué mapa de CS:GO hay un reloj gigante?', a: 'nuke' },
    { q: '¿Qué arma hace "dink" con casco en CS:GO?', a: 'deagle' }
];

function getGlobalChatBotRef() {
    return firebase.database().ref('globalChatBot/main');
}

function addCommunityHonorInDashboard(uid, points) {
    const ref = firebase.database().ref('users/' + uid);
    ref.transaction((current) => {
        const data = current || {};
        const newHonor = (data.communityHonor || 0) + points;
        return { ...data, communityHonor: newHonor };
    }).then(() => {
        if (uid === firebase.auth().currentUser.uid) showFloatingMessage('success', '+' + points + ' Honor');
    });
}

/** Integración con Pregonero: envía actividad al feed compartido (siteActivity) para que aparezca en Community. */
function pushSiteActivity(type, html) {
    try {
        const user = firebase.auth().currentUser;
        const nick = (currentUserData && currentUserData.nick) || (user && user.displayName) || 'Usuario';
        firebase.database().ref('siteActivity').push({
            type: type || 'dashboard',
            html: html,
            source: 'dashboard',
            userId: user ? user.uid : null,
            userNick: nick,
            timestamp: Date.now()
        });
    } catch (e) { /* silencio si falla */ }
}

function tryLaunchBotEventGlobalChat() {
    if (!CAMPFIRE_BOT_EVENTS_ENABLED) return;
    const authUser = firebase.auth().currentUser;
    if (!authUser) return;
    const botRef = getGlobalChatBotRef();
    const now = Date.now();
    botRef.once('value').then((snap) => {
        const d = snap.val() || {};
        const last = d.lastEventAt || 0;
        if (now - last < GLOBAL_CHAT_BOT_INTERVAL_MS) return;
        const eventType = Math.random() < 0.5 ? 'loot' : 'trivia';
        botRef.transaction((cur) => {
            const c = cur || {};
            if ((c.lastEventAt || 0) >= now - GLOBAL_CHAT_BOT_INTERVAL_MS) return undefined;
            if (eventType === 'loot') {
                return { lastEventAt: now, eventType: 'loot', lootEventId: null, lootClaimedBy: null };
            } else {
                const t = TRIVIA_POOL_GLOBAL[Math.floor(Math.random() * TRIVIA_POOL_GLOBAL.length)];
                return { lastEventAt: now, eventType: 'trivia', triviaQuestion: t.q, triviaAnswer: (t.a || '').toLowerCase(), triviaClaimedBy: null };
            }
        }).then(({ committed, snapshot }) => {
            if (!committed || !snapshot.val()) return;
            const v = snapshot.val();
            const messagesRef = firebase.database().ref('globalChat/main/messages');
            if (v.eventType === 'loot') {
                messagesRef.push({
                    userId: NEXUS_BOT_UID_GLOBAL,
                    userNick: 'Nexo Bot',
                    userPhoto: 'community.png',
                    text: '🎁 ¡Cofre de suministros desbloqueado! Escribe !loot para reclamar.',
                    type: 'bot',
                    timestamp: firebase.database.ServerValue.TIMESTAMP
                }).then((pushRef) => {
                    getGlobalChatBotRef().update({ lootEventId: pushRef.key });
                });
            } else if (v.eventType === 'trivia' && v.triviaQuestion) {
                messagesRef.push({
                    userId: NEXUS_BOT_UID_GLOBAL,
                    userNick: 'Nexo Bot',
                    userPhoto: 'community.png',
                    text: '❓ ' + v.triviaQuestion + ' (Responde en el chat con la respuesta correcta)',
                    type: 'bot',
                    timestamp: firebase.database.ServerValue.TIMESTAMP
                });
            }
        });
    });
}

let globalChatBotTimerId = null;
function startGlobalChatBotTimerInDashboard() {
    if (!CAMPFIRE_BOT_EVENTS_ENABLED) {
        stopGlobalChatBotTimerInDashboard();
        return;
    }
    if (globalChatBotTimerId) return;
    tryLaunchBotEventGlobalChat();
    globalChatBotTimerId = setInterval(tryLaunchBotEventGlobalChat, GLOBAL_CHAT_BOT_INTERVAL_MS + 10000);
}
function stopGlobalChatBotTimerInDashboard() {
    if (globalChatBotTimerId) {
        clearInterval(globalChatBotTimerId);
        globalChatBotTimerId = null;
    }
}

/**
 * Carga los últimos 30 mensajes y escucha nuevos.
 * MODIFICADO: Acepta un 'firebaseNode' para saber si es chat de equipo o misión.
 */
function loadChatMessages(chatId, firebaseNode = 'teamChats') {
    const messagesList = document.getElementById('chatMessagesList');
    if (!messagesList) return;
    if (!chatId) {
        messagesList.innerHTML = '<p style="color: #888; text-align: center; padding-top: 2rem;">Chat ready. Send a message to start.</p>';
        return;
    }
    
    messagesList.innerHTML = '<p style="color: #888; text-align: center; padding-top: 2rem;">Loading messages...</p>';
    
    const messagesRef = getChatMessagesRef(chatId, firebaseNode);
    
    if (currentChatMessagesRef && currentChatListener) {
        currentChatMessagesRef.off('value', currentChatListener);
    }

    const messagesQuery = (firebaseNode === 'globalChat' || firebaseNode === 'playzoneMission' || firebaseNode === 'privateChat')
        ? messagesRef.orderByChild('timestamp').limitToLast(50)
        : messagesRef.limitToLast(50);
    currentChatMessagesRef = messagesQuery;
    currentChatListener = messagesQuery.on('value', (snapshot) => {
        messagesList.innerHTML = '';
        if (!snapshot.exists() || !snapshot.hasChildren()) {
            messagesList.innerHTML = '<p style="color: #888; text-align: center; padding-top: 2rem;">No messages yet. Send one to start!</p>';
        } else {
            const items = [];
            snapshot.forEach((child) => {
                const msg = normalizePlayZoneChatMessage(child.val());
                if (msg) items.push(msg);
            });
            if (firebaseNode === 'playzoneMission' || firebaseNode === 'privateChat') {
                items.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
            }
            items.forEach((msg) => renderChatMessage(msg, messagesList));
            messagesList.scrollTop = messagesList.scrollHeight;
        }
    }, (error) => {
        console.error("Error loading chat messages:", error);
        messagesList.innerHTML = '<p style="color: #888; text-align: center; padding-top: 2rem;">Chat ready. Send a message to start.</p>';
    });
    if (firebaseNode === 'globalChat') startGlobalChatBotTimerInDashboard();
}

let lastBattleCallTimestampDashboard = 0;
function initBattleCallListenerDashboard() {
    const authUser = firebase.auth().currentUser;
    if (!authUser) return;
    try {
        firebase.database().ref('battleCalls/latest').on('value', (snap) => {
            const d = snap.val();
            if (!d || !d.timestamp) return;
            if (d.authorId === authUser.uid && Date.now() - d.timestamp < 3000) return;
            if (d.timestamp <= lastBattleCallTimestampDashboard) return;
            lastBattleCallTimestampDashboard = d.timestamp;
            const msg = '📯 ¡Llamada a Batalla! ' + (d.authorNick || 'Alguien') + ': ' + (d.title || '') + ' (' + (d.game || '') + ')';
            showBattleCallToastDashboard(msg);
            playCornetSoundDashboard();
        });
    } catch (e) {}
}

function showBattleCallToastDashboard(message) {
    let container = document.querySelector('.battle-call-toast-container');
    if (!container) {
        container = document.createElement('div');
        container.className = 'battle-call-toast-container';
        container.style.cssText = 'position:fixed;top:80px;left:50%;transform:translateX(-50%);z-index:10000;pointer-events:none;';
        document.body.appendChild(container);
    }
    const toast = document.createElement('div');
    toast.className = 'battle-call-toast';
    toast.style.cssText = 'padding:0.9rem 1.4rem;background:linear-gradient(135deg,#e53935 0%,#b42828 100%);color:#fff;border-radius:12px;box-shadow:0 8px 32px rgba(229,57,53,0.4);font-weight:600;font-size:0.95rem;opacity:0;transform:translateY(-10px);transition:opacity 0.3s,transform 0.3s;max-width:min(420px,90vw);';
    toast.innerHTML = '<i class="fas fa-trumpet" style="margin-right:0.5rem;color:#ffb347"></i> ' + message;
    container.appendChild(toast);
    setTimeout(() => toast.style.cssText = toast.style.cssText.replace('opacity:0', 'opacity:1').replace('translateY(-10px)', 'translateY(0)'), 10);
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(-10px)';
        setTimeout(() => toast.remove(), 300);
    }, 6000);
}

function playCornetSoundDashboard() {
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.frequency.setValueAtTime(400, ctx.currentTime);
        osc.frequency.setValueAtTime(600, ctx.currentTime + 0.1);
        osc.frequency.setValueAtTime(400, ctx.currentTime + 0.2);
        gain.gain.setValueAtTime(0.15, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.4);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.4);
    } catch (e) {}
}

var presenceRefDashboard = null;
var presenceByUidDashboard = {};
var PLAYER_STATUSES_DASHBOARD = [
    { value: '', label: 'En línea', emoji: '🟢' },
    { value: 'buscando_partida', label: 'Buscando partida', emoji: '🟢' },
    { value: 'en_partida', label: 'En partida', emoji: '🔴' },
    { value: 'forjando_estrategias', label: 'Forjando estrategias', emoji: '🟣' }
];

function initPresenceDashboard() {
    const authUser = firebase.auth().currentUser;
    if (!authUser || !currentUserData) return;
    try {
        presenceRefDashboard = firebase.database().ref('presence/' + authUser.uid);
        firebase.database().ref().child('presence').child(authUser.uid).onDisconnect().set(null);
        const status = currentUserData.status || null;
        presenceRefDashboard.set({ online: true, nick: currentUserData.nick || 'Usuario', since: Date.now(), status: status || null });
        firebase.database().ref('presence').on('value', (snap) => {
            presenceByUidDashboard = snap.val() || {};
        });
    } catch (e) {}
}

function initDashboardPlayerStatusInChat() {
    const wrap = document.getElementById('dashboardPlayerStatusWrap');
    if (!wrap) return;
    wrap.style.display = 'flex';
    wrap.innerHTML = '';
    const select = document.createElement('select');
    select.title = 'Estado';
    select.style.cssText = 'background:rgba(255,255,255,0.1);color:#fff;border:1px solid rgba(255,255,255,0.2);padding:4px 8px;border-radius:6px;font-size:12px;';
    PLAYER_STATUSES_DASHBOARD.forEach(function(s) {
        var opt = document.createElement('option');
        opt.value = s.value;
        opt.textContent = s.emoji + ' ' + s.label;
        select.appendChild(opt);
    });
    wrap.appendChild(select);
    select.addEventListener('change', function() {
        var v = this.value;
        if (presenceRefDashboard) presenceRefDashboard.update({ status: v || null });
        firebase.database().ref('users/' + firebase.auth().currentUser.uid).update({ status: v || null }).catch(function() {});
    });
}

/**
 * Renderiza un solo mensaje en la ventana del chat.
 */
function renderChatMessage(messageData, container) {
    messageData = normalizePlayZoneChatMessage(messageData);
    if (!messageData) return;
    const authUser = firebase.auth().currentUser;
    if (!authUser) return;

    const msgUid = messageData.userId || messageData.senderUid;
    const isMine = msgUid === authUser.uid;
    const item = document.createElement('div');
    
    // Clases base
    let itemClasses = ['message-item'];
    itemClasses.push(isMine ? 'mine' : 'theirs');
    itemClasses.push(messageData.type || 'text');
    
    item.className = itemClasses.join(' ');
    
    let avatarHTML = '';
    let authorHTML = '';
    
    // Mensajes del sistema (transferencia) no tienen autor
    if (messageData.type !== 'transfer') {
        const isBot = messageData.type === 'bot' || msgUid === 'nexus_bot';
        const defaultAvatar = (typeof currentChatFirebaseNode !== 'undefined' && currentChatFirebaseNode === 'globalChat') ? 'community.png' : 'dragon_profile_studiosgamesrs.png';
        avatarHTML = `
            <img src="${isBot ? 'community.png' : (messageData.photoURL || messageData.userPhoto || defaultAvatar)}" 
                 alt="${messageData.nick || messageData.userNick || 'User'}" 
                 class="message-avatar"
                 onmouseenter="showUserPopup(this, '${msgUid}')"
                 onmouseleave="hideUserPopup()"
                 onclick="window.location.href='/dashboard?uid=${msgUid}'">
        `;
        
        if (!isMine) {
            var pres = (typeof currentChatFirebaseNode !== 'undefined' && currentChatFirebaseNode === 'globalChat' && presenceByUidDashboard[msgUid]) ? presenceByUidDashboard[msgUid] : null;
            var statusInfo = pres && pres.status ? (PLAYER_STATUSES_DASHBOARD.find(function(s) { return s.value === pres.status; }) || null) : null;
            var statusHtml = statusInfo ? '<span class="message-status-badge" title="' + (statusInfo.label || '') + '">' + statusInfo.emoji + '</span>' : '';
            authorHTML = `
                <span class="message-author ${isBot ? 'message-author-bot' : ''}"
                      onmouseenter="showUserPopup(this, '${msgUid}')"
                      onmouseleave="hideUserPopup()"
                      onclick="window.location.href='/dashboard?uid=${msgUid}'">
                    ${statusHtml}${messageData.nick || messageData.userNick || 'Unknown'}
                </span>
            `;
        }
    }

    // --- Construir contenido del mensaje ---
    let messageContentHTML = '';
    
    if (messageData.text) {
        messageContentHTML += `<div class="message-text-content">${messageData.text}</div>`;
    }
    
    if (messageData.imageUrl) {
        if (!messageData.text) {
             // Si solo hay imagen, añadir clase para ocultar burbuja vacía
            item.classList.add('image-only');
        }
        messageContentHTML += `<img src="${messageData.imageUrl}" class="message-image" alt="Uploaded Image">`;
    }
    
    // Caso especial para transferencias (ignora todo lo demás)
    if (messageData.type === 'transfer') {
        item.innerHTML = `
            <div class="message-bubble">
                <div class="message-content">
                    <i class="fas fa-coins"></i> ${messageData.text}
                </div>
            </div>
        `;
    } else {
        // Renderizado estándar
        item.innerHTML = `
            ${avatarHTML}
            <div class="message-bubble">
                ${authorHTML}
                <div class="message-content">
                    ${messageContentHTML}
                </div>
            </div>
        `;
    }

    container.appendChild(item);
}

/**
 * Maneja el envío del formulario de chat.
 * MODIFICADO: Acepta un 'firebaseNode' para saber si es chat de equipo o misión.
 */
function handleChatFormSubmit(e, chatId, firebaseNode = 'teamChats') {
    e.preventDefault();
    const authUser = firebase.auth().currentUser;
    if (!authUser || !currentUserData) return;

    const textInput = document.getElementById('chatMessageInput');
    const messageText = textInput.value.trim();
    if (messageText.length === 0) return;
    
    let messageType = 'text';
    let processedText = messageText;
    
    // Comprobar comando (/)
    if (messageText.startsWith('(/)')) {
        messageType = 'important';
        processedText = messageText.substring(3).trim(); // Quitar el (/)
    }
    
    const messageData = {
        userId: authUser.uid,
        nick: currentUserData.nick || 'Unknown',
        photoURL: currentUserData.photoURL || 'dragon_profile_studiosgamesrs.png',
        text: processedText,
        type: messageType,
        timestamp: firebase.database.ServerValue.TIMESTAMP
    };
    if (firebaseNode === 'playzoneMission') {
        messageData.senderUid = authUser.uid;
    }

    const doPushMessage = () => {
        const pushRef = (firebaseNode === 'playzoneMission' || firebaseNode === 'privateChat')
            ? getChatMessagesRef(chatId, firebaseNode)
            : firebase.database().ref(`${firebaseNode}/${chatId}/messages`);
        pushRef.push(messageData)
            .catch(error => {
                console.error("Error sending message:", error);
                showFloatingMessage("error", "Error sending message.");
            });
        textInput.value = '';
    };

    if (firebaseNode === 'globalChat') {
        const botRef = getGlobalChatBotRef();
        botRef.once('value').then((snap) => {
            const d = snap.val() || {};
            const lower = messageText.toLowerCase();
            let claimed = false;
            if (lower === '!loot' && d.lootEventId && !d.lootClaimedBy) {
                claimed = true;
                botRef.update({ lootClaimedBy: authUser.uid }).then(() => {
                    addCommunityHonorInDashboard(authUser.uid, 25);
                    if (typeof pushSiteActivity === 'function') { const _s = (x) => (x || '').replace(/</g, '&lt;').replace(/>/g, '&gt;'); pushSiteActivity('honor', `<strong>${_s(currentUserData.nick)}</strong> reclamó el Cofre de suministros (+25 Honor)`); }
                    showFloatingMessage('success', '¡Cofre reclamado! +25 Honor');
                    textInput.value = '';
                    firebase.database().ref('globalChat/main/messages').push({
                        userId: NEXUS_BOT_UID_GLOBAL,
                        userNick: 'Nexo Bot',
                        userPhoto: 'community.png',
                        text: '🎉 ¡' + (currentUserData.nick || 'Alguien') + ' ha reclamado el cofre! +25 Honor.',
                        type: 'bot',
                        timestamp: firebase.database.ServerValue.TIMESTAMP
                    });
                });
            } else if (d.triviaAnswer && !d.triviaClaimedBy && lower === (d.triviaAnswer || '').toLowerCase()) {
                claimed = true;
                botRef.update({ triviaClaimedBy: authUser.uid }).then(() => {
                    addCommunityHonorInDashboard(authUser.uid, 15);
                    if (typeof pushSiteActivity === 'function') { const _s = (x) => (x || '').replace(/</g, '&lt;').replace(/>/g, '&gt;'); pushSiteActivity('honor', `<strong>${_s(currentUserData.nick) || 'Alguien'}</strong> acertó la trivia (+15 Honor)`); }
                    showFloatingMessage('success', '¡Respuesta correcta! +15 Honor');
                    textInput.value = '';
                    firebase.database().ref('globalChat/main/messages').push({
                        userId: NEXUS_BOT_UID_GLOBAL,
                        userNick: 'Nexo Bot',
                        userPhoto: 'community.png',
                        text: '✅ ¡' + (currentUserData.nick || 'Alguien') + ' acertó la trivia! +15 Honor.',
                        type: 'bot',
                        timestamp: firebase.database.ServerValue.TIMESTAMP
                    });
                });
            }
            if (!claimed) {
                if (typeof pushSiteActivity === 'function') { const _s = (x) => (x || '').replace(/</g, '&lt;').replace(/>/g, '&gt;'); pushSiteActivity('chat', `<strong>${_s(currentUserData.nick) || 'Alguien'}</strong> en el Fuego de Campamento`); }
                doPushMessage();
            }
        });
    } else {
        doPushMessage();
    }
}

/**
 * Maneja la subida de una imagen al chat.
 * MODIFICADO: Acepta un 'firebaseNode' para saber si es chat de equipo o misión.
 */
async function handleImageUpload(e, chatId, firebaseNode = 'teamChats') {
    const file = e.target.files[0];
    if (!file) return;
    const authUser = firebase.auth().currentUser;
    if (!authUser || !currentUserData) return;

    // Restricción 1: Tipo de archivo
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
        showFloatingMessage("error", "Invalid file type. Please use PNG, JPEG, or WEBP.");
        e.target.value = null; // Reset input
        return;
    }
    
    // Restricción 2: Tamaño de archivo (2MB)
    const MAX_SIZE = 2 * 1024 * 1024;
    if (file.size > MAX_SIZE) {
        showFloatingMessage("error", "File is too large (Max 2MB).");
        e.target.value = null; // Reset input
        return;
    }

    const textInput = document.getElementById('chatMessageInput');
    const messageText = textInput.value.trim(); // Coger texto si hay
    textInput.value = ''; // Limpiar input
    
    showFloatingMessage("success", "Uploading image...");

    try {
        const storageRef = firebase.storage().ref(`chat_images/${chatId}/${Date.now()}_${file.name}`);
        const snapshot = await storageRef.put(file);
        const downloadURL = await snapshot.ref.getDownloadURL();
        
        // Ahora, publicar el mensaje en la BD
        const messageData = {
            userId: authUser.uid,
            nick: currentUserData.nick || 'Unknown',
            photoURL: currentUserData.photoURL || 'dragon_profile_studiosgamesrs.png',
            text: messageText || null, // Guardar texto si había
            type: 'image',
            imageUrl: downloadURL,
            timestamp: firebase.database.ServerValue.TIMESTAMP
        };
        
        // Publicar usando el nodo correcto
        await firebase.database().ref(`${firebaseNode}/${chatId}/messages`).push(messageData);

    } catch (error) {
        console.error("Error uploading image:", error);
        showFloatingMessage("error", "Failed to upload image.");
    } finally {
        e.target.value = null; // Reset input para poder subir la misma imagen de nuevo
    }
}

/**
 * Abre el modal para transferir tokens.
 */
async function openTokenTransferModal(teamId, roster) {
  // ... (Se mantiene igual)
    const modal = document.getElementById('tokenTransferModal');
    const closeBtn = document.getElementById('closeTokenTransferModal');
    const form = document.getElementById('tokenTransferForm');
    const select = document.getElementById('transferMemberSelect');
    
    const authUser = firebase.auth().currentUser;
    if (!authUser) return;

    modal.style.display = 'flex';
    select.innerHTML = '<option value="">Loading members...</option>';
    select.disabled = true;
    
    const myRole = roster[authUser.uid].role;

    try {
        // Necesitamos los nicks, así que buscamos los datos de los usuarios del roster
        const userPromises = Object.keys(roster)
            .filter(uid => uid !== authUser.uid) // Excluirme a mí mismo
            .map(uid => firebase.database().ref(`users/${uid}`).once('value'));
            
        const userSnapshots = await Promise.all(userPromises);
        
        select.innerHTML = ''; // Limpiar "Loading"
        let memberCount = 0;
        
        userSnapshots.forEach(snap => {
            const userData = snap.val();
            const uid = snap.key;
            const userRole = roster[uid].role;
            
            // Si soy Capitán, muestro a todos los Miembros
            if (myRole === 'Captain' && userRole === 'Member') {
                select.innerHTML += `<option value="${uid}">${userData.nick || 'Unknown'}</option>`;
                memberCount++;
            }
            // Si soy Miembro, solo muestro al Capitán
            else if (myRole === 'Member' && userRole === 'Captain') {
                 select.innerHTML += `<option value="${uid}">${userData.nick || 'Unknown'} (Captain)</option>`;
                 memberCount++;
            }
        });

        if (memberCount === 0) {
            select.innerHTML = '<option value="">No members to transfer to</option>';
            select.disabled = true;
        } else {
            select.disabled = false;
        }

    } catch (error) {
        console.error("Error loading members for transfer:", error);
        select.innerHTML = '<option value="">Error loading members</option>';
    }

    // Asignar listeners
    closeBtn.onclick = () => modal.style.display = 'none';
    form.onsubmit = (e) => handleTokenTransferSubmit(e, teamId);
}

/**
 * Maneja el envío del formulario de transferencia (envía la solicitud).
 */
async function handleTokenTransferSubmit(e, teamId) {
  // ... (Se mantiene igual)
    e.preventDefault();
    
    const authUser = firebase.auth().currentUser;
    if (!authUser || !currentUserData) return;

    const select = document.getElementById('transferMemberSelect');
    const amountInput = document.getElementById('transferAmountInput');
    const confirmBtn = document.getElementById('confirmTransferBtn');

    const toUserId = select.value;
    const amount = parseInt(amountInput.value, 10);
    
    // --- Validación del Cliente ---
    if (!toUserId) {
        showFloatingMessage("error", "Please select a member.");
        return;
    }
    if (isNaN(amount) || amount <= 0) {
        showFloatingMessage("error", "Please enter a valid amount.");
        return;
    }
    // (Opcional: Comprobar balance local si 'currentUserData.tokens' está disponible)
    if (currentUserData.tokens < amount) {
         showFloatingMessage("error", "Insufficient token balance.");
         return;
    }
    
    confirmBtn.disabled = true;
    confirmBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Processing...';
    
    try {
        // --- ENVÍO SEGURO A LA CLOUD FUNCTION ---
        // Escribimos una 'solicitud' que la Cloud Function procesará.
        const requestRef = firebase.database().ref('tokenTransferRequests').push();
        await requestRef.set({
            fromUserId: authUser.uid,
            toUserId: toUserId,
            amount: amount,
            teamId: teamId,
            status: 'pending',
            timestamp: firebase.database.ServerValue.TIMESTAMP
        });
        
        showFloatingMessage("success", "Transfer request sent successfully!");
        document.getElementById('tokenTransferModal').style.display = 'none';
        amountInput.value = '';

    } catch (error) {
        console.error("Error sending transfer request:", error);
        showFloatingMessage("error", "Error sending request. Try again.");
    } finally {
        confirmBtn.disabled = false;
        confirmBtn.innerHTML = '<i class="fas fa-check-circle"></i> Confirmar Transferencia';
    }
}

// ==================================================================
// --- FIN: CÓDIGO DE CHAT Y DEPENDENCIAS (REFRACTORIZADO Y FLEXIBLE) ---
// ==================================================================

// ==================================================================
// --- INICIO: FUNCIÓN DE RESTRICCIÓN SOFT GATING (MEJORADA) ---
// ==================================================================
function activarModoRestringido(user) {
    // 1. Mostrar un Banner Fijo en la parte superior del Dashboard
    const banner = document.createElement("div");
    banner.style.background = "linear-gradient(90deg, #b71c1c, #e53935)";
    banner.style.color = "white";
    banner.style.textAlign = "center";
    banner.style.padding = "12px 20px";
    banner.style.fontWeight = "bold";
    banner.style.fontSize = "0.9rem";
    banner.style.boxShadow = "0 4px 15px rgba(229, 57, 53, 0.4)";
    banner.style.position = "sticky";
    banner.style.top = "0";
    banner.style.zIndex = "10000";
    // Determinar qué texto mostrar dependiendo de si ya tiene correo o no
    const actionText = user.email ? "Reenviar correo de activación" : "Vincular un correo para verificar";

    banner.innerHTML = `
      <i class="fas fa-lock"></i> ¡Acceso Limitado! Tu cuenta de Steam es segura, pero debes verificar tu correo para jugar. 
      <a href="#" id="btnReenviarCorreo" style="color: #ffca3a; text-decoration: underline; margin-left: 10px; cursor: pointer;">
        ${actionText}
      </a>
    `;
    document.body.prepend(banner);

    // Lógica para reenviar el correo desde el banner superior
    setTimeout(() => {
        const btnReenviar = document.getElementById('btnReenviarCorreo');
        if (btnReenviar) {
            btnReenviar.addEventListener('click', function(e) {
                e.preventDefault();
                this.innerText = "Enviando...";
                this.style.pointerEvents = "none";
                enviarCorreoVerificacion(user, this);
            });
        }
    }, 500);

    // 2. CONVERTIR EL BADGE DE ESTADO EN UN BOTÓN DE VERIFICACIÓN
    setTimeout(() => {
        const statusBadge = document.getElementById('verifiedStatusBadge');
        if (statusBadge) {
            statusBadge.classList.remove('verified');
            statusBadge.classList.add('not-verified');
            
            // Cambiamos el diseño para que parezca un botón de acción
            statusBadge.innerHTML = '<i class="fas fa-envelope"></i><span class="account-badge-text" id="textVerificarBadge" aria-hidden="true">Validar Email</span>';
            statusBadge.style.cursor = "pointer";
            statusBadge.style.background = "rgba(229, 57, 53, 0.3)";
            statusBadge.style.border = "1px solid #ffca3a"; // Borde dorado para llamar la atención
            statusBadge.style.boxShadow = "0 0 10px rgba(255, 202, 58, 0.3)";
            statusBadge.title = "Haz clic aquí para reenviar el correo de activación";

            // Evento para reenviar el correo al hacer clic en el badge del perfil
            statusBadge.onclick = function() {
                const spanText = document.getElementById('textVerificarBadge');
                if (spanText.innerText === "Enviando...") return; // Evitar doble clic
                
                spanText.innerText = "Enviando...";
                statusBadge.style.pointerEvents = "none";
                enviarCorreoVerificacion(user, spanText, statusBadge);
            };
        }

        // 3. Bloquear el widget de PlayZone
        const playZone = document.getElementById('playZoneWidget');
        if (playZone) {
            playZone.style.opacity = "0.4";
            playZone.style.filter = "grayscale(100%)";
            playZone.style.pointerEvents = "none"; 
            const playZoneTitle = playZone.querySelector('.playzone-title');
            if (playZoneTitle) playZoneTitle.innerHTML += ' <i class="fas fa-lock" style="color: #e53935; float: right;"></i>';
        }

        // 4. Bloquear el widget Competitivo
        const compWidget = document.getElementById('competitiveWidget');
        if (compWidget) {
            compWidget.style.opacity = "0.4";
            compWidget.style.filter = "grayscale(100%)";
            compWidget.style.pointerEvents = "none";
            const compTitle = compWidget.querySelector('.competitive-title');
            if (compTitle) compTitle.innerHTML += ' <i class="fas fa-lock" style="color: #e53935; float: right;"></i>';
        }
        
        // 5. Bloquear los botones del Nexus
        const nexusRow = document.getElementById('nexusActionsRow');
        if (nexusRow) {
             const btns = nexusRow.querySelectorAll('.nexus-main-btn');
             btns.forEach(btn => {
                  btn.style.opacity = "0.5";
                  btn.style.cursor = "not-allowed";
                  btn.onclick = (e) => {
                       e.preventDefault();
                       e.stopPropagation();
                       alert("Debes verificar tu correo para acceder a estas funciones.");
                  };
             });
        }
    }, 500); 
}

// Helper: Función centralizada para llamar a correos de verificación
async function enviarCorreoVerificacion(user, textElement, containerElement = null) {
    try {
        let targetEmail = user.email;

        // 1. SI ES UNA CUENTA FANTASMA DE STEAM
        if (!targetEmail) {
            // TODO: En el futuro reemplazaremos este prompt por un modal HTML temático
            const inputEmail = prompt("Tu cuenta de Steam es válida, pero aún no tiene un correo asociado.\n\nPor favor, ingresa tu dirección de correo electrónico para vincularla y recibir el enlace de activación:");

            if (!inputEmail || !inputEmail.includes('@')) {
                showFloatingMessage("error", "Operación cancelada. Debes ingresar un correo válido.");
                textElement.innerText = containerElement ? "Validar Email" : "Vincular correo";
                return;
            }
            targetEmail = inputEmail; 
        }

        // ---------------------------------------------------------------------
        // 2. ENVIAR DIRECTO A TU PHP
        // ---------------------------------------------------------------------
        textElement.innerText = "Enviando correo...";
        
        // Obtenemos el nick directamente del HTML como acordamos
        let nick = "Guerrero";
        const nameUI = document.getElementById("profileNickname");
        if (nameUI && nameUI.innerText.trim() !== "" && nameUI.innerText !== "User" && nameUI.innerText !== "Cargando...") {
            nick = nameUI.innerText.trim();
        } else if (typeof currentUserData !== 'undefined' && currentUserData && currentUserData.nick) {
            nick = currentUserData.nick;
        } else if (user.displayName) {
            nick = user.displayName;
        }

        const params = new URLSearchParams({ email: targetEmail, nickname: nick, uid: user.uid });

        const res = await fetch("send_verification.php", {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: params
        });

        // 3. LA MAGIA RESILIENTE: Extraer JSON saltándose las advertencias
        const textResponse = await res.text(); 
        let data;
        
        try {
            // Buscamos exactamente el inicio y el fin del JSON
            const jsonStart = textResponse.indexOf('{');
            const jsonEnd = textResponse.lastIndexOf('}') + 1;
            
            if (jsonStart !== -1 && jsonEnd !== -1) {
                const cleanJsonStr = textResponse.substring(jsonStart, jsonEnd);
                data = JSON.parse(cleanJsonStr); // Parseamos la parte limpia
            } else {
                throw new Error("No se encontró JSON válido.");
            }

            if (data.success) {
                // Sincronización visual local
                if (!user.email) {
                    await user.getIdToken(true);
                    await user.reload();
                }

                // USAMOS TU SISTEMA TEMÁTICO EN VEZ DE ALERT
                showFloatingMessage("success", "¡Enlace de activación enviado a " + targetEmail + "!");
                textElement.innerText = "Revisar Correo ✔";
            } else {
                showFloatingMessage("error", "Error del servidor: " + (data.error || data.message || "No se pudo enviar."));
                textElement.innerText = containerElement ? "Validar Email" : "Reenviar correo";
            }
        } catch (jsonError) {
            console.error("Respuesta cruda del PHP:", textResponse);
            // Si el rescate falla, asumimos que se envió porque el PHP casi siempre termina su trabajo
            showFloatingMessage("success", "¡Enlace enviado! Revisa la bandeja de " + targetEmail);
            textElement.innerText = "Revisar Correo ✔";
        }

    } catch (err) {
        console.error("Error de conexión:", err);
        showFloatingMessage("error", "Hubo un error de red al intentar conectar con el servidor.");
        textElement.innerText = containerElement ? "Validar Email" : "Vincular correo";
    }

    // Desbloqueo de seguridad
    setTimeout(() => {
        if (textElement.innerText.includes("Revisar Correo")) {
            textElement.innerText = containerElement ? "Validar Email" : "Reenviar correo";
        }
        if (containerElement) containerElement.style.pointerEvents = "auto";
        else textElement.style.pointerEvents = "auto";
    }, 15000);
}
// ==================================================================
// --- FIN: FUNCIÓN DE RESTRICCIÓN SOFT GATING ---
// ==================================================================