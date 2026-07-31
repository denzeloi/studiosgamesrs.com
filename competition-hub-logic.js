/* ======== JAVASCRIPT FOR competition-hub-logic.js (VERSIÓN FINAL Y HARDENED) ======== */

if (typeof firebase !== 'undefined') {
    if (typeof sgInitFirebaseApp === 'function') {
        sgInitFirebaseApp();
    } else if (window.SG_FIREBASE_CONFIG && (!firebase.apps || !firebase.apps.length)) {
        firebase.initializeApp(window.SG_FIREBASE_CONFIG);
    }
    // Necesario para el nuevo sistema de torneos
    // NOTA: Asegúrate de que tournament-system.js se cargue ANTES de esta lógica.
    // MODIFICACIÓN: Chequeo de existencia para evitar ReferenceError si tournament-system.js falla
    function initTournamentCreationWhenReady() {
        if (typeof initializeTournamentCreation === 'function') {
            initializeTournamentCreation();
        }
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initTournamentCreationWhenReady);
    } else {
        initTournamentCreationWhenReady();
    }
}

// Global state
let invitedMembers = [];
let currentUser = null;
let currentUserData = null; // To store user rank and teamId
let popupTimeout; // Timeout for hiding the popup card
let currentConfirmCallback = null; // Store the callback for the confirmation modal

// --- INICIO: Globales para el Chat ---
let currentChatListener = null; // Almacena el listener de Firebase para poder apagarlo
let currentChatTeamId = null; // Almacena el ID del equipo del chat actual
let currentChatRoster = null; // Almacena el roster del equipo actual
// --- FIN: Globales para el Chat ---

const teamFunctions = (typeof firebase !== 'undefined' && firebase.functions) ? firebase.functions() : null;

function teamFnErrorMessage(err, fallback) {
    if (err && err.code === 'functions/already-exists') return err.message || fallback;
    if (err && err.code === 'functions/permission-denied') return err.message || 'Permiso denegado.';
    if (err && err.code === 'functions/resource-exhausted') return err.message || 'El equipo está lleno.';
    return (err && err.message) ? err.message : fallback;
}

// ==================================================================
// --- Permisos base por rango ---
// ==================================================================
function getPermisosRango(rango) {
  if (!rango) return {};
  rango = rango.toLowerCase();
  if (rango === "commander" || rango === "boss_of_the_state") {
    return {
      puedeCrearTorneos: true,
      accesoTotal: true,
      prioridad: 3,
    };
  }
  if (rango === "boss_of_the_state") {
    return {
      puedeCrearTorneos: true,
      accesoTotal: true,
      prioridad: 4,
    };
  }
  return { puedeCrearTorneos: false, accesoTotal: false, prioridad: 1 };
}
// ==================================================================


document.addEventListener("DOMContentLoaded", function () {
    firebase.auth().onAuthStateChanged(user => {
        if (!user) {
            window.location.href = "login.html";
            return;
        }
        currentUser = user;

        loadTopTeams();

        const tabs = document.querySelectorAll('.hub-toggle-btn');
        tabs.forEach(tab => {
            tab.addEventListener('click', () => {
                document.querySelector('.hub-toggle-btn.active').classList.remove('active');
                tab.classList.add('active');
                loadAllTournaments();
            });
        });

        initializeDynamicHub(user).finally(function () {
            loadAllTournaments();
        });
        initializeInvitePlayerModal();
        if (window.SGTournamentOrganizer) {
            SGTournamentOrganizer.init({
                getUser: function () { return currentUser; },
                getUserData: function () { return currentUserData; },
                canOrganize: function (ud) {
                    return SGTournamentOrganizer.rankCanOrganize(ud);
                },
                sanitizeText: sanitizeText,
                notify: function (type, msg) { showNotification(msg, type === 'error' ? 'error' : 'success'); },
                fnError: teamFnErrorMessage,
                onTournamentCreated: function () { loadAllTournaments(); }
            });
        }

        // --- EXPLORAR EQUIPOS (lupa en Top Teams) ---
        const openBrowserBtn = document.getElementById('openTeamBrowserBtn');
        if (openBrowserBtn) openBrowserBtn.addEventListener('click', openTeamBrowser);
        // Misma lupa/función también en "Or Join an Existing Team".
        const openBrowserBtn2 = document.getElementById('openTeamBrowserBtn2');
        if (openBrowserBtn2) openBrowserBtn2.addEventListener('click', openTeamBrowser);
        const browserModal = document.getElementById('teamBrowserModal');
        const closeBrowserBtn = document.getElementById('closeTeamBrowserModal');
        if (closeBrowserBtn) closeBrowserBtn.addEventListener('click', () => { if (browserModal) browserModal.style.display = 'none'; });
        if (browserModal) browserModal.addEventListener('click', (e) => { if (e.target === browserModal) browserModal.style.display = 'none'; });
        const browserSearch = document.getElementById('teamBrowserSearch');
        if (browserSearch) browserSearch.addEventListener('input', () => renderTeamBrowserList(browserSearch.value));

        // --- APARIENCIA DE GRUPO (cerrar al hacer clic fuera) ---
        const appearanceModal = document.getElementById('teamAppearanceModal');
        if (appearanceModal) appearanceModal.addEventListener('click', (e) => { if (e.target === appearanceModal) appearanceModal.style.display = 'none'; });

        // --- GLOBAL EVENT LISTENERS ---
        // Close dropdown
        document.addEventListener('click', function(event) {
            const dropdownContainer = document.querySelector('.member-actions-container');
            const dropdownMenu = document.getElementById('memberActionsDropdown');
            if (dropdownContainer && dropdownMenu && !dropdownContainer.contains(event.target)) {
                dropdownMenu.style.display = 'none';
            }
        });
        // Close confirmation modal
        const closeConfModalBtn = document.getElementById('closeConfirmationModal');
        const cancelConfBtn = document.getElementById('cancelBtn');
        const confirmationModal = document.getElementById('confirmationModal');
        if(closeConfModalBtn) closeConfModalBtn.addEventListener('click', () => confirmationModal.style.display = 'none');
        if(cancelConfBtn) cancelConfBtn.addEventListener('click', () => confirmationModal.style.display = 'none');
        if(confirmationModal) confirmationModal.addEventListener('click', (event) => {
            if (event.target === confirmationModal) { // Click on background
                confirmationModal.style.display = 'none';
            }
        });
        // Confirmation button listener (defined once)
        const confirmBtn = document.getElementById('confirmBtn');
        if(confirmBtn) confirmBtn.addEventListener('click', () => {
            if (typeof currentConfirmCallback === 'function') {
                currentConfirmCallback(); // Execute the stored callback
            }
            confirmationModal.style.display = 'none'; // Close modal
            currentConfirmCallback = null; // Clear callback
        });
        // --- END GLOBAL EVENT LISTENERS ---
    });
});

/**
 * Main function to get user data and decide which Hub view to display.
 */
async function initializeDynamicHub(user) {
    const userRef = firebase.database().ref(`users/${user.uid}`);
    try {
        const snapshot = await userRef.once('value');
        currentUserData = snapshot.val();
        
        initializeHubSearch(); 
        
        const teamId = currentUserData ? currentUserData.teamId : null;
        const userRank = currentUserData ? currentUserData.rango : 'tribal_warrior';
        const userPermissions = getPermisosRango(userRank); 

        updateCompetitionStatus(user.uid, teamId);

        const createTeamCard = document.getElementById('createTeamCard');
        const teamDashboardCard = document.getElementById('teamDashboardCard');

        if (teamId) {
            createTeamCard.style.display = 'none';
            teamDashboardCard.style.display = 'block';
            loadTeamDashboard(teamId, user.uid);
        } else {
            createTeamCard.style.display = 'block';
            teamDashboardCard.style.display = 'none';
            loadJoinableTeams(user.uid);
            loadReceivedInvites(user.uid); 
        }
        initializeModal(user, userRank);
    } catch (error) {
        console.error("Error getting user data:", error);
        showNotification("Error loading your profile data.", "error"); 
        document.getElementById('createTeamCard').style.display = 'block';
        document.getElementById('teamDashboardCard').style.display = 'none';
        initializeModal(user, 'tribal_warrior');
    }
}


/**
 * Updates the 'My Competitive Status' widget.
 */
async function updateCompetitionStatus(userId, teamId) {
    const teamStatusContainer = document.getElementById('teamStatus');

    // Clear containers
    teamStatusContainer.innerHTML = '<p>Loading status...</p>';

    if (teamId) {
        const teamRef = firebase.database().ref(`teams/${teamId}`);
        try {
            const teamSnapshot = await teamRef.once('value');
            const teamData = teamSnapshot.val();

            if (teamData && teamData.roster && teamData.roster[userId]) {
                const userRole = teamData.roster[userId].role; 
                const invitesRef = firebase.database().ref(`teamInvites/${userId}`);
                const invitesSnapshot = await invitesRef.once('value');
                const invitesCount = invitesSnapshot.numChildren(); 

                // MODIFICACIÓN: Usar sanitizeText para teamData.name por seguridad XSS
                teamStatusContainer.innerHTML = `
                    <p>Team: <a href="#" onclick="openPublicTeamProfile('${teamId}'); return false;">${sanitizeText(teamData.name)}</a></p>
                    <p>Role: <span class="roster-role ${userRole.toLowerCase()}">${userRole}</span></p>
                    <p>Pending Invites: <span style="color: #f7c744; font-weight: bold;">${invitesCount}</span></p>
                `; 
            } else {
                teamStatusContainer.innerHTML = '<p style="color: #e53935;">Error: Team data not found or user not in roster. Reloading to fix profile...</p>';
                // MODIFICACIÓN: Fix de estado roto, uso de modal de confirmación
                showConfirmationModal(
                    'Data Error',
                    'Your profile links to a non-existent team. Attempt to fix your profile?',
                    async () => {
                        await firebase.database().ref(`users/${userId}/teamId`).remove();
                        window.location.reload();
                    }
                );
            }
        } catch(error) {
            console.error("Error fetching team status:", error);
            teamStatusContainer.innerHTML = '<p style="color: #e53935;">Error loading team status.</p>';
        }
    } else {
        const invitesRef = firebase.database().ref(`teamInvites/${userId}`);
        try {
            const invitesSnapshot = await invitesRef.once('value');
            const invitesCount = invitesSnapshot.numChildren();
             teamStatusContainer.innerHTML = `
                <p>Team: <span style="color: #888;">None</span></p>
                <p>Role: <span style="color: #888;">N/A</span></p>
                 <p>Pending Invites: <span style="color: #f7c744; font-weight: bold;">${invitesCount}</span></p>
            `;
        } catch (error) {
            console.error("Error fetching invites:", error);
             teamStatusContainer.innerHTML = `
                <p>Team: <span style="color: #888;">None</span></p>
                <p>Role: <span style="color: #888;">N/A</span></p>
                 <p>Pending Invites: <span style="color: #e53935;">Error</span></p>
            `;
        }
    }
}

/**
 * Loads and displays the Team Dashboard data.
 */
/**
 * Loads and displays the Team Dashboard data.
 */
async function loadTeamDashboard(teamId, currentUserId) {
    const teamRef = firebase.database().ref(`teams/${teamId}`);
    try {
        const snapshot = await teamRef.once('value');
        const teamData = snapshot.val();
        if (!teamData) {
            console.error(`Team data not found for ID: ${teamId}`);
            // FIX: Remoción de teamId si el equipo no existe
            await firebase.database().ref(`users/${currentUserId}/teamId`).remove();
            window.location.reload(); 
            return;
        }

        // Fill header
        document.getElementById('dashboardTeamName').textContent = sanitizeText(teamData.name);
        document.getElementById('dashboardTeamEmblem').src = teamData.emblemUrl || 'https://placehold.co/100x100/333/ccc?text=TEAM';

        // Fill Team Info widget (founded, founder, wins/losses, nivel, verificación) con datos reales
        populateTeamInfoWidget(teamData, teamId);

        // Para todo el roster, no solo el capitán: es su única puerta de entrada
        // a la sala del torneo desde el hub.
        loadRegisteredTournaments(teamId);

        // Fondo personalizado del panel del equipo (banner en el encabezado; se oscurece hacia
        // abajo para que el roster y los botones sigan legibles con cualquier imagen).
        const dashCard = document.getElementById('teamDashboardCard');
        if (dashCard) {
            const dashBgImg = getTeamBackgroundImage(teamData);
            if (dashBgImg) {
                dashCard.classList.add('has-bg-image');
                dashCard.style.background = `linear-gradient(to bottom, rgba(0,0,0,0.30) 0%, rgba(26,26,26,0.88) 40%, #1a1a1a 70%), url("${dashBgImg}") top center/cover no-repeat`;
            } else {
                dashCard.classList.remove('has-bg-image');
                dashCard.style.background = '';
            }
        }

        // Fill Roster list
        const rosterList = document.getElementById('rosterList');
        rosterList.innerHTML = ''; // Clear skeleton
        const roster = teamData.roster;

        // Por seguridad, ocultamos SIEMPRE los botones de gestión (eliminar / invitar)
        // por defecto. Solo se mostrarán más abajo si el usuario es el capitán.
        (function hideRosterCaptainControls() {
            const _rt = document.getElementById('rosterRemoveToggle');
            const _ib = document.getElementById('rosterInviteBtn');
            if (_rt) { _rt.style.display = 'none'; _rt.onclick = null; }
            if (_ib) { _ib.style.display = 'none'; _ib.onclick = null; }
            if (rosterList) rosterList.classList.remove('remove-mode');
        })();

        if (!roster) {
             rosterList.innerHTML = '<p style="color: #888;">No members found.</p>';
        } else {
            const userPromises = Object.keys(roster).map(uid =>
                firebase.database().ref(`users/${uid}`).once('value')
            );
            const userSnapshots = await Promise.all(userPromises);
            
            const isCaptain = !!(roster[currentUserId] && roster[currentUserId].role === 'Captain');

            userSnapshots.forEach(userSnap => {
                const userData = userSnap.val();
                const uid = userSnap.key;
                if (!userData) {
                    // Usuario eliminado
                    const memberEl = document.createElement('div');
                    memberEl.className = 'roster-member-item missing-user';
                    memberEl.innerHTML = `
                        <img src="dragon_profile_studiosgamesrs.png" alt="Missing User">
                        <span class="roster-name" style="color:#888;">User Deleted</span>
                        <span class="roster-role" style="background:#555;">N/A</span>
                    `;
                    rosterList.appendChild(memberEl);
                    return;
                }
                const role = roster[uid].role;
                const safeNick = sanitizeText(userData.nick || 'User');

                const memberEl = document.createElement('div');
                memberEl.className = 'roster-member-item';
                
                const kickButton = (isCaptain && uid !== currentUserId && role !== 'Captain') ? 
                    `<button class="kick-member-btn" onclick="showConfirmationModal('Kick Member', 'Are you sure you want to kick ${safeNick}?', () => kickMember('${teamId}', '${uid}', '${safeNick}'))">&times;</button>`
                    : '';
                
                memberEl.innerHTML = `
                    <img src="${userData.photoURL || 'dragon_profile_studiosgamesrs.png'}" alt="${safeNick}">
                    <span class="roster-name" style="cursor: pointer;" data-user-id="${uid}" onmouseenter="showUserPopup(this, '${uid}')" onmouseleave="hideUserPopup()" onclick="window.location.href='dashboard.html?uid=${uid}'">
                        ${safeNick}
                    </span>
                    <span class="roster-role ${role.toLowerCase()}">${role}</span>
                    ${kickButton}
                `;
                rosterList.appendChild(memberEl);
            });

            // Botón único de "modo eliminar": solo el capitán lo ve, y solo si hay
            // miembros que pueda expulsar. Al pulsarlo se muestran las X de cada jugador.
            const removeToggle = document.getElementById('rosterRemoveToggle');
            if (removeToggle) {
                const hasRemovable = isCaptain && Object.keys(roster).some(
                    uid => uid !== currentUserId && roster[uid].role !== 'Captain'
                );
                rosterList.classList.remove('remove-mode');
                removeToggle.classList.remove('active');
                removeToggle.title = 'Eliminar miembros';
                if (hasRemovable) {
                    removeToggle.style.display = 'inline-flex';
                    removeToggle.onclick = () => {
                        const on = rosterList.classList.toggle('remove-mode');
                        removeToggle.classList.toggle('active', on);
                        removeToggle.title = on ? 'Salir del modo eliminar' : 'Eliminar miembros';
                    };
                } else {
                    removeToggle.style.display = 'none';
                    removeToggle.onclick = null;
                }
            }

            // Botón "+" para invitar jugadores: mismo flujo que el menú de 3 puntos.
            // Solo lo ve el capitán.
            const rosterInviteBtn = document.getElementById('rosterInviteBtn');
            if (rosterInviteBtn) {
                if (isCaptain) {
                    rosterInviteBtn.style.display = 'inline-flex';
                    rosterInviteBtn.onclick = () => {
                        window.openInvitePlayerModal(teamId, teamData.name);
                    };
                } else {
                    rosterInviteBtn.style.display = 'none';
                    rosterInviteBtn.onclick = null;
                }
            }
        }
        
        // --- DROPDOWN AND REQUESTS LOGIC ---
        const requestsList = document.getElementById('pendingRequestsList');
        const requestsTitle = document.querySelector('#teamDashboardCard .dashboard-column:first-child .dashboard-section-title:nth-of-type(2)');
        const actionButtonContainer = document.querySelector('.member-actions-container'); 
        const actionButton = document.getElementById('teamEditBtn');
        const dropdownMenu = document.getElementById('memberActionsDropdown');
        const leaveTeamBtn = document.getElementById('leaveTeamBtn');
        const editEmblemBtn = document.getElementById('openEditModalBtn'); 
        const invitePlayerBtn = document.getElementById('invitePlayerBtn');
        const createTournamentBtn = document.getElementById('createTournamentBtn'); 
        
        const userRank = (currentUserData && currentUserData.rango) ? currentUserData.rango : 'tribal_warrior'; 
        const userPermissions = getPermisosRango(userRank); 
        
        const isCaptain = roster && roster[currentUserId] && roster[currentUserId].role === 'Captain';
        const isMember = roster && roster[currentUserId] && roster[currentUserId].role === 'Member'; 
        
        // Lógica para el botón "Crear Torneo" / "Gestionar Torneo"
        if (createTournamentBtn && userPermissions.puedeCrearTorneos) {
            // Verificar si ya tiene torneo activo
            firebase.database().ref('tournaments')
                .orderByChild('organizer/uid')
                .equalTo(currentUserId)
                .once('value')
                .then(snapshot => {
                    let hasActiveTournament = false;
                    let activeTournamentId = null;

                    if (snapshot.exists()) {
                        snapshot.forEach(child => {
                            const t = child.val();
                            if (t.status !== 'finalizado' && t.status !== 'cancelado') {
                                hasActiveTournament = true;
                                activeTournamentId = child.key;
                            }
                        });
                    }

                    if (hasActiveTournament) {
                        createTournamentBtn.innerHTML = '<i class="fas fa-tasks"></i> Gestionar Mi Torneo';
                        createTournamentBtn.onclick = (e) => {
                            e.preventDefault();
                            window.location.href = '/tournament-details?id=' + encodeURIComponent(activeTournamentId);
                        };
                        createTournamentBtn.style.display = 'flex';
                    } else {
                        createTournamentBtn.innerHTML = '<i class="fas fa-trophy"></i> Crear Torneo';
                        createTournamentBtn.onclick = (e) => {
                            e.preventDefault();
                            openTournamentCreationModal();
                        };
                        createTournamentBtn.style.display = 'flex';
                    }
                });
        } else if (createTournamentBtn) {
            createTournamentBtn.style.display = 'none';
        }

        if (actionButtonContainer && actionButton && dropdownMenu) {
            actionButtonContainer.style.display = 'block'; 
            dropdownMenu.style.display = 'none';

            actionButton.onclick = (event) => {
                event.stopPropagation(); 
                dropdownMenu.style.display = dropdownMenu.style.display === 'block' ? 'none' : 'block';
            };

            if (isCaptain) {
			// 1. Mostrar la sección y cargar invitaciones a torneos
                const tourInvitesSection = document.getElementById('tournamentInvitesSection');
                if (tourInvitesSection) {
                    tourInvitesSection.style.display = 'block';
                    loadTournamentInvites(teamId); // <--- LLAMADA NUEVA
                }
				
                requestsList.style.display = 'block';
                if(requestsTitle) requestsTitle.style.display = 'block';
                loadPendingRequests(teamId, requestsList);

                if (editEmblemBtn) editEmblemBtn.style.display = 'flex';
                if (leaveTeamBtn) leaveTeamBtn.style.display = 'none'; // El capitán disuelve, no sale
                
                if (invitePlayerBtn) { 
                    invitePlayerBtn.style.display = 'flex';
                    invitePlayerBtn.onclick = () => {
                        window.openInvitePlayerModal(teamId, teamData.name); 
                        dropdownMenu.style.display = 'none'; 
                    };
                }

                 if(editEmblemBtn) {
                     editEmblemBtn.onclick = () => {
                         openEditTeamModal(teamId, teamData.emblemUrl);
                         dropdownMenu.style.display = 'none'; 
                     };
                 }

                 // Botón "Editar apariencia" (solo capitán) — ahora dentro del menú de 3 puntos
                 var appearanceBtn = document.getElementById('editTeamAppearanceBtn');
                 if (appearanceBtn) {
                     appearanceBtn.style.display = 'flex';
                     appearanceBtn.onclick = () => {
                         openTeamAppearanceModal(teamId, teamData);
                         dropdownMenu.style.display = 'none';
                     };
                 }
                
                // Botón Disband para Capitán
                 if (leaveTeamBtn) {
                    leaveTeamBtn.style.display = 'flex'; 
                    leaveTeamBtn.textContent = 'Disband Team';
                    leaveTeamBtn.onclick = () => {
                        showConfirmationModal(
                            'Disband Team',
                            'Are you absolutely sure you want to DISBAND this team? This action is permanent.',
                            () => disbandTeam(teamId, currentUserId) 
                        );
                        dropdownMenu.style.display = 'none'; 
                    };
                 }

            } else if (isMember) {
                requestsList.style.display = 'none'; 
                if(requestsTitle) requestsTitle.style.display = 'none'; 

                if (leaveTeamBtn) leaveTeamBtn.style.display = 'flex';
                if (editEmblemBtn) editEmblemBtn.style.display = 'none';
                if (invitePlayerBtn) invitePlayerBtn.style.display = 'none'; 
                var appearanceBtnMember = document.getElementById('editTeamAppearanceBtn');
                if (appearanceBtnMember) appearanceBtnMember.style.display = 'none';

                if (leaveTeamBtn) {
                    leaveTeamBtn.textContent = 'Leave Team';
                    leaveTeamBtn.onclick = () => {
                        showConfirmationModal(
                            'Leave Team',
                            'Are you sure you want to leave this team?',
                            () => leaveTeam(teamId, currentUserId) 
                        );
                        dropdownMenu.style.display = 'none'; 
                    };
                }
            } else {
                 // Visitante
                 if (leaveTeamBtn) leaveTeamBtn.style.display = 'none';
                 if (editEmblemBtn) editEmblemBtn.style.display = 'none';
                 if (invitePlayerBtn) invitePlayerBtn.style.display = 'none'; 
                 var appearanceBtnGuest = document.getElementById('editTeamAppearanceBtn');
                 if (appearanceBtnGuest) appearanceBtnGuest.style.display = 'none';
                 actionButtonContainer.style.display = 'none';
            }
        }

        // Conectar botón de Chat
        const teamChatBtn = document.querySelector('.team-chat-btn');
        if (teamChatBtn) {
            teamChatBtn.onclick = () => {
                openTeamChat(teamId, teamData.name, teamData.roster);
            };
        }

    } catch (error) {
        console.error("Error loading team dashboard:", error);
        showNotification("Error loading team dashboard.", "error"); 
         document.getElementById('teamDashboardCard').innerHTML = '<p style="color: #e53935;">Error loading team dashboard.</p>';
    }
}

/**
 * Función para disolver el equipo (solo Capitán).
 */
async function disbandTeam(teamId, currentUserId) {
    if (!teamId || !currentUserId) {
        showNotification("Invalid action. Missing data.", "error");
        return;
    }
    if (!teamFunctions) {
        showNotification("Cloud Functions no disponibles.", "error");
        return;
    }

    try {
        await teamFunctions.httpsCallable('disbandTeam')({ teamId: teamId });
        showNotification("Team has been successfully disbanded.", "success");
        window.location.reload();
    } catch (error) {
        console.error("Error disbanding team:", error);
        showNotification('Failed to disband team: ' + teamFnErrorMessage(error, error.message || 'Unknown error'), "error");
    }
}


/**
 * Abre y maneja el modal para editar el emblema del equipo.
 */
function openEditTeamModal(teamId, currentEmblemUrl) {
    const modal = document.getElementById('editTeamModal');
    const closeBtn = document.getElementById('closeEditModal');
    const saveBtn = document.getElementById('saveEmblemBtn');
    const emblemPreview = document.getElementById('editEmblemPreview');
    const emblemInput = document.getElementById('editEmblemInput');
    let newEmblemFile = null;

    emblemPreview.src = currentEmblemUrl || 'https://placehold.co/100x100/333/ccc?text=TEAM';
    modal.style.display = 'flex';

    emblemInput.onchange = () => {
        if (emblemInput.files && emblemInput.files[0]) {
            newEmblemFile = emblemInput.files[0];
            const reader = new FileReader();
            reader.onload = (e) => { emblemPreview.src = e.target.result; };
            reader.readAsDataURL(newEmblemFile);
        }
    };
    const closeModal = () => {
        modal.style.display = 'none';
        emblemInput.value = null;
        newEmblemFile = null;
        saveBtn.onclick = null;
        closeBtn.onclick = null;
    };
    saveBtn.onclick = async () => {
        if (!newEmblemFile) { showNotification("Please select a new image first.", "error"); return; } 
        
        // FIX: Chequeo de tamaño de archivo antes de subir
        const MAX_SIZE = 2 * 1024 * 1024;
        if (newEmblemFile.size > MAX_SIZE) {
            showNotification("Image size exceeds 2MB limit.", "error");
            return;
        }
        // FIN FIX
        
        saveBtn.disabled = true;
        saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving...';
        try {
            const newEmblemUrl = await uploadTeamEmblem(teamId, newEmblemFile); 
            if (newEmblemUrl) {
                await firebase.database().ref(`teams/${teamId}/emblemUrl`).set(newEmblemUrl);
                document.getElementById('dashboardTeamEmblem').src = newEmblemUrl;
                showNotification("Team emblem updated successfully!", "success"); 
                closeModal();
            }
        } catch (error) {
            console.error("Error updating emblem URL in database:", error);
            showNotification("Error updating emblem: " + error.message, "error"); 
        } finally {
            saveBtn.disabled = false;
            saveBtn.innerHTML = '<i class="fas fa-save"></i> Save Changes';
        }
    };
    closeBtn.onclick = closeModal;
}

// ==============================================================
// --- INICIO: NUEVAS FUNCIONES PARA INVITAR JUGADORES (CAPITÁN) ---
// ==============================================================

/**
 * Initializes the "Invite Player" modal listeners.
 */
function initializeInvitePlayerModal() {
    const modal = document.getElementById('invitePlayerModal');
    const closeBtn = document.getElementById('closeInviteModal');
    const searchInput = document.getElementById('teamInviteSearchInput');
    const searchResults = document.getElementById('teamInviteSearchResults');
    let searchTimeout;

    if (!modal || !closeBtn || !searchInput || !searchResults) {
        return; 
    }

    const closeModal = () => {
        modal.style.display = 'none';
        searchInput.value = '';
        searchResults.innerHTML = '';
        searchResults.style.display = 'none';
    };

    closeBtn.onclick = closeModal;
    window.addEventListener('click', (event) => {
        if (event.target == modal) closeModal();
    });

    // Lógica de búsqueda
    searchInput.addEventListener('input', () => {
        clearTimeout(searchTimeout);
        const query = searchInput.value.trim().toLowerCase();
        
        // FIX: Aumentar el mínimo de búsqueda a 3 para optimizar
        if (query.length < 3) {
            searchResults.innerHTML = '<div class="search-result-item">Type at least 3 characters.</div>';
            searchResults.style.display = 'block';
            return;
        }
        // FIN FIX
        
        searchTimeout = setTimeout(async () => {
            const teamId = modal.dataset.teamId; 
            if (!teamId) return;
            searchUsersForInvite(query, teamId, searchResults); 
        }, 300);
    });
}

/**
 * Opens the "Invite Player" modal.
 */
window.openInvitePlayerModal = function(teamId, teamName) {
    const modal = document.getElementById('invitePlayerModal');
    if (!modal) {
        showNotification("Error: Invite modal not found.", "error");
        return;
    }
    modal.style.display = 'flex';
    modal.dataset.teamId = teamId; 
    
    const titleEl = document.getElementById('inviteModalTitle');
    if (titleEl) {
        titleEl.textContent = `Invite Player to ${sanitizeText(teamName)}`; // MODIFICACIÓN: Sanitizar
    }
    // Limpiar resultados de búsquedas anteriores
    document.getElementById('teamInviteSearchInput').value = '';
    document.getElementById('teamInviteSearchResults').innerHTML = '';
    document.getElementById('teamInviteSearchResults').style.display = 'none';
}

/**
 * Searches for users to invite (captain's modal).
 */
async function searchUsersForInvite(query, teamId, resultsContainer) {
    resultsContainer.style.display = 'block';
    resultsContainer.innerHTML = '<div class="search-result-item"><i class="fas fa-spinner fa-spin"></i> Searching...</div>';
    
    try {
        // 1. Obtener el roster del equipo actual para excluir miembros
        const teamRosterRef = firebase.database().ref(`teams/${teamId}/roster`);
        const rosterSnapshot = await teamRosterRef.once('value');
        const teamRoster = rosterSnapshot.val() || {};
        
        // 2. Buscar en todos los usuarios
        // PZ-017: users solo lo lee Commander/Boss; este buscador de invitación
        // de equipo solo necesita nick/photoURL/teamId, así que usa publicProfiles.
        const usersRef = firebase.database().ref('publicProfiles');
        const allUsersSnapshot = await usersRef.once('value');
        
        if (!allUsersSnapshot.exists()) {
            resultsContainer.innerHTML = '<div class="search-result-item">No users found.</div>';
            return;
        }
        
        let userResultsHTML = '';
        let count = 0;
        
        allUsersSnapshot.forEach(child => {
            const userData = child.val();
            const userId = child.key;
            const nick = userData.nick || '';
            
            // FILTRO HARDENED:
            if (nick.toLowerCase().includes(query) && 
                userId !== currentUser.uid && // No invitarme a mí mismo
                !teamRoster[userId] && // No invitar miembros del equipo
                !userData.teamId) { // Solo invitar usuarios sin equipo
                count++;
                
                const safeNick = sanitizeText(userData.nick || 'Unknown'); // MODIFICACIÓN: Sanitizar
                userResultsHTML += `
                    <div class="search-result-item" data-uid="${userId}">
                        <img src="${userData.photoURL || 'dragon_profile_studiosgamesrs.png'}" class="search-result-img">
                        <span class="search-result-nick">${safeNick}</span>
                        <button class="invite-send-btn" id="invite-btn-${userId}" 
                            onclick="sendInviteToUser('${userId}', '${teamId}', '${safeNick}')">
                            <i class="fas fa-paper-plane"></i> Invite
                        </button>
                    </div>
                `;
            }
        });
        
        if (count === 0) {
            resultsContainer.innerHTML = '<div class="search-result-item">No eligible users found.</div>';
        } else {
            resultsContainer.innerHTML = userResultsHTML;
        }
        
    } catch (error) {
        console.error("Error searching users for invite:", error);
        resultsContainer.innerHTML = '<div class="search-result-item">Error searching users.</div>';
    }
}

/**
 * Sends an invitation from a team to a user.
 */
window.sendInviteToUser = async function(userId, teamId, userNick) {
    const sendBtn = document.getElementById(`invite-btn-${userId}`);
    if (!sendBtn) return;

    sendBtn.disabled = true;
    sendBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';

    if (!teamFunctions) {
        showNotification("Cloud Functions no disponibles.", "error");
        sendBtn.disabled = false;
        sendBtn.innerHTML = '<i class="fas fa-paper-plane"></i> Invite';
        return;
    }

    try {
        await teamFunctions.httpsCallable('sendTeamInvite')({
            teamId: teamId,
            targetUserId: userId
        });
        sendBtn.innerHTML = '<i class="fas fa-check"></i> Sent';
        sendBtn.onclick = null;
        showNotification(`Invite sent to ${userNick}!`, "success");
    } catch (error) {
        console.error("Error sending invite:", error);
        showNotification(`Error: ${teamFnErrorMessage(error, error.message || 'Failed to send invite.')}`, "error");
        sendBtn.disabled = false;
        sendBtn.innerHTML = '<i class="fas fa-paper-plane"></i> Invite';
    }
}

// ==============================================================
// --- FIN: NUEVAS FUNCIONES PARA INVITAR JUGADORES (CAPITÁN) ---
// ==============================================================


/**
 * Initializes the "Create Team" modal logic.
 */
function initializeModal(user, userRank) {
    const modal = document.getElementById('createTeamModal');
    const createTeamBtn = document.getElementById('createTeamBtn');
    if (!modal || !createTeamBtn) { /* console.warn("Modal elements not found."); */ return; }

    const closeModalBtn = document.getElementById('closeModal');
    const cancelBtn = document.getElementById('cancelCreationBtn');
    const proceedBtn = document.getElementById('proceedWithTokensBtn');
    const finalizeBtn = document.getElementById('finalizeTeamBtn');
    const step1 = document.getElementById('modalStep1');
    const step2 = document.getElementById('modalStep2');
    const userTokenBalanceSpan = document.getElementById('userTokenBalance');
    const tokenCostNotice = document.querySelector('.token-cost-notice');

    // Referencia a los inputs de Step 2 para la validación
    const teamNameInput = document.getElementById('teamNameInput');
    const teamGameSelect = document.getElementById('teamGameSelect');
    const emblemInput = document.getElementById('teamEmblemInput');
    const emblemPreview = document.getElementById('teamEmblemPreview');

    const openModal = async () => {
        step1.style.display = 'block';
        step2.style.display = 'none';
        invitedMembers = [];
        renderRoster();
        
        // Limpiar inputs
        teamNameInput.value = '';
        emblemInput.value = null;
        emblemPreview.src = 'https://placehold.co/100x100/2a2a2a/888?text=Emblem';
        document.getElementById('captainProfilePic').src = user.photoURL || 'dragon_profile_studiosgamesrs.png';
        document.getElementById('captainProfileName').textContent = (currentUserData && currentUserData.nick) ? currentUserData.nick : (user.displayName || 'You');

        if (userRank === 'commander') {
            tokenCostNotice.style.display = 'none';
            proceedBtn.disabled = false;
            proceedBtn.textContent = "Proceed (Free for Commanders)";
        } else {
            tokenCostNotice.style.display = 'block';
            try {
                const userRef = firebase.database().ref(`users/${user.uid}/tokens`);
                const snapshot = await userRef.once('value');
                const tokens = snapshot.val() || 0;
                userTokenBalanceSpan.textContent = tokens;
                proceedBtn.disabled = tokens < 10;
                proceedBtn.textContent = tokens < 10 ? "Insufficient Tokens" : "Proceed to Team Setup";
            } catch (error) {
                console.error("Error fetching tokens:", error);
                showNotification("Error fetching your token balance.", "error"); 
                userTokenBalanceSpan.textContent = 'Error';
                proceedBtn.disabled = true;
            }
        }
        modal.style.display = 'flex';
    };

    const closeModal = () => { modal.style.display = 'none'; };
    
    const goToStep2 = () => { 
        if (proceedBtn.disabled) return; 
        step1.style.display = 'none'; 
        step2.style.display = 'block'; 
    };

    if(createTeamBtn) createTeamBtn.addEventListener('click', openModal);
    if(closeModalBtn) closeModalBtn.addEventListener('click', closeModal);
    if(cancelBtn) cancelBtn.addEventListener('click', closeModal);
    window.addEventListener('click', (event) => { if (event.target == modal) closeModal(); });
    if(proceedBtn) proceedBtn.addEventListener('click', goToStep2);

    if(finalizeBtn) finalizeBtn.addEventListener('click', async () => {
        finalizeBtn.disabled = true;
        finalizeBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Creating Team...';
        let newTeamId = null; 
        try {
            const teamName = teamNameInput.value;
            // Validación
            if (!teamName.trim() || teamName.length > 24) { 
                throw new Error("Team Name is required and must be max 24 characters."); 
            }
            const teamGame = teamGameSelect.value;
            const emblemFile = emblemInput.files[0];
            
            if (emblemFile) {
                const MAX_SIZE = 2 * 1024 * 1024;
                if (emblemFile.size > MAX_SIZE) {
                     throw new Error("Emblem file is too large (max 2MB).");
                }
            }

            let roster = {}; roster[user.uid] = { role: 'Captain' };
            const newTeamRef = firebase.database().ref('teams').push();
            newTeamId = newTeamRef.key;

            await newTeamRef.set({
                id: newTeamId, 
                name: teamName, 
                name_lowercase: teamName.toLowerCase(), 
                game: teamGame, 
                captain: user.uid, 
                roster: roster,
                emblemUrl: null, 
                createdAt: firebase.database.ServerValue.TIMESTAMP,
                stats: { wins: 0, tokens: 0 }
            });

            let emblemUrl = null;
            if (emblemFile) { emblemUrl = await uploadTeamEmblem(newTeamId, emblemFile); }

            const userUpdates = {};
            userUpdates[`/users/${user.uid}/teamId`] = newTeamId;
            
            if (userRank !== 'commander') {
                userUpdates[`/users/${user.uid}/tokens`] = firebase.database.ServerValue.increment(-10);
            }
            
            if (emblemUrl) { userUpdates[`/teams/${newTeamId}/emblemUrl`] = emblemUrl; }
            await firebase.database().ref().update(userUpdates);

            if (teamFunctions && invitedMembers.length) {
                for (const member of invitedMembers) {
                    try {
                        await teamFunctions.httpsCallable('sendTeamInvite')({
                            teamId: newTeamId,
                            targetUserId: member.uid
                        });
                    } catch (inviteErr) {
                        console.warn('Invite failed for', member.uid, inviteErr);
                    }
                }
            } else if (invitedMembers.length && !teamFunctions) {
                showNotification("Team created, but invites could not be sent (Functions unavailable).", "error");
            }

            showNotification("Team created successfully!" + (invitedMembers.length ? " Invitations sent." : ""), "success"); 
            closeModal();
            window.location.reload();
        } catch (error) {
            console.error("Error creating team:", error);
            showNotification("Error creating team: " + (error.message || 'Unknown error'), "error"); 
            if (newTeamId) {
                await firebase.database().ref(`teams/${newTeamId}`).remove().catch(() => {});
            }
        } finally {
            finalizeBtn.disabled = false;
            finalizeBtn.innerHTML = '<i class="fas fa-check-circle"></i> Finalize and Create Team';
        }
    });

    if(emblemInput && emblemPreview) {
        emblemInput.addEventListener('change', () => {
            if (emblemInput.files && emblemInput.files[0]) {
                 const MAX_SIZE = 2 * 1024 * 1024;
                if (emblemInput.files[0].size > MAX_SIZE) {
                    showNotification("Image size exceeds 2MB limit.", "error");
                    emblemInput.value = null; 
                    return;
                }
                const reader = new FileReader();
                reader.onload = (e) => { emblemPreview.src = e.target.result; }
                reader.readAsDataURL(emblemInput.files[0]);
            }
        });
    }

    // --- LÓGICA DE BÚSQUEDA CORREGIDA ---
    const inviteInput = document.getElementById('inviteUserInput');
    const inviteResultsContainer = document.getElementById('inviteSearchResults');
    let searchTimeout;
    
    if(inviteInput && inviteResultsContainer) {
        inviteInput.addEventListener('input', () => {
            clearTimeout(searchTimeout);
            const query = inviteInput.value.trim().toLowerCase();
            
            if (query.length < 1) {
                inviteResultsContainer.innerHTML = '';
                inviteResultsContainer.style.display = 'none';
                return;
            }

            searchTimeout = setTimeout(async () => {
                try {
                    console.log("🔎 Buscando:", query);
                    // PZ-017: búsqueda por prefijo de nick sobre publicProfiles (no users).
                    const usersRef = firebase.database().ref('publicProfiles');
                    
                    // 1. Consulta optimizada
                    const snapshot = await usersRef
                        .orderByChild('nick_lowercase')
                        .startAt(query)
                        .endAt(query + "\uf8ff")
                        .limitToFirst(50) 
                        .once('value');

                    const userResults = {};
                    
                    if (snapshot.exists()) {
                        snapshot.forEach(child => {
                            const userData = child.val();
                            const userId = child.key;
                            
                            // Filtros
                            const isMe = userId === currentUser.uid;
                            const hasTeam = !!userData.teamId; 
                            const isEmail = userData.nick && userData.nick.includes('@');
                            
                            if (!isMe && !hasTeam && !isEmail) {
                                userResults[userId] = userData;
                            }
                        });
                    }
                    
                    renderInviteResults(userResults);
                    
                } catch (searchError) {
                    console.error("Error searching users:", searchError);
                    inviteResultsContainer.innerHTML = '<div class="search-result-item">Error searching.</div>';
                    inviteResultsContainer.style.display = 'block';
                }
            }, 300);
        });
    }

    function renderInviteResults(users) {
        const container = document.getElementById('inviteSearchResults');
        const input = document.getElementById('inviteUserInput');
        
        if (!container) return;

        if (!users || Object.keys(users).length === 0) {
            container.innerHTML = '<div class="search-result-item">No eligible users found.</div>';
            container.style.display = 'block';
            return;
        }
        
        const htmlContent = Object.entries(users).map(([uid, userData]) => {
            if (invitedMembers.some(m => m.uid === uid)) return ''; // Ya invitado
            
            const safeNick = (typeof sanitizeText === 'function') ? sanitizeText(userData.nick) : (userData.nick || 'Unknown');
            const photo = userData.photoURL || 'dragon_profile_studiosgamesrs.png';

            return `
                <div class="search-result-item" 
                     data-uid="${uid}" 
                     data-nick="${safeNick}" 
                     data-photo="${photo}">
                    
                    <img src="${photo}" class="search-result-img" style="width:30px; height:30px; border-radius:50%; margin-right:10px;">
                    <div class="search-result-info" style="flex:1;">
                        <span class="search-result-nick" style="color:#fff; font-weight:bold;">${safeNick}</span>
                    </div>
                    <i class="fas fa-plus-circle" style="color:#4caf50;"></i>
                </div>
            `;
        }).join('');

        if (htmlContent === '') {
            container.innerHTML = '<div class="search-result-item">User already added.</div>';
        } else {
            container.innerHTML = htmlContent;
        }
        
        container.style.display = 'block';

        // Listeners para los items
        const items = container.querySelectorAll('.search-result-item');
        items.forEach(item => {
            item.addEventListener('click', function() {
                addMemberToRoster(this.dataset.uid, this.dataset.nick, this.dataset.photo);
                if(input) input.value = '';
                container.style.display = 'none';
            });
        });
    }

    function addMemberToRoster(uid, nick, photoURL) {
        const MAX_ROSTER = 9; 
        if (invitedMembers.length >= MAX_ROSTER) {
             showNotification(`Team roster is full.`, "error"); 
            return;
        }
        if (!invitedMembers.some(member => member.uid === uid)) {
            invitedMembers.push({ uid, nick, photoURL });
            renderRoster();
        }
    }
    
    // Exponer funciones necesarias al global para que funcionen desde HTML si fuera necesario
    window.removeMemberFromRoster = function(uid) {
        invitedMembers = invitedMembers.filter(member => member.uid !== uid);
        renderRoster();
    }

    function renderRoster() {
        const rosterList = document.querySelector('#createTeamModal .team-roster-list');
        if (!rosterList) return;
        
        // Limpiar solo los miembros invitados (mantener al capitán)
        rosterList.querySelectorAll('.roster-member:not(#captain-roster-member)').forEach(el => el.remove());
        
        invitedMembers.forEach(member => {
            const safeNick = sanitizeText(member.nick);
            const memberEl = document.createElement('div');
            memberEl.className = 'roster-member';
            memberEl.innerHTML = `
                <img src="${member.photoURL || 'dragon_profile_studiosgamesrs.png'}" alt="${safeNick}" class="roster-member-img">
                <span class="roster-member-name">${safeNick}</span>
                <span class="roster-member-role member">Invited</span>
                <button type="button" class="roster-remove-btn" onclick="removeMemberFromRoster('${member.uid}')">&times;</button>
            `;
            rosterList.appendChild(memberEl);
        });
    }

} // End of initializeModal


/**
 * Sube un archivo de emblema a Firebase Storage.
 */
async function uploadTeamEmblem(teamId, file) {
    if (!file) return null;
    const storage = firebase.storage();
    const storageRef = storage.ref(`team_emblems/${teamId}/${Date.now()}_${file.name}`); // FIX: Añadir timestamp para evitar conflictos de caché
    try {
        const snapshot = await storageRef.put(file);
        const downloadURL = await snapshot.ref.getDownloadURL();
        return downloadURL;
    } catch (error) {
        console.error("Error uploading emblem:", error);
        showNotification("Error uploading emblem: " + error.message, "error"); 
        throw error; // Propagate error for try/catch superior
    }
}


/**
 * Loads and filters tournaments.
 */
/**
 * Loads and filters tournaments based on the active tab.
 */
async function loadAllTournaments() {
    const listContainer = document.getElementById('tournamentsList');
    if(!listContainer) return;
    
    const activeTabBtn = document.querySelector('.hub-toggle-btn.active');
    const activeView = activeTabBtn ? activeTabBtn.dataset.view : 'active'; // 'active', 'upcoming', 'finished'
    
    listContainer.innerHTML = '<div class="tournament-card skeleton"></div><div class="tournament-card skeleton"></div>';

    try {
        const tournamentsRef = firebase.database().ref('tournaments');
        // Optimizamos pidiendo solo los últimos 20 para no saturar, ordenados por fecha de creación
        const snapshot = await tournamentsRef.orderByChild('createdAt').limitToLast(20).once('value');
        const allTournaments = snapshot.val();
        
        if (!allTournaments) {
            listContainer.innerHTML = '<p style="color: #aaa; text-align: center;">No tournaments found.</p>';
            return;
        }

        const tournamentsArray = Object.values(allTournaments);
        
        // FILTRADO INTELIGENTE
        let filteredTournaments = tournamentsArray.filter(t => {
            // Normalizamos el estado para evitar errores de mayúsculas/minúsculas
            const status = (t.status || 'pending').toLowerCase();
            
            if (activeView === 'active') {
                return status === 'en_vivo' || status === 'active' || status === 'in_progress';
            } else if (activeView === 'upcoming') {
                return status === 'pendiente' || status === 'pending' || status === 'open';
            } else if (activeView === 'finished') {
                return status === 'finalizado' || status === 'finished' || status === 'completed';
            }
            return false;
        });
        
        // Ordenar: Los más recientes primero
        filteredTournaments.sort((a, b) => b.createdAt - a.createdAt);

        renderTournaments(filteredTournaments, listContainer);
        
    } catch (error) {
        console.error("Error loading tournaments:", error);
        showNotification("Error loading tournaments.", "error"); 
        listContainer.innerHTML = '<p style="color: #e53935; text-align: center;">Error loading tournaments.</p>';
    }
}

/**
 * Renders the list of tournaments.
 */
/**
 * Renders the list of tournaments with smart action buttons.
 */
function renderTournaments(tournaments, container) {
    if(!container) return;
    
    const activeView = document.querySelector('.hub-toggle-btn.active')?.dataset.view || 'active';
    
    if (tournaments.length === 0) {
        container.innerHTML = `<p style="color: #aaa; text-align: center; padding: 2rem;">No ${activeView} tournaments found at the moment.</p>`;
        return;
    }
    container.innerHTML = '';
    
    tournaments.forEach(tournament => {
        if (!tournament || !tournament.id || !tournament.name) return;
        
        const card = document.createElement('div');
        card.className = 'tournament-card';
        
        // Determinar clase de estado visual
        let statusClass = 'status-upcoming';
        if (tournament.status === 'en_vivo' || tournament.status === 'active') statusClass = 'status-active';
        if (tournament.status === 'finalizado' || tournament.status === 'finished') statusClass = 'status-finished';

        const safeName = sanitizeText(tournament.name);
        
        // --- LÓGICA DE BOTONES DE ACCIÓN ---
        let actionButtonHTML = '';
        
        // 1. Si soy el Creador -> "Administrar"
        const creatorId = (tournament.organizer && tournament.organizer.uid) ? tournament.organizer.uid : tournament.creatorUid;
        const isCreator = currentUser && creatorId === currentUser.uid;
        
        if (isCreator) {
            actionButtonHTML = `<button type="button" class="view-tournament-btn tour-manage-btn" style="background: #ffca3a; color: #000;" data-tournament-id="${tournament.id}"><i class="fas fa-envelope-open-text"></i> Invitar equipos</button>`;
        } 
        // 2. Si el torneo está ABIERTO (Pendiente/Upcoming) -> "Inscribirse" o "Ver"
        else if (activeView === 'upcoming') {
            // Verificamos si mi equipo ya está inscrito
            const myTeamId = currentUserData?.teamId;
            const isRegistered = myTeamId && tournament.registeredTeams && tournament.registeredTeams[myTeamId];
            
            if (isRegistered) {
                actionButtonHTML = `<a class="view-tournament-btn" style="background: #4caf50; color:#000; text-decoration:none; display:inline-flex; align-items:center; gap:6px;" href="/tournament-details?id=${encodeURIComponent(tournament.id)}"><i class="fas fa-broadcast-tower"></i> Ir al torneo</a>`;
            } else {
                // Botón para ir a detalles e inscribirse
                actionButtonHTML = `<button class="view-tournament-btn" onclick="window.location.href='tournament-details.html?id=${tournament.id}'">Join Now</button>`;
            }
        }
        // 3. Si está EN VIVO -> "Watch Live", salvo que juegue mi equipo
        else if (activeView === 'active') {
            const myTeamId = currentUserData?.teamId;
            const iAmPlaying = myTeamId && tournament.registeredTeams && tournament.registeredTeams[myTeamId];
            actionButtonHTML = iAmPlaying
                ? `<a class="view-tournament-btn" style="background: #4caf50; color:#000; text-decoration:none; display:inline-flex; align-items:center; gap:6px;" href="/tournament-details?id=${encodeURIComponent(tournament.id)}"><i class="fas fa-broadcast-tower"></i> Entrar a mi partida</a>`
                : `<button class="view-tournament-btn" style="background: #e53935;" onclick="window.location.href='tournament-details.html?id=${tournament.id}'"><i class="fas fa-eye"></i> Watch Live</button>`;
        }
        // 4. Si está FINALIZADO -> "Ver Resultados"
        else {
             actionButtonHTML = `<button class="view-tournament-btn" style="background: #333;" onclick="window.location.href='tournament-details.html?id=${tournament.id}'">Results</button>`;
        }

        // Formatear fecha
        const dateStr = tournament.schedule ? new Date(tournament.schedule).toLocaleDateString() : 'TBA';

        card.innerHTML = `
            <div class="tournament-header">
                 <div class="game-logo-container" style="background-image: url('${getGameLogoUrl(tournament.game || 'default')}')"></div>
                <div class="tournament-title-container">
                    <h3 class="tournament-name">${safeName}</h3>
                    <span class="tournament-format">${tournament.format || tournament.modality || '5v5'} • ${dateStr}</span>
                </div>
            </div>
            <div class="tournament-details">
                <div class="detail-item"><div class="detail-item-title">Prize</div><div class="detail-item-value prize-pool">${tournament.prizePool || 0} T</div></div>
                <div class="detail-item"><div class="detail-item-title">Teams</div><div class="detail-item-value">${tournament.teams?.registered || Object.keys(tournament.registeredTeams || {}).length}/${tournament.teams?.max || 0}</div></div>
                <div class="detail-item"><div class="detail-item-title">Region</div><div class="detail-item-value">${tournament.regionServer || tournament.region || 'Global'}</div></div>
            </div>
            <div class="tournament-footer">
                <span class="tournament-status ${statusClass}">${tournament.status || 'Pending'}</span>
                ${actionButtonHTML}
            </div>
        `;
        container.appendChild(card);
    });

    container.querySelectorAll('.tour-manage-btn').forEach(function (btn) {
        btn.addEventListener('click', function () {
            var tid = btn.getAttribute('data-tournament-id');
            if (tid) openTournamentOrganizerModal(tid);
        });
    });
}
// Helper function to get game logo URL
function getGameLogoUrl(gameKey) {
     const logos = {
        cs2: 'https://firebasestorage.googleapis.com/v0/b/studiosgamesrs.firebasestorage.app/o/cs2-logo.png?alt=media&token=e1a8df39-c56b-45e0-8356-6213506cf260',
        valorant: 'URL_TO_VALORANT_LOGO.png', 
        lol: 'URL_TO_LOL_LOGO.png',           
        rl: 'URL_TO_RL_LOGO.png',             
        default: 'dragon_profile_studiosgamesrs.png' 
    };
    return logos[gameKey] || logos.default;
}

/**
 * Navigates to a specific tournament page (placeholder).
 */
function navigateToTournament(tournamentId) {
    console.log(`Navigating to tournament: ${tournamentId}`);
    // Future: window.location.href = `tournament_details.html?id=${tournamentId}`;
}

/**
 * Logs the user out.
 */
function logout() {
    firebase.auth().signOut().then(() => {
    window.location.href = "login.html";
  }).catch(error => {
      console.error("Logout failed:", error);
      showNotification("Logout failed. Please try again.", "error");
      window.location.href = "login.html";
  });
}


// =============================================
// --- TEAM & REQUEST RELATED FUNCTIONS ---
// =============================================

/**
 * Carga los Top Teams en el widget de la barra lateral.
 */
async function loadTopTeams() {
    const listContainer = document.getElementById('topTeamsList');
    if (!listContainer) return;
    try {
        const teamsRef = firebase.database().ref('teams');
        const snapshot = await teamsRef.orderByChild('stats/wins').limitToLast(3).once('value'); 
        const teams = snapshot.val();
        if (!teams) { listContainer.innerHTML = '<p style="color: #888; font-size:0.9rem;">No teams found.</p>'; return; }

        const teamsArray = Object.entries(teams).sort((a, b) => (b[1].stats?.wins || 0) - (a[1].stats?.wins || 0)); 
        listContainer.innerHTML = '';
        
        teamsArray.slice(0, 3).forEach(([teamId, teamData]) => { 
             const teamEl = document.createElement('div');
            teamEl.className = 'team-item';
             teamData.id = teamId; 
            
            const safeName = sanitizeText(teamData.name || 'Unnamed Team'); // MODIFICACIÓN: Sanitizar
            const topAccent = getTeamAccent(teamData);
            teamEl.style.borderLeftColor = topAccent;

            teamEl.innerHTML = `
                <img src="${teamData.emblemUrl || 'https://placehold.co/50x50/333/ccc?text=??'}" class="team-emblem" alt="${safeName} Emblem" style="border: 2px solid ${topAccent};">
                <div class="team-info">
                    <span class="team-name" style="cursor: pointer; color:${topAccent};" data-team-id="${teamData.id}" onmouseenter="showTeamPopup(this, '${teamData.id}')" onmouseleave="hideTeamPopup()" onclick="openPublicTeamProfile('${teamData.id}')">
                        ${safeName}
                    </span>
                    <div class="team-stats">
                        <span><i class="fas fa-trophy"></i> ${teamData.stats?.wins || 0} Wins</span>
                        <span><i class="fas fa-coins"></i> ${teamData.stats?.tokens || 0} Tokens</span>
                    </div>
                </div>
            `;
            listContainer.appendChild(teamEl);
        });
    } catch (error) {
        console.error("Error loading top teams:", error);
        showNotification("Error loading top teams.", "error"); 
        listContainer.innerHTML = '<p style="color: #e53935; font-size:0.9rem;">Error loading teams.</p>';
     }
}


/**
 * Carga la lista de equipos a los que un usuario puede unirse.
 */
async function loadJoinableTeams(currentUserId) {
     const listContainer = document.getElementById('joinableTeamsList');
    if (!listContainer) return;
    try {
        const userRequestsRef = firebase.database().ref(`userJoinRequests/${currentUserId}`);
        const userRequestsSnapshot = await userRequestsRef.once('value');
        const userSentRequests = userRequestsSnapshot.val() || {};

        const teamsRef = firebase.database().ref('teams');
        const snapshot = await teamsRef.once('value');
        const allTeams = snapshot.val();
        if (!allTeams) { listContainer.innerHTML = '<p style="color:#aaa; text-align:center;">No teams found.</p>'; return; }

        let joinableTeamsHTML = '';
        let hasJoinableTeams = false;

        Object.entries(allTeams).forEach(([teamId, teamData]) => {
            const roster = teamData.roster && typeof teamData.roster === 'object' ? teamData.roster : {};
            const playerCount = Object.keys(roster).length;

            if (playerCount < 10) { 
                hasJoinableTeams = true;
                const hasPendingRequest = userSentRequests[teamId];
                
                const safeName = sanitizeText(teamData.name || 'Unnamed Team'); // MODIFICACIÓN: Sanitizar

                joinableTeamsHTML += `
                    <div class="team-join-bar">
                        <div class="team-join-info">
                            <h4 class="team-name" style="cursor: pointer;" data-team-id="${teamId}" onmouseenter="showTeamPopup(this, '${teamId}')" onmouseleave="hideTeamPopup()" onclick="openPublicTeamProfile('${teamId}')">
                                ${safeName}
                            </h4>
                            <div class="team-join-details">
                                <span><i class="fas fa-calendar-alt"></i> Created: ${formatTimestamp(teamData.createdAt)}</span>
                                <span><i class="fas fa-users"></i> ${playerCount} / 10 Players</span>
                            </div>
                        </div>
                        <span class="team-join-game">${teamData.game || 'other'}</span>
                        <button
                            class="join-request-btn"
                            id="joinBtn-${teamId}"
                            onclick="sendJoinRequest('${teamId}')"
                            ${hasPendingRequest ? 'disabled' : ''}
                        >
                            ${hasPendingRequest ? 'Request Sent' : 'Send Join Request'}
                        </button>
                    </div>
                `;
            }
        });

        listContainer.innerHTML = hasJoinableTeams ? joinableTeamsHTML : '<p style="color:#aaa; text-align:center;">All teams are currently full or none exist.</p>';
    } catch (error) {
         console.error("Error loading joinable teams:", error);
         showNotification("Error loading available teams.", "error"); 
         listContainer.innerHTML = '<p style="color:#e53935; text-align:center;">Error loading teams.</p>';
     }
}

/**
 * Envía una solicitud para unirse a un equipo.
 */
window.sendJoinRequest = async function(teamId) {
    if (!currentUser || !currentUserData) {
        showNotification("You must be logged in to send a request.", "error"); 
        return;
    }
    const userNick = currentUserData.nick || 'Unknown User';
    
    const listButton = document.getElementById(`joinBtn-${teamId}`);
    const modalButton = document.getElementById('modalJoinTeamBtn');
    
    if (listButton) {
        listButton.disabled = true;
        listButton.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Sending...';
    }
    if (modalButton && modalButton.dataset.teamId === teamId && modalButton.style.display === 'block') {
         modalButton.disabled = true;
         modalButton.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Sending...';
    }

    try {
        // HARDENING: Chequeo de que el equipo no esté lleno en el cliente antes de enviar la request
        const teamRosterRef = firebase.database().ref(`teams/${teamId}/roster`);
        const rosterSnapshot = await teamRosterRef.once('value');
        if (rosterSnapshot.exists() && rosterSnapshot.numChildren() >= 10) {
            throw new Error("Team is already full.");
        }
        // FIN HARDENING
        
        const updates = {};
        const requestData = {
             userId: currentUser.uid,
            userName: sanitizeText(userNick), // MODIFICACIÓN: Sanitizar
            userPhoto: currentUser.photoURL || 'dragon_profile_studiosgamesrs.png',
            timestamp: firebase.database.ServerValue.TIMESTAMP
        };
        updates[`teamJoinRequests/${teamId}/${currentUser.uid}`] = requestData;
        updates[`userJoinRequests/${currentUser.uid}/${teamId}`] = true;
        await firebase.database().ref().update(updates);
        
        if (listButton) { listButton.innerHTML = 'Request Sent'; }
        if (modalButton && modalButton.dataset.teamId === teamId && modalButton.style.display === 'block') { modalButton.innerHTML = 'Request Sent'; }

        showNotification("Your request has been sent!", "success"); 
    } catch (error) {
        console.error("Error sending join request:", error);
        showNotification("Error sending request: " + (error.message || 'Unknown error'), "error"); 
        
        if (listButton) {
            listButton.disabled = false;
            listButton.innerHTML = 'Send Join Request';
        }
         if (modalButton && modalButton.dataset.teamId === teamId && modalButton.style.display === 'block') {
            modalButton.disabled = false;
            modalButton.innerHTML = '<i class="fas fa-plus"></i> Send Join Request';
        }
    }
}

/**
 * Formatea un timestamp de Firebase a una fecha legible.
 */
function formatTimestamp(timestamp) {
     if (!timestamp) return 'N/A';
    const date = new Date(timestamp);
    try {
        return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    } catch (e) {
        console.error("Invalid timestamp:", timestamp, e);
        return 'Invalid Date';
    }
}

// ---- Sistema de niveles de equipo (1 a 10) ----
// XP se gana jugando: victoria = +10, derrota = +3 (participar también suma).
const TEAM_LEVEL_THRESHOLDS = [0, 50, 120, 220, 350, 520, 740, 1020, 1380, 1850];
const TEAM_XP_PER_WIN = 10;
const TEAM_XP_PER_LOSS = 3;

function computeTeamXp(teamData) {
    const wins = (teamData.stats && typeof teamData.stats.wins === 'number') ? teamData.stats.wins : 0;
    const losses = (teamData.stats && typeof teamData.stats.losses === 'number') ? teamData.stats.losses : 0;
    return wins * TEAM_XP_PER_WIN + losses * TEAM_XP_PER_LOSS;
}
function computeTeamLevel(xp) {
    let level = 1;
    for (let i = 0; i < TEAM_LEVEL_THRESHOLDS.length; i++) {
        if (xp >= TEAM_LEVEL_THRESHOLDS[i]) level = i + 1;
    }
    return Math.min(level, 10);
}

// Rellena la ficha "Team Info": fundación, fundador, victorias/derrotas, nivel y verificación.
function populateTeamInfoWidget(teamData, teamId) {
    const foundedEl = document.getElementById('teamInfoFounded');
    const founderEl = document.getElementById('teamInfoFounder');
    const winsEl = document.getElementById('teamInfoWins');
    const lossesEl = document.getElementById('teamInfoLosses');
    if (!teamData) return;

    const wins = (teamData.stats && typeof teamData.stats.wins === 'number') ? teamData.stats.wins : 0;
    const losses = (teamData.stats && typeof teamData.stats.losses === 'number') ? teamData.stats.losses : 0;

    if (foundedEl) foundedEl.textContent = formatTimestamp(teamData.createdAt);
    if (winsEl) winsEl.textContent = wins;
    if (lossesEl) lossesEl.textContent = losses;

    // Nivel + barra de progreso
    const xp = computeTeamXp(teamData);
    const level = computeTeamLevel(xp);
    const levelEl = document.getElementById('teamInfoLevel');
    const xpEl = document.getElementById('teamInfoLevelXp');
    const barEl = document.getElementById('teamInfoLevelBar');
    const nextEl = document.getElementById('teamInfoLevelNext');
    if (levelEl) levelEl.textContent = 'Lv ' + level;
    if (xpEl) xpEl.textContent = xp + ' XP';
    if (level >= 10) {
        if (barEl) barEl.style.width = '100%';
        if (nextEl) nextEl.textContent = '¡Nivel máximo alcanzado!';
    } else {
        const curBase = TEAM_LEVEL_THRESHOLDS[level - 1];
        const nextBase = TEAM_LEVEL_THRESHOLDS[level];
        const pct = Math.max(0, Math.min(100, Math.round(((xp - curBase) / (nextBase - curBase)) * 100)));
        if (barEl) barEl.style.width = pct + '%';
        if (nextEl) nextEl.textContent = (nextBase - xp) + ' XP para el nivel ' + (level + 1);
    }

    if (founderEl) {
        const captainUid = teamData.captain;
        if (!captainUid) { founderEl.textContent = '—'; }
        else {
            founderEl.textContent = 'Loading...';
            firebase.database().ref(`users/${captainUid}/nick`).once('value')
                .then(snap => {
                    const nick = snap.val();
                    founderEl.textContent = nick ? sanitizeText(nick) : 'Unknown';
                })
                .catch(() => { founderEl.textContent = 'Unknown'; });
        }
    }

    // Verificación del equipo
    renderTeamVerification(teamData, teamId);
}

// ¿El equipo está inscrito en algún torneo activo (no finalizado/cancelado)?
// Devuelve una Promise<boolean>.
async function checkTeamTournamentEnrollment(teamId) {
    if (!teamId) return false;
    try {
        const snap = await firebase.database().ref('tournaments').limitToLast(50).once('value');
        if (!snap.exists()) return false;
        let enrolled = false;
        snap.forEach(ch => {
            const t = ch.val() || {};
            const reg = t.registeredTeams || {};
            if (!reg[teamId]) return;
            const st = (t.status || '').toString().toLowerCase();
            const finished = ['finalizado', 'finished', 'cancelado', 'cancelled', 'completed'].indexOf(st) !== -1;
            if (!finished) enrolled = true;
        });
        return enrolled;
    } catch (e) {
        console.error('Error comprobando inscripción en torneos:', e);
        return false;
    }
}

// ---- Verificación de equipo (todos pagan 5 coins; válida por 3 partidas) ----
// El cobro solo aparece si el equipo está inscrito en un torneo.
function renderTeamVerification(teamData, teamId) {
    const badge = document.getElementById('teamVerifyBadge');
    if (!badge || !teamId) return;

    const v = teamData.verification || {};
    const isVerified = v.status === 'verified' && (typeof v.matchesRemaining === 'number' ? v.matchesRemaining > 0 : false);

    // Si ya está verificado, mostramos el estado sin importar la inscripción.
    if (isVerified) {
        renderVerificationUI(teamData, teamId, true);
        return;
    }

    // Estado provisional mientras comprobamos la inscripción en torneos.
    const meta = document.getElementById('teamVerifyMeta');
    const progress = document.getElementById('teamVerifyProgress');
    const payBtn = document.getElementById('teamVerifyPayBtn');
    badge.className = 'team-verify-badge unverified';
    badge.innerHTML = '<i class="fas fa-shield-alt"></i> No verificado';
    if (meta) meta.textContent = 'Comprobando inscripción en torneos...';
    if (progress) progress.textContent = '';
    if (payBtn) payBtn.style.display = 'none';

    checkTeamTournamentEnrollment(teamId)
        .then(enrolled => renderVerificationUI(teamData, teamId, enrolled))
        .catch(() => renderVerificationUI(teamData, teamId, false));
}

function renderVerificationUI(teamData, teamId, enrolledInTournament) {
    const badge = document.getElementById('teamVerifyBadge');
    const meta = document.getElementById('teamVerifyMeta');
    const progress = document.getElementById('teamVerifyProgress');
    const payBtn = document.getElementById('teamVerifyPayBtn');
    if (!badge) return;

    const v = teamData.verification || {};
    const roster = teamData.roster || {};
    const rosterUids = Object.keys(roster);
    const payments = v.payments || {};
    const paidCount = rosterUids.filter(uid => payments[uid]).length;
    const totalMembers = rosterUids.length;
    const isVerified = v.status === 'verified' && (typeof v.matchesRemaining === 'number' ? v.matchesRemaining > 0 : false);
    const myUid = currentUser ? currentUser.uid : null;
    const iAmMember = myUid && roster[myUid];
    const iPaid = myUid && payments[myUid];

    if (isVerified) {
        badge.className = 'team-verify-badge verified';
        badge.innerHTML = '<i class="fas fa-check-circle"></i> Equipo verificado';
        if (meta) meta.textContent = 'Válido para ' + v.matchesRemaining + ' partida(s) de torneo más.';
        if (progress) progress.textContent = '';
        if (payBtn) payBtn.style.display = 'none';
        return;
    }

    // No verificado y NO inscrito en torneo: no se muestra el cobro.
    if (!enrolledInTournament) {
        badge.className = 'team-verify-badge unverified';
        badge.innerHTML = '<i class="fas fa-shield-alt"></i> No verificado';
        if (meta) meta.textContent = 'La verificación se activa al inscribir tu equipo en un torneo.';
        if (progress) progress.textContent = '';
        if (payBtn) payBtn.style.display = 'none';
        return;
    }

    // No verificado y SÍ inscrito: se habilita el cobro de 5 coins por miembro.
    badge.className = 'team-verify-badge unverified';
    badge.innerHTML = '<i class="fas fa-shield-alt"></i> No verificado';
    if (meta) meta.textContent = 'Tu equipo está inscrito: todos deben pagar 5 coins para jugar verificados.';
    if (progress) progress.textContent = paidCount + ' / ' + totalMembers + ' miembros han pagado su verificación.';
    if (payBtn) {
        if (iAmMember && !iPaid) {
            payBtn.style.display = 'flex';
            payBtn.disabled = false;
            payBtn.innerHTML = '<i class="fas fa-coins"></i> Pagar mi verificación (5 coins)';
            payBtn.onclick = () => payTeamVerification(teamId);
        } else if (iAmMember && iPaid) {
            payBtn.style.display = 'flex';
            payBtn.disabled = true;
            payBtn.innerHTML = '<i class="fas fa-check"></i> Ya pagaste tu parte';
        } else {
            payBtn.style.display = 'none';
        }
    }
}

// Llama a la Cloud Function que descuenta 5 coins y registra el pago de verificación.
async function payTeamVerification(teamId) {
    const payBtn = document.getElementById('teamVerifyPayBtn');
    if (!currentUser) return;
    if (payBtn) { payBtn.disabled = true; payBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Procesando...'; }
    try {
        const fn = firebase.functions().httpsCallable('payTeamVerification');
        const res = await fn({ teamId: teamId });
        const data = res && res.data ? res.data : {};
        if (data.alreadyPaid) {
            showNotification('Ya habías pagado tu verificación.', 'success');
        } else if (data.verified) {
            showNotification('¡Equipo verificado! Válido por 3 partidas.', 'success');
        } else {
            showNotification('Pago registrado. Faltan ' + (data.remainingMembers || 0) + ' miembro(s) por pagar.', 'success');
        }
        // Recarga los datos del equipo para refrescar el estado
        const snap = await firebase.database().ref(`teams/${teamId}`).once('value');
        if (snap.exists()) renderTeamVerification(snap.val(), teamId);
    } catch (e) {
        console.error('Error en verificación:', e);
        const msg = (e && e.message) ? e.message : 'No se pudo procesar el pago.';
        showNotification(msg, 'error');
        if (payBtn) { payBtn.disabled = false; payBtn.innerHTML = '<i class="fas fa-coins"></i> Pagar mi verificación (5 coins)'; }
    }
}


// =========================================================================
// --- INICIO: NUEVAS FUNCIONES PARA GESTIONAR INVITACIONES RECIBIDAS (JUGADOR) ---
// =========================================================================

/**
 * Carga las invitaciones que el usuario ha recibido de otros equipos.
 */
async function loadReceivedInvites(userId) {
    const listContainer = document.getElementById('receivedInvitesList');
    if (!listContainer) { return; }
    
    listContainer.innerHTML = '<div class="team-join-bar-skeleton"></div>'; 
    
    try {
        const invitesRef = firebase.database().ref(`teamInvites/${userId}`);
        const snapshot = await invitesRef.once('value');
        
        if (!snapshot.exists() || !snapshot.hasChildren()) {
            listContainer.innerHTML = '<p style="color: #888; text-align: center; font-size: 0.9rem;">You have no pending team invitations.</p>';
            return;
        }
        
        const invites = snapshot.val();
        let invitesHTML = '';
        let inviteCount = 0;
        
        Object.entries(invites).forEach(([teamId, inviteData]) => {
            if (!inviteData) return;
            inviteCount++;
            
            // MODIFICACIÓN: Sanitizar
            const safeTeamName = sanitizeText(inviteData.teamName);
            const safeInvitedBy = sanitizeText(inviteData.invitedBy);
            
            invitesHTML += `
                <div class="team-join-bar invite" id="invite-bar-${teamId}">
                    <img src="${inviteData.teamEmblem || 'https://placehold.co/50x50/333/ccc?text=??'}" alt="${safeTeamName} Emblem" class="team-emblem" style="width: 50px; height: 50px; border-radius: 50%;">
                    <div class="team-join-info">
                        <h4 class="team-name" style="cursor: pointer;" data-team-id="${teamId}" onmouseenter="showTeamPopup(this, '${teamId}')" onmouseleave="hideTeamPopup()" onclick="openPublicTeamProfile('${teamId}')">
                            ${safeTeamName}
                        </h4>
                        <div class="team-join-details">
                            <span><i class="fas fa-user-plus"></i> Invited by: ${safeInvitedBy}</span>
                        </div>
                    </div>
                    <div class="invite-actions" style="display: flex; gap: 0.5rem; margin-left: auto;">
                        <button class="join-request-btn" style="background: #4caf50;" id="accept-invite-${teamId}" onclick="acceptReceivedInvite('${teamId}', '${safeTeamName}')">
                            Accept
                        </button>
                        <button class="join-request-btn" style="background: #e53935;" id="decline-invite-${teamId}" onclick="declineReceivedInvite('${teamId}')">
                            Decline
                        </button>
                    </div>
                </div>
            `;
        });
        
        if (inviteCount > 0) {
            listContainer.innerHTML = invitesHTML;
        } else {
             listContainer.innerHTML = '<p style="color: #888; text-align: center; font-size: 0.9rem;">You have no pending team invitations.</p>';
        }
        
    } catch (error) {
        console.error("Error loading received invites:", error);
        showNotification("Error loading your invitations.", "error");
        listContainer.innerHTML = '<p style="color: #e53935; text-align: center;">Error loading invites.</p>';
    }
}

/**
 * Acepta una invitación de equipo recibida.
 */
window.acceptReceivedInvite = async function(teamId, teamName) {
    if (!currentUser) return;
    const userId = currentUser.uid;

    const acceptBtn = document.getElementById(`accept-invite-${teamId}`);
    const declineBtn = document.getElementById(`decline-invite-${teamId}`);
    if (acceptBtn) acceptBtn.disabled = true;
    if (declineBtn) declineBtn.disabled = true;
    if (acceptBtn) acceptBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';

    if (!teamFunctions) {
        showNotification("Cloud Functions no disponibles.", "error");
        if (acceptBtn) acceptBtn.disabled = false;
        if (declineBtn) declineBtn.disabled = false;
        if (acceptBtn) acceptBtn.innerHTML = 'Accept';
        return;
    }

    try {
        await teamFunctions.httpsCallable('acceptTeamInvite')({ teamId: teamId });
        showNotification(`Successfully joined ${teamName}!`, "success");
        window.location.reload();
    } catch (error) {
        console.error("Error accepting invite:", error);
        showNotification(`Failed to join: ${teamFnErrorMessage(error, error.message || 'Unknown error')}`, "error");
        if (acceptBtn) acceptBtn.disabled = false;
        if (declineBtn) declineBtn.disabled = false;
        if (acceptBtn) acceptBtn.innerHTML = 'Accept';
    }
}

/**
 * Rechaza una invitación de equipo recibida.
 */
window.declineReceivedInvite = async function(teamId) {
    if (!currentUser) return;
    const userId = currentUser.uid;
    
    const inviteBar = document.getElementById(`invite-bar-${teamId}`);
    if (inviteBar) inviteBar.style.opacity = '0.5';

    try {
        const inviteRef = firebase.database().ref(`teamInvites/${userId}/${teamId}`);
        await inviteRef.remove();
        
        if (inviteBar) inviteBar.remove();
        showNotification("Invite declined.", "success");
        
        const listContainer = document.getElementById('receivedInvitesList');
        if (listContainer && listContainer.children.length === 0) {
            listContainer.innerHTML = '<p style="color: #888; text-align: center; font-size: 0.9rem;">You have no pending team invitations.</p>';
        }
        
    } catch (error) {
        console.error("Error declining invite:", error);
        showNotification("Error declining invite.", "error");
        if (inviteBar) inviteBar.style.opacity = '1';
    }
}

// =========================================================================
// --- FIN: NUEVAS FUNCIONES PARA GESTIONAR INVITACIONES RECIBIDAS (JUGADOR) ---
// =========================================================================


// ==================================================================
// --- FUNCTIONS FOR HANDLING JOIN REQUESTS (ACCEPT/DECLINE) ---
// ==================================================================

/**
 * Carga las solicitudes pendientes en el dashboard del capitán.
 */
async function loadPendingRequests(teamId, listContainer) {
    listContainer.innerHTML = '<p style="color: #888; font-size: 0.9rem;">Loading requests...</p>';
    try {
        const requestsRef = firebase.database().ref(`teamJoinRequests/${teamId}`);
        const snapshot = await requestsRef.once('value');

        if (!snapshot.exists() || !snapshot.hasChildren()) {
            listContainer.innerHTML = '<p style="color: #888; font-size: 0.9rem;">No pending requests.</p>';
            return;
        }

        const requests = snapshot.val();
        listContainer.innerHTML = '';
        let requestCount = 0;

        Object.entries(requests).forEach(([userId, requestData]) => {
            if (!requestData || !requestData.userId || !requestData.userName) {
                console.warn("Skipping invalid request data:", requestData);
                return;
            }
            requestCount++;
            const itemEl = document.createElement('div');
            itemEl.className = 'request-item';
            itemEl.id = `request-item-${userId}`;

            const safeNick = sanitizeText(requestData.userName); // MODIFICACIÓN: Sanitizar
            
            itemEl.innerHTML = `
                <img src="${requestData.userPhoto || 'dragon_profile_studiosgamesrs.png'}" alt="User" class="roster-member-img" style="width: 35px; height: 35px; border-radius: 50%;">
                <span class="roster-name"
                   style="cursor: pointer;"
                   data-user-id="${requestData.userId}"
                   onmouseenter="showUserPopup(this, '${requestData.userId}')"
                   onmouseleave="hideUserPopup()"
                   onclick="window.location.href='dashboard.html?uid=${requestData.userId}'">
                    ${safeNick}
                </span>
                <div class="request-actions">
                    <button class="accept-btn" onclick="acceptJoinRequest('${teamId}', '${requestData.userId}')">Accept</button>
                    <button class="decline-btn" onclick="declineJoinRequest('${teamId}', '${requestData.userId}')">Decline</button>
                </div>
            `;

            listContainer.appendChild(itemEl);
        });

        if (requestCount === 0) {
             listContainer.innerHTML = '<p style="color: #888; font-size: 0.9rem;">No pending requests.</p>';
        }

    } catch (error) {
        console.error("Error loading pending requests:", error);
        showNotification("Error loading join requests.", "error"); 
        listContainer.innerHTML = '<p style="color: #e53935; font-size: 0.9rem;">Error loading requests.</p>';
    }
}

/**
 * Acepta la solicitud de un jugador para unirse al equipo.
 */
window.acceptJoinRequest = async function(teamId, userId) {
    const acceptBtn = document.querySelector(`#request-item-${userId} .accept-btn`);
    const declineBtn = document.querySelector(`#request-item-${userId} .decline-btn`);
    if(acceptBtn) acceptBtn.disabled = true;
    if(declineBtn) declineBtn.disabled = true;
    if (!teamFunctions) {
        showNotification("Cloud Functions no disponibles.", "error");
        if(acceptBtn) acceptBtn.disabled = false;
        if(declineBtn) declineBtn.disabled = false;
        return;
    }
    try {
        await teamFunctions.httpsCallable('acceptTeamJoinRequest')({ teamId: teamId, userId: userId });
        showNotification("Member accepted!", "success");
        window.location.reload();
    } catch (error) {
        console.error("Error accepting request:", error);
        showNotification("Failed to accept request: " + teamFnErrorMessage(error, error.message || 'Unknown error'), "error");
        if(acceptBtn) acceptBtn.disabled = false;
        if(declineBtn) declineBtn.disabled = false;
    }
}

/**
 * Rechaza la solicitud de un jugador para unirse al equipo.
 */
window.declineJoinRequest = async function(teamId, userId) {
    showConfirmationModal(
        'Decline Request',
        `Are you sure you want to decline the request from this user?`,
        async () => {
             // HARDENING: Chequeo de que el Capitán sigue siendo el Capitán (seguridad)
            const teamSnap = await firebase.database().ref(`teams/${teamId}`).once('value');
            if (teamSnap.val().captain !== currentUser.uid) {
                 showNotification("Permission denied. You are no longer the captain.", "error");
                 return;
            }
             // FIN HARDENING

            const acceptBtn = document.querySelector(`#request-item-${userId} .accept-btn`);
            const declineBtn = document.querySelector(`#request-item-${userId} .decline-btn`);
            if(acceptBtn) acceptBtn.disabled = true;
            if(declineBtn) declineBtn.disabled = true;
            try {
                const updates = {};
                updates[`teamJoinRequests/${teamId}/${userId}`] = null;
                updates[`userJoinRequests/${userId}/${teamId}`] = null;
                await firebase.database().ref().update(updates);
                showNotification("Request declined.", "success"); 
                document.getElementById(`request-item-${userId}`)?.remove();
            } catch (error) {
                console.error("Error declining request:", error);
                showNotification("Failed to decline request: " + error.message, "error"); 
                 if(acceptBtn) acceptBtn.disabled = false; 
                if(declineBtn) declineBtn.disabled = false;
            }
        }
    );
}


// ===============================================
// --- FUNCTIONS FOR POPUP & LEAVE TEAM ---
// ===============================================

/**
 * Muestra la mini-tarjeta de usuario (HOVER).
 */
window.showUserPopup = async function(linkElement, userId) {
    clearTimeout(popupTimeout);
    const popupCard = document.getElementById('userPopupCard');
    if (!popupCard || !userId) return;

    popupCard.classList.remove('rank-commander', 'rank-divisional', 'rank-tribal');

    document.getElementById('popupUserPhoto').src = 'dragon_profile_studiosgamesrs.png';
    document.getElementById('popupUserNick').textContent = 'Loading...';
    document.getElementById('popupUserGroup').textContent = '...';
    document.getElementById('popupUserRank').textContent = 'Loading...';
    document.getElementById('popupUserHonor').textContent = '...';

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
            document.getElementById('popupUserPhoto').src = userData.photoURL || 'dragon_profile_studiosgamesrs.png';
            document.getElementById('popupUserNick').textContent = sanitizeText(userData.nick || 'Unknown User'); // MODIFICACIÓN: Sanitizar

            // Honor de la comunidad
            const honorVal = Number(userData.communityHonor || 0);
            document.getElementById('popupUserHonor').textContent = honorVal.toLocaleString();

            // Grupo actual: mostramos el nombre del equipo si pertenece a uno
            const groupEl = document.getElementById('popupUserGroup');
            if (userData.teamId) {
                groupEl.textContent = 'Loading...';
                firebase.database().ref(`teams/${userData.teamId}/name`).once('value')
                    .then(snap => { groupEl.textContent = snap.val() ? sanitizeText(snap.val()) : 'Sin grupo'; })
                    .catch(() => { groupEl.textContent = 'Sin grupo'; });
            } else {
                groupEl.textContent = 'Sin grupo';
            }

            // Rango (normalizado a minúsculas para evitar fallos por mayúsculas, p. ej. "Commander")
            const rango = (userData.rango || 'tribal_warrior').toString().toLowerCase();
            const rankEl = document.getElementById('popupUserRank');
            rankEl.textContent = getRankName(rango);

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
            document.getElementById('popupUserGroup').textContent = 'N/A';
            document.getElementById('popupUserRank').textContent = 'Error';
            document.getElementById('popupUserHonor').textContent = '0';
        }
        setTimeout(() => { popupCard.classList.add('visible'); }, 10);
    } catch (error) {
        console.error("Error showing user popup:", error);
        document.getElementById('popupUserNick').textContent = 'Error';
        document.getElementById('popupUserGroup').textContent = 'N/A';
        document.getElementById('popupUserRank').textContent = 'Error';
        document.getElementById('popupUserHonor').textContent = '0';
         setTimeout(() => { popupCard.classList.add('visible'); }, 10);
    }
}

/**
 * NUEVA FUNCIÓN HELPER: Devuelve el nombre legible del rango.
 */
function getRankName(rangoKey) {
    switch((rangoKey || '').toString().toLowerCase()) {
        case 'commander': return 'Commander';
        case 'divisional_commander': return 'Divisional';
        case 'tribal_warrior': return 'Tribal Warrior';
        default: return 'Tribal Warrior';
    }
}

/**
 * Hides the user info popup card after a short delay.
 */
window.hideUserPopup = function() {
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
 * Allows a team member (not captain) to leave their current team. Uses Confirmation Modal.
 * @param {string} teamId
 * @param {string} userId
 */
async function leaveTeam(teamId, userId) {
    if (!teamId || !userId) {
        console.error("Missing teamId or userId for leaveTeam");
        showNotification("An error occurred. Cannot leave team.", "error");
        return;
    }
    if (!teamFunctions) {
        showNotification("Cloud Functions no disponibles.", "error");
        return;
    }

    try {
        await teamFunctions.httpsCallable('leaveTeam')({ teamId: teamId });
        showNotification("You have left the team.", "success");
        setTimeout(() => {
            window.location.reload();
        }, 800);
    } catch (error) {
        console.error("Error leaving team:", error);
        showNotification("Failed to leave team: " + teamFnErrorMessage(error, error.message || 'Unknown error'), "error");
    }
}

/**
 * Capitán expulsa a un miembro del equipo (SEC-010: teamId vía Cloud Function).
 */
window.kickMember = async function(teamId, memberUid, memberNick) {
    if (!teamId || !memberUid) {
        showNotification("Invalid kick action.", "error");
        return;
    }
    if (!teamFunctions) {
        showNotification("Cloud Functions no disponibles.", "error");
        return;
    }
    try {
        await teamFunctions.httpsCallable('kickTeamMember')({ teamId: teamId, memberUid: memberUid });
        showNotification((memberNick || 'Member') + ' has been removed from the team.', "success");
        window.location.reload();
    } catch (error) {
        console.error("Error kicking member:", error);
        showNotification("Failed to kick member: " + teamFnErrorMessage(error, error.message || 'Unknown error'), "error");
    }
};

// ===============================================
// --- NEW UI HELPER FUNCTIONS ---
// ===============================================

/**
 * Displays a custom notification message.
 */
function showNotification(message, type = 'success') {
    const container = document.getElementById('notificationContainer');
    if (!container) return;

    const safeMessage = sanitizeText(message); // MODIFICACIÓN: Sanitizar
    
    const notification = document.createElement('div');
    notification.className = `notification-item ${type}`; 

    let iconClass = 'fa-check-circle'; 
    if (type === 'error') {
        iconClass = 'fa-exclamation-triangle';
    }

    notification.innerHTML = `
        <i class="fas ${iconClass}"></i>
        <span>${safeMessage}</span>
    `;

    container.appendChild(notification);

    setTimeout(() => {
        notification.style.animation = 'fadeOutNotification 0.5s forwards';
         setTimeout(() => {
            notification.remove();
        }, 500); 
    }, 5000); 
}

/**
 * Shows the confirmation modal.
 */
function showConfirmationModal(title, message, onConfirm) {
    const modal = document.getElementById('confirmationModal');
    const titleEl = document.getElementById('confirmationTitle');
    const messageEl = document.getElementById('confirmationMessage');

    if (!modal || !titleEl || !messageEl) {
        console.error("Confirmation modal elements not found!");
        if (confirm(`${title}\n\n${message}`)) {
            onConfirm();
        }
        return;
    }

    titleEl.textContent = sanitizeText(title); // MODIFICACIÓN: Sanitizar
    messageEl.textContent = sanitizeText(message); // MODIFICACIÓN: Sanitizar
    currentConfirmCallback = onConfirm; 

    modal.style.display = 'flex'; 
}

/**
 * NUEVA FUNCIÓN HELPER: Sanitiza texto para prevenir XSS.
 * Utiliza textContent para escapar el HTML.
 */
function sanitizeText(text) {
    if (!text) return '';
    const div = document.createElement('div');
    // FIX: Convertir a String antes de asignar textContent, por si acaso
    div.textContent = String(text); 
    // Usar innerHTML después de asignar textContent escapa el HTML.
    return div.innerHTML; 
}

// ==================================================================
// --- INICIO: CÓDIGO PARA BÚSQUEDA Y PERFILES PÚBLICOS ---
// ==================================================================

let teamPopupTimeout; 

/**
 * Inicializa la barra de búsqueda del encabezado para buscar jugadores y equipos.
 */
function initializeHubSearch() {
    const searchInput = document.getElementById('userSearchInput');
    const searchResults = document.getElementById('searchResults');
    let searchTimeout = null;

    if (!searchInput || !searchResults) { return; }

    searchInput.addEventListener('input', function() {
        const query = this.value.trim().toLowerCase();
        if (searchTimeout) clearTimeout(searchTimeout);

        if (query.length < 3) { // FIX: Aumentar mínimo de búsqueda a 3
            searchResults.style.display = 'none';
            return;
        }

        searchTimeout = setTimeout(() => {
            searchPlayersAndTeams(query);
        }, 300); 
    });

    document.addEventListener('click', function(e) {
        if (!e.target.closest('.header-search')) {
            searchResults.style.display = 'none';
        }
    });
}

/**
 * Busca en Firebase tanto jugadores como equipos.
 */
async function searchPlayersAndTeams(query) {
    const searchResults = document.getElementById('searchResults');
    if (!searchResults) return;

    searchResults.style.display = 'block';
    searchResults.innerHTML = '<div class="search-result-item">Searching...</div>';

    try {
        // PZ-017: solo se necesitan nick/photoURL para esta búsqueda combinada, usa publicProfiles.
        const usersRef = firebase.database().ref('publicProfiles');
        const teamsRef = firebase.database().ref('teams');

        // 1. Buscar Jugadores
        const allUsersSnapshot = await usersRef.once('value');
        const userResults = [];
        if (allUsersSnapshot.exists()) {
            allUsersSnapshot.forEach(child => {
                const userData = child.val();
                const nick = userData.nick || '';
                if (nick.toLowerCase().includes(query)) {
                    userResults.push({
                        type: 'user',
                        uid: child.key,
                        nick: sanitizeText(userData.nick), // MODIFICACIÓN: Sanitizar
                        photoURL: userData.photoURL || 'dragon_profile_studiosgamesrs.png'
                    });
                }
            });
        }
        const limitedUserResults = userResults.slice(0, 3);


        // 2. Buscar Equipos
        const teamSnapshot = await teamsRef.orderByChild('name_lowercase')
                                           .startAt(query)
                                           .endAt(query + '\uf8ff')
                                           .limitToFirst(3)
                                           .once('value');
        
        const teamResults = [];
        if (teamSnapshot.exists()) {
            teamSnapshot.forEach(child => {
                const teamData = child.val();
                teamResults.push({
                    type: 'team',
                    teamId: child.key,
                    name: sanitizeText(teamData.name || 'Team'), // MODIFICACIÓN: Sanitizar
                    emblemUrl: teamData.emblemUrl || 'https://placehold.co/50x50/333/ccc?text=??'
                });
            });
        }

        // 3. Combinar y Renderizar
        const allResults = [...limitedUserResults, ...teamResults];
        renderSearchResults(allResults);

    } catch (error) {
        console.error("Error en la búsqueda:", error);
        searchResults.innerHTML = '<div class="search-result-item">Error during search.</div>';
    }
}

/**
 * Renderiza los resultados combinados de jugadores y equipos en el dropdown.
 */
function renderSearchResults(results) {
    const searchResults = document.getElementById('searchResults');
    if (results.length === 0) {
        searchResults.innerHTML = '<div class="search-result-item">No results found.</div>';
        return;
    }

    searchResults.innerHTML = results.map(item => {
        if (item.type === 'user') {
            return `
                <div class="search-result-item" 
                     data-user-id="${item.uid}"
                     onmouseenter="showUserPopup(this, '${item.uid}')" 
                     onmouseleave="hideUserPopup()"
                     onclick="window.location.href='dashboard.html?uid=${item.uid}'">
                    
                    <img src="${item.photoURL}" alt="${item.nick}" class="search-result-img" style="border: 2px solid #4bdfff;">
                    <div class="search-result-info">
                        <div class="search-result-nick">${item.nick}</div>
                        <div class="search-result-rank" style="color: #4bdfff;">Player</div>
                    </div>
                </div>
            `;
        } else if (item.type === 'team') {
            return `
                <div class="search-result-item" 
                     data-team-id="${item.teamId}"
                     onmouseenter="showTeamPopup(this, '${item.teamId}')"
                     onmouseleave="hideTeamPopup()"
                     onclick="openPublicTeamProfile('${item.teamId}')">
                    
                    <img src="${item.emblemUrl}" alt="${item.name}" class="search-result-img" style="border-radius: 50%; border: 2px solid #ffca3a;">
                    <div class="search-result-info">
                        <div class="search-result-nick">${item.name}</div>
                        <div class="search-result-rank" style="color: #ffca3a;">Team</div>
                    </div>
                </div>
            `;
        }
        return '';
    }).join('');

    searchResults.querySelectorAll('.search-result-item').forEach(item => {
        item.addEventListener('click', () => {
            searchResults.style.display = 'none';
        });
    });
}

/**
 * Muestra la mini-tarjeta de equipo al pasar el ratón.
 */
window.showTeamPopup = async function(linkElement, teamId) {
    clearTimeout(teamPopupTimeout);
    const popupCard = document.getElementById('teamPopupCard');
    if (!popupCard || !teamId) return;

    document.getElementById('popupTeamEmblem').src = 'https://placehold.co/50x50/333/ccc?text=??';
    document.getElementById('popupTeamName').textContent = 'Loading...';
    document.getElementById('popupTeamGame').textContent = '...';
    document.getElementById('popupTeamMembers').textContent = '...';
    document.getElementById('popupTeamWins').textContent = '...';

    const linkRect = linkElement.getBoundingClientRect();
    let top = window.scrollY + linkRect.bottom + 8;
    let left = window.scrollX + linkRect.left;
    popupCard.style.top = `${top}px`;
    popupCard.style.left = `${left}px`;
    popupCard.style.display = 'block';
    popupCard.classList.remove('visible');
    
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
            document.getElementById('popupTeamEmblem').src = teamData.emblemUrl || 'https://placehold.co/50x50/333/ccc?text=??';
            document.getElementById('popupTeamName').textContent = sanitizeText(teamData.name || 'Unknown Team'); // MODIFICACIÓN: Sanitizar
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
 * Abre el modal de perfil público de un equipo.
 */
window.openPublicTeamProfile = async function(teamId) {
    const modal = document.getElementById('teamProfileModal');
    const closeBtn = document.getElementById('closeTeamProfileModal');
    if (!modal || !teamId || !currentUser) return;

    modal.style.display = 'flex';
    document.getElementById('modalTeamName').textContent = 'Loading...';
    document.getElementById('modalTeamEmblem').src = 'https://placehold.co/100x100/333/ccc?text=TEAM';
    document.getElementById('modalRosterList').innerHTML = '<div class="roster-member-item skeleton"></div>';
    document.getElementById('modalStatGame').textContent = '...';
    document.getElementById('modalStatWins').textContent = '...';
    document.getElementById('modalStatTokens').textContent = '...';
    document.getElementById('modalStatCreated').textContent = '...';
    const joinBtn = document.getElementById('modalJoinTeamBtn');
    joinBtn.style.display = 'none'; 
    joinBtn.onclick = null; 
    joinBtn.dataset.teamId = teamId; 

    closeBtn.onclick = () => { modal.style.display = 'none'; };

    try {
        const teamRef = firebase.database().ref(`teams/${teamId}`);
        const snapshot = await teamRef.once('value');
        if (!snapshot.exists()) {
            throw new Error("Team not found.");
        }
        const teamData = snapshot.val();

        const profileAccent = getTeamAccent(teamData);
        const modalNameEl = document.getElementById('modalTeamName');
        modalNameEl.textContent = sanitizeText(teamData.name); // MODIFICACIÓN: Sanitizar
        modalNameEl.style.color = profileAccent;
        const modalEmblemEl = document.getElementById('modalTeamEmblem');
        modalEmblemEl.src = teamData.emblemUrl || 'https://placehold.co/100x100/333/ccc?text=TEAM';
        modalEmblemEl.style.borderColor = profileAccent;
        document.getElementById('modalStatGame').textContent = teamData.game || 'N/A';

        // Fondo personalizado del perfil (elegido por el capitán)
        const profileCard = modal.querySelector('.modal-content');
        if (profileCard) profileCard.style.background = getTeamBackgroundCss(getTeamBackgroundId(teamData));

        // Imagen de fondo personalizada en el recuadro del encabezado (emblema + nombre)
        const profileHeader = modal.querySelector('.team-profile-header');
        if (profileHeader) {
            const bgImg = getTeamBackgroundImage(teamData);
            if (bgImg) {
                profileHeader.style.background = `linear-gradient(rgba(0,0,0,0.4), rgba(0,0,0,0.75)), url("${bgImg}") center/cover no-repeat`;
            } else {
                profileHeader.style.background = ''; // vuelve al degradado por defecto del CSS
            }
        }
        document.getElementById('modalStatWins').textContent = teamData.stats?.wins || 0;
        document.getElementById('modalStatTokens').textContent = teamData.stats?.tokens || 0;
        document.getElementById('modalStatCreated').textContent = formatTimestamp(teamData.createdAt);

        const rosterList = document.getElementById('modalRosterList');
        rosterList.innerHTML = ''; 
        if (!teamData.roster || Object.keys(teamData.roster).length === 0) {
            rosterList.innerHTML = '<p style="color: #888; font-size: 0.9rem;">This team has no members.</p>';
        } else {
            const userPromises = Object.keys(teamData.roster).map(uid => 
                firebase.database().ref(`users/${uid}`).once('value')
            );
            const userSnapshots = await Promise.all(userPromises);

            userSnapshots.forEach(userSnap => {
                const userData = userSnap.val();
                const uid = userSnap.key;
                if (!userData) return; 

                const role = teamData.roster[uid].role;
                const memberEl = document.createElement('div');
                memberEl.className = 'roster-member-item';
                
                const safeNick = sanitizeText(userData.nick || 'User'); // MODIFICACIÓN: Sanitizar
                
                memberEl.innerHTML = `
                    <img src="${userData.photoURL || 'dragon_profile_studiosgamesrs.png'}" alt="${safeNick}">
                    <span class="roster-name" style="cursor: pointer;" data-user-id="${uid}" onmouseenter="showUserPopup(this, '${uid}')" onmouseleave="hideUserPopup()" onclick="window.location.href='dashboard.html?uid=${uid}'">
                        ${safeNick}
                    </span>
                    <span class="roster-role ${role.toLowerCase()}">${role}</span>
                `;
                rosterList.appendChild(memberEl);
            });
        }

        const isMember = currentUserData.teamId === teamId;
        if (!currentUserData.teamId) {
            const requestRef = firebase.database().ref(`userJoinRequests/${currentUser.uid}/${teamId}`);
            const requestSnap = await requestRef.once('value');
            const hasSentRequest = requestSnap.exists();
            
            joinBtn.style.display = 'block';
            joinBtn.disabled = hasSentRequest;
            joinBtn.innerHTML = hasSentRequest ? 'Request Sent' : '<i class="fas fa-plus"></i> Send Join Request';
            if (!hasSentRequest) {
                joinBtn.onclick = () => window.sendJoinRequest(teamId);
            }
        } else if (isMember) {
             joinBtn.style.display = 'none'; 
        } else {
             joinBtn.style.display = 'block';
             joinBtn.disabled = true;
             joinBtn.innerHTML = 'Leave your team to join';
        }

    } catch (error) {
        console.error("Error al abrir perfil de equipo:", error);
        showNotification(error.message, "error");
        document.getElementById('modalTeamName').textContent = 'Error';
        document.getElementById('modalRosterList').innerHTML = `<p style="color: #e53935;">${error.message}</p>`;
    }
}

// ===============================================
// --- FIN: CÓDIGO NUEVO ---
// ===============================================

// ==================================================================
// --- TEAM BROWSER (Explorar equipos) + APARIENCIA DE GRUPO ---
// ==================================================================
const TEAM_ACCENT_PRESETS = [
    { id: 'gold',   color: '#ffca3a' },
    { id: 'cyan',   color: '#4bdfff' },
    { id: 'green',  color: '#4caf50' },
    { id: 'red',    color: '#e5484d' },
    { id: 'purple', color: '#a06bff' },
    { id: 'orange', color: '#ff8f3a' },
    { id: 'pink',   color: '#ff5fa2' },
    { id: 'blue',   color: '#3a7bff' }
];
const DEFAULT_TEAM_ACCENT = '#ffca3a';

// Fondos del perfil del equipo. Guardamos solo el id (seguro); el CSS se aplica en cliente.
// 'default' es gratis; los premium se compran con coins (dos opciones iniciales).
const TEAM_BACKGROUND_PRESETS = [
    { id: 'default', label: 'Clásico', css: 'linear-gradient(to bottom, #252525, #1a1a1a)', premium: false, price: 0 },
    { id: 'aurora',  label: 'Aurora',  css: 'linear-gradient(160deg, #0f2027, #203a43, #2c5364)', premium: true, price: 15 },
    { id: 'gold',    label: 'Dorado',  css: 'linear-gradient(160deg, #3a2f0b, #6b5a1d, #d4af37)', premium: true, price: 30 },
    { id: 'red',     label: 'Rojo',    css: 'linear-gradient(160deg, #2b0f0f, #7a1d1d, #c62828)', premium: true, price: 50 }
];
const DEFAULT_TEAM_BACKGROUND = 'default';
// Nivel mínimo para subir una imagen de fondo personalizada.
const CUSTOM_BG_UPLOAD_LEVEL = 10;

function getBackgroundPreset(bgId) {
    return TEAM_BACKGROUND_PRESETS.find(p => p.id === bgId) || TEAM_BACKGROUND_PRESETS[0];
}
// ¿El equipo tiene desbloqueado este fondo? El 'default' siempre; los premium si se compraron.
function teamOwnsBackground(teamData, bgId) {
    if (!bgId || bgId === 'default') return true;
    const preset = getBackgroundPreset(bgId);
    if (!preset.premium) return true;
    const owned = teamData && teamData.appearance && teamData.appearance.ownedBackgrounds;
    return !!(owned && owned[bgId]);
}
function getTeamLevelFromData(teamData) {
    return computeTeamLevel(computeTeamXp(teamData));
}

function getTeamAccent(teamData) {
    const c = teamData && teamData.appearance && teamData.appearance.color;
    return (typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c)) ? c : DEFAULT_TEAM_ACCENT;
}
function getTeamBackgroundId(teamData) {
    const b = teamData && teamData.appearance && teamData.appearance.background;
    return TEAM_BACKGROUND_PRESETS.some(p => p.id === b) ? b : DEFAULT_TEAM_BACKGROUND;
}
function getTeamBackgroundCss(bgId) {
    const preset = TEAM_BACKGROUND_PRESETS.find(p => p.id === bgId) || TEAM_BACKGROUND_PRESETS[0];
    return preset.css;
}
function getTeamBackgroundImage(teamData) {
    const url = teamData && teamData.appearance && teamData.appearance.backgroundImage;
    return (typeof url === 'string' && url) ? url : '';
}

// Convierte un dataURL a Blob (fallback cuando canvas.toBlob no está disponible).
function dataURLToBlob(dataURL) {
    const parts = dataURL.split(',');
    const mime = (parts[0].match(/:(.*?);/) || [])[1] || 'image/jpeg';
    const bin = atob(parts[1]);
    const len = bin.length;
    const arr = new Uint8Array(len);
    for (let i = 0; i < len; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: mime });
}

// Comprime CUALQUIER imagen en el navegador (redimensiona y baja calidad) para que ocupe poco.
// Acepta cualquier resolución/tamaño; si es muy grande, reduce dimensiones y calidad
// de forma iterativa hasta un objetivo aproximado. Devuelve siempre un Blob JPEG.
function compressImageToBlob(file, maxDim, quality) {
    maxDim = maxDim || 1280;
    quality = quality || 0.72;
    const TARGET_BYTES = 350 * 1024; // ~350 KB objetivo para mantenerlo ligero
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('No se pudo leer el archivo.'));
        reader.onload = (e) => {
            const img = new Image();
            img.onerror = () => reject(new Error('El archivo no es una imagen válida.'));
            img.onload = () => {
                try {
                    const render = (dim, q) => {
                        let w = img.width, h = img.height;
                        if (!w || !h) throw new Error('Imagen sin dimensiones.');
                        if (w >= h && w > dim) { h = Math.round(h * dim / w); w = dim; }
                        else if (h > w && h > dim) { w = Math.round(w * dim / h); h = dim; }
                        const canvas = document.createElement('canvas');
                        canvas.width = w; canvas.height = h;
                        const ctx = canvas.getContext('2d');
                        ctx.fillStyle = '#1a1a1a';
                        ctx.fillRect(0, 0, w, h);
                        ctx.drawImage(img, 0, 0, w, h);
                        return canvas;
                    };

                    // Intenta reducir dimensión y calidad progresivamente hasta el objetivo.
                    const attempts = [
                        { dim: maxDim, q: quality },
                        { dim: 1000, q: 0.66 },
                        { dim: 820,  q: 0.6 },
                        { dim: 640,  q: 0.55 }
                    ];
                    let idx = 0;
                    const tryNext = () => {
                        const a = attempts[idx];
                        const canvas = render(a.dim, a.q);
                        const done = (blob) => {
                            if (!blob) { advance(); return; }
                            if (blob.size <= TARGET_BYTES || idx >= attempts.length - 1) {
                                resolve(blob);
                            } else {
                                advance();
                            }
                        };
                        const advance = () => {
                            idx++;
                            if (idx >= attempts.length) {
                                // Último recurso: fallback vía dataURL a calidad baja.
                                try {
                                    const c = render(640, 0.5);
                                    resolve(dataURLToBlob(c.toDataURL('image/jpeg', 0.5)));
                                } catch (err) { reject(new Error('No se pudo procesar la imagen.')); }
                                return;
                            }
                            tryNext();
                        };
                        if (canvas.toBlob) {
                            canvas.toBlob(done, 'image/jpeg', a.q);
                        } else {
                            try { done(dataURLToBlob(canvas.toDataURL('image/jpeg', a.q))); }
                            catch (err) { advance(); }
                        }
                    };
                    tryNext();
                } catch (err) {
                    reject(new Error('No se pudo procesar la imagen.'));
                }
            };
            img.src = e.target.result;
        };
        reader.readAsDataURL(file);
    });
}

// Sube el fondo del equipo a Storage (reutiliza la carpeta del emblema, ya permitida por reglas).
async function uploadTeamBackground(teamId, blob) {
    if (!blob) return null;
    const storage = firebase.storage();
    const storageRef = storage.ref(`team_emblems/${teamId}/bg_${Date.now()}.jpg`);
    const snapshot = await storageRef.put(blob, { contentType: 'image/jpeg' });
    return await snapshot.ref.getDownloadURL();
}
function getTeamMotto(teamData) {
    const m = teamData && teamData.appearance && teamData.appearance.motto;
    return (typeof m === 'string') ? m : '';
}
// Normaliza texto (minúsculas, sin acentos) para buscar equipos de forma tolerante.
function normalizeTeamText(s) {
    s = (s == null ? '' : String(s)).toLowerCase().trim();
    try { s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); } catch (e) {}
    return s;
}

let teamBrowserCache = [];
let teamBrowserPage = 1;
let teamBrowserFilter = '';
const TEAM_BROWSER_PAGE_SIZE = 3; // Mostrar 3 equipos por página.

async function openTeamBrowser() {
    const modal = document.getElementById('teamBrowserModal');
    const listEl = document.getElementById('teamBrowserList');
    const searchEl = document.getElementById('teamBrowserSearch');
    if (!modal || !currentUser) return;
    modal.style.display = 'flex';
    if (searchEl) searchEl.value = '';
    if (listEl) listEl.innerHTML = '<p class="team-browser-empty">Cargando equipos...</p>';

    try {
        // Trae hasta 50 equipos ordenados por victorias (mejores primero); mostramos como mínimo 10.
        const snap = await firebase.database().ref('teams').orderByChild('stats/wins').limitToLast(50).once('value');
        teamBrowserCache = [];
        if (snap.exists()) {
            snap.forEach(ch => { const d = ch.val() || {}; d.id = ch.key; teamBrowserCache.push({ id: ch.key, data: d }); });
        }
        teamBrowserCache.sort((a, b) => (b.data.stats?.wins || 0) - (a.data.stats?.wins || 0));
        renderTeamBrowserList('');
    } catch (e) {
        console.error('Error cargando equipos:', e);
        if (listEl) listEl.innerHTML = '<p class="team-browser-empty" style="color:#e5484d;">Error al cargar equipos.</p>';
    }
}

// Al buscar/abrir, reinicia a la página 1 y renderiza.
function renderTeamBrowserList(filter) {
    teamBrowserFilter = filter || '';
    teamBrowserPage = 1;
    renderTeamBrowserPage();
}

function renderTeamBrowserPage() {
    const listEl = document.getElementById('teamBrowserList');
    if (!listEl) return;
    const q = normalizeTeamText(teamBrowserFilter);
    let items = teamBrowserCache;
    if (q) items = items.filter(t => normalizeTeamText(t.data.name).indexOf(q) !== -1);

    if (!items.length) {
        listEl.innerHTML = '<p class="team-browser-empty">No se encontraron equipos con ese nombre.</p>';
        return;
    }

    // Paginación: 3 por página.
    const totalPages = Math.max(1, Math.ceil(items.length / TEAM_BROWSER_PAGE_SIZE));
    if (teamBrowserPage > totalPages) teamBrowserPage = totalPages;
    if (teamBrowserPage < 1) teamBrowserPage = 1;
    const start = (teamBrowserPage - 1) * TEAM_BROWSER_PAGE_SIZE;
    const pageItems = items.slice(start, start + TEAM_BROWSER_PAGE_SIZE);

    const myTeamId = currentUserData ? currentUserData.teamId : null;
    listEl.innerHTML = '';
    pageItems.forEach(({ id, data }) => {
        const accent = getTeamAccent(data);
        const motto = getTeamMotto(data);
        const safeName = sanitizeText(data.name || 'Unnamed Team');
        const safeMotto = motto ? sanitizeText(motto) : '';
        const wins = data.stats?.wins || 0;
        const tokens = data.stats?.tokens || 0;
        const emblem = data.emblemUrl || 'https://placehold.co/50x50/333/ccc?text=??';

        let actionHtml;
        if (myTeamId && myTeamId === id) {
            actionHtml = '<span class="team-browser-badge own">Tu equipo</span>';
        } else if (!myTeamId) {
            actionHtml = `<button class="team-browser-action join" data-join="${id}"><i class="fas fa-plus"></i> Unirse</button>`;
        } else {
            actionHtml = `<button class="team-browser-action leave" data-leave="1"><i class="fas fa-sign-out-alt"></i> Leave your team to join</button>`;
        }

        const row = document.createElement('div');
        row.className = 'team-browser-item';
        row.style.borderLeftColor = accent;
        const browserBgImg = getTeamBackgroundImage(data);
        if (browserBgImg) {
            row.style.background = `linear-gradient(rgba(24,26,32,0.82), rgba(24,26,32,0.82)), url("${browserBgImg}") center/cover no-repeat`;
        }
        row.innerHTML = `
            <img class="team-browser-emblem" src="${emblem}" alt="${safeName}" style="border-color:${accent};">
            <div class="team-browser-info" data-open="${id}">
                <span class="team-browser-name" style="color:${accent};">${safeName}</span>
                ${safeMotto ? `<span class="team-browser-motto">${safeMotto}</span>` : ''}
                <div class="team-browser-stats">
                    <span><i class="fas fa-trophy"></i> ${wins} Wins</span>
                    <span><i class="fas fa-coins"></i> ${tokens} T</span>
                    <span><i class="fas fa-gamepad"></i> ${sanitizeText(data.game || 'N/A')}</span>
                </div>
            </div>
            <div class="team-browser-action-wrap">${actionHtml}</div>
        `;
        listEl.appendChild(row);
    });

    // Controles de paginación por números (solo si hay más de una página).
    if (totalPages > 1) {
        const pager = document.createElement('div');
        pager.className = 'team-browser-pager';
        let pagerHtml = '';
        pagerHtml += `<button class="tb-page-btn nav" data-page="${teamBrowserPage - 1}" ${teamBrowserPage === 1 ? 'disabled' : ''} title="Anterior">&lsaquo;</button>`;
        for (let p = 1; p <= totalPages; p++) {
            pagerHtml += `<button class="tb-page-btn num ${p === teamBrowserPage ? 'active' : ''}" data-page="${p}">${p}</button>`;
        }
        pagerHtml += `<button class="tb-page-btn nav" data-page="${teamBrowserPage + 1}" ${teamBrowserPage === totalPages ? 'disabled' : ''} title="Siguiente">&rsaquo;</button>`;
        pager.innerHTML = pagerHtml;
        listEl.appendChild(pager);
        pager.querySelectorAll('.tb-page-btn[data-page]').forEach(btn => {
            btn.addEventListener('click', () => {
                const p = parseInt(btn.getAttribute('data-page'), 10);
                if (isNaN(p) || p < 1 || p > totalPages || p === teamBrowserPage) return;
                teamBrowserPage = p;
                renderTeamBrowserPage();
            });
        });
    }

    listEl.querySelectorAll('[data-open]').forEach(el => {
        el.addEventListener('click', () => {
            const tid = el.getAttribute('data-open');
            const modal = document.getElementById('teamBrowserModal');
            if (modal) modal.style.display = 'none';
            openPublicTeamProfile(tid);
        });
    });
    listEl.querySelectorAll('[data-join]').forEach(el => {
        el.addEventListener('click', (e) => {
            e.stopPropagation();
            const tid = el.getAttribute('data-join');
            const modal = document.getElementById('teamBrowserModal');
            if (modal) modal.style.display = 'none';
            openPublicTeamProfile(tid); // El perfil incluye el flujo de "Send Join Request"
        });
    });
    listEl.querySelectorAll('[data-leave]').forEach(el => {
        el.addEventListener('click', (e) => {
            e.stopPropagation();
            const myId = currentUserData ? currentUserData.teamId : null;
            if (!myId) return;
            const modal = document.getElementById('teamBrowserModal');
            if (modal) modal.style.display = 'none';
            showConfirmationModal(
                'Leave Team',
                'Para unirte a otro equipo primero debes salir del tuyo. ¿Salir de tu equipo actual?',
                () => leaveTeam(myId, currentUser.uid)
            );
        });
    });
}

function applyTeamAccentToDashboard(color) {
    const emblem = document.getElementById('dashboardTeamEmblem');
    if (emblem) emblem.style.borderColor = color;
    const name = document.getElementById('dashboardTeamName');
    if (name) name.style.color = color;
}

function openTeamAppearanceModal(teamId, teamData) {
    const modal = document.getElementById('teamAppearanceModal');
    const closeBtn = document.getElementById('closeTeamAppearanceModal');
    const colorsEl = document.getElementById('appearanceColors');
    const bgEl = document.getElementById('appearanceBackgrounds');
    const mottoInput = document.getElementById('appearanceMotto');
    const saveBtn = document.getElementById('saveTeamAppearanceBtn');
    if (!modal || !teamId || !teamData) return;

    let selectedColor = getTeamAccent(teamData);
    let selectedBg = getTeamBackgroundId(teamData);
    const currentMotto = getTeamMotto(teamData);
    const teamLevel = getTeamLevelFromData(teamData);
    const canUploadCustom = teamLevel >= CUSTOM_BG_UPLOAD_LEVEL;
    let ownedBgs = Object.assign({}, (teamData.appearance && teamData.appearance.ownedBackgrounds) || {});

    // Estado de la imagen de fondo personalizada.
    let existingBgImage = getTeamBackgroundImage(teamData); // URL guardada
    let newBgBlob = null;        // blob comprimido pendiente de subir
    let newBgPreviewUrl = '';    // dataURL para previsualizar
    let removeBgImage = false;   // si el usuario decide quitarla

    const bgImgInput = document.getElementById('appearanceBgImgInput');
    const bgImgPreview = document.getElementById('appearanceBgImgPreview');
    const bgImgRemoveBtn = document.getElementById('appearanceBgImgRemoveBtn');

    function currentBgImageForPreview() {
        if (removeBgImage) return '';
        if (newBgPreviewUrl) return newBgPreviewUrl;
        return existingBgImage;
    }

    const pvEmblem = document.getElementById('appearancePreviewEmblem');
    const pvName = document.getElementById('appearancePreviewName');
    const pvMotto = document.getElementById('appearancePreviewMotto');
    const pvWins = document.getElementById('appearancePreviewWins');
    const pvItem = document.getElementById('appearancePreview');

    function refreshPreview() {
        if (pvEmblem) { pvEmblem.src = teamData.emblemUrl || 'https://placehold.co/50x50/333/ccc?text=??'; pvEmblem.style.borderColor = selectedColor; }
        if (pvName) { pvName.textContent = sanitizeText(teamData.name || 'Tu equipo'); pvName.style.color = selectedColor; }
        if (pvMotto) pvMotto.textContent = (mottoInput && mottoInput.value) ? mottoInput.value : 'Tu lema aparecerá aquí';
        if (pvWins) pvWins.textContent = teamData.stats?.wins || 0;
        if (pvItem) {
            pvItem.style.borderLeftColor = selectedColor;
            const bgImg = currentBgImageForPreview();
            if (bgImg) {
                pvItem.style.background = `linear-gradient(rgba(0,0,0,0.45), rgba(0,0,0,0.7)), url("${bgImg}") center/cover no-repeat`;
            } else {
                pvItem.style.background = getTeamBackgroundCss(selectedBg);
            }
        }
        // Cuadro de previsualización del uploader
        if (bgImgPreview) {
            const bgImg = currentBgImageForPreview();
            if (bgImg) {
                bgImgPreview.style.backgroundImage = `url("${bgImg}")`;
                bgImgPreview.classList.add('has-image');
                bgImgPreview.innerHTML = '';
            } else {
                bgImgPreview.style.backgroundImage = '';
                bgImgPreview.classList.remove('has-image');
                bgImgPreview.innerHTML = '<span>Sin imagen</span>';
            }
        }
        if (bgImgRemoveBtn) bgImgRemoveBtn.style.display = currentBgImageForPreview() ? 'inline-flex' : 'none';
    }

    // Bloqueo de subida personalizada: solo nivel 10.
    const bgImgUploadBtn = document.getElementById('appearanceBgImgUploadBtn');
    const bgImgLevelTag = document.getElementById('appearanceBgImgLevelTag');
    const bgImgHint = document.getElementById('appearanceBgImgHint');
    if (bgImgLevelTag) {
        if (canUploadCustom) {
            bgImgLevelTag.innerHTML = '<i class="fas fa-unlock"></i> Desbloqueado';
            bgImgLevelTag.classList.add('unlocked');
        } else {
            bgImgLevelTag.innerHTML = '<i class="fas fa-lock"></i> Nivel ' + CUSTOM_BG_UPLOAD_LEVEL;
            bgImgLevelTag.classList.remove('unlocked');
        }
    }
    if (bgImgUploadBtn) {
        if (canUploadCustom) {
            bgImgUploadBtn.disabled = false;
            bgImgUploadBtn.classList.remove('locked');
            bgImgUploadBtn.innerHTML = '<i class="fas fa-upload"></i> Subir imagen';
        } else {
            bgImgUploadBtn.disabled = true;
            bgImgUploadBtn.classList.add('locked');
            bgImgUploadBtn.innerHTML = '<i class="fas fa-lock"></i> Nivel ' + CUSTOM_BG_UPLOAD_LEVEL + ' para subir';
        }
    }
    if (bgImgHint && !canUploadCustom) {
        bgImgHint.textContent = 'Subir tu propia imagen se desbloquea al nivel ' + CUSTOM_BG_UPLOAD_LEVEL + '. Mientras tanto puedes comprar un fondo con coins arriba.';
    }

    if (bgImgInput) {
        bgImgInput.onchange = async () => {
            if (!canUploadCustom) {
                showNotification('Subir imagen personalizada requiere nivel ' + CUSTOM_BG_UPLOAD_LEVEL + '.', 'error');
                bgImgInput.value = '';
                return;
            }
            const file = bgImgInput.files && bgImgInput.files[0];
            if (!file) return;
            if (!/^image\//.test(file.type || '')) { showNotification('Selecciona un archivo de imagen.', 'error'); bgImgInput.value = ''; return; }
            const HARD_MAX = 30 * 1024 * 1024; // 30MB tope de seguridad antes de comprimir
            if (file.size > HARD_MAX) { showNotification('La imagen es demasiado grande (máx. 30MB).', 'error'); bgImgInput.value = ''; return; }
            if (bgImgUploadBtn) { bgImgUploadBtn.disabled = true; bgImgUploadBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Procesando...'; }
            try {
                newBgBlob = await compressImageToBlob(file, 1280, 0.72);
                newBgPreviewUrl = URL.createObjectURL(newBgBlob);
                removeBgImage = false;
                refreshPreview();
            } catch (err) {
                console.error('Error procesando imagen de fondo:', err);
                showNotification((err && err.message) ? err.message : 'No se pudo procesar la imagen.', 'error');
            } finally {
                if (bgImgUploadBtn) { bgImgUploadBtn.disabled = false; bgImgUploadBtn.innerHTML = '<i class="fas fa-upload"></i> Subir imagen'; }
                bgImgInput.value = '';
            }
        };
    }
    if (bgImgRemoveBtn) {
        bgImgRemoveBtn.onclick = () => {
            newBgBlob = null;
            newBgPreviewUrl = '';
            removeBgImage = true;
            refreshPreview();
        };
    }

    if (colorsEl) {
        colorsEl.innerHTML = '';
        TEAM_ACCENT_PRESETS.forEach(preset => {
            const sw = document.createElement('button');
            sw.type = 'button';
            sw.className = 'appearance-color' + (preset.color.toLowerCase() === selectedColor.toLowerCase() ? ' selected' : '');
            sw.style.background = preset.color;
            sw.setAttribute('data-color', preset.color);
            sw.addEventListener('click', () => {
                selectedColor = preset.color;
                colorsEl.querySelectorAll('.appearance-color').forEach(x => x.classList.remove('selected'));
                sw.classList.add('selected');
                refreshPreview();
            });
            colorsEl.appendChild(sw);
        });
    }

    function renderBgSwatches() {
        if (!bgEl) return;
        bgEl.innerHTML = '';
        TEAM_BACKGROUND_PRESETS.forEach(preset => {
            const owned = teamOwnsBackground({ appearance: { ownedBackgrounds: ownedBgs } }, preset.id);
            const wrap = document.createElement('div');
            wrap.className = 'appearance-bg-wrap';

            const sw = document.createElement('button');
            sw.type = 'button';
            sw.className = 'appearance-bg' + (preset.id === selectedBg ? ' selected' : '') + (owned ? '' : ' locked');
            sw.style.background = preset.css;
            sw.title = preset.label + (preset.premium && !owned ? (' · ' + preset.price + ' coins') : '');
            sw.setAttribute('data-bg', preset.id);
            if (!owned) {
                const lock = document.createElement('span');
                lock.className = 'appearance-bg-lock';
                lock.innerHTML = '<i class="fas fa-lock"></i>';
                sw.appendChild(lock);
            }
            sw.addEventListener('click', () => {
                if (owned) {
                    selectedBg = preset.id;
                    bgEl.querySelectorAll('.appearance-bg').forEach(x => x.classList.remove('selected'));
                    sw.classList.add('selected');
                    refreshPreview();
                } else {
                    buyBackground(preset);
                }
            });
            wrap.appendChild(sw);

            const label = document.createElement('div');
            label.className = 'appearance-bg-label';
            label.innerHTML = owned
                ? sanitizeText(preset.label)
                : ('<i class="fas fa-coins"></i> ' + preset.price);
            wrap.appendChild(label);

            bgEl.appendChild(wrap);
        });
    }

    async function buyBackground(preset) {
        if (!currentUser) return;
        if (!window.confirm('¿Comprar el fondo "' + preset.label + '" por ' + preset.price + ' coins? Se aplicará a tu equipo.')) return;
        try {
            const fn = firebase.functions().httpsCallable('purchaseTeamBackground');
            const res = await fn({ teamId: teamId, backgroundId: preset.id });
            const data = (res && res.data) || {};
            if (data.success) {
                ownedBgs[preset.id] = true;
                if (!teamData.appearance) teamData.appearance = {};
                teamData.appearance.ownedBackgrounds = Object.assign({}, teamData.appearance.ownedBackgrounds, ownedBgs);
                selectedBg = preset.id;
                showNotification('¡Fondo comprado y aplicado! Recuerda Guardar.', 'success');
                renderBgSwatches();
                refreshPreview();
            } else {
                showNotification(data.message || 'No se pudo completar la compra.', 'error');
            }
        } catch (e) {
            console.error('Error comprando fondo:', e);
            showNotification((e && e.message) ? e.message : 'No se pudo comprar el fondo.', 'error');
        }
    }

    renderBgSwatches();

    if (mottoInput) {
        mottoInput.value = currentMotto;
        mottoInput.oninput = refreshPreview;
    }
    refreshPreview();
    modal.style.display = 'flex';

    const closeModal = () => { modal.style.display = 'none'; saveBtn.onclick = null; if (closeBtn) closeBtn.onclick = null; };
    if (closeBtn) closeBtn.onclick = closeModal;

    saveBtn.onclick = async () => {
        saveBtn.disabled = true;
        saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Guardando...';
        try {
            const motto = (mottoInput ? (mottoInput.value || '') : '').trim().slice(0, 60);

            // Resuelve la imagen de fondo: nueva (subir), quitar, o mantener la existente.
            let backgroundImage = existingBgImage || null;
            if (newBgBlob) {
                saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Subiendo imagen...';
                backgroundImage = await uploadTeamBackground(teamId, newBgBlob);
            } else if (removeBgImage) {
                backgroundImage = null;
            }

            // Salvaguarda: no permitir guardar un fondo premium que no se posee.
            if (!teamOwnsBackground({ appearance: { ownedBackgrounds: ownedBgs } }, selectedBg)) {
                selectedBg = 'default';
            }

            // Usamos update() para NO borrar 'ownedBackgrounds' (lo escribe el servidor al comprar).
            const appearanceUpdate = {
                color: selectedColor,
                background: selectedBg,
                motto: motto,
                backgroundImage: backgroundImage,
                updatedAt: firebase.database.ServerValue.TIMESTAMP
            };
            await firebase.database().ref(`teams/${teamId}/appearance`).update(appearanceUpdate);
            teamData.appearance = Object.assign({}, teamData.appearance, { color: selectedColor, background: selectedBg, motto: motto, backgroundImage: backgroundImage });
            applyTeamAccentToDashboard(selectedColor);
            showNotification('Apariencia del grupo actualizada.', 'success');
            loadTopTeams();
            closeModal();
        } catch (e) {
            console.error('Error guardando apariencia:', e);
            showNotification('Error al guardar la apariencia: ' + (e.message || e), 'error');
        } finally {
            saveBtn.disabled = false;
            saveBtn.innerHTML = '<i class="fas fa-save"></i> Guardar apariencia';
        }
    };
}

// ==================================================================
// --- INICIO: NUEVO BLOQUE DE FUNCIONES PARA EL CHAT DE EQUIPO ---
// ==================================================================

/**
 * Abre la ventana del chat de equipo.
 */
function openTeamChat(teamId, teamName, roster) {
    if (!currentUser || !currentUserData) return;

    currentChatTeamId = teamId;
    currentChatRoster = roster;

    const chatWindow = document.getElementById('teamChatWindow');
    const closeBtn = document.getElementById('closeChatBtn');
    const teamNameLink = document.getElementById('chatTeamNameLink');
    const chatForm = document.getElementById('teamChatForm');
    const tokenTransferBtn = document.getElementById('openTokenTransferBtn');
    const imageUpload = document.getElementById('chatImageUpload');
    const emojiBtn = document.getElementById('chatEmojiBtn'); 

    teamNameLink.textContent = sanitizeText(teamName); // MODIFICACIÓN: Sanitizar
    teamNameLink.onclick = (e) => {
        e.preventDefault();
        openPublicTeamProfile(teamId); 
    };

    closeBtn.onclick = closeTeamChat;
    chatForm.onsubmit = (e) => handleChatFormSubmit(e, teamId);
    tokenTransferBtn.onclick = () => openTokenTransferModal(teamId, roster);
    imageUpload.onchange = (e) => handleImageUpload(e, teamId);
    emojiBtn.onclick = () => showNotification("Emoji feature coming soon!", "success");

    chatWindow.style.display = 'flex'; 
    setTimeout(() => {
        chatWindow.classList.add('visible'); 
    }, 10);

    loadChatMessages(teamId);
}

/**
 * Cierra la ventana del chat y limpia los listeners.
 */
function closeTeamChat() {
    const chatWindow = document.getElementById('teamChatWindow');
    chatWindow.classList.remove('visible');
    
    setTimeout(() => {
        chatWindow.style.display = 'none';
    }, 300); 

    if (currentChatListener && currentChatTeamId) {
        const messagesRef = firebase.database().ref(`teamChats/${currentChatTeamId}/messages`);
        messagesRef.off('child_added', currentChatListener);
    }

    currentChatListener = null;
    currentChatTeamId = null;
    currentChatRoster = null;
    
    document.getElementById('chatMessagesList').innerHTML = '';
}

/**
 * Carga los últimos 30 mensajes y escucha nuevos.
 */
function loadChatMessages(teamId) {
    const messagesList = document.getElementById('chatMessagesList');
    messagesList.innerHTML = '<p style="color: #888; text-align: center; padding-top: 2rem;">Loading messages...</p>';
    
    let isInitialLoad = true;
    
    const messagesRef = firebase.database().ref(`teamChats/${teamId}/messages`);
    
    currentChatListener = messagesRef.limitToLast(30).on('child_added', (snapshot) => {
        if (isInitialLoad) {
            messagesList.innerHTML = ''; 
            isInitialLoad = false;
        }
        
        const messageData = snapshot.val();
        renderChatMessage(messageData, messagesList);
        
        messagesList.scrollTop = messagesList.scrollHeight;
        
    }, (error) => {
        console.error("Error loading chat messages:", error);
        messagesList.innerHTML = '<p style="color: #e53935; text-align: center;">Error loading chat.</p>';
    });
}

/**
 * Renderiza un solo mensaje en la ventana del chat.
 */
function renderChatMessage(messageData, container) {
    if (!messageData) return;

    const isMine = messageData.userId === currentUser.uid;
    const item = document.createElement('div');
    
    let itemClasses = ['message-item'];
    itemClasses.push(isMine ? 'mine' : 'theirs');
    itemClasses.push(messageData.type || 'text');
    
    item.className = itemClasses.join(' ');
    
    let avatarHTML = '';
    let authorHTML = '';
    
    // MODIFICACIÓN: Sanitizar Nickname y Texto
    const safeNick = sanitizeText(messageData.nick || 'User');
    const safeText = sanitizeText(messageData.text || '');
    
    if (messageData.type !== 'transfer') {
        avatarHTML = `
            <img src="${messageData.photoURL || 'dragon_profile_studiosgamesrs.png'}" 
                 alt="${safeNick}" 
                 class="message-avatar"
                 onclick="window.location.href='dashboard.html?uid=${messageData.userId}'">
        `;
        
        if (!isMine) {
            authorHTML = `
                <span class="message-author"
                      onmouseenter="showUserPopup(this, '${messageData.userId}')"
                      onmouseleave="hideUserPopup()"
                      onclick="window.location.href='dashboard.html?uid=${messageData.userId}'">
                    ${safeNick}
                </span>
            `;
        }
    }

    let messageContentHTML = '';
    
    if (messageData.text) {
        messageContentHTML += `<div class="message-text-content">${safeText}</div>`;
    }
    
    if (messageData.imageUrl) {
        if (!messageData.text) {
            item.classList.add('image-only');
        }
        messageContentHTML += `<img src="${messageData.imageUrl}" class="message-image" alt="Uploaded Image">`;
    }
    
    if (messageData.type === 'transfer') {
        item.innerHTML = `
            <div class="message-bubble">
                <div class="message-content">
                    <i class="fas fa-coins"></i> ${safeText}
                </div>
            </div>
        `;
    } else {
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
 * Muestra un mensaje de ayuda local en el chat.
 */
function showChatHelp() {
    const messagesList = document.getElementById('chatMessagesList');

    const helpMessageText = sanitizeText(`Comandos de Chat:
               /help - Muestra este mensaje.
               /imp [mensaje] - Envía un mensaje importante.
               /transfer - Abre el menú de transferencia de tokens.`)
               .replace(/\n/g, '<br>');
               
    const formattedHelp = helpMessageText.replace('Comandos de Chat:', '<b>Comandos de Chat:</b>');

    const helpMessage = {
        type: 'transfer', 
        text: formattedHelp
    };

    renderChatMessage(helpMessage, messagesList);
    messagesList.scrollTop = messagesList.scrollHeight;
}
function handleChatFormSubmit(e, teamId) {
    e.preventDefault();
    if (!currentUser || !currentUserData) return;

    const textInput = document.getElementById('chatMessageInput');
    const messageText = textInput.value.trim();
    
    // HARDENING: Chequeo de límites de longitud (max 250 characters)
    const MAX_LENGTH = 250; 
    if (messageText.length > MAX_LENGTH) {
        showNotification(`Message is too long (Max ${MAX_LENGTH} characters).`, "error");
        return;
    }
    
    if (messageText.length === 0) return;

    if (messageText.startsWith('/')) {
        const commandParts = messageText.split(' ');
        const command = commandParts[0].toLowerCase();
        const args = commandParts.slice(1).join(' ');

        switch(command) {
            case '/help':
                showChatHelp();
                break;
            case '/imp':
            case '/important':
                if (args.length > 0) {
                    sendChatMessage(teamId, sanitizeText(args), 'important'); // MODIFICACIÓN: Sanitizar args
                } else {
                    showNotification("Escribe un mensaje después de /imp", "error");
                }
                break;
            case '/transfer':
                if (currentChatRoster) {
                    openTokenTransferModal(teamId, currentChatRoster);
                } else {
                    console.error("Error: Roster no disponible para abrir modal de transferencia.");
                    showNotification("Error: No se pueden cargar los miembros del equipo.", "error");
                }
                break;
            default:
                showNotification(`Comando desconocido: ${command}`, "error");
        }

        textInput.value = ''; 
        return;
    }

    sendChatMessage(teamId, sanitizeText(messageText), 'text'); // MODIFICACIÓN: Sanitizar mensaje normal
    textInput.value = ''; 
}

/**
 * Función separada para enviar el mensaje a Firebase.
 */
function sendChatMessage(teamId, text, type) {
    const messageData = {
        userId: currentUser.uid,
        nick: currentUserData.nick || 'Unknown',
        photoURL: currentUserData.photoURL || 'dragon_profile_studiosgamesrs.png',
        text: text, // El texto ya está sanitizado en handleChatFormSubmit
        type: type,
        timestamp: firebase.database.ServerValue.TIMESTAMP
    };

    firebase.database().ref(`teamChats/${teamId}/messages`).push(messageData)
        .catch(error => {
            console.error("Error sending message:", error);
            showNotification("Error sending message.", "error");
        });
}

/**
 * Maneja la subida de una imagen al chat.
 */
async function handleImageUpload(e, teamId) {
    const file = e.target.files[0];
    if (!file) return;

    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
        showNotification("Invalid file type. Please use PNG, JPEG, or WEBP.", "error");
        e.target.value = null; 
        return;
    }
    
    const MAX_SIZE = 2 * 1024 * 1024;
    if (file.size > MAX_SIZE) {
        showNotification("File is too large (Max 2MB).", "error");
        e.target.value = null; 
        return;
    }

    const textInput = document.getElementById('chatMessageInput');
    const messageText = textInput.value.trim(); 
    textInput.value = ''; 
    
    showNotification("Uploading image...", "success");

    try {
        const storageRef = firebase.storage().ref(`chat_images/${teamId}/${Date.now()}_${file.name}`);
        const snapshot = await storageRef.put(file);
        const downloadURL = await snapshot.ref.getDownloadURL();
        
        const messageData = {
            userId: currentUser.uid,
            nick: currentUserData.nick || 'Unknown',
            photoURL: currentUserData.photoURL || 'dragon_profile_studiosgamesrs.png',
            text: messageText ? sanitizeText(messageText) : null, // MODIFICACIÓN: Sanitizar texto adjunto
            type: 'image',
            imageUrl: downloadURL,
            timestamp: firebase.database.ServerValue.TIMESTAMP
        };
        
        await firebase.database().ref(`teamChats/${teamId}/messages`).push(messageData);

    } catch (error) {
        console.error("Error uploading image:", error);
        showNotification("Failed to upload image.", "error");
    } finally {
        e.target.value = null; 
    }
}

/**
 * Abre el modal para transferir tokens.
 */
async function openTokenTransferModal(teamId, roster) {
    const modal = document.getElementById('tokenTransferModal');
    const closeBtn = document.getElementById('closeTokenTransferModal');
    const form = document.getElementById('tokenTransferForm');
    const select = document.getElementById('transferMemberSelect');
    
    modal.style.display = 'flex';
    select.innerHTML = '<option value="">Loading members...</option>';
    select.disabled = true;
    
    const myRole = roster[currentUser.uid].role;
    
    // FIX: Limpiar el amount input y el select
    document.getElementById('transferAmountInput').value = '';
    // FIN FIX

    try {
        const userPromises = Object.keys(roster)
            .filter(uid => uid !== currentUser.uid) 
            .map(uid => firebase.database().ref(`users/${uid}`).once('value'));
            
        const userSnapshots = await Promise.all(userPromises);
        
        select.innerHTML = '<option value="">Select Member</option>'; // FIX: Añadir opción por defecto
        let memberCount = 0;
        
        userSnapshots.forEach(snap => {
            const userData = snap.val();
            const uid = snap.key;
            const userRole = roster[uid].role;
            const safeNick = sanitizeText(userData.nick || 'Unknown'); // MODIFICACIÓN: Sanitizar
            
            if (myRole === 'Captain' && userRole === 'Member') {
                select.innerHTML += `<option value="${uid}">${safeNick}</option>`;
                memberCount++;
            }
            else if (myRole === 'Member' && userRole === 'Captain') {
                 select.innerHTML += `<option value="${uid}">${safeNick} (Captain)</option>`;
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

    closeBtn.onclick = () => modal.style.display = 'none';
    form.onsubmit = (e) => handleTokenTransferSubmit(e, teamId);
}

/**
 * Maneja el envío del formulario de transferencia (envía la solicitud).
 */
async function handleTokenTransferSubmit(e, teamId) {
    e.preventDefault();
    
    const select = document.getElementById('transferMemberSelect');
    const amountInput = document.getElementById('transferAmountInput');
    const confirmBtn = document.getElementById('confirmTransferBtn');

    const toUserId = select.value;
    const amount = parseInt(amountInput.value, 10);
    
    if (!toUserId || select.value === '') {
        showNotification("Please select a member.", "error");
        return;
    }
    if (isNaN(amount) || amount <= 0) { // FIX: Asegurar que el monto sea positivo
        showNotification("Please enter a valid positive amount (min 1).", "error");
        return;
    }
    // HARDENING: Chequeo de balance local
    if (currentUserData && currentUserData.tokens < amount) {
         showNotification("Insufficient token balance.", "error");
         return;
    }
    // FIN HARDENING
    
    confirmBtn.disabled = true;
    confirmBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Processing...';
    
    try {
        // HARDENING: Envío de solicitud a la Cloud Function (asumiendo que la Cloud Function existe)
        const requestRef = firebase.database().ref('tokenTransferRequests').push();
        await requestRef.set({
            fromUserId: currentUser.uid,
            toUserId: toUserId,
            amount: amount,
            teamId: teamId,
            status: 'pending',
            timestamp: firebase.database.ServerValue.TIMESTAMP
        });
        
        showNotification("Transfer request sent successfully! Processing...", "success");
        document.getElementById('tokenTransferModal').style.display = 'none';
        amountInput.value = '';

    } catch (error) {
        console.error("Error sending transfer request:", error);
        showNotification("Error sending request. Try again.", "error");
    } finally {
        confirmBtn.disabled = false;
        confirmBtn.innerHTML = '<i class="fas fa-check-circle"></i> Confirmar Transferencia';
    }
}

// ==================================================================
// --- FIN: NUEVO BLOQUE DE FUNCIONES PARA EL CHAT DE EQUIPO ---
// ==================================================================

// ==================================================================
// --- LÓGICA DE INVITACIONES A TORNEOS (PARA CAPITANES) ---
// ==================================================================

/**
 * Carga en tiempo real las invitaciones de torneos recibidas por el equipo.
 */
function loadTournamentInvites(teamId) {
    const listContainer = document.getElementById('tournamentInvitesList');
    if (!listContainer) return;

    const invitesRef = firebase.database().ref(`tournamentInvites/${teamId}`);

    invitesRef.on('value', (snapshot) => {
        if (!snapshot.exists()) {
            listContainer.innerHTML = '<p class="sg-tour-inline-hint" style="text-align:center;">No tienes invitaciones a torneos pendientes.</p>';
            return;
        }

        listContainer.innerHTML = '';
        const invites = snapshot.val();

        Object.entries(invites).forEach(([tournamentId, inviteData]) => {
            const safeTourName = sanitizeText(inviteData.tournamentName || 'Torneo');
            const safeInviter = sanitizeText(inviteData.invitedBy || 'Organizador');

            const card = document.createElement('div');
            card.className = 'sg-tour-captain-card';
            card.id = `tour-invite-${tournamentId}`;

            const when = inviteData.timestamp ? new Date(inviteData.timestamp).toLocaleString('es-ES', {
                day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit'
            }) : '';

            card.innerHTML =
                '<h4><i class="fas fa-trophy"></i> ' + safeTourName + '</h4>' +
                '<p style="margin:0;color:#aaa;font-size:0.85rem;">Invitado por <strong style="color:#fff;">' + safeInviter + '</strong>' +
                (when ? (' · ' + when) : '') + '</p>' +
                '<div class="sg-tour-captain-actions">' +
                '<button type="button" class="sg-tour-btn sg-tour-btn-primary tour-accept-btn">Aceptar e inscribir</button>' +
                '<button type="button" class="sg-tour-btn sg-tour-btn-ghost tour-decline-btn">Rechazar</button>' +
                '</div>';

            card.querySelector('.tour-accept-btn').addEventListener('click', function () {
                acceptTournamentInvite(teamId, tournamentId, inviteData.tournamentName || 'Torneo');
            });
            card.querySelector('.tour-decline-btn').addEventListener('click', function () {
                declineTournamentInvite(teamId, tournamentId);
            });

            listContainer.appendChild(card);
        });
    });
}

/**
 * Acepta la invitación: Inscribe al equipo en el torneo y borra la invite.
 */
window.acceptTournamentInvite = async function(teamId, tournamentId, tournamentName) {
    const safeName = sanitizeText(tournamentName || 'Torneo');
    if (!confirm('¿Inscribir a tu equipo en «' + safeName + '»? Esta acción confirma la participación en el torneo.')) return;

    if (!currentUser || !teamId) return;
    const teamSnap = await firebase.database().ref(`teams/${teamId}`).once('value');
    const team = teamSnap.val() || {};
    if (team.captain !== currentUser.uid) {
        showNotification('Solo el capitán del equipo puede aceptar invitaciones a torneos.', 'error');
        return;
    }

    const acceptBtn = document.querySelector(`#tour-invite-${tournamentId} .tour-accept-btn`);
    if (acceptBtn) { acceptBtn.disabled = true; acceptBtn.textContent = 'Inscribiendo…'; }

    try {
        // Se guarda una foto de quién estaba en el roster al aceptar: así el
        // torneo sabe que entran los 5/6, no solo el capitán que pulsó el botón,
        // y tournament-details puede distinguir jugador de espectador.
        const snapshot = window.SGTournamentRoster
            ? await window.SGTournamentRoster.snapshotFor(teamId, team)
            : null;

        const updates = window.SGTournamentRoster
            ? window.SGTournamentRoster.registrationUpdates(tournamentId, teamId, snapshot)
            : { [`tournaments/${tournamentId}/registeredTeams/${teamId}`]: true };
        updates[`tournamentInvites/${teamId}/${tournamentId}`] = null;
        // Aviso para el resto del roster: ellos no ven la sección de
        // invitaciones (es solo del capitán) y hasta ahora no se enteraban de
        // nada. Con esto el overlay les ofrece el enlace directo a la sala.
        updates[`tournamentRegistrations/${teamId}/${tournamentId}`] = {
            tournamentName: tournamentName || 'Torneo',
            acceptedBy: (currentUserData && currentUserData.nick) || 'el capitán',
            acceptedAt: Date.now()
        };

        await firebase.database().ref().update(updates);

        const size = snapshot ? snapshot.size : 0;
        const pending = snapshot ? Math.max(0, snapshot.size - snapshot.steamReady) : 0;
        let msg = '¡Equipo inscrito en «' + safeName + '»!';
        if (size) msg += ' Entran ' + size + ' jugador' + (size === 1 ? '' : 'es') + ' del roster.';
        // Sin Steam vinculado MatchZy no puede colocar al jugador en su equipo,
        // así que el capitán se entera ahora y no el día del partido.
        if (pending) {
            msg += ' Faltan ' + pending + ' por vincular Steam antes de jugar.';
        }
        // 'warning' no tiene estilo propio en el hub; el aviso de Steam se ve
        // con detalle en la tarjeta que queda fijada abajo.
        showNotification(msg, 'success');
        // La tarjeta con el enlace a la sala la pinta loadRegisteredTournaments
        // en cuanto RTDB refleja la escritura de arriba, y sigue ahí al recargar.
        if (window.SGWelcomeOverlay && window.SGWelcomeOverlay.markTournamentRegistrationSeen) {
            window.SGWelcomeOverlay.markTournamentRegistrationSeen(currentUser.uid, teamId, tournamentId);
        }

    } catch (error) {
        console.error("Error joining tournament:", error);
        showNotification('No se pudo inscribir: ' + (error.message || 'Error desconocido'), 'error');
        if (acceptBtn) { acceptBtn.disabled = false; acceptBtn.textContent = 'Aceptar e inscribir'; }
    }
}

/**
 * Torneos en los que el equipo ya está inscrito, con el enlace directo a la
 * sala. Va en su propia sección (no en la de invitaciones, que es solo del
 * capitán y se repinta entera cada vez que cambia una invitación) para que
 * cualquier miembro del roster tenga a mano por dónde entrar, también al
 * recargar la página días después.
 */
function loadRegisteredTournaments(teamId) {
    const section = document.getElementById('tournamentActiveSection');
    const listContainer = document.getElementById('tournamentActiveList');
    if (!section || !listContainer || !teamId) return;

    firebase.database().ref(`tournamentRegistrations/${teamId}`).on('value', (snapshot) => {
        const entries = snapshot.val() || {};
        const ids = Object.keys(entries);
        if (!ids.length) {
            section.style.display = 'none';
            listContainer.innerHTML = '';
            return;
        }

        section.style.display = 'block';
        // Lo más reciente arriba: normalmente es el torneo que se está jugando.
        ids.sort((a, b) => (entries[b].acceptedAt || 0) - (entries[a].acceptedAt || 0));
        listContainer.innerHTML = '';
        ids.forEach((tournamentId) => {
            const card = document.createElement('div');
            card.className = 'sg-tour-registered-card';
            card.id = `tour-registered-${tournamentId}`;
            renderRegisteredTournamentCard(card, teamId, tournamentId, entries[tournamentId] || {});
            listContainer.appendChild(card);
        });
    }, () => { /* el usuario salió del equipo entre listeners: ignorar */ });
}

function renderRegisteredTournamentCard(card, teamId, tournamentId, entry) {
    const safeName = sanitizeText(entry.tournamentName || 'Torneo');
    const safeBy = sanitizeText(entry.acceptedBy || 'el capitán');
    const href = '/tournament-details?id=' + encodeURIComponent(tournamentId);

    card.innerHTML =
        '<div class="sg-tour-registered-head">' +
        '<i class="fas fa-check-circle"></i>' +
        '<strong>' + safeName + '</strong>' +
        '<span class="sg-tour-registered-status" data-role="status">Inscritos</span>' +
        '</div>' +
        '<p class="sg-tour-registered-sub">Aceptado por <strong>' + safeBy + '</strong>. ' +
        'Todo el roster entra por aquí.</p>' +
        '<div data-role="chips"></div>' +
        '<div class="sg-tour-captain-actions">' +
        '<a class="sg-tour-btn sg-tour-btn-primary" href="' + href + '">' +
        '<i class="fas fa-broadcast-tower"></i> Ir al torneo</a>' +
        '</div>';

    // Estado y roster se leen del torneo: así la tarjeta dice si ya está en
    // vivo y a quién le falta vincular Steam antes de que empiece.
    firebase.database().ref(`tournaments/${tournamentId}`).once('value').then((snap) => {
        const t = snap.val();
        if (!t) return;
        const statusEl = card.querySelector('[data-role="status"]');
        const status = String(t.status || '').toLowerCase();
        if (statusEl) {
            if (status === 'en_vivo' || status === 'active' || status === 'live') {
                statusEl.textContent = 'EN VIVO';
                statusEl.classList.add('is-live');
            } else if (status === 'finalizado' || status === 'finished' || status === 'completed') {
                statusEl.textContent = 'Finalizado';
                statusEl.classList.add('is-done');
            } else if (t.schedule) {
                statusEl.textContent = new Date(t.schedule).toLocaleString('es-ES', {
                    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit'
                });
            }
        }

        const roster = (t.registeredRosters || {})[teamId];
        const players = window.SGTournamentRoster ? window.SGTournamentRoster.playersOf(roster) : [];
        if (!players.length) return;
        const chipsEl = card.querySelector('[data-role="chips"]');
        if (!chipsEl) return;
        const pending = players.filter((p) => p.steam === false).length;
        chipsEl.innerHTML =
            '<div class="sg-tour-roster-chips">' + players.map((p) => {
                return '<span class="sg-tour-roster-chip' + (p.steam === false ? ' is-warn' : '') + '">' +
                    '<i class="fab fa-steam"></i>' + sanitizeText(p.nick) +
                    (p.role === 'Captain' ? ' <b>(C)</b>' : '') + '</span>';
            }).join('') + '</div>' +
            (pending
                ? '<p class="sg-tour-registered-warn"><i class="fas fa-exclamation-triangle"></i> ' +
                  pending + ' sin Steam vinculado: el servidor no puede asignarlos a su equipo.</p>'
                : '');
    }).catch(() => {});
}

/**
 * Rechaza la invitación (solo la borra).
 */
window.declineTournamentInvite = async function(teamId, tournamentId) {
    if (!confirm('¿Rechazar esta invitación al torneo?')) return;

    if (!currentUser || !teamId) return;
    const teamSnap = await firebase.database().ref(`teams/${teamId}/captain`).once('value');
    if (teamSnap.val() !== currentUser.uid) {
        showNotification('Solo el capitán del equipo puede rechazar invitaciones.', 'error');
        return;
    }

    try {
        await firebase.database().ref(`tournamentInvites/${teamId}/${tournamentId}`).remove();
        showNotification('Invitación rechazada.', 'success');
    } catch (error) {
        console.error("Error declining:", error);
        showNotification('No se pudo rechazar la invitación.', 'error');
    }
}
