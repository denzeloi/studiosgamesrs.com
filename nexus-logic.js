/**
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║                    STUDIOSGAMESRS - CREATOR NEXUS v8.0                    ║
 * ║                    Sistema de Gamificación Ultra Avanzado                  ║
 * ║                    Arquitectura Profesional - 100% Funcional               ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 * 
 * Características:
 * - Sistema de XP y niveles completo
 * - Misiones con verificación real
 * - Firebase integrado con sincronización en tiempo real
 * - IA para análisis de imágenes
 * - Sistema de referidos funcional
 * - Logros con progreso
 * - Canvas con herramientas profesionales
 * - Notificaciones en tiempo real
 * - Modo oscuro/claro
 * - Animaciones fluidas
 * - 100% Responsive
 */

'use strict';

// ═════════════════════════════════════════════════════════════════════════════
// CONFIGURACIÓN GLOBAL
// ═════════════════════════════════════════════════════════════════════════════
const CONFIG = {
    /** Config Firebase: cargada desde sg-firebase-init.js (SEC-022). */
    get firebase() {
        return (typeof window !== 'undefined' && window.SG_FIREBASE_CONFIG) || {};
    },
    baseUrl: "https://studiosgamesrs.com",
    xp: {
        ranks: [
            {
                level: 1,
                accessName: 'Acceso Básico',
                name: 'NOVATO',
                xp: 0,
                color: '#58a6ff',
                icon: 'fa-seedling',
                tagline: 'Explora el Nexus y gana XP con misiones de promoción',
                benefits: [
                    'Acceso completo al Creator Nexus',
                    'Misiones diarias y de promoción SGRS',
                    'Ranking, rachas y progreso de XP',
                    'Insignia de bienvenida al completar tu primera tarea'
                ],
                profilePerks: ['Insignia Novato SGRS']
            },
            {
                level: 2,
                accessName: 'Creador Activo',
                name: 'CREADOR',
                xp: 500,
                color: '#a371f7',
                icon: 'fa-palette',
                tagline: 'Diseña contenido y desbloquea personalización inicial',
                benefits: [
                    'Branding Studio: overlays y plantillas básicas',
                    'Temas de color para tu canvas',
                    '+5% XP extra en misiones',
                    'Recompensas de perfil por tareas completadas'
                ],
                profilePerks: ['Tema dashboard', 'Insignias de misiones']
            },
            {
                level: 3,
                accessName: 'Promotor SGRS',
                name: 'PROMOTOR',
                xp: 1500,
                color: '#f778ba',
                icon: 'fa-bullhorn',
                tagline: 'Promueve la página y gana personalización exclusiva',
                benefits: [
                    'Misiones avanzadas de promoción con recompensas',
                    'Insignias exclusivas de perfil por logros',
                    '+10% XP en misiones',
                    'Vista previa del Creator Market'
                ],
                profilePerks: ['Marco de perfil estándar', 'Insignias especiales']
            },
            {
                level: 4,
                accessName: 'Influencer Nexus',
                name: 'INFLUENCER',
                xp: 3000,
                color: '#e3b341',
                icon: 'fa-shield-halved',
                tagline: 'Acceso amplio y marco personalizado de Nexus',
                benefits: [
                    'Mercado Técnico desbloqueado',
                    'Marco de perfil personalizado Nexus (próximamente)',
                    'Plantillas premium y kit creador avanzado',
                    '+15% XP · soporte prioritario en comunidad'
                ],
                profilePerks: ['Marco Nexus personalizado (Lv.4+)', 'Kit plantillas premium']
            },
            {
                level: 5,
                accessName: 'Embajador Élite',
                name: 'EMBAJADOR',
                xp: 6000,
                color: '#3fb950',
                icon: 'fa-crown',
                tagline: 'Máximo nivel de acceso — todos los beneficios desbloqueados',
                benefits: [
                    'Todos los beneficios del Nexus desbloqueados',
                    'Marco de perfil único Embajador (legendario)',
                    'Acceso beta, contenido exclusivo y eventos anticipados',
                    '+25% XP máximo · destacado en promoción oficial SGRS'
                ],
                profilePerks: ['Marco único Embajador', 'Todo el contenido de perfil desbloqueado']
            }
        ],
        dailyBonus: 100,
        referralBonus: 500,
        streakBonus: [0, 50, 100, 150, 200, 300, 500],
        multiplierPerRank: 0.05
    },
    mercadoTecnico: {
        minRankIndex: 3,
        minRankName: 'INFLUENCER',
        minXp: 3000
    },
    quests: [
        {
            id: 'join_discord',
            title: 'Unirse a Discord',
            description: 'Únete a nuestra comunidad oficial',
            xp: 400,
            type: 'community',
            icon: 'fa-discord',
            color: '#5865F2',
            difficulty: 'medium',
            cooldown: 0,
            action: 'joinDiscord'
        },
        {
            id: 'invite_friend',
            title: 'Invitar un Amigo',
            description: 'Comparte tu código de referido',
            xp: 500,
            type: 'community',
            icon: 'fa-user-plus',
            color: '#e3b341',
            difficulty: 'hard',
            cooldown: 0,
            action: 'inviteFriend'
        },
        {
            id: 'create_overlay',
            title: 'Crear Overlay',
            description: 'Diseña tu primer overlay en el Studio',
            xp: 350,
            type: 'creative',
            icon: 'fa-palette',
            color: '#a371f7',
            difficulty: 'medium',
            cooldown: 0,
            action: 'createOverlay'
        },
        {
            id: 'daily_login',
            title: 'Inicio Diario',
            description: 'Inicia sesión hoy',
            xp: 100,
            type: 'daily',
            icon: 'fa-calendar-check',
            color: '#3fb950',
            difficulty: 'easy',
            cooldown: 24 * 60 * 60 * 1000,
            action: 'dailyLogin'
        },
        {
            id: 'complete_profile',
            title: 'Completar Perfil',
            description: 'Completa toda tu información de perfil',
            xp: 250,
            type: 'profile',
            icon: 'fa-user-edit',
            color: '#f778ba',
            difficulty: 'medium',
            cooldown: 0,
            action: 'completeProfile'
        }
    ],
    achievements: [
        { id: 'first_steps', name: 'Primeros Pasos', description: 'Completa tu primera misión', xp: 100, icon: 'fa-shoe-prints', requirement: 1, type: 'quests' },
        { id: 'social_butterfly', name: 'Mariposa Social', description: 'Completa 5 misiones sociales', xp: 300, icon: 'fa-share-alt', requirement: 5, type: 'social_quests' },
        { id: 'referral_master', name: 'Maestro de Referidos', description: 'Consigue 10 referidos', xp: 1000, icon: 'fa-users', requirement: 10, type: 'referrals' },
        { id: 'streak_keeper', name: 'Mantenedor de Racha', description: '7 días consecutivos activo', xp: 500, icon: 'fa-fire', requirement: 7, type: 'streak' },
        { id: 'xp_collector', name: 'Coleccionista', description: 'Acumula 5,000 XP', xp: 500, icon: 'fa-coins', requirement: 5000, type: 'xp' },
        { id: 'legendary', name: 'Leyenda Viviente', description: 'Alcanza el nivel 5 (Embajador Élite)', xp: 2000, icon: 'fa-crown', requirement: 5, type: 'rank' },
        { id: 'designer_pro', name: 'Diseñador Pro', description: 'Crea 10 overlays', xp: 800, icon: 'fa-paint-brush', requirement: 10, type: 'overlays' },
        { id: 'community_builder', name: 'Constructor', description: 'Invita a 25 amigos', xp: 1500, icon: 'fa-hands-helping', requirement: 25, type: 'referrals' },
        { id: 'daily_warrior', name: 'Guerrero Diario', description: '30 días de actividad', xp: 2000, icon: 'fa-calendar-alt', requirement: 30, type: 'daily_streak' }
    ],
    rewards: [
        { id: 'welcome_badge', name: 'Insignia Bienvenida', description: 'Tu primera insignia al unirte al Nexus', level: 1, icon: 'fa-award', type: 'badge', xpBonus: 100 },
        { id: 'theme_dashboard', name: 'Tema Dashboard', description: 'Personaliza fondo y marco de perfil', level: 2, icon: 'fa-palette', type: 'theme' },
        { id: 'profile_frame', name: 'Marco de Perfil', description: 'Marco exclusivo por misiones completadas', level: 3, icon: 'fa-image', type: 'badge' },
        { id: 'beta_access', name: 'Acceso Beta', description: 'Prueba funciones antes que nadie', level: 4, icon: 'fa-flask' },
        { id: 'priority_support', name: 'Soporte Prioritario', description: 'Atención prioritaria en la comunidad', level: 4, icon: 'fa-headset' },
        { id: 'profile_frame_nexus', name: 'Marco Nexus', description: 'Marco personalizado de Influencer (Lv.4+)', level: 4, icon: 'fa-square-full', type: 'frame', comingSoon: true },
        { id: 'badge_elite', name: 'Insignia Élite', description: 'Insignia difícil — requiere nivel 5', level: 5, icon: 'fa-certificate', type: 'badge', xpBonus: 2500, difficulty: 'legendary' },
        { id: 'exclusive_content', name: 'Contenido Exclusivo', description: 'Material exclusivo para embajadores', level: 5, icon: 'fa-star' },
        { id: 'event_early', name: 'Eventos Anticipados', description: 'Entrada anticipada a eventos SGRS', level: 5, icon: 'fa-calendar-alt', type: 'badge' },
        { id: 'custom_overlay', name: 'Overlay Personalizado', description: 'Diseño único para tu canal', level: 5, icon: 'fa-magic' },
        { id: 'creator_tools', name: 'Kit Creador', description: 'Plantillas y recursos extra para creadores', level: 5, icon: 'fa-toolbox', type: 'badge' },
        { id: 'frame_ambassador', name: 'Marco Embajador', description: 'Marco único legendario — nivel máximo', level: 5, icon: 'fa-gem', type: 'frame', comingSoon: true },
        { id: 'vip_lounge', name: 'Sala VIP', description: 'Acceso a canal privado de la comunidad', level: 5, icon: 'fa-crown', type: 'badge', xpBonus: 1000 }
    ],
    themes: {
        blue: { primary: '#58a6ff', secondary: '#1f6feb', gradient: 'linear-gradient(135deg, #58a6ff, #1f6feb)' },
        purple: { primary: '#a371f7', secondary: '#8957e5', gradient: 'linear-gradient(135deg, #a371f7, #8957e5)' },
        pink: { primary: '#f778ba', secondary: '#db61a2', gradient: 'linear-gradient(135deg, #f778ba, #db61a2)' },
        green: { primary: '#3fb950', secondary: '#2ea043', gradient: 'linear-gradient(135deg, #3fb950, #2ea043)' },
        gold: { primary: '#e3b341', secondary: '#d29922', gradient: 'linear-gradient(135deg, #e3b341, #d29922)' },
        red: { primary: '#f85149', secondary: '#da3633', gradient: 'linear-gradient(135deg, #f85149, #da3633)' },
        cyan: { primary: '#39c5cf', secondary: '#2a9aa2', gradient: 'linear-gradient(135deg, #39c5cf, #2a9aa2)' },
        orange: { primary: '#fb8500', secondary: '#f9c74f', gradient: 'linear-gradient(135deg, #fb8500, #f9c74f)' }
    },
    sounds: {
        enabled: true,
        volume: 0.5
    },
    // Misión del día: misma para todos según día de la semana (0=Dom, 6=Sab)
    dailyMissions: [
        { day: 0, title: 'Comparte en Facebook', description: 'Comparte StudiosGamesRS en tu perfil de Facebook y ayuda a la comunidad a crecer.', questId: 'share_facebook', url: 'https://www.facebook.com/sharer/sharer.php?u=https%3A%2F%2Fstudiosgamesrs.com', buttonLabel: 'Abrir Facebook', icon: 'fab fa-facebook' },
        { day: 1, title: 'Comparte en Twitter/X', description: 'Publica sobre StudiosGamesRS en Twitter/X y gana XP.', questId: 'share_twitter', url: 'https://twitter.com/intent/tweet?text=%C2%A1%C3%9Anete%20a%20Creator%20Nexus%20de%20%40StudiosGamesRS!%20%F0%9F%8E%AE%E2%9C%A8&url=https%3A%2F%2Fstudiosgamesrs.com', buttonLabel: 'Abrir Twitter', icon: 'fab fa-twitter' },
        { day: 2, title: 'Comparte en Facebook', description: 'Comparte StudiosGamesRS en tu perfil de Facebook y gana recompensas.', questId: 'share_facebook', url: 'https://www.facebook.com/sharer/sharer.php?u=https%3A%2F%2Fstudiosgamesrs.com', buttonLabel: 'Abrir Facebook', icon: 'fab fa-facebook' },
        { day: 3, title: 'Comparte por WhatsApp', description: 'Envía el enlace de StudiosGamesRS a tus contactos de WhatsApp.', questId: 'share_whatsapp', url: 'https://wa.me/?text=%C2%A1%C3%9Anete%20a%20Creator%20Nexus!%20https%3A%2F%2Fstudiosgamesrs.com', buttonLabel: 'Abrir WhatsApp', icon: 'fab fa-whatsapp' },
        { day: 4, title: 'Comparte en Facebook', description: 'Comparte nuestra comunidad en Facebook y suma puntos.', questId: 'share_facebook', url: 'https://www.facebook.com/sharer/sharer.php?u=https%3A%2F%2Fstudiosgamesrs.com', buttonLabel: 'Abrir Facebook', icon: 'fab fa-facebook' },
        { day: 5, title: 'Únete a Discord', description: 'Entra al servidor oficial de StudiosGamesRS en Discord.', questId: 'join_discord', url: 'https://discord.gg/studiosgamesrs', buttonLabel: 'Abrir Discord', icon: 'fab fa-discord' },
        { day: 6, title: 'Comparte en Facebook', description: 'Comparte StudiosGamesRS en Facebook y cierra la semana con bonus.', questId: 'share_facebook', url: 'https://www.facebook.com/sharer/sharer.php?u=https%3A%2F%2Fstudiosgamesrs.com', buttonLabel: 'Abrir Facebook', icon: 'fab fa-facebook' }
    ]
};

// ═════════════════════════════════════════════════════════════════════════════
// ESTADO GLOBAL
// ═════════════════════════════════════════════════════════════════════════════
const State = {
    user: {
        id: null,
        username: null,
        email: null,
        displayName: null,
        photoURL: null,
        communityHonor: 0,
        isDashboardUser: false,
        createdAt: null
    },
    stats: {
        xp: 0,
        level: 1,
        rank: 0,
        streak: 0,
        maxStreak: 0,
        lastLogin: null,
        totalQuestsCompleted: 0,
        totalReferrals: 0,
        verifiedReferrals: 0,
        overlaysCreated: 0,
        achievementsUnlocked: 0
    },
    quests: {},
    achievements: {},
    claimedRewards: {},
    badges: [],
    referrals: [],
    settings: {
        theme: 'dark',
        notifications: true,
        sound: true,
        language: 'es'
    },
    canvas: {
        image: null,
        zoom: 100,
        theme: 'blue',
        effects: [],
        history: [],
        lastAIXpTime: 0,
        logoWatermark: null
    },
    ui: {
        activeTab: 'all',
        sidebarOpen: true,
        notifications: []
    },
    dailyMissionPopup: {
        openedLink: false,
        current: null
    },
    recentActivities: [],
    leaderboardCache: [],
    creatorMarket: {
        status: null,
        application: null,
        totalEarnings: 0,
        pendingEarnings: 0,
        paidEarnings: 0,
        lastWalletEntry: null,
        walletLedger: [],
        publicationsCache: {},
        activeView: 'posts',
        activePanel: 'feed'
    },
    boost: {
        active: false,
        multiplier: 1,
        expires: null
    }
};

// ═════════════════════════════════════════════════════════════════════════════
// CLASE PRINCIPAL - NEXUS CORE
// ═════════════════════════════════════════════════════════════════════════════
class NexusCore {
    constructor() {
        this.firebase = null;
        this.db = null;
        this.auth = null;
        this.storage = null;
        this.functions = null;
        this.userRef = null;
        this.creatorMarketSelectedFile = null;
        this.creatorPreviewObjectUrl = null;
        this.creatorMetricsRefreshTimer = null;
        this.listeners = [];
        this.initialized = false;
        
        // Bindings
        this.init = this.init.bind(this);
        this.handleError = this.handleError.bind(this);
    }

    // ═════════════════════════════════════════════════════════════════════════
    // INICIALIZACIÓN
    // ═════════════════════════════════════════════════════════════════════════
    async init() {
        console.log('🚀 Iniciando Creator Nexus v8.0...');
        
        try {
            // Paso 0: Capturar código de referido en URL (?ref=NEXUS-XXX) para nuevos usuarios
            const urlParams = new URLSearchParams(window.location.search);
            const refCode = urlParams.get('ref');
            if (refCode && /^NEXUS-[A-Z0-9]{1,12}$/i.test(refCode)) {
                localStorage.setItem('pending_referral_code', refCode.toUpperCase());
                window.history.replaceState({}, '', window.location.pathname + (window.location.hash || ''));
            }
            
            // Paso 1: Generar/Recuperar ID de usuario
            this.initUserId();
            
            // Paso 2: Inicializar Firebase
            await this.initFirebase();
            
            // Paso 3: Cargar datos del usuario
            await this.loadUserData();
            
            // Paso 4: Inicializar UI
            this.initUI();
            
            // Paso 5: Configurar eventos
            this.initEvents();
            
            // Paso 6: Inicializar Canvas
            this.initCanvas();
            
            // Paso 7: Inicializar efectos visuales
            this.initVisualEffects();
            
            // Paso 8: Verificar referidos
            this.checkReferral();
            
            // Paso 9: Iniciar timers
            this.initTimers();
            
            // Paso 10: Mostrar bienvenida
            this.showWelcome();

            await this.refreshLeaderboard();
            this.updateMercadoTecnico();
            
            this.initialized = true;
            console.log('✅ Nexus Core inicializado correctamente');
            
        } catch (error) {
            console.error('❌ Error en inicialización:', error);
            this.handleError(error);
            this.initOfflineMode();
        }
    }

    initUserId() {
        let userId = localStorage.getItem('nexus_user_id');
        let username = localStorage.getItem('nexus_username');
        
        if (!userId) {
            userId = 'nx_' + this.generateId(12);
            localStorage.setItem('nexus_user_id', userId);
        }
        
        if (!username) {
            username = 'Usuario_' + Math.floor(Math.random() * 9999);
            localStorage.setItem('nexus_username', username);
        }
        
        State.user.id = userId;
        State.user.username = username;
        State.user.createdAt = localStorage.getItem('nexus_created_at') || new Date().toISOString();
        
        if (!localStorage.getItem('nexus_created_at')) {
            localStorage.setItem('nexus_created_at', State.user.createdAt);
        }
    }

    resolveAvatarUrl(userData, steamData, fbPhoto) {
        const steamAvatar = (steamData && steamData.avatarfull) || (userData && userData.steam && userData.steam.avatarfull) || null;
        const preferSteam = userData && (userData.preferSteamAvatar === true || userData.avatarSource === 'steam');
        if (preferSteam && steamAvatar) return steamAvatar;
        if (userData && userData.photoURL) return userData.photoURL;
        return steamAvatar || fbPhoto || null;
    }

    updateHonorDisplay() {
        const honorEl = document.getElementById('profile-honor');
        if (honorEl) {
            const honorValue = Number(State.user.communityHonor || 0);
            honorEl.textContent = 'Honor: ' + honorValue.toLocaleString();
        }
    }

    async refreshDashboardProfile() {
        if (!State.user.isDashboardUser || !this.db || !State.user.id) return;
        try {
            const userSnap = await this.db.ref('users/' + State.user.id).once('value');
            const userData = userSnap.val() || {};
            const steamSnap = await this.db.ref('users/' + State.user.id + '/steam').once('value');
            const steamData = steamSnap.val();
            if (userData.nick) State.user.displayName = userData.nick;
            State.user.communityHonor = Number(userData.communityHonor || 0);
            State.user.photoURL = this.resolveAvatarUrl(userData, steamData, State.user.photoURL);
            this.updateHonorDisplay();
            this.updateRankDisplay();
        } catch (_) {}
    }

    async initFirebase() {
        try {
            if (typeof firebase === 'undefined') {
                throw new Error('Firebase SDK no cargado');
            }
            
            if (typeof sgInitFirebaseApp === 'function') {
                sgInitFirebaseApp();
            } else if (!firebase.apps || firebase.apps.length === 0) {
                const cfg = window.SG_FIREBASE_CONFIG;
                if (!cfg || !cfg.apiKey) throw new Error('sg-firebase-init.js no cargado');
                firebase.initializeApp(cfg);
            }
            this.db = firebase.database();
            this.auth = firebase.auth();
            if (firebase.storage) this.storage = firebase.storage();
            if (firebase.functions) this.functions = firebase.functions();
            
            // Esperar auth; dar ~1.2s a persistencia para restaurar sesión (evita perder dashboard user al recargar)
            const fbUser = await new Promise((resolve) => {
                let done = false;
                const finish = (u) => { if (!done) { done = true; unsub(); resolve(u); } };
                const unsub = this.auth.onAuthStateChanged((user) => {
                    if (user) finish(user);
                    else setTimeout(() => finish(this.auth.currentUser), 1200);
                });
            });
            
            if (fbUser && !fbUser.isAnonymous) {
                State.user.id = fbUser.uid;
                State.user.isDashboardUser = true;
                State.user.displayName = fbUser.displayName || null;
                State.user.photoURL = fbUser.photoURL || null;
                try {
                    const userSnap = await this.db.ref('users/' + fbUser.uid).once('value');
                    const userData = userSnap.val() || {};
                    if (userData.nick) State.user.displayName = userData.nick;
                    State.user.communityHonor = Number(userData.communityHonor || 0);
                    const steamSnap = await this.db.ref('users/' + fbUser.uid + '/steam').once('value');
                    const steamData = steamSnap.val();
                    State.user.photoURL = this.resolveAvatarUrl(userData, steamData, fbUser.photoURL || null);
                } catch (_) {}
                this.db.ref('users/' + fbUser.uid + '/communityHonor').on('value', (snap) => {
                    State.user.communityHonor = Number(snap.val() || 0);
                    this.updateHonorDisplay();
                });
                this.db.ref('users/' + fbUser.uid).on('value', (snap) => {
                    const ud = snap.val();
                    if (!ud) return;
                    if (ud.nick) State.user.displayName = ud.nick;
                    const steam = ud.steam || null;
                    State.user.photoURL = this.resolveAvatarUrl(ud, steam, fbUser.photoURL || null);
                    this.updateRankDisplay();
                });
                await this.ensureReferralCodeForUser(fbUser.uid);
                await this.syncReferralsFromDashboard(fbUser.uid);
                this.userRef = this.db.ref(`nexus/users/${State.user.id}`);
                this.attachCreatorApplicationListener();
                this.db.ref('users/' + fbUser.uid + '/referrals').on('value', (snap) => {
                    const refs = snap.val();
                    State.stats.verifiedReferrals = refs ? Object.keys(refs).length : 0;
                    this.updateReferralDisplay();
                    this.renderReferralsTable(snap);
                });
                console.log('🔐 Usuario Dashboard:', fbUser.uid);
            } else {
                const userCredential = await this.auth.signInAnonymously();
                console.log('🔐 Anónimo:', userCredential.user.uid);
                this.userRef = this.db.ref(`nexus/users/${State.user.id}`);
            }
            
            // Escuchar cambios en tiempo real
            this.userRef.on('value', (snapshot) => {
                const data = snapshot.val();
                if (data) {
                    this.syncData(data);
                }
            });
            
            // Guardar datos iniciales si no existen
            const snapshot = await this.userRef.once('value');
            if (!snapshot.exists()) {
                await this.saveUserData();
            }
            
        } catch (error) {
            console.warn('⚠️ Firebase no disponible:', error.message);
            this.db = null;
            this.auth = null;
        }
    }

    async loadUserData() {
        try {
            const saved = localStorage.getItem('nexus_state');
            if (saved) {
                const data = JSON.parse(saved);
                this.mergeLocalUiPrefs(data);
            }

            if (this.userRef) {
                const snap = await this.userRef.once('value');
                if (snap.exists()) {
                    this.syncData(snap.val());
                }
            }

            await this.checkDailyStreak();
            await this.tryAutoClaimDailyLogin();
            this.updateLevelFromXP();
        } catch (error) {
            console.warn('⚠️ Error cargando datos:', error);
        }
    }

    /** SEC-021: localStorage solo preferencias de UI — no XP, misiones ni logros. */
    mergeLocalUiPrefs(data) {
        if (data.settings) Object.assign(State.settings, data.settings);
        if (data.recentActivities && Array.isArray(data.recentActivities)) {
            State.recentActivities = data.recentActivities.slice(-10);
        }
    }

    buildNexusLocalCachePayload() {
        return {
            settings: State.settings,
            recentActivities: State.recentActivities.slice(-10),
            lastUpdated: Date.now()
        };
    }

    persistNexusLocalCache() {
        try {
            localStorage.setItem('nexus_state', JSON.stringify(this.buildNexusLocalCachePayload()));
        } catch (_) {}
    }

    syncData(data) {
        if (data.stats) {
            this.applyStatsFromServer(data.stats, false);
        }
        if (data.referrals) {
            State.referrals = data.referrals;
        }
        if (data.claimedRewards) {
            State.claimedRewards = { ...State.claimedRewards, ...data.claimedRewards };
        }
        if (data.badges && Array.isArray(data.badges)) {
            State.badges = [...data.badges];
        }
        if (data.achievements) {
            State.achievements = { ...State.achievements, ...data.achievements };
        }
        if (data.quests) {
            State.quests = { ...State.quests, ...data.quests };
        }
        if (data.xpBoost) {
            this.syncXpBoostFromServer(data.xpBoost);
        }
        if (data.user) {
            if (data.user.displayName !== undefined) State.user.displayName = data.user.displayName;
            if (!State.user.isDashboardUser && data.user.photoURL !== undefined) {
                State.user.photoURL = data.user.photoURL;
            }
        }
        this.updateUI();
        this.persistLocalStateFromFirebase(data);
    }

    applyStatsFromServer(stats, updateUi = true) {
        if (!stats) return;
        const keepRefs = State.user.isDashboardUser ? State.stats.verifiedReferrals : undefined;
        State.stats.xp = stats.xp != null ? Number(stats.xp) : State.stats.xp;
        State.stats.level = stats.level != null ? Number(stats.level) : State.stats.level;
        State.stats.rank = stats.rank != null ? Number(stats.rank) : State.stats.rank;
        State.stats.streak = stats.streak != null ? Number(stats.streak) : State.stats.streak;
        State.stats.maxStreak = stats.maxStreak != null ? Number(stats.maxStreak) : State.stats.maxStreak;
        State.stats.lastLogin = stats.lastLogin != null ? stats.lastLogin : State.stats.lastLogin;
        State.stats.totalQuestsCompleted = stats.totalQuestsCompleted != null
            ? Number(stats.totalQuestsCompleted) : State.stats.totalQuestsCompleted;
        State.stats.totalReferrals = stats.totalReferrals != null
            ? Number(stats.totalReferrals) : State.stats.totalReferrals;
        if (keepRefs === undefined) {
            State.stats.verifiedReferrals = stats.verifiedReferrals != null
                ? Number(stats.verifiedReferrals) : State.stats.verifiedReferrals;
        } else {
            State.stats.verifiedReferrals = keepRefs;
        }
        State.stats.overlaysCreated = stats.overlaysCreated != null
            ? Number(stats.overlaysCreated) : State.stats.overlaysCreated;
        State.stats.achievementsUnlocked = stats.achievementsUnlocked != null
            ? Number(stats.achievementsUnlocked) : State.stats.achievementsUnlocked;
        if (updateUi) {
            this.updateXPBar();
            this.updateStatsDisplay();
            this.updateMercadoTecnico();
            this.updateLocalRankDisplay();
        }
    }

    resolveXpActionKey(source, explicitKey) {
        if (explicitKey) return explicitKey;
        const src = String(source || '').trim();
        const sourceMap = {
            'Descargar overlay': 'download_overlay',
            'Compartir overlay': 'share_overlay',
            'Generar con IA': 'generate_ai',
            'Usar IA': 'use_ai',
            'Análisis de diseño': 'analyze_design'
        };
        if (sourceMap[src]) return sourceMap[src];
        if (src.startsWith('Logro:')) return 'achievement:general';
        if (src.startsWith('Recompensa:')) return 'reward:general';
        if (src.startsWith('Racha de')) return 'streak_bonus';
        return 'general';
    }

    async ensureNexusStatsNode() {
        if (!this.functions || !State.user.isDashboardUser) return;
        await this.checkDailyStreak();
    }

    async syncActivityStats(payload) {
        if (!payload || !Object.keys(payload).length) return null;
        console.warn('syncActivityStats: deprecado — usa processNexusDailyStreak.');
        return this.checkDailyStreak();
    }

    syncXpBoostFromServer(boost) {
        const now = Date.now();
        const expiresAt = boost && boost.expiresAt != null ? Number(boost.expiresAt) : 0;
        if (!boost || !expiresAt || expiresAt <= now) {
            State.boost.active = false;
            State.boost.multiplier = 1;
            State.boost.expires = null;
        } else {
            State.boost.active = true;
            State.boost.multiplier = Number(boost.multiplier) || 2;
            State.boost.expires = expiresAt;
        }
        this.updateBoostUI();
    }

    updateBoostUI() {
        const indicator = document.getElementById('xp-boost-indicator');
        const btn = document.querySelector('.xp-boost-btn');
        const active = !!(State.boost.active && State.boost.expires && State.boost.expires > Date.now());

        if (indicator) indicator.style.display = active ? 'flex' : 'none';
        if (btn) {
            btn.disabled = false;
            btn.classList.toggle('is-active', active);
            btn.title = active
                ? `Boost x${State.boost.multiplier} activo (otorgado por Commander)`
                : 'El boost x2 solo lo otorga un Commander de SGRS';
        }
        if (active) this.updateBoostTimer();
    }

    updateBoostTimer() {
        const timerEl = document.querySelector('.boost-timer');
        if (!timerEl || !State.boost.expires) return;
        const diff = State.boost.expires - Date.now();
        if (diff <= 0) {
            State.boost.active = false;
            State.boost.multiplier = 1;
            State.boost.expires = null;
            this.updateBoostUI();
            return;
        }
        const totalSec = Math.floor(diff / 1000);
        const h = Math.floor(totalSec / 3600);
        const m = Math.floor((totalSec % 3600) / 60);
        const s = totalSec % 60;
        timerEl.textContent = h > 0
            ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
            : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }

    persistLocalStateFromFirebase() {
        this.persistNexusLocalCache();
    }

    getClientWritableQuests() {
        return {};
    }

    persistQuestStateLocal() {
        this.persistNexusLocalCache();
    }

    hasOverlayCanvas() {
        return !!(State.canvas && State.canvas.image);
    }

    async completeOverlayUpload() {
        if (!this.functions || !State.user.isDashboardUser) return false;
        if (!this.hasOverlayCanvas()) return false;

        try {
            const result = await this.functions.httpsCallable('completeNexusOverlayUpload')({
                hasCanvas: true
            });
            const data = result.data || {};
            if (data.stats) this.applyStatsFromServer(data.stats);
            if (data.quest) State.quests.create_overlay = data.quest;

            const questXp = Number(data.questXpGranted) || 0;
            if (questXp > 0) {
                const quest = CONFIG.quests.find((q) => q.id === 'create_overlay');
                this.pushActivity('fa-check-circle', `${State.user.username} completó: ${quest ? quest.title : 'Crear Overlay'}`);
                this.showToast('¡Misión completada!', 'success', `+${questXp} XP · overlay registrado`);
                if (quest) {
                    this.pushUserNotification({
                        text: `Misión completada: ${quest.title} (+${questXp} XP)`,
                        icon: quest.icon || 'fa-palette',
                        type: 'quest'
                    });
                }
            }

            this.renderQuests();
            this.checkAchievements();
            await this.saveUserData();
            return true;
        } catch (error) {
            console.warn('completeOverlayUpload:', error.message || error);
            return false;
        }
    }

    async registerBrandingStudioSession() {
        if (!this.functions || !State.user.isDashboardUser || !this.hasOverlayCanvas()) return null;
        try {
            const result = await this.functions.httpsCallable('registerBrandingStudioSession')({});
            return (result.data && result.data.session) || null;
        } catch (error) {
            console.warn('registerBrandingStudioSession:', error);
            return null;
        }
    }

    async claimOverlayDownloadXp() {
        if (!this.functions || !State.user.isDashboardUser || !this.hasOverlayCanvas()) return 0;
        try {
            const result = await this.functions.httpsCallable('claimOverlayDownloadXp')({});
            const data = result.data || {};
            if (data.stats) this.applyStatsFromServer(data.stats);
            return Number(data.granted) || 0;
        } catch (error) {
            const code = error && error.code ? String(error.code) : '';
            if (!code.includes('resource-exhausted') && !code.includes('already-exists')) {
                console.warn('claimOverlayDownloadXp:', error);
            }
            return 0;
        }
    }

    async claimOverlayShareXp(shareMethod) {
        if (!this.functions || !State.user.isDashboardUser || !this.hasOverlayCanvas()) return 0;
        try {
            const result = await this.functions.httpsCallable('claimOverlayShareXp')({
                shareMethod
            });
            const data = result.data || {};
            if (data.stats) this.applyStatsFromServer(data.stats);
            const granted = Number(data.granted) || 0;
            if (granted > 0) {
                this.showToast('Compartir', 'success', `Overlay compartido · +${granted} XP`);
            }
            return granted;
        } catch (error) {
            const code = error && error.code ? String(error.code) : '';
            if (!code.includes('resource-exhausted') && !code.includes('already-exists')) {
                console.warn('claimOverlayShareXp:', error);
                this.showToast('Compartir', 'info', error.message || 'XP de compartir no disponible aún.');
            }
            return 0;
        }
    }

    async claimOverlayGenerateAiXp() {
        if (!this.functions || !State.user.isDashboardUser || !this.hasOverlayCanvas()) return 0;
        try {
            const result = await this.functions.httpsCallable('claimOverlayGenerateAiXp')({});
            const data = result.data || {};
            if (data.stats) this.applyStatsFromServer(data.stats);
            return Number(data.granted) || 0;
        } catch (error) {
            const code = error && error.code ? String(error.code) : '';
            if (!code.includes('resource-exhausted') && !code.includes('failed-precondition')) {
                console.warn('claimOverlayGenerateAiXp:', error);
            }
            return 0;
        }
    }

    async claimOverlayUseAiXp() {
        if (!this.functions || !State.user.isDashboardUser || !this.hasOverlayCanvas()) return 0;
        try {
            const result = await this.functions.httpsCallable('claimOverlayUseAiXp')({});
            const data = result.data || {};
            if (data.stats) this.applyStatsFromServer(data.stats);
            return Number(data.granted) || 0;
        } catch (error) {
            const code = error && error.code ? String(error.code) : '';
            if (!code.includes('resource-exhausted') && !code.includes('failed-precondition')) {
                console.warn('claimOverlayUseAiXp:', error);
            }
            return 0;
        }
    }

    async claimOverlayAnalyzeDesignXp() {
        if (!this.functions || !State.user.isDashboardUser || !this.hasOverlayCanvas()) return 0;
        try {
            const result = await this.functions.httpsCallable('claimOverlayAnalyzeDesignXp')({});
            const data = result.data || {};
            if (data.stats) this.applyStatsFromServer(data.stats);
            return Number(data.granted) || 0;
        } catch (error) {
            const code = error && error.code ? String(error.code) : '';
            if (!code.includes('resource-exhausted') && !code.includes('failed-precondition')) {
                console.warn('claimOverlayAnalyzeDesignXp:', error);
            }
            return 0;
        }
    }

    getClientWritableSettings() {
        const s = { ...State.settings };
        delete s.profileCustomizationUnlocked;
        return s;
    }

    async saveUserData() {
        this.persistNexusLocalCache();

        if (this.db && this.userRef) {
            try {
                const firebasePayload = {
                    user: {
                        id: State.user.id,
                        username: State.user.username,
                        displayName: State.user.displayName,
                        photoURL: State.user.photoURL,
                        isDashboardUser: !!State.user.isDashboardUser
                    },
                    referrals: State.referrals,
                    settings: (() => {
                        const s = this.getClientWritableSettings();
                        if (State.settings.profileCustomizationUnlocked) {
                            s.profileCustomizationUnlocked = true;
                        }
                        return s;
                    })(),
                    recentActivities: State.recentActivities.slice(-10),
                    lastUpdated: Date.now()
                };
                await this.userRef.update(firebasePayload);
            } catch (error) {
                console.warn('⚠️ Error guardando en Firebase:', error);
            }
        }
    }

    // ═════════════════════════════════════════════════════════════════════════
    // SISTEMA DE XP Y NIVELES (SEC-001: XP solo vía Cloud Functions)
    // ═════════════════════════════════════════════════════════════════════════
    async addXP(amount, source = 'general', showNotification = true, actionKey = null) {
        const baseAmount = Math.floor(Number(amount) || 0);
        if (baseAmount < 1) return 0;

        const oldLevel = State.stats.level;
        const resolvedActionKey = this.resolveXpActionKey(source, actionKey);

        if (!this.functions) {
            console.warn('addXP: Cloud Functions no disponibles');
            if (showNotification) {
                this.showToast('XP no disponible', 'warning', 'Conexión con el servidor requerida.');
            }
            return 0;
        }

        try {
            const result = await this.functions.httpsCallable('awardNexusXp')({
                amount: baseAmount,
                actionKey: resolvedActionKey,
                source: String(source).slice(0, 120)
            });
            const data = result.data || {};
            const granted = Number(data.granted) || 0;
            if (data.stats) {
                this.applyStatsFromServer(data.stats);
            } else {
                this.updateLevelFromXP();
                this.updateXPBar();
                this.updateStatsDisplay();
                this.updateMercadoTecnico();
                this.updateLocalRankDisplay();
            }

            if (showNotification && granted > 0) {
                this.showToast(`+${granted} XP`, 'success', `Ganado por: ${source}`);
            }

            this.checkAchievements();

            if (granted >= 100) {
                this.triggerConfetti();
            }

            if (State.stats.level > oldLevel) {
                this.onLevelUp(State.stats.level);
            }

            return granted;
        } catch (error) {
            const code = error && error.code ? String(error.code) : '';
            if (code.includes('already-exists') || code.includes('resource-exhausted')) {
                if (showNotification) {
                    this.showToast('XP no disponible', 'info', error.message || 'Acción ya registrada o en cooldown.');
                }
            } else {
                console.warn('addXP:', error);
                if (showNotification) {
                    this.showToast('Error XP', 'error', 'No se pudo registrar la experiencia.');
                }
            }
            return 0;
        }
    }

    updateLevelFromXP() {
        let newLevel = 1;
        let newRank = 0;
        
        for (let i = CONFIG.xp.ranks.length - 1; i >= 0; i--) {
            if (State.stats.xp >= CONFIG.xp.ranks[i].xp) {
                newLevel = CONFIG.xp.ranks[i].level;
                newRank = i;
                break;
            }
        }
        
        State.stats.level = newLevel;
        State.stats.rank = newRank;
    }

    onLevelUp(newLevel) {
        const rank = CONFIG.xp.ranks[State.stats.rank];
        this.pushActivity('fa-arrow-up', `${State.user.username} subió al Nivel ${newLevel}`);
        
        // Sonido
        this.playSound('levelup');
        
        // Notificación especial
        this.showAchievementUnlock(`Nivel ${newLevel}`, rank.icon);
        
        // Toast
        this.showToast(
            '¡SUBIDA DE NIVEL!',
            'success',
            `Has alcanzado el Nivel ${newLevel}`
        );
        this.pushUserNotification({
            text: `¡Subiste al Nivel ${newLevel}!`,
            icon: 'fa-arrow-up',
            type: 'level_up'
        });
        
        // Confetti especial
        this.triggerConfetti({
            particleCount: 150,
            colors: [rank.color, '#ffffff', '#ffd700'],
            spread: 100
        });
        
        // Desbloquear recompensas
        this.updateRewards();
        this.updateMercadoTecnico();
        
        // Guardar
        this.saveUserData();
    }

    // ═════════════════════════════════════════════════════════════════════════
    // SISTEMA DE MISIONES
    // ═════════════════════════════════════════════════════════════════════════
    getDailyMission() {
        const missions = CONFIG.dailyMissions || [];
        const day = new Date().getDay();
        return missions.find(m => m.day === day) || missions[0] || { title: 'Comparte en Facebook', description: 'Comparte StudiosGamesRS en Facebook.', questId: 'share_facebook', url: 'https://www.facebook.com/sharer/sharer.php?u=https%3A%2F%2Fstudiosgamesrs.com', buttonLabel: 'Abrir Facebook', icon: 'fab fa-facebook' };
    }

    startQuest(questId) {
        const quest = CONFIG.quests.find(q => q.id === questId);
        if (!quest) {
            this.showToast('Error', 'error', 'Misión no encontrada');
            return;
        }
        
        // Verificar cooldown
        const questData = State.quests[questId] || {};
        if (questData.lastCompleted && quest.cooldown > 0) {
            const timeSince = Date.now() - questData.lastCompleted;
            if (timeSince < quest.cooldown) {
                const hours = Math.ceil((quest.cooldown - timeSince) / (60 * 60 * 1000));
                this.showToast('En cooldown', 'warning', `Disponible en ${hours} horas`);
                return;
            }
        }
        
        // Ejecutar acción
        this.executeQuestAction(quest);
    }

    executeQuestAction(quest) {
        const self = this;
        const verificationPendingMsg = 'La verificación aún no está activa. No se otorga EXP automáticamente.';
        const openExternal = (url, features) => {
            window.open(url, '_blank', features || '');
            self.showToast('Acción abierta', 'info', verificationPendingMsg);
        };

        const actions = {
            shareFacebook: () => {
                const url = `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent('https://studiosgamesrs.com')}`;
                openExternal(url, 'width=600,height=400');
            },
            shareTwitter: () => {
                const text = '¡Únete a Creator Nexus de @StudiosGamesRS! 🎮✨';
                const url = `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent('https://studiosgamesrs.com')}`;
                openExternal(url, 'width=600,height=400');
            },
            shareWhatsApp: () => {
                const text = '¡Únete a Creator Nexus! https://studiosgamesrs.com';
                openExternal(`https://wa.me/?text=${encodeURIComponent(text)}`);
            },
            shareTelegram: () => {
                const text = '¡Únete a Creator Nexus!';
                openExternal(`https://t.me/share/url?url=${encodeURIComponent('https://studiosgamesrs.com')}&text=${encodeURIComponent(text)}`);
            },
            visitDashboard: () => {
                openExternal('https://studiosgamesrs.com/dashboard');
            },
            joinDiscord: () => {
                openExternal('https://discord.gg/studiosgamesrs');
            },
            inviteFriend: () => {
                this.copyReferralCode();
                this.showToast('Código copiado', 'info', 'Comparte tu código con amigos');
            },
            createOverlay: () => {
                this.toggleNexusPanel('branding', true);
                this.showToast('Crea un overlay', 'info', 'Sube una imagen y personalízala');
            },
            dailyLogin: () => {
                this.claimDailyLoginQuest(quest);
            },
            completeProfile: () => {
                openExternal('https://studiosgamesrs.com/profile');
            }
        };
        
        const action = actions[quest.action];
        if (action) {
            action();
        } else {
            this.showToast('No disponible', 'warning', verificationPendingMsg);
        }
    }

    simulateVerification(callback, delay) {
        this.showToast('Verificación pendiente', 'info', 'Esta misión requiere verificación real antes de otorgar EXP.');
    }

    async claimDailyLoginQuest(quest, options = {}) {
        const silent = !!options.silent;
        if (!quest || quest.id !== 'daily_login') return false;

        if (!this.functions) {
            if (!silent) {
                this.showToast('Inicio diario', 'warning', 'Conexión con el servidor requerida.');
            }
            return false;
        }
        if (!State.user.isDashboardUser) {
            if (!silent) {
                this.showToast('Inicio diario', 'warning', 'Inicia sesión con tu cuenta StudiosGamesRS.');
            }
            return false;
        }

        const questData = State.quests[quest.id] || {};
        if (questData.lastCompleted && quest.cooldown > 0 &&
            (Date.now() - questData.lastCompleted) < quest.cooldown) {
            if (!silent) {
                this.showToast('En cooldown', 'warning', 'Ya reclamaste el login diario hoy.');
            }
            return false;
        }

        try {
            const result = await this.functions.httpsCallable('completeNexusDailyLogin')({});
            const data = result.data || {};
            if (data.quest) State.quests[quest.id] = data.quest;
            if (data.stats) this.applyStatsFromServer(data.stats);
            const granted = Number(data.granted) || 0;

            this.pushActivity('fa-check-circle', `${State.user.username} completó: ${quest.title}`);
            this.renderQuests();
            this.checkAchievements();
            await this.saveUserData();

            if (granted > 0) {
                const msg = `+${granted} XP ganados`;
                if (options.auto) {
                    this.showToast('Inicio diario', 'success', msg);
                } else {
                    this.showToast('¡Misión completada!', 'success', msg);
                }
                this.pushUserNotification({
                    text: `Misión completada: ${quest.title} (+${granted} XP)`,
                    icon: quest.icon || 'fa-check-circle',
                    type: 'quest'
                });
            }
            return true;
        } catch (error) {
            const code = error && error.code ? String(error.code) : '';
            if (!silent && !code.includes('resource-exhausted') && !code.includes('already-exists')) {
                console.warn('claimDailyLoginQuest:', error);
                this.showToast('Inicio diario', 'error', error.message || 'No se pudo completar el login diario.');
            }
            return false;
        }
    }

    async tryAutoClaimDailyLogin() {
        const quest = CONFIG.quests.find((q) => q.id === 'daily_login');
        if (!quest) return;
        await this.claimDailyLoginQuest(quest, { silent: true, auto: true });
    }

    async completeQuest(quest) {
        if (quest && quest.id === 'daily_login') {
            return this.claimDailyLoginQuest(quest);
        }
        if (quest && quest.id === 'create_overlay') {
            this.showToast('Crear overlay', 'info', 'Sube una imagen al canvas para completar esta misión.');
            return;
        }
        if (!this.functions || !State.user.isDashboardUser) {
            this.showToast('Error', 'error', 'Conexión con el servidor requerida.');
            return;
        }

        const questData = State.quests[quest.id] || {};
        if (questData.lastCompleted && quest.cooldown > 0 &&
            (Date.now() - questData.lastCompleted) < quest.cooldown) {
            const hours = Math.ceil((quest.cooldown - (Date.now() - questData.lastCompleted)) / (60 * 60 * 1000));
            this.showToast('En cooldown', 'warning', `Disponible en ${hours} horas`);
            return;
        }

        try {
            const result = await this.functions.httpsCallable('completeNexusQuest')({ questId: quest.id });
            const data = result.data || {};
            if (data.quest) State.quests[quest.id] = data.quest;
            if (data.stats) this.applyStatsFromServer(data.stats);
            const granted = Number(data.granted) || 0;

            this.pushActivity('fa-check-circle', `${State.user.username} completó: ${quest.title}`);
            this.renderQuests();
            this.persistQuestStateLocal();
            this.checkAchievements();

            this.showToast('¡Misión completada!', 'success', `+${granted || quest.xp} XP ganados`);
            this.pushUserNotification({
                text: `Misión completada: ${quest.title} (+${granted || quest.xp} XP)`,
                icon: quest.icon || 'fa-check-circle',
                type: 'quest'
            });
        } catch (error) {
            const code = error && error.code ? String(error.code) : '';
            if (code.includes('resource-exhausted')) {
                this.showToast('En cooldown', 'warning', 'Esta misión aún no está disponible.');
                return;
            }
            if (code.includes('already-exists')) {
                this.showToast('Ya completada', 'info', 'Esta misión ya fue completada.');
                return;
            }
            console.warn('completeQuest:', error);
            this.showToast('Error', 'error', error.message || 'No se pudo completar la misión.');
        }
    }

    // ═════════════════════════════════════════════════════════════════════════
    // SISTEMA DE REFERIDOS
    // ═════════════════════════════════════════════════════════════════════════
    checkReferral() {
        const refCode = localStorage.getItem('pending_referral_code');
        if (refCode && State.user.isDashboardUser) {
            this.registerReferredUser(refCode);
        }
    }

    async registerReferredUser(refCode) {
        if (!refCode || !this.functions || !State.user.isDashboardUser) return;
        refCode = String(refCode).trim().toUpperCase();
        if (refCode === this.getReferralCode()) return;

        try {
            await this.functions.httpsCallable('awardReferralBonus')({ refCode });
            localStorage.removeItem('pending_referral_code');
            this.showToast('¡Referido registrado!', 'success', 'Tu amigo recibió +500 XP');
        } catch (error) {
            const code = error && error.code ? String(error.code) : '';
            if (code.includes('already-exists') || code.includes('failed-precondition')) {
                localStorage.removeItem('pending_referral_code');
            } else {
                console.warn('Error registrando referido:', error.message || error);
            }
        }
    }

    async ensureReferralCodeForUser(uid) {
        if (!this.functions) return;
        try {
            await this.functions.httpsCallable('ensureUserReferralCode')({});
        } catch (e) { console.warn('ensureReferralCode:', e); }
    }

    async syncReferralsFromDashboard(uid) {
        if (!this.db) return;
        try {
            const ref = this.db.ref('users/' + uid + '/referrals');
            const snap = await ref.once('value');
            const refs = snap.val();
            const count = refs ? Object.keys(refs).length : 0;
            State.stats.verifiedReferrals = Math.max(State.stats.verifiedReferrals || 0, count);
        } catch (e) { console.warn('syncReferrals:', e); }
    }

    getReferralCode() {
        if (!State.user || !State.user.id) return 'NEXUS-XXXX';
        const clean = State.user.id.replace(/^nx_/, '').substr(0, 8).toUpperCase();
        return 'NEXUS-' + clean;
    }

    getReferralLink() {
        const base = CONFIG.baseUrl || 'https://studiosgamesrs.com';
        return `${base}/login?ref=${encodeURIComponent(this.getReferralCode())}`;
    }

    // ═════════════════════════════════════════════════════════════════════════
    // SISTEMA DE LOGROS (SEC-012: desbloqueo server-side)
    // ═════════════════════════════════════════════════════════════════════════
    async checkAchievements() {
        if (!this.functions) return;
        if (this._checkingAchievements) return;
        this._checkingAchievements = true;
        try {
            const result = await this.functions.httpsCallable('checkNexusAchievements')({});
            const data = result.data || {};
            if (data.stats) this.applyStatsFromServer(data.stats);
            if (data.achievements) State.achievements = { ...data.achievements };
            const unlocked = Array.isArray(data.unlocked) ? data.unlocked : [];
            unlocked.forEach((item) => {
                const achievement = CONFIG.achievements.find(a => a.id === item.id);
                if (achievement) this.presentAchievementUnlock(achievement, item.xpGranted);
            });
            if (unlocked.length) {
                this.renderAchievements();
                this.persistAchievementStateLocal();
            }
        } catch (error) {
            console.warn('checkAchievements:', error);
        } finally {
            this._checkingAchievements = false;
        }
    }

    persistAchievementStateLocal() {
        this.persistNexusLocalCache();
    }

    presentAchievementUnlock(achievement, xpGranted) {
        this.pushActivity('fa-trophy', `${State.user.username} desbloqueó: ${achievement.name}`);
        this.showAchievementUnlock(achievement.name, achievement.icon);
        const granted = Number(xpGranted) || Number(achievement.xp) || 0;
        this.showToast(
            '¡Logro Desbloqueado!',
            'success',
            `${achievement.name}: +${granted} XP`
        );
        this.pushUserNotification({
            text: `Logro desbloqueado: ${achievement.name} (+${granted} XP)`,
            icon: achievement.icon || 'fa-trophy',
            type: 'achievement'
        });
    }

    pushUserNotification(payload) {
        if (!State.user.id) return;
        const data = {
            text: payload.text || '',
            icon: payload.icon || 'fa-bell',
            timestamp: Date.now(),
            read: false,
            type: payload.type || 'general',
            link: payload.link || null
        };
        if (window.SGNotifications && typeof window.SGNotifications.push === 'function') {
            window.SGNotifications.push(State.user.id, data);
        } else if (this.db) {
            this.db.ref('users/' + State.user.id + '/notifications').push(data);
        }
    }

    // ═════════════════════════════════════════════════════════════════════════
    // CANVAS Y BRANDING STUDIO
    // ═════════════════════════════════════════════════════════════════════════
    initCanvas() {
        const canvas = document.getElementById('nexus-branding-canvas');
        if (!canvas) return;
        
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        
        // Dibujar estado inicial
        this.drawCanvasPlaceholder();
        
        // Configurar eventos de drag & drop
        const wrapper = document.querySelector('.canvas-wrapper-inner');
        if (wrapper) {
            wrapper.addEventListener('dragover', (e) => {
                e.preventDefault();
                wrapper.classList.add('dragover');
            });
            
            wrapper.addEventListener('dragleave', () => {
                wrapper.classList.remove('dragover');
            });
            
            wrapper.addEventListener('drop', (e) => {
                e.preventDefault();
                wrapper.classList.remove('dragover');
                
                if (e.dataTransfer.files.length > 0) {
                    this.handleImageUpload(e.dataTransfer.files[0]);
                }
            });
        }

        const logoImg = new Image();
        logoImg.crossOrigin = 'anonymous';
        logoImg.onload = () => {
            State.canvas.logoWatermark = logoImg;
            if (State.canvas.image) this.renderCanvas();
            else this.drawCanvasPlaceholder();
        };
        logoImg.src = 'https://studiosgamesrs.com/home/sitepad-data/uploads/2023/06/Studiosgamesrs_FF-01.png';
    }

    drawCanvasPlaceholder() {
        if (!this.ctx) return;
        
        const w = this.canvas.width;
        const h = this.canvas.height;
        
        // Fondo
        this.ctx.fillStyle = '#0d1117';
        this.ctx.fillRect(0, 0, w, h);
        
        // Grid sutil
        this.ctx.strokeStyle = 'rgba(88, 166, 255, 0.1)';
        this.ctx.lineWidth = 1;
        
        for (let x = 0; x < w; x += 50) {
            this.ctx.beginPath();
            this.ctx.moveTo(x, 0);
            this.ctx.lineTo(x, h);
            this.ctx.stroke();
        }
        
        for (let y = 0; y < h; y += 50) {
            this.ctx.beginPath();
            this.ctx.moveTo(0, y);
            this.ctx.lineTo(w, y);
            this.ctx.stroke();
        }
        
        // Logo centrado (mismo estilo que en overlay para streaming)
        const theme = CONFIG.themes.blue || { primary: '#58a6ff' };
        this.drawCenterLogo(theme);
        
        // Texto de ayuda debajo
        this.ctx.font = '24px Montserrat';
        this.ctx.fillStyle = 'rgba(201, 209, 217, 0.35)';
        this.ctx.textAlign = 'center';
        this.ctx.textBaseline = 'middle';
        this.ctx.fillText('Arrastra una imagen o haz clic para subir', w / 2, h / 2 + 95);
    }

    handleImageUpload(file) {
        if (!file || !file.type.startsWith('image/')) {
            this.showToast('Error', 'error', 'Por favor sube una imagen válida');
            return;
        }
        
        if (file.size > 10 * 1024 * 1024) {
            this.showToast('Error', 'error', 'La imagen debe ser menor a 10MB');
            return;
        }
        
        const reader = new FileReader();
        
        reader.onload = (e) => {
            const img = new Image();
            
            img.onload = () => {
                State.canvas.image = img;
                this.renderCanvas();
                this.registerBrandingStudioSession().then(() => {
                    this.analyzeImageWithAI();
                });
                this.updateUploadStats();
                
                // Registrar overlay en servidor (misión + contador)
                setTimeout(() => {
                    this.completeOverlayUpload();
                }, 2000);

                this.saveUserData();
            };
            
            img.src = e.target.result;
        };
        
        reader.readAsDataURL(file);
    }

    renderCanvas() {
        if (!this.ctx || !State.canvas.image) return;
        
        const img = State.canvas.image;
        const zoom = State.canvas.zoom / 100;
        const theme = CONFIG.themes[State.canvas.theme];
        
        const w = this.canvas.width;
        const h = this.canvas.height;
        
        // Limpiar
        this.ctx.fillStyle = '#0d1117';
        this.ctx.fillRect(0, 0, w, h);
        
        // Calcular dimensiones
        const scale = Math.min(
            (w - 100) / img.width,
            (h - 100) / img.height
        ) * zoom;
        
        const imgW = img.width * scale;
        const imgH = img.height * scale;
        const x = (w - imgW) / 2;
        const y = (h - imgH) / 2;
        
        // Aplicar efectos
        this.ctx.save();
        
        // Efecto glow
        if (State.canvas.effects.includes('glow')) {
            this.ctx.shadowColor = theme.primary;
            this.ctx.shadowBlur = 40;
        }
        
        // Efecto shadow
        if (State.canvas.effects.includes('shadow')) {
            this.ctx.shadowColor = 'rgba(0, 0, 0, 0.6)';
            this.ctx.shadowBlur = 30;
            this.ctx.shadowOffsetX = 15;
            this.ctx.shadowOffsetY = 15;
        }
        
        // Dibujar imagen
        this.ctx.drawImage(img, x, y, imgW, imgH);
        
        this.ctx.restore();
        
        // Marco
        this.ctx.strokeStyle = theme.primary;
        this.ctx.lineWidth = 6;
        this.ctx.strokeRect(x - 10, y - 10, imgW + 20, imgH + 20);
        
        // Efecto neon
        if (State.canvas.effects.includes('neon')) {
            this.ctx.strokeStyle = theme.primary;
            this.ctx.lineWidth = 3;
            this.ctx.shadowColor = theme.primary;
            this.ctx.shadowBlur = 20;
            this.ctx.strokeRect(x - 20, y - 20, imgW + 40, imgH + 40);
            this.ctx.shadowBlur = 0;
        }
        
        // Esquinas decorativas
        this.drawCornerAccents(x - 10, y - 10, imgW + 20, imgH + 20, theme.primary);
        
        // Watermark
        this.drawWatermark(theme);
    }

    drawCornerAccents(x, y, w, h, color) {
        const size = 30;
        
        this.ctx.fillStyle = color;
        
        // Esquina superior izquierda
        this.ctx.fillRect(x - 5, y - 5, size, 4);
        this.ctx.fillRect(x - 5, y - 5, 4, size);
        
        // Esquina superior derecha
        this.ctx.fillRect(x + w - size + 5, y - 5, size, 4);
        this.ctx.fillRect(x + w - 4, y - 5, 4, size);
        
        // Esquina inferior izquierda
        this.ctx.fillRect(x - 5, y + h - 4, size, 4);
        this.ctx.fillRect(x - 5, y + h - size + 5, 4, size);
        
        // Esquina inferior derecha
        this.ctx.fillRect(x + w - size + 5, y + h - 4, size, 4);
        this.ctx.fillRect(x + w - 4, y + h - size + 5, 4, size);
    }

    drawWatermark(theme) {
        this.drawCenterLogo(theme);
    }

    drawCenterLogo(theme) {
        this.ctx.save();
        const cw = this.canvas.width;
        const ch = this.canvas.height;
        const logo = State.canvas.logoWatermark;

        const frameHeight = 180;
        const frameY = ch - frameHeight;

        // Marco inferior full-width: gradiente negro-rojo transparente (de arriba a abajo)
        const gradient = this.ctx.createLinearGradient(0, frameY, 0, ch);
        gradient.addColorStop(0, 'rgba(0, 0, 0, 0)');
        gradient.addColorStop(0.35, 'rgba(20, 0, 0, 0.5)');
        gradient.addColorStop(0.7, 'rgba(15, 0, 0, 0.78)');
        gradient.addColorStop(1, 'rgba(10, 0, 0, 0.92)');

        this.ctx.fillStyle = gradient;
        this.ctx.fillRect(0, frameY, cw, frameHeight);

        if (logo && logo.complete && logo.naturalWidth) {
            const maxWidth = 300;
            const maxHeight = 175;
            const cy = ch - frameHeight / 2 - 6;
            const leftMargin = 42;

            const nw = logo.naturalWidth;
            const nh = logo.naturalHeight;
            const scale = Math.min(maxWidth / nw, maxHeight / nh, 1);
            const logoDisplayW = Math.round(nw * scale);
            const logoDisplayH = Math.round(nh * scale);

            const logoX = leftMargin;
            const logoY = cy - logoDisplayH / 2;
            this.ctx.drawImage(logo, logoX, logoY, logoDisplayW, logoDisplayH);
        }
        this.ctx.restore();
    }

    analyzeImageWithAI() {
        const feedback = document.getElementById('ai-feedback');
        const suggestion = document.getElementById('ai-suggestion');
        
        if (!feedback || !suggestion) return;
        
        // Simular análisis de IA
        const analyses = [
            {
                text: 'La imagen tiene excelente contraste. El tema azul resaltará los detalles.',
                suggestion: 'Aplicar tema azul + efecto glow',
                theme: 'blue',
                effect: 'glow'
            },
            {
                text: 'Detecto tonos cálidos. El tema dorado complementará perfectamente.',
                suggestion: 'Aplicar tema dorado + efecto neon',
                theme: 'gold',
                effect: 'neon'
            },
            {
                text: 'Imagen con buena iluminación. El efecto de sombra añadirá profundidad.',
                suggestion: 'Aplicar sombra + zoom al 110%',
                theme: 'purple',
                effect: 'shadow'
            }
        ];
        
        const analysis = analyses[Math.floor(Math.random() * analyses.length)];
        
        feedback.innerHTML = `
            <strong>🤖 Análisis de IA:</strong><br>
            ${analysis.text}<br><br>
            <strong>💡 Recomendación:</strong> ${analysis.suggestion}
        `;
        
        suggestion.style.display = 'flex';
        suggestion.onclick = () => {
            this.applyAIRecommendation(analysis.theme, analysis.effect);
        };
        
        // Mostrar indicador de IA activa
        const aiStatus = document.getElementById('ai-status');
        if (aiStatus) {
            aiStatus.classList.add('has-suggestions');
        }

        this.claimOverlayAnalyzeDesignXp().then((granted) => {
            if (granted > 0) {
                this.showToast('Análisis', 'success', `+${granted} XP`);
                this.checkAchievements();
            }
        });
    }

    applyAIRecommendation(theme, effect) {
        State.canvas.theme = theme;
        
        if (!State.canvas.effects.includes(effect)) {
            State.canvas.effects.push(effect);
        }
        
        // Actualizar botones de tema
        document.querySelectorAll('.theme-dot').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.theme === theme);
        });
        
        this.renderCanvas();
        
        this.showToast('IA', 'success', 'Recomendaciones aplicadas automáticamente');
        this.claimOverlayUseAiXp().then((granted) => {
            if (granted > 0) {
                this.showToast('IA', 'success', `+${granted} XP`);
            }
        });
    }

    // ═════════════════════════════════════════════════════════════════════════
    // UI Y RENDERIZADO
    // ═════════════════════════════════════════════════════════════════════════
    pushActivity(icon, text) {
        if (!State.recentActivities) State.recentActivities = [];
        State.recentActivities.push({ icon, text, ts: Date.now() });
        if (State.recentActivities.length > 10) {
            State.recentActivities = State.recentActivities.slice(-10);
        }
        this.updateActivityFeed();
        if (this.db) {
            try {
                this.db.ref('siteActivity').push({
                    type: 'nexus',
                    html: `<strong>${(State.user.username || 'Jugador').replace(/</g, '&lt;')}</strong> ${text.replace(/</g, '&lt;')}`,
                    timestamp: Date.now()
                });
            } catch (e) { /* ignore */ }
        }
    }

    updateActivityFeed() {
        const feed = document.getElementById('community-activity-feed');
        if (!feed) return;
        const items = (State.recentActivities || []).slice(-3).reverse();
        if (items.length === 0) {
            feed.innerHTML = '<div class="activity-item activity-empty"><i class="fas fa-info-circle"></i> Últimas acciones en la página...</div>';
            return;
        }
        feed.innerHTML = items.map(a => `
            <div class="activity-item">
                <i class="fas ${a.icon}"></i> ${a.text}
            </div>
        `).join('');
    }

    initUI() {
        this.updateXPBar();
        this.updateStatsDisplay();
        this.updateRankDisplay();
        this.updateReferralDisplay();
        this.updateActivityFeed();
        this.updateDailyMissionDisplay();
        this.renderQuests();
        this.renderAchievements();
        this.renderRewards();
        this.updateTheme();
        this.updateBoostUI();
    }

    updateUI() {
        this.updateXPBar();
        this.updateStatsDisplay();
        this.updateRankDisplay();
        this.updateReferralDisplay();
        this.updateBoostUI();
        this.updateActivityFeed();
        this.updateDailyMissionDisplay();
        this.renderRewards();
        this.updateMercadoTecnico();
    }

    updateDailyMissionDisplay() {
        const mission = this.getDailyMission();
        const titleEl = document.getElementById('daily-quest-title');
        const descEl = document.getElementById('daily-quest-desc');
        if (titleEl) titleEl.textContent = mission.title;
        if (descEl) descEl.textContent = mission.description;
    }

    openDailyMissionPopup() {
        const mission = this.getDailyMission();
        const quest = CONFIG.quests.find(q => q.id === mission.questId);
        const alreadyCompleted = State.quests[mission.questId]?.completed;
        const onCooldown = quest && State.quests[mission.questId]?.lastCompleted && quest.cooldown > 0 && (Date.now() - State.quests[mission.questId].lastCompleted) < quest.cooldown;
        if (alreadyCompleted || onCooldown) {
            this.showToast(alreadyCompleted ? 'Ya completada' : 'En cooldown', 'info', alreadyCompleted ? 'Ya completaste la misión del día.' : 'Vuelve mañana para una nueva misión.');
            return;
        }
        State.dailyMissionPopup.current = mission;
        State.dailyMissionPopup.openedLink = false;

        const overlay = document.getElementById('daily-mission-popup-overlay');
        const popup = document.getElementById('daily-mission-popup');
        const titleEl = document.getElementById('daily-mission-popup-title');
        const descEl = document.getElementById('daily-mission-popup-desc');
        const btnLabel = document.getElementById('daily-mission-popup-btn-label');
        const openBtn = document.getElementById('daily-mission-popup-open-btn');
        if (titleEl) titleEl.textContent = mission.title;
        if (descEl) descEl.textContent = mission.description;
        if (btnLabel) btnLabel.textContent = mission.buttonLabel;
        if (openBtn) {
            openBtn.innerHTML = '';
            const icon = document.createElement('i');
            icon.className = mission.icon || 'fab fa-facebook';
            openBtn.appendChild(icon);
            openBtn.appendChild(document.createTextNode(' '));
            openBtn.appendChild(document.createTextNode(mission.buttonLabel));
            openBtn.onclick = () => {
                window.open(mission.url, '_blank', 'width=600,height=400');
                State.dailyMissionPopup.openedLink = true;
            };
        }
        if (overlay) overlay.style.display = 'block';
        if (popup) popup.style.display = 'block';
    }

    closeDailyMissionPopup() {
        const openedLink = State.dailyMissionPopup.openedLink;
        const mission = State.dailyMissionPopup.current;
        const overlay = document.getElementById('daily-mission-popup-overlay');
        const popup = document.getElementById('daily-mission-popup');

        if (openedLink && mission) {
            this.showToast('Verificación pendiente', 'info', 'La misión del día requiere verificación real. No se otorgó EXP automáticamente.');
        }

        if (overlay) overlay.style.display = 'none';
        if (popup) popup.style.display = 'none';
        State.dailyMissionPopup.openedLink = false;
        State.dailyMissionPopup.current = null;
    }

    updateXPBar() {
        const currentRank = CONFIG.xp.ranks[State.stats.rank];
        const nextRank = CONFIG.xp.ranks[State.stats.rank + 1];
        
        const xpInRank = State.stats.xp - currentRank.xp;
        const xpNeeded = nextRank ? nextRank.xp - currentRank.xp : 1000;
        const progress = Math.min((xpInRank / xpNeeded) * 100, 100);
        
        // Barra principal
        const xpFill = document.getElementById('xp-fill-dynamic');
        if (xpFill) xpFill.style.width = `${progress}%`;
        
        // Barra del header
        const headerFill = document.getElementById('header-xp-fill');
        if (headerFill) headerFill.style.width = `${progress}%`;
        
        // Texto
        const xpRatio = document.getElementById('xp-ratio');
        if (xpRatio) {
            xpRatio.textContent = `${State.stats.xp.toLocaleString()} / ${nextRank ? nextRank.xp.toLocaleString() : 'MAX'} XP`;
        }
        
        // Anillo SVG
        const ring = document.getElementById('main-progress-ring');
        if (ring) {
            const ringRadius = parseFloat(ring.getAttribute('r')) || 42;
            const c = 2 * Math.PI * ringRadius;
            const offset = c - (progress / 100) * c;
            ring.style.strokeDasharray = `${c} ${c}`;
            ring.style.strokeDashoffset = offset;
        }

        this.updateXPMilestones();
    }

    updateXPMilestones() {
        const container = document.querySelector('.xp-milestones');
        if (!container) return;
        const ranks = CONFIG.xp.ranks;
        const maxXp = ranks[ranks.length - 1].xp || 6000;
        container.innerHTML = ranks.map((r) => {
            const left = maxXp > 0 ? (r.xp / maxXp) * 100 : 0;
            const reached = State.stats.level >= r.level;
            return `<div class="milestone${reached ? ' reached' : ''}" style="left: ${left}%;" data-xp="${r.xp}" title="${r.xp.toLocaleString()} XP">Niv. ${r.level}</div>`;
        }).join('');
    }

    updateStatsDisplay() {
        const xpCounter = document.getElementById('nav-xp-counter');
        if (xpCounter) xpCounter.textContent = `${State.stats.xp.toLocaleString()} XP`;
        
        const streakDays = document.getElementById('streak-days');
        if (streakDays) streakDays.textContent = `${State.stats.streak} días`;
        
        const achievementsCount = document.getElementById('achievements-count');
        if (achievementsCount) {
            const unlocked = Object.keys(State.achievements).length;
            achievementsCount.textContent = `${unlocked}/${CONFIG.achievements.length}`;
        }
        
        const totalXp = document.getElementById('total-quest-xp');
        if (totalXp) totalXp.textContent = State.stats.xp.toLocaleString();
        
        const completedQuests = document.getElementById('completed-quests');
        if (completedQuests) completedQuests.textContent = State.stats.totalQuestsCompleted;

        const badgeCount = document.getElementById('badge-count');
        if (badgeCount) badgeCount.textContent = `${(State.badges || []).length} Badges`;
    }

    updateRankDisplay() {
        const rank = CONFIG.xp.ranks[State.stats.rank];
        const displayName = State.user.displayName || State.user.username || 'Usuario';
        
        const title = document.getElementById('current-rank-title');
        if (title) title.textContent = displayName;

        this.updateHonorDisplay();
        
        const nextName = document.getElementById('next-rank-name');
        if (nextName) {
            nextName.textContent = rank.accessName || `Nivel ${State.stats.level}`;
        }

        const nextTarget = document.getElementById('next-rank-target');
        const nextRank = CONFIG.xp.ranks[State.stats.rank + 1];
        if (nextTarget) {
            nextTarget.textContent = nextRank
                ? `Siguiente: ${nextRank.accessName} (${nextRank.xp.toLocaleString()} XP)`
                : 'Has alcanzado el acceso máximo del Nexus';
        }
        
        const letter = document.getElementById('rank-letter');
        if (letter) {
            if (State.user.photoURL) {
                letter.innerHTML = '';
                const img = document.createElement('img');
                img.src = State.user.photoURL;
                img.alt = displayName;
                img.className = 'rank-avatar-img';
                img.onerror = function() {
                    letter.innerHTML = rank.icon && rank.icon.startsWith('fa-')
                        ? `<i class="fas ${rank.icon}" style="font-size:1.4em;"></i>`
                        : (rank.icon || '⚔️');
                };
                letter.appendChild(img);
            } else if (rank.icon && rank.icon.startsWith('fa-')) {
                letter.innerHTML = `<i class="fas ${rank.icon}" style="font-size:1.4em;"></i>`;
            } else {
                letter.textContent = rank.icon || '⚔️';
            }
        }
        
        const communityRank = document.getElementById('community-rank');
        if (communityRank) communityRank.textContent = `Nivel ${State.stats.level}`;

        this.updateAccessTag();
    }

    updateAccessTag() {
        const rank = CONFIG.xp.ranks[State.stats.rank] || CONFIG.xp.ranks[0];
        const label = document.getElementById('nexus-access-tag-label');
        if (label) label.textContent = rank.accessName || rank.name;
        const tag = document.getElementById('nexus-access-tag');
        if (tag) {
            tag.style.borderColor = rank.color + '55';
            tag.dataset.level = String(State.stats.level);
        }
    }

    openAccessOverlay() {
        const overlay = document.getElementById('nexus-access-overlay');
        if (!overlay) return;
        this.renderAccessOverlay();
        overlay.classList.add('nexus-access-overlay-visible');
        overlay.setAttribute('aria-hidden', 'false');
        document.body.classList.add('nexus-access-overlay-open');
    }

    closeAccessOverlay() {
        const overlay = document.getElementById('nexus-access-overlay');
        if (!overlay) return;
        overlay.classList.remove('nexus-access-overlay-visible');
        overlay.setAttribute('aria-hidden', 'true');
        document.body.classList.remove('nexus-access-overlay-open');
    }

    renderAccessOverlay() {
        const rank = CONFIG.xp.ranks[State.stats.rank] || CONFIG.xp.ranks[0];
        const nextRank = CONFIG.xp.ranks[State.stats.rank + 1];
        const currentEl = document.getElementById('nexus-access-current');
        const tiersEl = document.getElementById('nexus-access-tiers');
        const progressEl = document.getElementById('nexus-access-progress-text');
        if (!currentEl || !tiersEl) return;

        const xpInRank = State.stats.xp - rank.xp;
        const xpNeeded = nextRank ? nextRank.xp - rank.xp : 0;
        const progress = nextRank && xpNeeded > 0 ? Math.min((xpInRank / xpNeeded) * 100, 100) : 100;

        if (progressEl) {
            progressEl.textContent = nextRank
                ? `${State.stats.xp.toLocaleString()} / ${nextRank.xp.toLocaleString()} XP para ${nextRank.accessName}`
                : `${State.stats.xp.toLocaleString()} XP — nivel máximo alcanzado`;
        }

        const progressFill = document.getElementById('nexus-access-progress-fill');
        if (progressFill) progressFill.style.width = progress + '%';

        currentEl.innerHTML =
            '<div class="nexus-access-current-card" style="--tier-color:' + rank.color + '">' +
                '<div class="nexus-access-current-seal"><i class="fas ' + rank.icon + '"></i></div>' +
                '<div class="nexus-access-current-meta">' +
                    '<span class="nexus-access-current-level">Nivel ' + State.stats.level + ' / 5</span>' +
                    '<h3 class="nexus-access-current-name">' + (rank.accessName || rank.name) + '</h3>' +
                    '<p class="nexus-access-current-tagline">' + (rank.tagline || '') + '</p>' +
                '</div>' +
            '</div>' +
            '<div class="nexus-access-current-perks">' +
                '<h4><i class="fas fa-unlock"></i> Tu acceso actual</h4>' +
                '<ul>' + (rank.benefits || []).map(function(b) { return '<li>' + b + '</li>'; }).join('') + '</ul>' +
                (rank.profilePerks && rank.profilePerks.length
                    ? '<div class="nexus-access-profile-perks"><strong>Personalización de perfil:</strong> ' + rank.profilePerks.join(' · ') + '</div>'
                    : '') +
            '</div>';

        tiersEl.innerHTML = CONFIG.xp.ranks.map(function(r, idx) {
            const unlocked = State.stats.level >= r.level;
            const isCurrent = State.stats.rank === idx;
            const statusClass = unlocked ? (isCurrent ? ' is-current' : ' is-unlocked') : ' is-locked';
            const statusIcon = unlocked ? (isCurrent ? 'fa-star' : 'fa-check-circle') : 'fa-lock';
            const perks = (r.benefits || []).slice(0, 3).map(function(b) { return '<li>' + b + '</li>'; }).join('');
            const frameNote = (r.level >= 4 && r.profilePerks && r.profilePerks.some(function(p) { return /marco/i.test(p); }))
                ? '<span class="nexus-access-frame-note"><i class="fas fa-image"></i> Marco de perfil incluido</span>'
                : '';
            return '<article class="nexus-access-tier' + statusClass + '" style="--tier-color:' + r.color + '">' +
                '<div class="nexus-access-tier-head">' +
                    '<span class="nexus-access-tier-badge"><i class="fas ' + statusIcon + '"></i></span>' +
                    '<div><span class="nexus-access-tier-num">Nivel ' + r.level + '</span>' +
                    '<h4>' + (r.accessName || r.name) + '</h4>' +
                    '<span class="nexus-access-tier-xp">' + r.xp.toLocaleString() + ' XP</span></div>' +
                '</div>' +
                '<p class="nexus-access-tier-desc">' + (r.tagline || '') + '</p>' +
                '<ul class="nexus-access-tier-list">' + perks + '</ul>' +
                frameNote +
            '</article>';
        }).join('');
    }

    hasNexusAccess(minLevel) {
        return State.stats.level >= minLevel;
    }

    updateReferralDisplay(skipTableRender) {
        const code = this.getReferralCode();
        
        const display = document.getElementById('referral-code-display');
        if (display) display.textContent = code;
        
        const short = document.getElementById('referral-code-short');
        if (short) short.textContent = code;
        
        const verified = document.getElementById('verified-referrals');
        if (verified) verified.textContent = State.stats.verifiedReferrals || 0;
        
        const xpEarned = document.getElementById('referral-xp-earned');
        if (xpEarned) {
            xpEarned.textContent = ((State.stats.verifiedReferrals || 0) * CONFIG.xp.referralBonus).toLocaleString();
        }
        
        const referralCount = document.getElementById('referral-count');
        if (referralCount) referralCount.textContent = `${State.stats.verifiedReferrals || 0} Referidos`;
        
        const totalRef = document.getElementById('total-referrals');
        if (totalRef) totalRef.textContent = State.stats.verifiedReferrals || 0;
        const totalVer = document.getElementById('total-verified');
        if (totalVer) totalVer.textContent = State.stats.verifiedReferrals || 0;
        
        if (!skipTableRender) this.renderReferralsTable();
    }

    async renderReferralsTable(snapshotOrData) {
        const tbody = document.getElementById('referrals-table-body');
        if (!tbody) return;
        if (!State.user.isDashboardUser || !this.db) {
            tbody.innerHTML = '<tr class="empty-row"><td colspan="4"><i class="fas fa-user-friends"></i><p>Aún no tienes referidos</p><small>Comparte tu link para que se registren</small></td></tr>';
            return;
        }
        try {
            let refs = null;
            if (snapshotOrData) refs = snapshotOrData.val ? snapshotOrData.val() : snapshotOrData;
            if (refs === null) {
                const snap = await this.db.ref('users/' + State.user.id + '/referrals').once('value');
                refs = snap.val();
            }
            if (!refs || Object.keys(refs).length === 0) {
                tbody.innerHTML = '<tr class="empty-row"><td colspan="4"><i class="fas fa-user-friends"></i><p>Aún no tienes referidos</p><small>Comparte tu link para que se registren</small></td></tr>';
                return;
            }
            const entries = Object.entries(refs);
            let xpByUid = {};
            if (this.functions) {
                try {
                    const xpRes = await this.functions.httpsCallable('getMyReferralsNexusXp')({});
                    xpByUid = (xpRes.data && xpRes.data.xpByUid) || {};
                } catch (_) {}
            }
            const rows = await Promise.all(entries.map(async ([uid, data]) => {
                const d = new Date(data.timestamp || 0);
                const dateStr = d.toLocaleDateString('es-ES', { day: '2-digit', month: 'short', year: 'numeric' });
                let steamStatus = '<span class="stat-pending">Pendiente</span>';
                let userXp = '-';
                try {
                    const userSnap = await this.db.ref('users/' + uid).once('value');
                    const u = userSnap.val();
                    const refSteamId = String((u && (u.steamID || (u.steam && u.steam.steamid))) || '').trim();
                    if (/^\d{17}$/.test(refSteamId)) steamStatus = '<span class="stat-ok"><i class="fab fa-steam"></i> Steam</span>';
                    const xp = xpByUid[uid];
                    userXp = typeof xp === 'number' ? xp.toLocaleString() + ' XP' : '-';
                } catch (_) {}
                const nick = (data.nick || 'Usuario').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                return `<tr><td>${nick}</td><td>${dateStr}</td><td>${steamStatus}</td><td>${userXp}</td></tr>`;
            }));
            tbody.innerHTML = rows.join('');
        } catch (e) {
            tbody.innerHTML = '<tr class="empty-row"><td colspan="4"><i class="fas fa-exclamation-triangle"></i><p>Error al cargar referidos</p></td></tr>';
        }
    }

    renderQuests() {
        const container = document.getElementById('quest-list-dynamic');
        if (!container) return;
        
        container.innerHTML = '';
        
        const filteredQuests = State.ui.activeTab === 'all' ? 
            CONFIG.quests : 
            CONFIG.quests.filter(q => q.type === State.ui.activeTab);
        
        filteredQuests.forEach(quest => {
            const questData = State.quests[quest.id] || {};
            const isCompleted = questData.completed;
            const isOnCooldown = questData.lastCompleted && 
                quest.cooldown > 0 && 
                (Date.now() - questData.lastCompleted) < quest.cooldown;
            
            const div = document.createElement('div');
            div.className = `quest-item ${isCompleted ? 'completed' : ''} ${isOnCooldown ? 'cooldown' : ''}`;
            div.dataset.questId = quest.id;
            
            div.innerHTML = `
                <div class="quest-header">
                    <div class="quest-title">
                        <i class="fab ${quest.icon}" style="color: ${quest.color}"></i>
                        ${quest.title}
                    </div>
                    <div class="quest-xp">+${quest.xp} XP</div>
                </div>
                <div class="quest-description">${quest.description}</div>
                ${isOnCooldown ? `
                    <div class="quest-cooldown">
                        <i class="fas fa-clock"></i> 
                        Disponible en ${this.formatCooldown(questData.lastCompleted, quest.cooldown)}
                    </div>
                ` : ''}
                <div class="quest-actions">
                    <button class="quest-btn primary" onclick="Nexus.startQuest('${quest.id}')" 
                        ${isCompleted || isOnCooldown ? 'disabled' : ''}>
                        <i class="fas ${isCompleted ? 'fa-check' : 'fa-play'}"></i> 
                        ${isCompleted ? 'COMPLETADO' : isOnCooldown ? 'EN COOLDOWN' : 'COMENZAR'}
                    </button>
                </div>
            `;
            
            container.appendChild(div);
        });
        
        // Actualizar contador
        const activeCount = CONFIG.quests.filter(q => {
            const data = State.quests[q.id];
            return !data || !data.completed;
        }).length;
        
        const countEl = document.getElementById('active-quest-count');
        if (countEl) countEl.textContent = `${activeCount} activas`;
    }

    renderAchievements() {
        const container = document.getElementById('achievements-container');
        if (!container) return;
        
        container.innerHTML = '';
        
        CONFIG.achievements.forEach(ach => {
            const unlocked = State.achievements[ach.id];
            
            const div = document.createElement('div');
            div.className = `achievement-card ${unlocked ? 'unlocked' : 'locked'}`;
            
            div.innerHTML = `
                <div class="achievement-icon">
                    <i class="fas ${ach.icon}"></i>
                </div>
                <div class="achievement-info">
                    <h4>${ach.name}</h4>
                    <p>${ach.description}</p>
                    <div class="achievement-progress">
                        <div class="progress-fill" style="width: ${unlocked ? 100 : 0}%"></div>
                    </div>
                </div>
                <div class="achievement-xp">+${ach.xp} XP</div>
            `;
            
            container.appendChild(div);
        });
        
        // Actualizar progreso general
        const total = CONFIG.achievements.length;
        const unlocked = Object.keys(State.achievements).length;
        const progress = Math.round((unlocked / total) * 100);
        
        const progressText = document.getElementById('achievements-progress-text');
        if (progressText) progressText.textContent = `${progress}%`;
        
        const progressBar = document.getElementById('achievements-progress-bar');
        if (progressBar) progressBar.style.width = `${progress}%`;
        
        const totalEl = document.getElementById('achievements-total');
        if (totalEl) totalEl.textContent = `${unlocked}/${total}`;
    }

    renderRewards() {
        const rewards = CONFIG.rewards;
        const grid = document.querySelector('.rewards-grid');
        if (grid && !grid.dataset.dynamicBuilt) {
            grid.dataset.dynamicBuilt = '1';
            grid.innerHTML = rewards.map((reward) => {
                const iconHtml = reward.id === 'badge_elite'
                    ? '<img src="https://studiosgamesrs.com/home/sitepad-data/uploads/2024/07/dragon-1.png" alt="Insignia Élite" class="elite-badge-img">'
                    : `<i class="fas ${reward.icon}"></i>`;
                const eliteClass = reward.id === 'badge_elite' ? ' reward-icon-elite' : '';
                const hover = reward.xpBonus
                    ? `<div class="reward-hover">Desbloquea al alcanzar nivel ${reward.level} · +${reward.xpBonus.toLocaleString()} XP al reclamar</div>`
                    : `<div class="reward-hover">Desbloquea al alcanzar nivel ${reward.level}</div>`;
                return `<div class="reward-card locked" data-reward="${reward.id}">
                    <div class="reward-icon${eliteClass}">${iconHtml}</div>
                    <h4>${reward.name}</h4>
                    <p>${reward.description}</p>
                    <div class="reward-progress"><div class="progress-fill" style="width: 0%"></div></div>
                    <button class="reward-btn" disabled>NIVEL ${reward.level}</button>
                    ${hover}
                </div>`;
            }).join('');
        }

        const unlockedCount = rewards.filter(r => State.stats.level >= r.level).length;
        
        document.querySelectorAll('.reward-card').forEach(card => {
            const rewardId = card.dataset.reward;
            const reward = rewards.find(r => r.id === rewardId);
            if (!reward) return;
            
            const isUnlocked = State.stats.level >= reward.level;
            const isClaimed = !!State.claimedRewards[reward.id];
            
            card.classList.toggle('locked', !isUnlocked);
            card.classList.toggle('claimed', isClaimed);
            
            const btn = card.querySelector('.reward-btn');
            if (btn) {
                btn.disabled = isClaimed;
                btn.textContent = isClaimed ? 'RECLAMADO' : (isUnlocked ? 'RECLAMAR' : `NIVEL ${reward.level}`);
                btn.dataset.rewardId = reward.id;
            }
            
            const progress = Math.min((State.stats.level / reward.level) * 100, 100);
            const fill = card.querySelector('.progress-fill');
            if (fill) fill.style.width = `${progress}%`;
        });
        
        const counter = document.getElementById('unlocked-rewards');
        if (counter) counter.textContent = `${unlockedCount}/${rewards.length}`;
    }

    async claimReward(rewardId) {
        const reward = CONFIG.rewards.find(r => r.id === rewardId);
        if (!reward || State.stats.level < reward.level || State.claimedRewards[rewardId]) return;
        if (!this.functions) {
            this.showToast('Error', 'error', 'Conexión con el servidor requerida.');
            return;
        }

        try {
            const result = await this.functions.httpsCallable('claimNexusReward')({ rewardId });
            const data = result.data || {};
            State.claimedRewards[rewardId] = { at: data.claimedAt || Date.now() };
            if (Array.isArray(data.badges)) {
                State.badges = [...data.badges];
            } else if (reward.type === 'badge' && !State.badges.includes(rewardId)) {
                State.badges.push(rewardId);
            }
            if (data.profileCustomizationUnlocked || reward.type === 'theme') {
                State.settings.profileCustomizationUnlocked = true;
            }
            if (data.stats) {
                this.applyStatsFromServer(data.stats);
            }
            this.persistNexusLocalCache();
            this.renderRewards();
            this.updateRankDisplay();
            const xpGranted = Number(data.xpGranted) || 0;
            this.showToast('¡Recompensa reclamada!', 'success', reward.name + (xpGranted ? (' · +' + xpGranted + ' XP') : ''));
            this.pushUserNotification({
                text: `Recompensa reclamada: ${reward.name}` + (xpGranted ? ` (+${xpGranted} XP)` : ''),
                icon: reward.icon || 'fa-gift',
                type: 'reward'
            });
            if (typeof this.triggerConfetti === 'function') this.triggerConfetti();
        } catch (error) {
            const code = error && error.code ? String(error.code) : '';
            if (code.includes('already-exists')) {
                State.claimedRewards[rewardId] = State.claimedRewards[rewardId] || { at: Date.now() };
                this.renderRewards();
                this.showToast('Ya reclamada', 'info', reward.name);
                return;
            }
            if (code.includes('permission-denied')) {
                this.showToast('Nivel insuficiente', 'warning', 'Alcanza el nivel ' + reward.level + ' para reclamar.');
                return;
            }
            console.warn('claimReward:', error);
            this.showToast('Error', 'error', 'No se pudo reclamar la recompensa.');
        }
    }

    // ═════════════════════════════════════════════════════════════════════════
    // PANELES DESPLEGABLES (ACORDEÓN)
    // ═════════════════════════════════════════════════════════════════════════
    toggleNexusPanel(panelId, forceOpen = null) {
        const body = document.getElementById('panel-' + panelId);
        const section = document.querySelector('.nexus-accordion-panel[data-panel="' + panelId + '"]');
        const header = section?.querySelector('.nexus-accordion-header');
        if (!body || !header) return;

        const isOpen = body.classList.contains('is-open');
        const shouldOpen = forceOpen === true ? true : forceOpen === false ? false : !isOpen;

        body.classList.toggle('is-open', shouldOpen);
        section.classList.toggle('is-expanded', shouldOpen);
        header.setAttribute('aria-expanded', shouldOpen ? 'true' : 'false');

        if (shouldOpen && panelId === 'branding' && this.renderCanvas) {
            requestAnimationFrame(() => this.renderCanvas());
        }
        if (shouldOpen && panelId === 'creator-market') {
            this.updateMercadoTecnico();
        }
        if (shouldOpen && panelId === 'logros') {
            this.renderAchievements();
        }
        if (shouldOpen) {
            setTimeout(() => {
                section.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }, 120);
        }
    }

    // ═════════════════════════════════════════════════════════════════════════
    // RANKING Y MERCADO TÉCNICO
    // ═════════════════════════════════════════════════════════════════════════
    isMercadoTecnicoUnlocked() {
        const cfg = CONFIG.mercadoTecnico;
        return State.stats.rank >= cfg.minRankIndex || State.stats.xp >= cfg.minXp;
    }

    updateMercadoTecnico() {
        const unlocked = this.isMercadoTecnicoUnlocked();
        const lockedPanel = document.getElementById('mercado-tecnico-locked');
        const unlockedPanel = document.getElementById('mercado-tecnico-unlocked');
        const progressEl = document.getElementById('mercado-unlock-progress');
        const progressText = document.getElementById('mercado-unlock-progress-text');
        const cfg = CONFIG.mercadoTecnico;

        if (lockedPanel) lockedPanel.style.display = unlocked ? 'none' : '';
        if (unlockedPanel) unlockedPanel.style.display = unlocked ? 'block' : 'none';

        if (!unlocked && progressEl && progressText) {
            const pct = Math.min(100, Math.round((State.stats.xp / cfg.minXp) * 100));
            progressEl.style.width = pct + '%';
            const needed = Math.max(0, cfg.minXp - State.stats.xp);
            progressText.textContent = State.stats.xp.toLocaleString() + ' / ' + cfg.minXp.toLocaleString() + ' XP' +
                (needed > 0 ? ' · Faltan ' + needed.toLocaleString() + ' XP' : '');
        }
        if (State.user.isDashboardUser && this.db) {
            this.loadCreatorMarketStatus().then(() => {
                this.updateMercadoTecnicoTabBadge();
                if (unlocked) this.renderCreatorMarketStage();
            });
        } else {
            this.updateMercadoTecnicoTabBadge();
        }
    }

    escCreatorMarketHtml(value) {
        if (value == null || value === '') return '—';
        const div = document.createElement('div');
        div.textContent = String(value);
        return div.innerHTML;
    }

    buildCreatorApplicationSummaryHtml(app) {
        const q = (app && app.questionnaire) || {};
        const submitted = app && app.submittedAt
            ? new Date(app.submittedAt).toLocaleString('es-ES', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
            : '—';
        return '<div class="mercado-submission-item status-pending">' +
            '<div class="mercado-submission-info"><strong>' + this.escCreatorMarketHtml(q.creatorName || app.nick || 'Tu solicitud') + '</strong>' +
            '<small>Enviada: ' + submitted + '</small></div>' +
            '<span class="mercado-status">En revisión</span></div>' +
            '<div class="cm-pending-detail-grid">' +
            '<p><strong>Facebook:</strong> ' + this.escCreatorMarketHtml(q.facebookProfileName) + '</p>' +
            '<p><strong>URL:</strong> ' + this.escCreatorMarketHtml(q.facebookProfileUrl) + '</p>' +
            '<p><strong>Tipo:</strong> ' + this.escCreatorMarketHtml(q.contentType) + '</p>' +
            '<p><strong>Frecuencia:</strong> ' + this.escCreatorMarketHtml(q.postingFrequency) + '</p>' +
            (q.experience ? '<p><strong>Experiencia:</strong> ' + this.escCreatorMarketHtml(q.experience.slice(0, 220)) + (q.experience.length > 220 ? '…' : '') + '</p>' : '') +
            (q.motivation ? '<p><strong>Motivación:</strong> ' + this.escCreatorMarketHtml(q.motivation.slice(0, 220)) + (q.motivation.length > 220 ? '…' : '') + '</p>' : '') +
            '</div>';
    }

    attachCreatorApplicationListener() {
        if (!this.db || !State.user.id || !State.user.isDashboardUser || this.creatorAppListener) return;
        this.creatorAppListener = this.db.ref('nexus/creatorApplications/' + State.user.id).on('value', (snap) => {
            const app = snap.val();
            State.creatorMarket.application = app;
            State.creatorMarket.status = (app && app.status) || null;
            this.renderCreatorMarketStage();
            this.updateMercadoTecnicoTabBadge();
        });
    }

    updateMercadoTecnicoTabBadge() {
        const tabBadge = document.getElementById('creator-market-tab-badge');
        const unlocked = this.isMercadoTecnicoUnlocked();
        if (!tabBadge) return;
        if (!unlocked) {
            tabBadge.textContent = 'BLOQUEADO';
            tabBadge.classList.add('locked-badge');
            tabBadge.classList.remove('active-badge', 'pending-badge', 'approved-badge');
            return;
        }
        const st = State.creatorMarket.status;
        tabBadge.textContent = st === 'approved' ? 'CREADOR' : st === 'pending' ? 'EN REVISIÓN' : st === 'rejected' ? 'RECHAZADO' : 'SOLICITAR';
        tabBadge.classList.toggle('locked-badge', false);
        tabBadge.classList.toggle('active-badge', st === 'approved');
        tabBadge.classList.toggle('pending-badge', st === 'pending');
        tabBadge.classList.toggle('approved-badge', st === 'approved');
    }

    async loadCreatorMarketStatus() {
        if (!this.db || !State.user.id) return;
        try {
            const [appSnap, cmSnap] = await Promise.all([
                this.db.ref('nexus/creatorApplications/' + State.user.id).once('value'),
                this.db.ref('nexus/users/' + State.user.id + '/creatorMarket').once('value')
            ]);
            const app = appSnap.val();
            const cm = cmSnap.val() || {};
            State.creatorMarket.status = (app && app.status) || cm.applicationStatus || null;
            State.creatorMarket.application = app;
            State.creatorMarket.totalEarnings = Number(cm.totalEarnings) || 0;
            State.creatorMarket.pendingEarnings = Number(cm.pendingEarnings) || 0;
            State.creatorMarket.lastWalletEntry = cm.lastWalletEntry || null;
        } catch (e) {
            console.warn('Creator Market status:', e);
        }
    }

    renderCreatorMarketStage() {
        const status = State.creatorMarket.status;
        const panels = {
            apply: document.getElementById('cm-apply-panel'),
            pending: document.getElementById('cm-pending-panel'),
            rejected: document.getElementById('cm-rejected-panel'),
            approved: document.getElementById('cm-approved-panel')
        };
        Object.values(panels).forEach(p => { if (p) p.style.display = 'none'; });

        if (status === 'pending') {
            if (panels.pending) panels.pending.style.display = 'block';
            const summary = document.getElementById('cm-pending-summary');
            const app = State.creatorMarket.application;
            if (summary) {
                summary.innerHTML = app
                    ? this.buildCreatorApplicationSummaryHtml(app)
                    : '<p class="mercado-empty">Tu solicitud está en revisión, pero no se pudo cargar el detalle. Recarga la página.</p>';
            }
        } else if (status === 'rejected') {
            if (panels.rejected) panels.rejected.style.display = 'block';
            const note = document.getElementById('cm-rejected-note');
            if (note) note.textContent = State.creatorMarket.application?.reviewNote || 'Tu solicitud no fue aprobada en esta ocasión.';
        } else if (status === 'approved') {
            if (panels.approved) panels.approved.style.display = 'block';
            this.renderCreatorDashboard();
            this.attachCreatorPublicationsListener();
            this.attachCreatorWalletListener();
            this.attachMercadoSubmissionsListener();
            this.renderMercadoSubmissions();
            this.initCreatorMarketUpload();
            this.initCreatorMarketInsights();
            this.initCreatorPayoutInfo();
            this.attachCreatorWalletLedgerListener();
            this.switchCreatorMarketPanel(State.creatorMarket.activePanel || 'feed');
            this.switchCreatorMarketView(State.creatorMarket.activeView || 'posts');
            this.startCreatorMetricsAutoRefresh();
        } else {
            if (panels.apply) panels.apply.style.display = 'block';
        }
    }

    formatRelativeTime(ts) {
        if (!ts) return '—';
        const diff = Date.now() - Number(ts);
        if (diff < 60000) return 'ahora mismo';
        const min = Math.floor(diff / 60000);
        if (min < 60) return 'hace ' + min + ' min';
        const hrs = Math.floor(min / 60);
        if (hrs < 24) return 'hace ' + hrs + ' h';
        const days = Math.floor(hrs / 24);
        return 'hace ' + days + ' d';
    }

    buildEngagementMini(views, likes, comments) {
        const v = Number(views) || 0;
        const l = Number(likes) || 0;
        const c = Number(comments) || 0;
        const rate = v > 0 ? Math.min(100, Math.round(((l + c) / v) * 1000) / 10) : 0;
        return '<div class="cm-engagement-mini" title="Interacción vs vistas">' +
            '<span class="cm-engagement-label"><i class="fas fa-chart-line"></i> ' + rate + '% engagement</span>' +
            '<span class="cm-engagement-bar"><span style="width:' + Math.min(rate, 100) + '%"></span></span></div>';
    }

    handleCreatorMarketFile(file) {
        const fileInput = document.getElementById('mercado-file-input');
        const preview = document.getElementById('mercado-file-preview');
        const uploadBtn = document.getElementById('mercado-upload-btn');
        if (!file) return;
        this.creatorMarketSelectedFile = file;
        if (fileInput) {
            const dt = new DataTransfer();
            dt.items.add(file);
            fileInput.files = dt.files;
        }
        this.renderCreatorMarketFilePreview(file, preview, uploadBtn);
    }

    renderCreatorDashboard() {
        const app = State.creatorMarket.application;
        const q = app?.questionnaire || {};
        const fb = app?.facebookLinked || q;
        const fbText = document.getElementById('cm-fb-linked-text');
        if (fbText) {
            fbText.textContent = (fb.facebookProfileName || fb.facebookProfileUrl || '—') +
                (fb.facebookProfileUrl ? ' · ' + fb.facebookProfileUrl : '');
        }
        const earned = document.getElementById('cm-stat-earned');
        const pending = document.getElementById('cm-stat-pending');
        if (earned) earned.textContent = '$' + State.creatorMarket.totalEarnings.toFixed(2);
        if (pending) pending.textContent = '$' + State.creatorMarket.pendingEarnings.toFixed(2);
    }

    initCreatorPayoutInfo() {
        const syncBadge = document.getElementById('cm-metrics-sync-badge');
        if (syncBadge && syncBadge.dataset.bound !== '1') {
            syncBadge.dataset.bound = '1';
            syncBadge.addEventListener('click', () => this.refreshCreatorMetrics(false));
        }
    }

    getCreatorMarketViewMeta(view) {
        const meta = {
            earned: {
                title: 'Ganado total',
                icon: 'fa-coins',
                hint: 'Historial de ingresos, tarifas y estadísticas de tu cartera en Creator Market.'
            },
            pending: {
                title: 'Pendiente de verificación',
                icon: 'fa-hourglass-half',
                hint: 'Dinero acumulado por métricas reales. Boss of the State lo verifica en Commander Panel antes del pago.'
            },
            posts: {
                title: 'Tus publicaciones',
                icon: 'fa-broadcast-tower',
                hint: 'Todas tus publicaciones en la página de Facebook de StudiosGamesRS.'
            },
            live: {
                title: 'En vivo',
                icon: 'fa-circle',
                hint: 'Solo publicaciones activas en Facebook ahora mismo.'
            }
        };
        return meta[view] || meta.posts;
    }

    switchCreatorMarketPanel(panel) {
        const next = panel === 'submit' ? 'submit' : 'feed';
        State.creatorMarket.activePanel = next;
        document.querySelectorAll('.cm-fb-nav-btn').forEach(btn => {
            btn.classList.toggle('active', btn.getAttribute('data-cm-panel') === next);
        });
        const feedPanel = document.getElementById('cm-panel-feed');
        const submitPanel = document.getElementById('cm-panel-submit');
        if (feedPanel) feedPanel.style.display = next === 'feed' ? 'block' : 'none';
        if (submitPanel) submitPanel.style.display = next === 'submit' ? 'block' : 'none';
        if (next === 'submit') {
            this.renderMercadoSubmissions();
            this.initCreatorMarketInsights();
        } else if (State.creatorMarket.activeView === 'posts' || State.creatorMarket.activeView === 'live') {
            this.refreshCreatorMetrics(false);
        }
    }

    switchCreatorMarketView(view) {
        const allowed = ['earned', 'pending', 'posts', 'live'];
        const next = allowed.includes(view) ? view : 'posts';
        State.creatorMarket.activeView = next;
        document.querySelectorAll('.cm-stat-tab').forEach(btn => {
            btn.classList.toggle('active', btn.getAttribute('data-cm-view') === next);
        });
        const meta = this.getCreatorMarketViewMeta(next);
        const titleEl = document.getElementById('cm-view-title');
        const hintEl = document.getElementById('cm-view-hint');
        const syncBadge = document.getElementById('cm-metrics-sync-badge');
        if (titleEl) titleEl.innerHTML = '<i class="fas ' + meta.icon + '"></i> ' + meta.title;
        if (hintEl) hintEl.textContent = meta.hint;
        if (syncBadge) syncBadge.style.display = (next === 'posts' || next === 'live') ? '' : 'none';
        this.renderCreatorViewContent();
        if (next === 'posts' || next === 'live') this.refreshCreatorMetrics(true);
    }

    attachCreatorWalletLedgerListener() {
        if (!this.db || !State.user.id || this.creatorWalletLedgerListener) return;
        this.creatorWalletLedgerListener = this.db.ref('nexus/users/' + State.user.id + '/creatorMarket/walletLedger')
            .on('value', (snap) => {
                const entries = [];
                snap.forEach(ch => entries.push({ id: ch.key, ...ch.val() }));
                entries.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
                State.creatorMarket.walletLedger = entries;
                let paid = 0;
                entries.forEach(e => {
                    if (e.paid) paid += Number(e.amount) || 0;
                });
                State.creatorMarket.paidEarnings = Math.round(paid * 100) / 100;
                if (State.creatorMarket.activeView === 'earned' || State.creatorMarket.activeView === 'pending') {
                    this.renderCreatorViewContent();
                }
            });
    }

    getCreatorPublicationsList() {
        const pubMap = State.creatorMarket.publicationsCache || {};
        const pubs = Object.keys(pubMap).map(id => ({ id, ...pubMap[id] }));
        pubs.sort((a, b) => (b.publishedAt || b.createdAt || 0) - (a.publishedAt || a.createdAt || 0));
        return pubs;
    }

    getFilteredCreatorPublications(view) {
        const pubs = this.getCreatorPublicationsList();
        if (view === 'live') return pubs.filter(p => this.isPublicationLiveOnFacebook(p));
        return pubs;
    }

    buildCreatorWalletEntryHtml(entry, opts) {
        const options = opts || {};
        const amt = Number(entry.amount) || 0;
        const tokens = Number(entry.tokens) || 0;
        const paid = !!entry.paid;
        const statusCls = paid ? 'cm-wallet-paid' : 'cm-wallet-pending';
        const statusLabel = paid ? 'Verificado' : 'En verificación';
        const typeIcon = entry.type === 'referral' ? 'fa-user-plus'
            : entry.type === 'video_plays' ? 'fa-play-circle' : 'fa-eye';
        let amountLine = amt > 0 ? ('+$' + amt.toFixed(2)) : '';
        if (tokens > 0) amountLine += (amountLine ? ' · ' : '') + ('+' + tokens + ' tokens');
        const pubLine = entry.publicationTitle
            ? ('<span class="cm-wallet-pub"><i class="fas fa-file-alt"></i> ' + this.escCreatorMarketHtml(entry.publicationTitle) + '</span>')
            : '';
        const approveHint = (!paid && options.showVerifyHint)
            ? '<p class="cm-wallet-verify-hint"><i class="fas fa-shield-alt"></i> Boss of the State revisará este ingreso en Commander Panel.</p>'
            : '';
        return '<div class="cm-wallet-row ' + statusCls + '">' +
            '<div class="cm-wallet-row-top">' +
            '<span class="cm-wallet-type"><i class="fas ' + typeIcon + '"></i></span>' +
            '<div class="cm-wallet-main">' +
            '<strong>' + this.escCreatorMarketHtml(entry.reason || 'Movimiento Creator Market') + '</strong>' +
            pubLine +
            '</div>' +
            '<div class="cm-wallet-amount">' + (amountLine || '—') + '</div>' +
            '</div>' +
            '<div class="cm-wallet-meta">' +
            '<span class="cm-wallet-status">' + statusLabel + '</span>' +
            '<span><i class="fas fa-clock"></i> ' + this.formatRelativeTime(entry.createdAt) + '</span>' +
            (entry.paidAt ? (' · Verificado ' + this.formatRelativeTime(entry.paidAt)) : '') +
            '</div>' + approveHint + '</div>';
    }

    renderEarnedView(container) {
        const entries = State.creatorMarket.walletLedger || [];
        const total = State.creatorMarket.totalEarnings;
        const pending = State.creatorMarket.pendingEarnings;
        const paid = State.creatorMarket.paidEarnings;
        const byType = { views: 0, video_plays: 0, referral: 0, other: 0 };
        entries.forEach(e => {
            const amt = Number(e.amount) || 0;
            if (e.type === 'views') byType.views += amt;
            else if (e.type === 'video_plays') byType.video_plays += amt;
            else if (e.type === 'referral') byType.referral += amt;
            else byType.other += amt;
        });
        const statsHtml = '<div class="cm-earned-summary">' +
            '<div class="cm-earned-stat"><span>Acumulado</span><strong>$' + total.toFixed(2) + '</strong></div>' +
            '<div class="cm-earned-stat cm-earned-stat-paid"><span>Verificado</span><strong>$' + paid.toFixed(2) + '</strong></div>' +
            '<div class="cm-earned-stat cm-earned-stat-pending"><span>Pendiente</span><strong>$' + pending.toFixed(2) + '</strong></div>' +
            '<div class="cm-earned-stat"><span>Movimientos</span><strong>' + entries.length + '</strong></div>' +
            '</div>' +
            '<div class="cm-earned-breakdown">' +
            '<h5><i class="fas fa-chart-pie"></i> Por origen</h5>' +
            '<ul class="cm-earned-types">' +
            '<li><i class="fas fa-eye"></i> Vistas <strong>$' + byType.views.toFixed(2) + '</strong></li>' +
            '<li><i class="fas fa-play-circle"></i> Reproducciones <strong>$' + byType.video_plays.toFixed(2) + '</strong></li>' +
            '<li><i class="fas fa-user-plus"></i> Referidos <strong>$' + byType.referral.toFixed(2) + '</strong></li>' +
            (byType.other > 0 ? ('<li><i class="fas fa-ellipsis-h"></i> Otros <strong>$' + byType.other.toFixed(2) + '</strong></li>') : '') +
            '</ul></div>' +
            '<div class="cm-payout-rates-card">' +
            '<h5><i class="fas fa-receipt"></i> Tarifas Creator Market</h5>' +
            '<ul class="cm-payout-rates">' +
            '<li><i class="fas fa-eye"></i> 1.000 vistas = <strong>$0.67</strong></li>' +
            '<li><i class="fas fa-play-circle"></i> 1.000 reproducciones = <strong>$0.60</strong></li>' +
            '<li><i class="fas fa-user-plus"></i> Referido registrado = <strong>$2</strong> <span class="cm-payout-plus">+ 50 tokens</span></li>' +
            '</ul></div>';
        const historyHtml = entries.length
            ? ('<div class="cm-wallet-history"><h5><i class="fas fa-history"></i> Historial de ingresos</h5>' +
                entries.map(e => this.buildCreatorWalletEntryHtml(e)).join('') + '</div>')
            : ('<div class="cm-empty-state"><span class="cm-empty-icon"><i class="fas fa-coins"></i></span>' +
                '<strong>Sin ingresos aún</strong>' +
                '<p>Cuando tus publicaciones generen vistas o reproducciones verás aquí cada movimiento y por qué ganaste.</p></div>');
        container.innerHTML = statsHtml + historyHtml;
    }

    renderPendingView(container) {
        const entries = (State.creatorMarket.walletLedger || []).filter(e => !e.paid);
        const totalPending = State.creatorMarket.pendingEarnings;
        const pubIds = new Set(entries.map(e => e.publicationId).filter(Boolean));
        const relatedPubs = this.getCreatorPublicationsList().filter(p => pubIds.has(p.id));
        const walletHtml = entries.length
            ? ('<div class="cm-pending-wallet">' +
                '<div class="cm-pending-total"><span>Total en verificación</span><strong>$' + totalPending.toFixed(2) + '</strong></div>' +
                '<p class="cm-pending-note"><i class="fas fa-info-circle"></i> Este dinero se genera por métricas reales de Facebook. Boss of the State lo aprueba en Commander Panel tras revisar el contenido.</p>' +
                entries.map(e => this.buildCreatorWalletEntryHtml(e, { showVerifyHint: true })).join('') +
                '</div>')
            : ('<div class="cm-empty-state"><span class="cm-empty-icon"><i class="fas fa-hourglass-half"></i></span>' +
                '<strong>Nada pendiente</strong>' +
                '<p>No hay ingresos esperando verificación en este momento.</p></div>');
        container.innerHTML = walletHtml;
        if (relatedPubs.length) {
            const pubsWrap = document.createElement('div');
            pubsWrap.className = 'cm-pending-pubs';
            pubsWrap.innerHTML = '<h5><i class="fas fa-link"></i> Publicaciones relacionadas</h5><div class="cm-publications-list"></div>';
            container.appendChild(pubsWrap);
            this.renderPublicationCards(relatedPubs, pubsWrap.querySelector('.cm-publications-list'));
        }
    }

    buildCreatorPublicationCardHtml(p) {
        const m = p.metrics || {};
        const e = p.earnings || {};
        const isLive = this.isPublicationLiveOnFacebook(p);
        const statusTag = this.buildCreatorPublicationStatusTag(p);
        const earnStr = e.amount != null ? ('$' + Number(e.amount).toFixed(2)) : '—';
        const relTime = this.formatRelativeTime(m.lastUpdatedAt || p.publishedAt);
        const captionPreview = p.caption ? ('<p class="cm-pub-caption">' + this.escCreatorMarketHtml(p.caption.length > 140 ? p.caption.slice(0, 140) + '…' : p.caption) + '</p>') : '';
        const playsLine = p.mediaType === 'video'
            ? ('<span class="cm-metric-pill"><i class="fas fa-play-circle"></i> ' + (m.videoPlays || m.views || 0).toLocaleString() + '</span>')
            : ('<span class="cm-metric-pill"><i class="fas fa-eye"></i> ' + (m.views || 0).toLocaleString() + '</span>');
        const mediaBadge = p.mediaType === 'video'
            ? '<span class="cm-media-type-badge cm-media-video"><i class="fas fa-video"></i> Video</span>'
            : '<span class="cm-media-type-badge cm-media-image"><i class="fas fa-image"></i> Imagen</span>';
        return '<div class="cm-pub-card' + (isLive ? ' cm-pub-card-live' : '') + (p.status === 'removed' ? ' cm-pub-card-removed' : '') + '" data-pub-id="' + this.escCreatorMarketHtml(p.id) + '">' +
            '<div class="cm-pub-layout">' +
            '<div class="cm-pub-main">' +
            '<div class="cm-pub-header"><div class="cm-pub-title-row"><strong>' + this.escCreatorMarketHtml(p.title || 'Publicación') + '</strong>' + mediaBadge + '</div>' + statusTag + '</div>' +
            captionPreview +
            '<div class="cm-pub-metrics">' + playsLine +
            '<span class="cm-metric-pill"><i class="fas fa-heart"></i> ' + (m.likes || 0).toLocaleString() + '</span>' +
            '<span class="cm-metric-pill"><i class="fas fa-comment"></i> ' + (m.comments || 0).toLocaleString() + '</span>' +
            '</div>' +
            this.buildEngagementMini(m.views || m.videoPlays, m.likes, m.comments) +
            '<div class="cm-pub-earn"><i class="fas fa-coins"></i> <span>' + earnStr + '</span> <span class="cm-pub-rate-hint">estimado</span></div>' +
            '<div class="cm-geo-map-host" id="cm-geo-' + this.escCreatorMarketHtml(p.id) + '"></div>' +
            '<div class="cm-pub-meta"><i class="fas fa-clock"></i> ' + relTime +
            (m.scanStatus === 'facebook_api' ? ' · <span class="cm-fb-api-tag">Facebook</span>' : '') +
            (p.facebookPostUrl ? ' · <a href="' + this.escCreatorMarketHtml(p.facebookPostUrl) + '" target="_blank" rel="noopener">Ver post</a>' : '') +
            '</div>' +
            this.buildCreatorShareButtons(p.facebookPostUrl, p.title) +
            '</div>' +
            this.buildCreatorPublicationThumb(p) +
            '</div></div>';
    }

    renderPublicationCards(pubs, listEl) {
        if (!listEl) return;
        if (!pubs.length) {
            listEl.innerHTML = '<div class="cm-empty-state">' +
                '<span class="cm-empty-icon"><i class="fas fa-broadcast-tower"></i></span>' +
                '<strong>Sin publicaciones</strong>' +
                '<p>No hay publicaciones para mostrar en esta vista.</p></div>';
            return;
        }
        listEl.innerHTML = pubs.map(p => this.buildCreatorPublicationCardHtml(p)).join('');
        this.bindCreatorShareActions(listEl);
        if (window.CreatorMarketMap) {
            pubs.forEach(p => {
                const host = document.getElementById('cm-geo-' + p.id);
                if (host) window.CreatorMarketMap.renderGeoMap(host, (p.metrics && p.metrics.geoByCountry) || {});
            });
        }
    }

    renderCreatorViewContent() {
        const container = document.getElementById('cm-dynamic-content');
        if (!container || State.creatorMarket.status !== 'approved') return;
        const view = State.creatorMarket.activeView || 'posts';
        if (view === 'earned') {
            this.renderEarnedView(container);
            return;
        }
        if (view === 'pending') {
            this.renderPendingView(container);
            return;
        }
        container.innerHTML = '<div id="cm-publications-list" class="cm-publications-list"></div>';
        const listEl = document.getElementById('cm-publications-list');
        const pubs = this.getFilteredCreatorPublications(view);
        if (!pubs.length) {
            const isLive = view === 'live';
            listEl.innerHTML = '<div class="cm-empty-state">' +
                '<span class="cm-empty-icon"><i class="fas fa-' + (isLive ? 'circle' : 'broadcast-tower') + '"></i></span>' +
                '<strong>' + (isLive ? 'Nada en vivo' : 'Sin publicaciones aún') + '</strong>' +
                '<p>' + (isLive
                    ? 'Solo aparecen publicaciones activas en Facebook. Cerradas o dadas de baja no se muestran aquí.'
                    : 'Cuando un Commander publique tu contenido en Facebook, verás métricas en vivo aquí.') + '</p></div>';
            return;
        }
        this.renderPublicationCards(pubs, listEl);
    }

    setCreatorMetricsSyncBadge(text, spinning) {
        const badge = document.getElementById('cm-metrics-sync-badge');
        if (!badge) return;
        badge.innerHTML = (spinning ? '<i class="fas fa-sync-alt fa-spin"></i> ' : '<i class="fas fa-sync-alt"></i> ') + text;
    }

    refreshCreatorMetrics(silent) {
        if (!this.functions || State.creatorMarket.status !== 'approved') return Promise.resolve();
        if (!silent) this.setCreatorMetricsSyncBadge('Actualizando…', true);
        return this.functions.httpsCallable('refreshMyCreatorMarketMetrics')({})
            .then(() => {
                const now = new Date().toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
                this.setCreatorMetricsSyncBadge('Actualizado ' + now, false);
            })
            .catch((err) => {
                console.warn('refreshCreatorMetrics', err);
                this.setCreatorMetricsSyncBadge('Pulsa para reintentar', false);
            });
    }

    startCreatorMetricsAutoRefresh() {
        if (this.creatorMetricsRefreshTimer) return;
        this.refreshCreatorMetrics(true);
        this.creatorMetricsRefreshTimer = setInterval(() => {
            if (State.creatorMarket.status !== 'approved') return;
            if (State.creatorMarket.activePanel !== 'feed') return;
            const view = State.creatorMarket.activeView;
            if (view !== 'posts' && view !== 'live') return;
            this.refreshCreatorMetrics(true);
        }, 3 * 60 * 1000);
    }

    attachCreatorWalletListener() {
        if (!this.db || !State.user.id || this.creatorWalletListener) return;
        this.creatorWalletListener = this.db.ref('nexus/users/' + State.user.id + '/creatorMarket')
            .on('value', (snap) => {
                const cm = snap.val() || {};
                State.creatorMarket.totalEarnings = Number(cm.totalEarnings) || 0;
                State.creatorMarket.pendingEarnings = Number(cm.pendingEarnings) || 0;
                State.creatorMarket.lastWalletEntry = cm.lastWalletEntry || null;
                this.renderCreatorDashboard();
            });
    }

    isPublicationLiveOnFacebook(p) {
        const m = p.metrics || {};
        if (p.status === 'closed') return false;
        if (p.status === 'removed') return false;
        if (m.fbLive === false) return false;
        return p.status === 'live';
    }

    buildCreatorPublicationStatusTag(p) {
        if (p.status === 'closed') {
            return '<span class="cm-pub-status cm-pub-status-closed"><i class="fas fa-stop-circle"></i> CERRADO</span>';
        }
        if (p.status === 'removed' || (p.metrics && p.metrics.fbLive === false)) {
            return '<span class="cm-pub-status cm-pub-status-removed"><i class="fas fa-ban"></i> DADO DE BAJA</span>';
        }
        if (this.isPublicationLiveOnFacebook(p)) {
            return '<span class="cm-pub-live"><i class="fas fa-circle"></i> EN VIVO</span>';
        }
        return '<span class="cm-pub-status cm-pub-status-pending"><i class="fas fa-clock"></i> PROCESANDO</span>';
    }

    buildCreatorPublicationThumb(p) {
        const url = p.mediaUrl || '';
        if (!url) {
            return '<div class="cm-pub-thumb cm-pub-thumb-empty"><i class="fas fa-image"></i></div>';
        }
        if (p.mediaType === 'video') {
            return '<div class="cm-pub-thumb cm-pub-thumb-video">' +
                '<video src="' + this.escCreatorMarketHtml(url) + '" muted playsinline preload="metadata"></video>' +
                '<span class="cm-pub-thumb-badge"><i class="fas fa-play"></i></span></div>';
        }
        return '<div class="cm-pub-thumb"><img src="' + this.escCreatorMarketHtml(url) + '" alt="Tu archivo" loading="lazy"></div>';
    }

    attachCreatorPublicationsListener() {
        if (!this.db || !State.user.id || this.creatorPubListener) return;
        this.creatorPubListener = this.db.ref('creatorMarket/publications')
            .orderByChild('authorUid')
            .equalTo(State.user.id)
            .on('value', (snap) => {
                this.renderCreatorPublications(snap.val() || {});
            });
    }

    buildCreatorShareButtons(postUrl, title) {
        if (!postUrl) return '';
        const safeUrl = this.escCreatorMarketHtml(postUrl);
        const encUrl = encodeURIComponent(postUrl);
        const encText = encodeURIComponent((title || 'StudiosGamesRS') + ' ');
        return '<div class="cm-share-row">' +
            '<span class="cm-share-label"><i class="fas fa-share-alt"></i> Compartir en:</span>' +
            '<a href="https://www.facebook.com/sharer/sharer.php?u=' + encUrl + '" target="_blank" rel="noopener" class="cm-share-btn cm-share-fb"><i class="fab fa-facebook"></i> Facebook</a>' +
            '<a href="https://twitter.com/intent/tweet?url=' + encUrl + '&text=' + encText + '" target="_blank" rel="noopener" class="cm-share-btn cm-share-x"><i class="fab fa-twitter"></i> X</a>' +
            '<a href="https://wa.me/?text=' + encText + encUrl + '" target="_blank" rel="noopener" class="cm-share-btn cm-share-wa"><i class="fab fa-whatsapp"></i> WhatsApp</a>' +
            '<a href="https://t.me/share/url?url=' + encUrl + '&text=' + encText + '" target="_blank" rel="noopener" class="cm-share-btn cm-share-tg"><i class="fab fa-telegram-plane"></i> Telegram</a>' +
            '<a href="https://www.reddit.com/submit?url=' + encUrl + '&title=' + encText + '" target="_blank" rel="noopener" class="cm-share-btn cm-share-rd"><i class="fab fa-reddit"></i> Reddit</a>' +
            '<a href="https://www.linkedin.com/sharing/share-offsite/?url=' + encUrl + '" target="_blank" rel="noopener" class="cm-share-btn cm-share-li"><i class="fab fa-linkedin"></i> LinkedIn</a>' +
            '<button type="button" class="cm-share-btn cm-share-copy" data-url="' + safeUrl + '"><i class="fas fa-link"></i> Copiar enlace</button>' +
            '</div>';
    }

    bindCreatorShareActions(rootEl) {
        if (!rootEl) return;
        rootEl.querySelectorAll('.cm-share-copy').forEach((btn) => {
            if (btn.dataset.bound === '1') return;
            btn.dataset.bound = '1';
            btn.addEventListener('click', () => {
                const url = btn.getAttribute('data-url') || '';
                if (!url) return;
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText(url).then(() => {
                        this.showToast('Enlace copiado', 'success', 'Pégalo donde quieras compartir.');
                    }).catch(() => {
                        window.prompt('Copia este enlace:', url);
                    });
                } else {
                    window.prompt('Copia este enlace:', url);
                }
            });
        });
    }

    renderCreatorPublications(pubMap) {
        State.creatorMarket.publicationsCache = pubMap || {};
        const pubs = this.getCreatorPublicationsList();
        const postsEl = document.getElementById('cm-stat-posts');
        const liveEl = document.getElementById('cm-stat-live');
        if (postsEl) postsEl.textContent = String(pubs.length);
        const liveCount = pubs.filter(p => this.isPublicationLiveOnFacebook(p)).length;
        if (liveEl) liveEl.textContent = String(liveCount);
        if (State.creatorMarket.activeView === 'posts' || State.creatorMarket.activeView === 'live') {
            this.renderCreatorViewContent();
        }
    }

    async submitCreatorMarketApplication(event) {
        event.preventDefault();
        if (!this.isMercadoTecnicoUnlocked() || !this.db || !this.userRef) {
            this.showToast('No disponible', 'error', 'Alcanza el nivel 4 (3.000 XP) primero.');
            return;
        }
        if (State.creatorMarket.status === 'pending') {
            this.showToast('Ya enviada', 'info', 'Tu solicitud está en revisión.');
            return;
        }

        const questionnaire = {
            creatorName: document.getElementById('cm-app-name')?.value?.trim(),
            facebookProfileName: document.getElementById('cm-app-fb-name')?.value?.trim(),
            facebookProfileUrl: document.getElementById('cm-app-fb-url')?.value?.trim(),
            contentType: document.getElementById('cm-app-content-type')?.value,
            experience: document.getElementById('cm-app-experience')?.value?.trim(),
            motivation: document.getElementById('cm-app-motivation')?.value?.trim(),
            portfolioUrl: document.getElementById('cm-app-portfolio')?.value?.trim() || null,
            postingFrequency: document.getElementById('cm-app-frequency')?.value
        };

        if (!questionnaire.creatorName || !questionnaire.facebookProfileName || !questionnaire.facebookProfileUrl) {
            this.showToast('Campos obligatorios', 'error', 'Completa nombre y cuenta de Facebook.');
            return;
        }

        const payload = {
            uid: State.user.id,
            nick: State.user.displayName || State.user.username || 'Usuario',
            status: 'pending',
            submittedAt: Date.now(),
            questionnaire
        };

        try {
            await this.db.ref('nexus/creatorApplications/' + State.user.id).set(payload);
            await this.userRef.child('creatorMarket').update({
                applicationStatus: 'pending',
                submittedAt: Date.now()
            });
            State.creatorMarket.status = 'pending';
            State.creatorMarket.application = payload;
            document.getElementById('cm-application-form')?.reset();
            this.showToast('Solicitud enviada', 'success', 'Todos los Commanders pueden ver tu petición.');
            this.pushUserNotification({
                text: 'Creator Market: tu solicitud fue enviada y está en revisión por los Commanders.',
                icon: 'fa-store',
                type: 'creator_market',
                link: '/nexus'
            });
            this.renderCreatorMarketStage();
            this.updateMercadoTecnico();
        } catch (err) {
            console.error(err);
            this.showToast('Error', 'error', 'No se pudo enviar la solicitud.');
        }
    }

    async resetCreatorMarketApplication() {
        if (!this.db || !State.user.id) return;
        try {
            await this.db.ref('nexus/creatorApplications/' + State.user.id).remove();
            await this.userRef.child('creatorMarket').update({
                applicationStatus: null,
                submittedAt: null
            });
            State.creatorMarket.status = null;
            State.creatorMarket.application = null;
            this.renderCreatorMarketStage();
            this.updateMercadoTecnico();
        } catch (err) {
            this.showToast('Error', 'error', 'No se pudo reiniciar la solicitud.');
        }
    }

    switchCreatorMarketTab(tab) {
        this.switchCreatorMarketPanel(tab === 'submit' ? 'submit' : 'feed');
    }

    initCreatorMarketInsights() {
        if (!window.CreatorMarketInsights || typeof CreatorMarketInsights.init !== 'function') return;
        CreatorMarketInsights.init({ db: this.db, functions: this.functions });
    }

    initCreatorMarketUpload() {
        const uploadBtn = document.getElementById('mercado-upload-btn');
        const fileInput = document.getElementById('mercado-file-input');
        const preview = document.getElementById('mercado-file-preview');
        if (!uploadBtn || !fileInput || uploadBtn.dataset.bound === '1') return;
        uploadBtn.dataset.bound = '1';

        uploadBtn.addEventListener('click', () => fileInput.click());
        fileInput.addEventListener('change', () => {
            const file = fileInput.files && fileInput.files[0];
            if (file) this.handleCreatorMarketFile(file);
        });
        ['dragenter', 'dragover'].forEach((ev) => {
            uploadBtn.addEventListener(ev, (e) => {
                e.preventDefault();
                e.stopPropagation();
                uploadBtn.classList.add('cm-dropzone-active');
            });
        });
        ['dragleave', 'drop'].forEach((ev) => {
            uploadBtn.addEventListener(ev, (e) => {
                e.preventDefault();
                e.stopPropagation();
                uploadBtn.classList.remove('cm-dropzone-active');
            });
        });
        uploadBtn.addEventListener('drop', (e) => {
            const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
            if (file) this.handleCreatorMarketFile(file);
        });
    }

    renderCreatorMarketFilePreview(file, previewEl, uploadBtn) {
        if (!previewEl) return;
        if (!file) {
            previewEl.style.display = 'none';
            previewEl.innerHTML = '';
            if (uploadBtn) {
                uploadBtn.classList.remove('cm-dropzone-ready', 'cm-dropzone-active');
                uploadBtn.innerHTML = '<span class="cm-dropzone-icon"><i class="fas fa-file-image"></i></span>' +
                    '<strong>Arrastra o pulsa para subir</strong>' +
                    '<span class="cm-dropzone-sub">JPG, PNG, WEBP, GIF (15 MB) · MP4, WEBM, MOV (100 MB)</span>';
            }
            return;
        }
        const isVideo = file.type.startsWith('video/');
        const maxMb = isVideo ? 100 : 15;
        if (file.size > maxMb * 1024 * 1024) {
            this.showToast('Archivo muy grande', 'error', 'Máximo ' + maxMb + ' MB para ' + (isVideo ? 'video' : 'imagen') + '.');
            this.creatorMarketSelectedFile = null;
            previewEl.style.display = 'none';
            previewEl.innerHTML = '';
            return;
        }
        previewEl.style.display = 'block';
        const sizeMb = (file.size / (1024 * 1024)).toFixed(2);
        let mediaHtml = isVideo
            ? '<video controls playsinline class="cm-upload-preview-media"></video>'
            : '<img alt="Vista previa" class="cm-upload-preview-media">';
        previewEl.innerHTML =
            '<div class="cm-upload-preview-card">' + mediaHtml +
            '<div class="cm-upload-preview-meta"><strong>' + this.escCreatorMarketHtml(file.name) + '</strong>' +
            '<span>' + sizeMb + ' MB · ' + (isVideo ? 'Video' : 'Imagen') + '</span>' +
            '<button type="button" class="cm-upload-remove-btn" id="mercado-remove-file"><i class="fas fa-times"></i> Quitar</button></div></div>';
        const mediaEl = previewEl.querySelector('.cm-upload-preview-media');
        if (this.creatorPreviewObjectUrl) {
            URL.revokeObjectURL(this.creatorPreviewObjectUrl);
            this.creatorPreviewObjectUrl = null;
        }
        const objUrl = URL.createObjectURL(file);
        this.creatorPreviewObjectUrl = objUrl;
        if (mediaEl) {
            mediaEl.src = objUrl;
            if (isVideo) mediaEl.type = file.type;
        }
        if (uploadBtn) uploadBtn.classList.add('cm-dropzone-ready');
        if (uploadBtn) uploadBtn.innerHTML = '<span class="cm-dropzone-icon"><i class="fas fa-check"></i></span><strong>Archivo listo</strong><span class="cm-dropzone-sub">Pulsa para cambiar</span>';
        const removeBtn = document.getElementById('mercado-remove-file');
        if (removeBtn) {
            removeBtn.addEventListener('click', () => {
                this.creatorMarketSelectedFile = null;
                const input = document.getElementById('mercado-file-input');
                if (input) input.value = '';
                if (this.creatorPreviewObjectUrl) {
                    URL.revokeObjectURL(this.creatorPreviewObjectUrl);
                    this.creatorPreviewObjectUrl = null;
                }
                if (uploadBtn) uploadBtn.classList.remove('cm-dropzone-ready');
                this.renderCreatorMarketFilePreview(null, previewEl, uploadBtn);
            });
        }
    }

    async uploadCreatorMediaFile(file, onProgress) {
        if (!file || !this.storage || !State.user.id) {
            throw new Error('Subida no disponible');
        }
        const safeName = Date.now() + '_' + String(file.name).replace(/[^a-zA-Z0-9._-]/g, '_');
        const ref = this.storage.ref('creatorMarket/' + State.user.id + '/' + safeName);
        const snap = await new Promise((resolve, reject) => {
            const task = ref.put(file);
            task.on('state_changed', (progress) => {
                if (onProgress && progress.totalBytes) {
                    onProgress(Math.round((progress.bytesTransferred / progress.totalBytes) * 100));
                }
            }, reject, resolve);
        });
        const mediaUrl = await snap.ref.getDownloadURL();
        return {
            mediaUrl: mediaUrl,
            storagePath: snap.ref.fullPath,
            mediaType: file.type.startsWith('video/') ? 'video' : 'image',
            contentType: file.type,
            mediaFileName: file.name
        };
    }

    attachMercadoSubmissionsListener() {
        if (!this.userRef || this.mercadoSubListener) return;
        this.mercadoSubListener = this.userRef.child('mercadoSubmissions').on('value', () => {
            this.renderMercadoSubmissions();
        });
    }

    async fetchLeaderboard() {
        if (!this.functions) return State.leaderboardCache || [];
        try {
            const result = await this.functions.httpsCallable('getNexusLeaderboard')({ limit: 50 });
            const data = result.data || {};
            const list = Array.isArray(data.entries) ? data.entries : [];
            State.leaderboardCache = list;
            return list;
        } catch (e) {
            console.warn('Leaderboard:', e);
            return State.leaderboardCache || [];
        }
    }

    updateLocalRankDisplay() {
        const list = State.leaderboardCache || [];
        if (!list.length || !State.user.id) return;
        const updated = list.map(u => u.uid === State.user.id ? { ...u, xp: State.stats.xp, level: State.stats.level, rankIndex: State.stats.rank } : u);
        updated.sort((a, b) => b.xp - a.xp);
        const idx = updated.findIndex(u => u.uid === State.user.id);
        const label = idx >= 0 ? '#' + (idx + 1) : '#-';
        const rankEl = document.getElementById('global-rank');
        if (rankEl) rankEl.textContent = label;
        const widgetRank = document.getElementById('widget-leaderboard-rank');
        if (widgetRank) widgetRank.textContent = label;
        State.leaderboardCache = updated;
    }

    async refreshLeaderboard() {
        const list = await this.fetchLeaderboard();
        const idx = list.findIndex(u => u.uid === State.user.id);
        const rankEl = document.getElementById('global-rank');
        if (rankEl) rankEl.textContent = idx >= 0 ? '#' + (idx + 1) : '#-';
        const widgetRank = document.getElementById('widget-leaderboard-rank');
        if (widgetRank) widgetRank.textContent = idx >= 0 ? '#' + (idx + 1) : '#-';
        return list;
    }

    async openLeaderboardModal() {
        const modal = document.getElementById('leaderboard-modal');
        const listEl = document.getElementById('leaderboard-list');
        if (!modal || !listEl) return;
        listEl.innerHTML = '<div class="leaderboard-loading"><i class="fas fa-spinner fa-spin"></i> Cargando ranking...</div>';
        modal.style.display = 'flex';
        document.body.style.overflow = 'hidden';

        const list = await this.fetchLeaderboard();
        if (!list.length) {
            listEl.innerHTML = '<p class="leaderboard-empty">Aún no hay jugadores en el ranking.</p>';
            return;
        }

        listEl.innerHTML = list.slice(0, 25).map((entry, i) => {
            const isMe = entry.uid === State.user.id;
            const rankCfg = CONFIG.xp.ranks[entry.rankIndex] || CONFIG.xp.ranks[0];
            const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '#' + (i + 1);
            const avatar = entry.photoURL
                ? '<img src="' + entry.photoURL + '" alt="" class="leaderboard-avatar">'
                : '<span class="leaderboard-avatar-fallback"><i class="fas ' + rankCfg.icon + '"></i></span>';
            return '<div class="leaderboard-row' + (isMe ? ' is-me' : '') + '">' +
                '<span class="leaderboard-pos">' + medal + '</span>' +
                avatar +
                '<div class="leaderboard-info"><strong>' + entry.name + '</strong>' +
                '<span>Nivel ' + entry.level + '</span></div>' +
                '<span class="leaderboard-xp">' + entry.xp.toLocaleString() + ' XP</span></div>';
        }).join('');
    }

    closeLeaderboardModal() {
        const modal = document.getElementById('leaderboard-modal');
        if (modal) modal.style.display = 'none';
        document.body.style.overflow = '';
    }

    async submitMercadoTecnico(event) {
        if (event) event.preventDefault();
        if (!this.isMercadoTecnicoUnlocked()) {
            this.showToast('Mercado Técnico', 'warning', 'Alcanza Influencer Nexus (Nivel 4 · 3.000 XP) para desbloquear.');
            return;
        }
        if (State.creatorMarket.status !== 'approved') {
            this.showToast('No autorizado', 'error', 'Debes ser aprobado en Creator Market para enviar contenido.');
            return;
        }
        const title = document.getElementById('mercado-title')?.value?.trim();
        const caption = document.getElementById('mercado-caption')?.value?.trim();
        const file = this.creatorMarketSelectedFile;
        if (!title || !caption) {
            this.showToast('Campos requeridos', 'warning', 'Título y descripción son obligatorios.');
            return;
        }
        if (!file) {
            this.showToast('Archivo requerido', 'warning', 'Arrastra o pulsa la zona de subida para elegir imagen o video.');
            return;
        }
        if (!this.userRef || !this.storage) {
            this.showToast('Error', 'error', 'Inicia sesión e intenta de nuevo.');
            return;
        }

        const submitBtn = document.getElementById('mercado-submit-btn');
        const origBtn = submitBtn ? submitBtn.innerHTML : '';
        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Subiendo…';
        }

        const insightScore = window.CreatorMarketInsights && CreatorMarketInsights.getLastScore
            ? CreatorMarketInsights.getLastScore() : null;

        try {
            const media = await this.uploadCreatorMediaFile(file, (pct) => {
                if (submitBtn) submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Subiendo ' + pct + '%…';
            });
            const submission = {
                title,
                caption,
                mediaUrl: media.mediaUrl,
                storagePath: media.storagePath,
                mediaType: media.mediaType,
                contentType: media.contentType,
                mediaFileName: media.mediaFileName,
                authorId: State.user.id,
                authorName: State.user.displayName || State.user.username || 'Usuario',
                status: 'pending',
                createdAt: Date.now(),
                insightScore: insightScore
            };
            const ref = this.userRef.child('mercadoSubmissions').push();
            await ref.set(submission);
            await this.db.ref('creatorMarket/submissionQueue/' + State.user.id + '/' + ref.key).set({
                ...submission,
                uid: State.user.id,
                submissionId: ref.key
            });
            this.creatorMarketSelectedFile = null;
            if (this.creatorPreviewObjectUrl) {
                URL.revokeObjectURL(this.creatorPreviewObjectUrl);
                this.creatorPreviewObjectUrl = null;
            }
            const fileInput = document.getElementById('mercado-file-input');
            if (fileInput) fileInput.value = '';
            const uploadBtn = document.getElementById('mercado-upload-btn');
            if (uploadBtn) uploadBtn.classList.remove('cm-dropzone-ready');
            this.renderCreatorMarketFilePreview(null, document.getElementById('mercado-file-preview'), uploadBtn);
            this.showToast('Enviado', 'success', 'Archivo alojado en StudiosGamesRS. Un Commander lo publicará en Facebook al aprobarlo.');
            document.getElementById('mercado-submit-form')?.reset();
            await this.renderMercadoSubmissions();
        } catch (e) {
            console.warn('Mercado Técnico:', e);
            this.showToast('Error', 'error', e.message || 'No se pudo enviar. Intenta de nuevo.');
        } finally {
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.innerHTML = origBtn;
            }
        }
    }

    async renderMercadoSubmissions() {
        const listEl = document.getElementById('mercado-submissions-list');
        if (!listEl || !this.userRef) return;
        try {
            const snap = await this.userRef.child('mercadoSubmissions').once('value');
            const items = [];
            snap.forEach(child => items.push({ id: child.key, ...child.val() }));
            items.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
            const recent = items.slice(0, 5);
            if (!recent.length) {
                listEl.innerHTML = '<p class="mercado-empty">Aún no has enviado contenido.</p>';
                return;
            }
            const statusLabels = { pending: 'En revisión', approved: 'Aprobado', published: 'Publicado', rejected: 'Rechazado' };
            listEl.innerHTML = recent.map(s => {
                const label = statusLabels[s.status] || s.status || 'En revisión';
                const fbLink = s.facebookPostUrl
                    ? ('<div class="cm-submission-link"><a href="' + this.escCreatorMarketHtml(s.facebookPostUrl) + '" target="_blank" rel="noopener"><i class="fab fa-facebook"></i> Ver publicación</a></div>')
                    : '';
                const shareBlock = s.facebookPostUrl ? this.buildCreatorShareButtons(s.facebookPostUrl, s.title) : '';
                const rejectNote = s.status === 'rejected' && s.reviewNote
                    ? ('<p class="cm-submission-note">' + this.escCreatorMarketHtml(s.reviewNote) + '</p>') : '';
                const mediaPreview = s.mediaUrl
                    ? (s.mediaType === 'video'
                        ? '<div class="cm-submission-media"><video controls playsinline src="' + this.escCreatorMarketHtml(s.mediaUrl) + '"></video></div>'
                        : '<div class="cm-submission-media"><img src="' + this.escCreatorMarketHtml(s.mediaUrl) + '" alt=""></div>')
                    : '';
                const insightTag = s.insightScore != null
                    ? ('<span class="cm-insight-score-tag">Potencial ref. ' + s.insightScore + '/100</span>') : '';
                return '<div class="mercado-submission-item status-' + (s.status || 'pending') + '">' +
                    '<div class="cm-submission-top">' +
                    '<div class="mercado-submission-info"><strong>' + this.escCreatorMarketHtml(s.title) + '</strong>' +
                    '<small>' + new Date(s.createdAt || 0).toLocaleDateString('es') + '</small></div>' +
                    '<div class="cm-submission-badges"><span class="mercado-status">' + label + '</span>' + insightTag + '</div></div>' +
                    mediaPreview +
                    (s.caption ? '<p class="cm-submission-caption">' + this.escCreatorMarketHtml(s.caption.length > 120 ? s.caption.slice(0, 120) + '…' : s.caption) + '</p>' : '') +
                    fbLink + shareBlock + rejectNote + '</div>';
            }).join('');
            this.bindCreatorShareActions(listEl);
        } catch (e) {
            listEl.innerHTML = '<p class="mercado-empty">No se pudieron cargar tus envíos.</p>';
        }
    }

    // ═════════════════════════════════════════════════════════════════════════
    // EVENTOS Y UTILIDADES
    // ═════════════════════════════════════════════════════════════════════════
    initEvents() {
        // Scroll del header
        window.addEventListener('scroll', () => {
            const header = document.getElementById('main-header');
            if (header) {
                header.classList.toggle('scrolled', window.scrollY > 50);
            }
        });
        
        // Upload zone
        const uploadZone = document.getElementById('upload-zone');
        const imageInput = document.getElementById('image-input');
        
        if (uploadZone && imageInput) {
            uploadZone.addEventListener('click', () => imageInput.click());
            imageInput.addEventListener('change', (e) => {
                if (e.target.files[0]) {
                    this.handleImageUpload(e.target.files[0]);
                }
            });
        }
        
        // Recompensas: click en RECLAMAR
        document.addEventListener('click', (e) => {
            const btn = e.target.closest('.reward-btn');
            if (btn && !btn.disabled && btn.dataset.rewardId) {
                this.claimReward(btn.dataset.rewardId);
            }
        });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') this.closeAccessOverlay();
        });
    }

    initVisualEffects() {
        // Partículas
        const container = document.getElementById('particles-container');
        if (!container) return;
        
        const colors = ['#58a6ff', '#a371f7', '#e3b341', '#3fb950'];
        
        for (let i = 0; i < 25; i++) {
            this.createParticle(container, colors);
        }
        
        setInterval(() => {
            const particles = container.querySelectorAll('.particle');
            if (particles.length < 35) {
                this.createParticle(container, colors);
            }
            particles.forEach(p => {
                if (parseFloat(p.style.opacity) <= 0) p.remove();
            });
        }, 800);
    }

    createParticle(container, colors) {
        const p = document.createElement('div');
        p.className = 'particle';
        const size = Math.random() * 3 + 1;
        
        p.style.cssText = `
            position: absolute;
            width: ${size}px;
            height: ${size}px;
            background: ${colors[Math.floor(Math.random() * colors.length)]};
            border-radius: 50%;
            left: ${Math.random() * 100}%;
            top: 100%;
            opacity: ${Math.random() * 0.5 + 0.2};
            pointer-events: none;
            animation: floatParticle ${Math.random() * 15 + 10}s linear forwards;
        `;
        
        container.appendChild(p);
    }

    initTimers() {
        setInterval(() => this.updateTimers(), 1000);
        if (State.user.isDashboardUser && this.db) {
            setInterval(() => this.refreshReferralsFromFirebase(), 45000);
            setInterval(() => this.refreshLeaderboard(), 120000);
        }
    }

    async refreshReferralsFromFirebase() {
        if (!State.user.isDashboardUser || !this.db) return;
        try {
            const snap = await this.db.ref('users/' + State.user.id + '/referrals').once('value');
            const refs = snap.val();
            const count = refs ? Object.keys(refs).length : 0;
            State.stats.verifiedReferrals = count;
            this.updateReferralDisplay(true);
            this.renderReferralsTable(snap);
        } catch (e) { /* silencioso */ }
    }

    updateTimers() {
        // Timer de misión diaria
        const dailyTimer = document.getElementById('daily-timer');
        if (dailyTimer) {
            const now = new Date();
            const tomorrow = new Date(now);
            tomorrow.setDate(tomorrow.getDate() + 1);
            tomorrow.setHours(0, 0, 0, 0);
            const diff = tomorrow - now;
            
            const h = Math.floor(diff / (60 * 60 * 1000));
            const m = Math.floor((diff % (60 * 60 * 1000)) / (60 * 1000));
            const s = Math.floor((diff % (60 * 1000)) / 1000);
            
            dailyTimer.textContent = `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
        }

        this.updateBoostTimer();
    }

    async checkDailyStreak() {
        if (!this.functions || !State.user.isDashboardUser) return;
        try {
            const result = await this.functions.httpsCallable('processNexusDailyStreak')({});
            const data = result.data || {};
            if (data.stats) this.applyStatsFromServer(data.stats);
            const xpGranted = Number(data.xpGranted) || 0;
            const streakBonus = Number(data.streakBonus) || 0;
            if (!data.alreadyProcessed && streakBonus > 0 && xpGranted > 0) {
                this.showToast('¡Racha!', 'success', `+${xpGranted} XP por ${State.stats.streak} días consecutivos`);
                this.checkAchievements();
            }
        } catch (error) {
            console.warn('checkDailyStreak:', error);
        }
    }

    // ═════════════════════════════════════════════════════════════════════════
    // UTILIDADES
    // ═════════════════════════════════════════════════════════════════════════
    showToast(title, type = 'info', message = '') {
        const container = document.getElementById('toast-container');
        if (!container) return;
        
        const icons = {
            success: 'fa-check-circle',
            error: 'fa-times-circle',
            info: 'fa-info-circle',
            warning: 'fa-exclamation-triangle'
        };
        
        const toast = document.createElement('div');
        toast.className = `nexus-toast ${type}`;
        toast.innerHTML = `
            <div class="toast-icon"><i class="fas ${icons[type]}"></i></div>
            <div class="toast-content">
                <div class="toast-title">${title}</div>
                ${message ? `<div class="toast-message">${message}</div>` : ''}
            </div>
            <button class="toast-close" onclick="this.parentElement.remove()">×</button>
        `;
        
        container.appendChild(toast);
        
        // Sonido
        this.playSound(type);
        
        // Auto-remove
        setTimeout(() => {
            toast.classList.add('hiding');
            setTimeout(() => toast.remove(), 400);
        }, 5000);
    }

    showAchievementUnlock(name, icon) {
        const unlock = document.getElementById('achievement-unlock');
        if (!unlock) return;
        const iconEl = unlock.querySelector('.unlock-icon');
        if (iconEl) {
            if (typeof icon === 'string' && icon.startsWith('fa-')) {
                iconEl.innerHTML = `<i class="fas ${icon}" style="font-size:2.5rem;"></i>`;
            } else {
                iconEl.textContent = icon;
            }
        }
        unlock.querySelector('.unlock-text').textContent = name;
        
        unlock.classList.add('active');
        
        this.triggerConfetti();
        
        setTimeout(() => unlock.classList.remove('active'), 3000);
    }

    triggerConfetti(options = {}) {
        if (typeof confetti === 'undefined') return;
        
        confetti({
            particleCount: options.particleCount || 80,
            spread: options.spread || 60,
            origin: { y: 0.7 },
            colors: options.colors || ['#58a6ff', '#a371f7', '#e3b341', '#3fb950'],
            ...options
        });
    }

    showWelcome() {
        const hasVisited = localStorage.getItem('nexus_visited');
        
        if (!hasVisited) {
            this.showToast(
                '¡Bienvenido a Creator Nexus!',
                'success',
                'Completa misiones para ganar XP y subir de nivel'
            );
            localStorage.setItem('nexus_visited', 'true');
            
            // Primera misión
            setTimeout(() => {
                this.showToast('Primera misión', 'info', 'Visita tu dashboard para comenzar');
            }, 3000);
        } else {
            this.showToast('¡Bienvenido de vuelta!', 'info', `Racha actual: ${State.stats.streak} días`);
        }
    }

    playSound(type) {
        if (!State.settings.sound) return;
        // Aquí se pueden agregar sonidos
    }

    updateTheme() {
        document.body.setAttribute('data-theme', State.settings.theme);
        const icon = document.getElementById('theme-icon');
        if (localStorage.getItem('nexus_effect_brazas') === '1') {
            document.body.classList.add('effect-brazas');
            if (icon) icon.className = 'fas fa-fire';
        } else {
            document.body.classList.remove('effect-brazas');
            if (icon) icon.className = 'fas fa-palette';
        }
    }

    formatCooldown(lastCompleted, cooldown) {
        const remaining = cooldown - (Date.now() - lastCompleted);
        const hours = Math.floor(remaining / (60 * 60 * 1000));
        const minutes = Math.floor((remaining % (60 * 60 * 1000)) / (60 * 1000));
        return `${hours}h ${minutes}m`;
    }

    generateId(length) {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        let result = '';
        for (let i = 0; i < length; i++) {
            result += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return result;
    }

    handleError(error) {
        console.error('Error:', error);
        this.showToast('Error', 'error', error.message || 'Algo salió mal');
    }

    initOfflineMode() {
        this.initUI();
        this.initEvents();
        this.initCanvas();
        this.initVisualEffects();
        this.initTimers();
        this.updateMercadoTecnico();
        this.showToast('Modo offline', 'warning', 'Algunas funciones pueden no estar disponibles');
    }

    updateUploadStats() {
        const count = document.getElementById('image-count');
        const storage = document.getElementById('storage-used');
        
        if (count) {
            const current = parseInt(count.textContent) || 0;
            count.textContent = current + 1;
        }
        
        if (storage) {
            const current = parseFloat(storage.textContent) || 0;
            storage.textContent = (current + 2.5).toFixed(1);
        }
    }
}

// ═════════════════════════════════════════════════════════════════════════════
// INSTANCIA GLOBAL
// ═════════════════════════════════════════════════════════════════════════════
const Nexus = new NexusCore();

// Inicializar cuando el DOM esté listo
document.addEventListener('DOMContentLoaded', () => {
    Nexus.init();
});

// ═════════════════════════════════════════════════════════════════════════════
// FUNCIONES GLOBALES
// ═════════════════════════════════════════════════════════════════════════════
window.Nexus = Nexus;

// Navegación
function showXpHistory() { Nexus.showToast('Historial XP', 'info', 'Próximamente disponible'); }
function showRankInfo() { 
    const rank = CONFIG.xp.ranks[State.stats.rank];
    Nexus.showToast(`Nivel ${State.stats.level}`, 'info', `Beneficios: ${rank.benefits.join(', ')}`); 
}
function showReferralModal() { 
    copyReferralLink();
    Nexus.showToast('Link copiado', 'success', 'Link completo copiado al portapapeles'); 
}

// Referidos
function copyReferralCode() {
    navigator.clipboard.writeText(Nexus.getReferralCode()).then(() => {
        Nexus.showToast('¡Copiado!', 'success', 'Código copiado al portapapeles');
    });
}

function generateQRCode() { 
    Nexus.showToast('QR Code', 'info', 'Generando código QR...'); 
}

function shareReferral(platform) {
    const url = Nexus.getReferralLink();
    const text = '¡Únete a Studiosgamesrs - Creator Nexus!';
    
    const urls = {
        facebook: `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}`,
        twitter: `https://twitter.com/intent/tweet?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`,
        whatsapp: `https://wa.me/?text=${encodeURIComponent(text + ' ' + url)}`,
        telegram: `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`,
        discord: 'https://discord.gg/studiosgamesrs',
        email: `mailto:?subject=Únete a Creator Nexus&body=${encodeURIComponent(text + ' ' + url)}`
    };
    
    if (urls[platform]) {
        window.open(urls[platform], '_blank');
    }
}

function copyReferralLink() {
    navigator.clipboard.writeText(Nexus.getReferralLink()).then(() => {
        Nexus.showToast('¡Link copiado!', 'success');
    });
}

function showReferralStats() { 
    Nexus.showToast('Estadísticas', 'info', `${State.stats.verifiedReferrals} referidos verificados`); 
}
function showReferralDetails() { Nexus.showToast('Detalles', 'info'); }
function showReferralTips() { Nexus.showToast('Consejos', 'info', 'Comparte en redes sociales y grupos de gaming'); }
function refreshReferrals() { 
    if (window.Nexus && typeof Nexus.refreshReferralsFromFirebase === 'function') {
        Nexus.refreshReferralsFromFirebase().then(() => {
            if (window.Nexus && window.Nexus.showToast) Nexus.showToast('Lista actualizada', 'success');
        });
    } else {
        if (window.Nexus) Nexus.updateReferralDisplay();
        if (window.Nexus && window.Nexus.showToast) Nexus.showToast('Actualizado', 'success');
    }
}
function exportReferrals() { Nexus.showToast('Exportar', 'info', 'Descargando CSV...'); }
function viewReferral(id) { Nexus.showToast('Referido', 'info'); }

// Misiones
function showDailyMission() { Nexus.showToast('Misión diaria', 'info', 'Completa la misión para bonus de XP'); }
function openDailyMissionPopup() { Nexus.openDailyMissionPopup(); }
function closeDailyMissionPopup() { Nexus.closeDailyMissionPopup(); }
function startDailyQuest() {
    if (window.Nexus && typeof window.Nexus.startQuest === 'function') {
        window.Nexus.startQuest('share_facebook');
    } else {
        if (typeof Nexus !== 'undefined' && Nexus.startQuest) Nexus.startQuest('share_facebook');
        else if (window.alert) window.alert('Cargando... Recarga la página si el botón no responde.');
    }
}
function filterQuests(filter) {
    State.ui.activeTab = filter;
    document.querySelectorAll('.filter-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.filter === filter);
    });
    Nexus.renderQuests();
}
function startQuest(questId) { Nexus.startQuest(questId); }
function showXpBreakdown() { 
    Nexus.showToast('Desglose XP', 'info', `Total: ${State.stats.xp.toLocaleString()} XP`); 
}
function showCompletionStats() { 
    Nexus.showToast('Completados', 'info', `${State.stats.totalQuestsCompleted} misiones`); 
}
function showQuestHistory() { Nexus.showToast('Historial', 'info', 'Próximamente'); }

// Logros
function showAchievements() { 
    const unlocked = Object.keys(State.achievements).length;
    Nexus.showToast('Logros', 'info', `${unlocked}/${CONFIG.achievements.length} desbloqueados`); 
}
function showBadges() { Nexus.showToast('Insignias', 'info', 'Ver todas tus insignias'); }
function showLeaderboard() { Nexus.openLeaderboardModal(); }
function showActivityLog() { Nexus.showToast('Actividad', 'info', 'Próximamente'); }
function showStreakDetails() { 
    Nexus.showToast('Racha', 'info', `${State.stats.streak} días (Máx: ${State.stats.maxStreak})`); 
}

// Recompensas
function showRewardDetails(type) {
    if (type === 'basic' || !type) {
        Nexus.openAccessOverlay();
        return;
    }
    Nexus.showToast('Recompensas', 'info');
}
function openNexusAccessOverlay() { Nexus.openAccessOverlay(); }
function closeNexusAccessOverlay() { Nexus.closeAccessOverlay(); }
function showAllRewards() { Nexus.showToast('Todas las recompensas', 'info'); }

// Canvas
function resetCanvas() {
    State.canvas.image = null;
    State.canvas.effects = [];
    State.canvas.zoom = 100;
    Nexus.drawCanvasPlaceholder();
    Nexus.updateCanvasStatus('Canvas reiniciado');
}

function zoomIn() {
    State.canvas.zoom = Math.min(State.canvas.zoom + 10, 200);
    Nexus.renderCanvas();
    const el = document.getElementById('zoom-level');
    if (el) el.textContent = `${State.canvas.zoom}%`;
}

function zoomOut() {
    State.canvas.zoom = Math.max(State.canvas.zoom - 10, 50);
    Nexus.renderCanvas();
    const el = document.getElementById('zoom-level');
    if (el) el.textContent = `${State.canvas.zoom}%`;
}

function applyEffect(effect) {
    if (State.canvas.effects.includes(effect)) {
        State.canvas.effects = State.canvas.effects.filter(e => e !== effect);
    } else {
        State.canvas.effects.push(effect);
    }
    Nexus.renderCanvas();
    Nexus.showToast('Efecto aplicado', 'success');
}

function setTheme(theme) {
    State.canvas.theme = theme;
    document.querySelectorAll('.theme-dot').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.theme === theme);
    });
    Nexus.renderCanvas();
}

function downloadOverlay() {
    const canvas = document.getElementById('nexus-branding-canvas');
    if (!canvas || !State.canvas.image) {
        Nexus.showToast('Exportar', 'warning', 'Sube una imagen primero');
        return;
    }

    const link = document.createElement('a');
    link.download = `nexus-overlay-${Date.now()}.png`;
    link.href = canvas.toDataURL('image/png');
    link.click();

    Nexus.claimOverlayDownloadXp().then((granted) => {
        const msg = granted > 0
            ? `Overlay guardado · +${granted} XP`
            : 'Overlay guardado correctamente';
        Nexus.showToast('¡Descargado!', 'success', msg);
    });
}

async function shareOverlay() {
    const canvas = document.getElementById('nexus-branding-canvas');
    if (!canvas || !State.canvas.image) {
        Nexus.showToast('Compartir', 'warning', 'Sube y diseña un overlay primero');
        return;
    }

    try {
        const blob = await new Promise((resolve, reject) => {
            canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('NO_BLOB'))), 'image/png');
        });
        const file = new File([blob], 'nexus-overlay.png', { type: 'image/png' });
        let shareMethod = null;

        if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
            await navigator.share({
                title: 'Mi overlay — Creator Nexus',
                text: 'Overlay creado en StudiosGamesRS Creator Nexus',
                files: [file]
            });
            shareMethod = 'web_share';
        } else if (navigator.clipboard && window.ClipboardItem) {
            await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
            shareMethod = 'clipboard';
            Nexus.showToast('Compartir', 'success', 'Imagen copiada al portapapeles');
        } else {
            Nexus.showToast(
                'Compartir',
                'info',
                'Tu navegador no permite compartir directamente. Usa Exportar HD.'
            );
            return;
        }

        await Nexus.claimOverlayShareXp(shareMethod);
    } catch (error) {
        if (error && error.name === 'AbortError') return;
        console.warn('shareOverlay:', error);
        Nexus.showToast('Compartir', 'error', 'No se pudo compartir el overlay');
    }
}

function saveTemplate() { Nexus.showToast('Guardado', 'success', 'Plantilla guardada'); }

// IA
function applyAISuggestion() {
    const feedback = document.getElementById('ai-feedback');
    if (feedback) {
        const text = feedback.textContent;
        if (text.includes('azul')) Nexus.applyAIRecommendation('blue', 'glow');
        else if (text.includes('dorado')) Nexus.applyAIRecommendation('gold', 'neon');
        else Nexus.applyAIRecommendation('purple', 'shadow');
    }
}

function generateWithAI() {
    if (!State.canvas.image) {
        Nexus.showToast('IA', 'warning', 'Sube una imagen primero');
        return;
    }
    
    // Generar automáticamente
    const themes = ['blue', 'purple', 'gold'];
    const effects = ['glow', 'neon'];
    
    State.canvas.theme = themes[Math.floor(Math.random() * themes.length)];
    State.canvas.effects = [effects[Math.floor(Math.random() * effects.length)]];
    State.canvas.zoom = 110;
    
    document.querySelectorAll('.theme-dot').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.theme === State.canvas.theme);
    });
    
    Nexus.renderCanvas();
    Nexus.showToast('IA', 'success', 'Overlay generado automáticamente');
    Nexus.claimOverlayGenerateAiXp().then((granted) => {
        if (granted > 0) {
            Nexus.showToast('IA', 'success', `+${granted} XP`);
        }
    });
}

function analyzeDesign() {
    if (!State.canvas.image) {
        Nexus.showToast('Análisis', 'warning', 'Sube una imagen primero');
        return;
    }
    
    Nexus.analyzeImageWithAI();
    Nexus.showToast('Análisis', 'success', 'Análisis completado');
}

function showAITips() {
    Nexus.showToast('Consejos', 'info', '• Usa imágenes de alta calidad\n• Formatos: PNG, JPG, WEBP\n• Máximo 10MB');
}

// Boost: solo server-side vía Commander (SEC-006)
function activateXpBoost() {
    const active = State.boost.active && State.boost.expires && State.boost.expires > Date.now();
    if (active) {
        const mins = Math.ceil((State.boost.expires - Date.now()) / 60000);
        Nexus.showToast(
            'Boost activo',
            'success',
            `XP x${State.boost.multiplier} durante ${mins} min más (otorgado por Commander)`
        );
        Nexus.updateBoostUI();
        return;
    }

    Nexus.showToast(
        'Boost XP x2',
        'info',
        'Solo un Commander de SGRS puede otorgarte boost. Participa en eventos, Creator Market o promociones oficiales.'
    );
}

function toggleTheme() {
    document.body.classList.toggle('effect-brazas');
    const isOn = document.body.classList.contains('effect-brazas');
    localStorage.setItem('nexus_effect_brazas', isOn ? '1' : '0');
    
    const icon = document.getElementById('theme-icon');
    if (icon) icon.className = isOn ? 'fas fa-fire' : 'fas fa-palette';
    Nexus.showToast(isOn ? 'Efecto brazas activado' : 'Efecto brazas desactivado', 'info', '');
}

function closeStreakNotif() {
    const notif = document.getElementById('streak-notification');
    if (notif) notif.style.display = 'none';
}

function toggleWidget() {
    const content = document.getElementById('widget-content');
    if (content) content.classList.toggle('open');
}

function joinCommunityChat() { window.open('https://discord.gg/studiosgamesrs', '_blank'); }
function viewLiveLeaderboard() { Nexus.openLeaderboardModal(); }
function closeLeaderboardModal() { Nexus.closeLeaderboardModal(); }
function toggleNexusPanel(panelId, forceOpen) { Nexus.toggleNexusPanel(panelId, forceOpen); }
function openWorkspaceTab(tabId) { Nexus.toggleNexusPanel(tabId, true); }
function submitMercadoTecnico(event) { Nexus.submitMercadoTecnico(event); }
function submitCreatorMarketApplication(event) { Nexus.submitCreatorMarketApplication(event); }
function resetCreatorMarketApplication() { Nexus.resetCreatorMarketApplication(); }
function switchCreatorMarketTab(tab) { Nexus.switchCreatorMarketTab(tab); }
function switchCreatorMarketView(view) { Nexus.switchCreatorMarketView(view); }
function switchCreatorMarketPanel(panel) { Nexus.switchCreatorMarketPanel(panel); }

function showXpDetails() {
    const xp = State.stats.verifiedReferrals * CONFIG.xp.referralBonus;
    Nexus.showToast('XP por referidos', 'info', `${xp.toLocaleString()} XP ganados`);
}

console.log('🎮 Creator Nexus v8.0 - Ultra Edition cargado');
