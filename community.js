// =============================================
// community.js - El Nexo | Studiosgamesrs (Completo y funcional)
// =============================================

if (typeof sgInitFirebaseApp === 'function') {
    sgInitFirebaseApp();
} else if (window.SG_FIREBASE_CONFIG && (!firebase.apps || !firebase.apps.length)) {
    firebase.initializeApp(window.SG_FIREBASE_CONFIG);
}
const app = firebase.app();
// Comunidad usa solo Realtime Database (+ Storage para las fotos). Sin Firestore.
const storage = firebase.storage();
const auth = firebase.auth();
const rtdb = firebase.database();

const DEFAULT_AVATAR = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0MCIgaGVpZ2h0PSI0MCIgdmlld0JveD0iMCAwIDQwIDQwIj48Y2lyY2xlIGN4PSIyMCIgY3k9IjIwIiByPSIyMCIgZmlsbD0iIzMzMyIvPjxjaXJjbGUgY3g9IjIwIiBjeT0iMTUiIHI9IjYiIGZpbGw9IiM2NjYiLz48Y2lyY2xlIGN4PSIyMCIgY3k9IjMwIiByPSI5IiBmaWxsPSIjNjY2Ii8+PC9zdmc+';

const PLAYER_STATUSES = [
    { value: '', label: 'En línea', emoji: '🟢' },
    { value: 'buscando_partida', label: 'Buscando partida', emoji: '🟢' },
    { value: 'en_partida', label: 'En partida', emoji: '🔴' },
    { value: 'forjando_estrategias', label: 'Forjando estrategias', emoji: '🟣' }
];
let presenceByUid = {};
let currentUser = null;
let userProfile = null;
let dailyUploadCount = 0;
let dailyImageUploadCount = 0;
let presenceRef = null;
let currentForgeSelection = null;
let forgeUploadMode = 'image_local';

const FORGE_VIDEO_DAILY_LIMIT = 2;
const FORGE_IMAGE_MAX_BYTES = 12 * 1024 * 1024;
const FORGE_ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const FORGE_VIDEO_MAX_BYTES = 20 * 1024 * 1024;
const FORGE_ALLOWED_VIDEO_TYPES = ['video/mp4', 'video/webm'];
const FORGE_PUBLISH_COOLDOWN_MS = 45 * 1000;
const FORGE_UPLOAD_TOKEN_REWARD = 2;
const FORGE_UPLOAD_COST_HONOR = 10;
const FORGE_VOTE_REWARD_HONOR = 1;
const WEEKLY_GRAND_PRIZE_HONOR = 500;
const LEGEND_FX_HONOR_REQUIRED = 300;

function hashStringSimple(str) {
    const s = String(str || '');
    let hash = 0;
    for (let i = 0; i < s.length; i += 1) {
        hash = ((hash << 5) - hash) + s.charCodeAt(i);
        hash |= 0;
    }
    return Math.abs(hash).toString(36);
}

async function acquireForgePublishCooldown(uid) {
    const now = Date.now();
    const cooldownRef = rtdb.ref('users/' + uid + '/forgePublishGateAt');
    const tx = await cooldownRef.transaction((cur) => {
        const last = typeof cur === 'number' ? cur : 0;
        if (now - last < FORGE_PUBLISH_COOLDOWN_MS) return;
        return now;
    });
    const committed = !!(tx && tx.committed);
    const prev = tx && tx.snapshot ? tx.snapshot.val() : null;
    return { ok: committed, now, previous: (typeof prev === 'number' ? prev : 0) };
}

async function reserveWeeklyEmbedUrl(embedUrl, userId) {
    const weekStart = getStartOfWeekMs(Date.now(), 0);
    const canonical = String(embedUrl || '').trim().toLowerCase();
    const hash = hashStringSimple(canonical);
    const lockRef = rtdb.ref('forgeWeeklyUrlIndex/' + weekStart + '/' + hash);
    const tx = await lockRef.transaction((cur) => {
        if (cur && cur.urlCanonical) return;
        return {
            urlCanonical: canonical,
            userId: userId || '',
            createdAt: Date.now()
        };
    });
    const ok = !!(tx && tx.committed);
    return {
        ok,
        weekStart,
        hash,
        ref: lockRef
    };
}

function getStartOfWeekMs(ts, weekOffset = 0) {
    const d = new Date(ts || Date.now());
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1) + (weekOffset * 7);
    d.setDate(diff);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
}

function parseClipEmbedUrl(rawUrl) {
    const input = (rawUrl || '').trim();
    if (!input) return null;
    try {
        const url = new URL(input);
        const host = (url.hostname || '').toLowerCase().replace(/^www\./, '');
        const path = url.pathname || '';
        const parent = window.location.hostname || 'localhost';

        if (host === 'youtu.be' || host.endsWith('youtube.com')) {
            let videoId = '';
            if (host === 'youtu.be') videoId = path.split('/').filter(Boolean)[0] || '';
            if (!videoId && path === '/watch') videoId = url.searchParams.get('v') || '';
            if (!videoId && path.startsWith('/shorts/')) videoId = path.split('/shorts/')[1]?.split('/')[0] || '';
            if (!videoId && path.startsWith('/live/')) videoId = path.split('/live/')[1]?.split('/')[0] || '';
            if (!videoId && path.startsWith('/embed/')) videoId = path.split('/embed/')[1]?.split('/')[0] || '';
            if (!videoId) return null;
            return { provider: 'youtube', embedUrl: `https://www.youtube.com/embed/${encodeURIComponent(videoId)}` };
        }

        if (host.endsWith('twitch.tv')) {
            if (host === 'clips.twitch.tv') {
                const clipId = path.split('/').filter(Boolean)[0] || '';
                if (!clipId) return null;
                return { provider: 'twitch', embedUrl: `https://clips.twitch.tv/embed?clip=${encodeURIComponent(clipId)}&parent=${encodeURIComponent(parent)}` };
            }
            if (path.includes('/clip/')) {
                const clipId = path.split('/clip/')[1]?.split('/')[0] || '';
                if (!clipId) return null;
                return { provider: 'twitch', embedUrl: `https://clips.twitch.tv/embed?clip=${encodeURIComponent(clipId)}&parent=${encodeURIComponent(parent)}` };
            }
            if (path.startsWith('/videos/')) {
                const vodId = path.split('/videos/')[1]?.split('/')[0] || '';
                if (!vodId) return null;
                return { provider: 'twitch', embedUrl: `https://player.twitch.tv/?video=v${encodeURIComponent(vodId)}&parent=${encodeURIComponent(parent)}` };
            }
            return null;
        }

        if (host.endsWith('kick.com')) {
            if (path.startsWith('/embed')) return { provider: 'kick', embedUrl: url.toString() };
            if (path.startsWith('/clips/')) {
                const clipId = path.split('/clips/')[1]?.split('/')[0] || '';
                if (!clipId) return null;
                return { provider: 'kick', embedUrl: `https://kick.com/embed/clips/${encodeURIComponent(clipId)}` };
            }
            if (path.startsWith('/video/')) {
                const videoId = path.split('/video/')[1]?.split('/')[0] || '';
                if (!videoId) return null;
                return { provider: 'kick', embedUrl: `https://kick.com/embed/video/${encodeURIComponent(videoId)}` };
            }
            const channel = path.split('/').filter(Boolean)[0] || '';
            if (channel) return { provider: 'kick', embedUrl: `https://kick.com/embed/${encodeURIComponent(channel)}` };
            return { provider: 'kick', embedUrl: url.toString() };
        }

        if (host.endsWith('steamcommunity.com') || host.endsWith('steampowered.com')) {
            return { provider: 'steam', embedUrl: url.toString() };
        }
    } catch (e) {
        return null;
    }
    return null;
}

// --- Autenticación y perfil ---
auth.onAuthStateChanged(async (user) => {
    if (user) {
        // Commander Panel is TOP: blocked users cannot use the site
        const blockedSnap = await rtdb.ref('users/' + user.uid + '/blocked').once('value');
        if (blockedSnap.val() === true) {
            await auth.signOut();
            window.location.href = '/login?blocked=1';
            return;
        }
        currentUser = user;
        await loadUserProfile(user.uid);
        await updateStreak(user.uid);
        updateMiniProfile();
        checkDailyUploads(user.uid);
        initForgeLatestLive();
        loadGallery();
        ensureResolvedBattleCallSeed().then(() => loadThreads());
        loadChatMessages();
        loadHeraldFeed();
        loadFeaturedMembers();
        initPresence();
        initSiteActivityListener();
        tryClaimWeeklyFameBonus();
        initBattleCallListener();
        loadMentorsList();
        loadAnnals();
        updateBattleHornCount();
        initProfileScroll();
        initAchievements();
        initDragDropPanels();
        initThemeFury();
        initStreamerMode();
        initAudioAmbient();
        initPlayerCardGenerator();
        initNotificationsToggle();
        registerServiceWorker();
    } else {
        window.location.href = '/login';
    }
});

const RANK_LABELS = {
    boss_of_the_state: 'Boss of the State',
    commander: 'Commander',
    divisional_commander: 'Comandante Divisional',
    comandante_divisional: 'Comandante Divisional',
    tribal_warrior: 'Guerrero Tribal',
    tribal: 'Tribal'
};

function normalizeRank(rank) {
    return (rank || 'tribal').toLowerCase().replace(/\s+/g, '_');
}

function getForgePhotoLimit(rank) {
    const r = normalizeRank(rank);
    if (r === 'boss_of_the_state' || r === 'commander') return null;
    if (r === 'divisional_commander' || r === 'comandante_divisional') return 50;
    return 2;
}

function isPhotoLimitReached(count, rank) {
    const lim = getForgePhotoLimit(rank);
    if (lim === null) return false;
    return count >= lim;
}

function formatPhotoBadge(count, rank) {
    const lim = getForgePhotoLimit(rank);
    if (lim === null) return '∞ fotos';
    const left = Math.max(0, lim - count);
    return `${left}/${lim} fotos`;
}

async function loadUserProfile(uid) {
    try {
        const [userSnap, essenceSnap] = await Promise.all([
            rtdb.ref('users/' + uid).once('value'),
            rtdb.ref('users/' + uid + '/essence').once('value')
        ]);
        const d = userSnap.val();
        const ess = essenceSnap.val();
        const rawRank = (d?.rango || d?.rank || 'tribal');
        const rank = typeof rawRank === 'string' ? rawRank.toLowerCase().replace(/\s+/g, '_') : 'tribal';
        if (d && (d.nick != null || d.nickname != null || d.photoURL != null || d.communityHonor != null)) {
            userProfile = {
                nickname: d.nick || d.nickname || currentUser.displayName || 'Jugador',
                photoURL: d.photoURL || currentUser.photoURL || DEFAULT_AVATAR,
                communityHonor: d.communityHonor ?? 0,
                rank: rank,
                rankLabel: RANK_LABELS[rank] || rank,
                status: d.status || null,
                mentorAvailable: !!d.mentorAvailable,
                mainGame: d.mainGame || d.preferredGame || null,
                nexusLevel: (ess && typeof ess.level === 'number') ? ess.level : 1,
                communityLegendFx: d?.profileCustomization?.communityLegendFx || null,
                profileCustomization: d?.profileCustomization || null
            };
            if (userProfile.communityHonor === undefined) {
                userProfile.communityHonor = 0;
                await rtdb.ref('users/' + uid).update({ communityHonor: 0 });
            }
        } else {
            userProfile = {
                nickname: currentUser.displayName || 'Jugador',
                photoURL: currentUser.photoURL || DEFAULT_AVATAR,
                communityHonor: 0,
                rank: 'tribal',
                rankLabel: 'Tribal',
                status: null,
                mentorAvailable: false,
                mainGame: null,
                nexusLevel: 1,
                communityLegendFx: null
            };
            await rtdb.ref('users/' + uid).update({
                nick: userProfile.nickname,
                photoURL: userProfile.photoURL,
                communityHonor: 0,
                rango: 'tribal'
            });
        }
    } catch (e) {
        console.warn('loadUserProfile', e);
        userProfile = {
            nickname: currentUser.displayName || 'Jugador',
            photoURL: currentUser.photoURL || DEFAULT_AVATAR,
            communityHonor: 0,
            rank: 'tribal',
            rankLabel: 'Tribal',
            status: null,
            mentorAvailable: false,
            mainGame: null,
            nexusLevel: 1,
            communityLegendFx: null
        };
    }
}

async function addTokens(uid, amount, imageId) {
    if (!amount || amount <= 0 || !imageId) return 0;
    if (uid !== currentUser?.uid) return 0;
    try {
        if (typeof firebase.functions !== 'function') {
            console.warn('addTokens: Cloud Functions no disponibles');
            return 0;
        }
        const result = await firebase.functions().httpsCallable('awardCommunityForgeUploadTokens')({ imageId });
        const granted = Number(result.data && result.data.granted) || 0;
        if (granted > 0 && userProfile) {
            userProfile.tokens = (userProfile.tokens || 0) + granted;
        }
        return granted;
    } catch (e) {
        const code = e && e.code ? String(e.code) : '';
        if (!code.includes('already-exists')) {
            console.warn('addTokens', e);
        }
        return 0;
    }
}

function getHonorTier(honor) {
    const h = Number(honor) || 0;
    if (h >= 5000) return 'legend';
    if (h >= 1000) return 'veteran';
    if (h >= 300) return 'rising';
    return 'base';
}

function honorTierLabel(tier) {
    if (tier === 'legend') return 'Leyenda del Nexo';
    if (tier === 'veteran') return 'Veterano de Honor';
    if (tier === 'rising') return 'Guerrero en ascenso';
    return 'Honor inicial';
}

function openCommunityUser(uid, nick, action) {
    if (!uid || uid === 'seed_author_valorant' || uid === 'seed_mentor_pulse' || uid === 'seed_igl_shadow') {
        showNotification((nick || 'Jugador') + ' — perfil de ejemplo del Consejo.', 'info');
        return;
    }
    if (action === 'chat') {
        window.location.href = '/dashboard?uid=' + encodeURIComponent(uid) + '&chat=1';
        return;
    }
    window.location.href = '/dashboard?uid=' + encodeURIComponent(uid);
}

function bindCommunityUserClicks(root) {
    if (!root) return;
    root.querySelectorAll('[data-community-uid]').forEach((el) => {
        if (el.dataset.bound === '1') return;
        el.dataset.bound = '1';
        el.addEventListener('click', (e) => {
            e.stopPropagation();
            openCommunityUser(el.dataset.communityUid, el.dataset.communityNick || '', el.dataset.communityAction || 'profile');
        });
    });
}

async function loadFriendsList() {
    const list = document.getElementById('friendsList');
    if (!list || !currentUser) return;
    try {
        const snap = await rtdb.ref('sgFriends/' + currentUser.uid).once('value');
        if (!snap.exists()) {
            list.innerHTML = '<p class="friends-empty">Aún no tienes amigos. Búscalos en el chat o en Campeones del Nexo.</p>';
            return;
        }
        const uids = Object.keys(snap.val() || {});
        const profiles = await Promise.all(uids.map(async (uid) => {
            const u = await rtdb.ref('users/' + uid).once('value');
            const d = u.val() || {};
            return {
                uid,
                nick: d.nick || d.nickname || 'Jugador',
                photo: d.photoURL || DEFAULT_AVATAR,
                honor: d.communityHonor || 0
            };
        }));
        list.innerHTML = profiles.map((p) => `
            <div class="friend-item" data-community-uid="${escapeAttr(p.uid)}" data-community-nick="${escapeAttr(p.nick)}" data-community-action="profile" title="Ver perfil">
                <img src="${escapeAttr(p.photo)}" alt="" onerror="this.src='${DEFAULT_AVATAR}'">
                <div class="friend-item-info">
                    <strong>${escapeHtml(p.nick)}</strong>
                    <span class="honor-tier-${getHonorTier(p.honor)}">${p.honor} Honor</span>
                </div>
                <button type="button" class="friend-chat-btn" data-community-uid="${escapeAttr(p.uid)}" data-community-nick="${escapeAttr(p.nick)}" data-community-action="chat" title="Enviar mensaje"><i class="fas fa-comment"></i></button>
            </div>`).join('');
        bindCommunityUserClicks(list);
        list.querySelectorAll('.friend-chat-btn').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                openCommunityUser(btn.dataset.communityUid, btn.dataset.communityNick, 'chat');
            });
        });
    } catch (e) {
        list.innerHTML = '<p class="friends-empty">No se pudo cargar la lista de amigos.</p>';
    }
}

const RESOLVED_BATTLE_THREAD_ID = 'demo_resolved_mirage_b';

async function ensureResolvedBattleCallSeed() {
    const ref = rtdb.ref('forumThreads/' + RESOLVED_BATTLE_THREAD_ID);
    try {
        const snap = await ref.once('value');
        if (snap.exists()) return;
        const created = Date.now() - (3 * 24 * 60 * 60 * 1000);
        const resolved = created + (2 * 24 * 60 * 60 * 1000);
        await ref.set({
            title: '[RESUELTA] Perdimos el B en Mirage 12-10 — ¿dónde se rompió la exec?',
            game: 'valorant',
            helpType: 'estrategia',
            authorId: 'seed_author_valorant',
            authorNick: 'NeonSpectre',
            authorPhoto: DEFAULT_AVATAR,
            authorMentorAvailable: false,
            createdAt: created,
            lastReplyAt: resolved,
            replyCount: 4,
            isHelpRequest: true,
            isResolved: true,
            resolvedAt: resolved,
            resolvedByNick: 'VeteranPulse',
            resolutionSummary: 'Ajustaron la exec: humo CT más temprano, Sova recon en B main y entrada coordinada a 1:38.',
            firstPost: 'Escuadrón, necesito ayuda táctica.\n\nPartida ranked Ascendant II. Mapa Mirage. Íbamos 10-8 y perdimos la ronda decisiva en B site.\n\nContexto:\n• Ejecutamos 3-1-1 con humo ventana y flash conector.\n• El duelista entró antes de que el humo CT cubriera del todo.\n• El sentinel colocó muro en market y nos partió la entrada.\n• Morimos 2v5 y cerraron 12-10.\n\nClip mental: entramos con buena util pero el timing entre conector y ventana estuvo desfasado ~2s.\n\n¿Qué ajustarían para la próxima vez? ¿Cambian a split A o insisten en B con otra rutina?',
            replies: [
                {
                    authorId: 'seed_mentor_pulse',
                    authorNick: 'VeteranPulse',
                    authorPhoto: DEFAULT_AVATAR,
                    body: 'El problema no fue el site, fue el retraso del humo CT. En Ascendant la ventana debe ir antes de la primera flash de conector. Prueba pausar 1s tras el humo ventana y manda recon de Sova a market antes de comprometer.',
                    timestamp: created + (6 * 60 * 60 * 1000),
                    isMentor: true
                },
                {
                    authorId: 'seed_igl_shadow',
                    authorNick: 'ShadowIGL',
                    authorPhoto: DEFAULT_AVATAR,
                    body: 'También revisen la posición del lurk en palace. Si no presionan A cuando el muro sale, el rotate de CT llega muy rápido a market. Un fake paso en A main abre la entrada real a B.',
                    timestamp: created + (18 * 60 * 60 * 1000),
                    isMentor: false
                },
                {
                    authorId: 'seed_author_valorant',
                    authorNick: 'NeonSpectre',
                    authorPhoto: DEFAULT_AVATAR,
                    body: 'Probamos hoy con humo CT primero y recon previo. Ganamos 13-9 la revancha. Gracias por el desglose.',
                    timestamp: created + (3 * 24 * 60 * 60 * 1000),
                    isMentor: false
                },
                {
                    authorId: 'seed_mentor_pulse',
                    authorNick: 'VeteranPulse',
                    authorPhoto: DEFAULT_AVATAR,
                    body: 'Excelente cierre. Marcada como resuelta. Recomendación final: graben el timing de util en practice mode y repitan la entrada 5 veces seguidas antes de ranked.',
                    timestamp: resolved,
                    isMentor: true,
                    isResolution: true
                }
            ]
        });
    } catch (e) {
        console.warn('ensureResolvedBattleCallSeed', e);
    }
}

function applyCommunityProfileFrame() {
    const wrap = document.getElementById('miniProfileAvatarWrap');
    if (!wrap || !userProfile) return;
    if (window.SGProfileCustomization && typeof window.SGProfileCustomization.applyAvatarFrame === 'function') {
        const db = (typeof firebase !== 'undefined' && firebase.database) ? firebase.database() : null;
        const apply = () => window.SGProfileCustomization.applyAvatarFrame(wrap, userProfile);
        if (db && window.SGProfileCustomization.loadAssets) {
            window.SGProfileCustomization.loadAssets(db).then(apply).catch(apply);
        } else {
            apply();
        }
    }
}

async function addHonorPoints(uid, points) {
    try {
        const ref = rtdb.ref('users/' + uid);
        await ref.transaction((current) => {
            const data = current || {};
            const newHonor = (data.communityHonor || 0) + points;
            return { ...data, communityHonor: newHonor };
        });
        if (uid === currentUser.uid) {
            userProfile.communityHonor = (userProfile.communityHonor || 0) + points;
            updateMiniProfile();
        }
        const el = document.getElementById('honorBarFill');
        const pts = document.getElementById('honorPoints');
        if (uid === currentUser.uid && userProfile) {
            const honor = userProfile.communityHonor ?? 0;
            const pct = Math.min((honor / 1000) * 100, 100);
            if (el) { el.style.width = pct + '%'; el.setAttribute('aria-valuenow', honor); }
            if (pts) {
                pts.textContent = honor;
                pts.className = 'honor-display-value honor-tier-' + getHonorTier(honor);
                pts.title = honorTierLabel(getHonorTier(honor));
            }
            const miniHonor = document.getElementById('miniHonorValue');
            if (miniHonor) {
                miniHonor.textContent = honor;
                miniHonor.className = 'mini-honor-value honor-tier-' + getHonorTier(honor);
                miniHonor.title = honorTierLabel(getHonorTier(honor));
            }
        }
    } catch (e) {
        showNotification('Error al actualizar honor', 'error');
    }
}

async function tryClaimWeeklyFameBonus() {
    if (!currentUser) return;
    try {
        const snap = await rtdb.ref('weeklyFameBonuses').once('value');
        if (!snap.exists()) return;
        snap.forEach((child) => {
            const d = child.val();
            if (d && d.userId === currentUser.uid) {
                const weekStart = child.key;
                rtdb.ref('users/' + currentUser.uid + '/weeklyBonuses/' + weekStart).once('value').then((bonusSnap) => {
                    if (bonusSnap.exists()) return;
                    rtdb.ref('users/' + currentUser.uid + '/weeklyBonuses/' + weekStart).set(true).then(() => {
                        addHonorPoints(currentUser.uid, 100);
                        pushActivity('honor', `¡<strong>Muro de la Fama</strong>! Recibiste +100 Honor por la imagen más reaccionada de la semana.`);
                        showNotification('¡+100 Honor por el Muro de la Fama!', 'success');
                    });
                });
            }
        });
    } catch (e) { /* ignore */ }
}

// --- Racha del Día: días seguidos entrando a Community ---
const MS_PER_DAY = 24 * 60 * 60 * 1000;
let userStreak = 0;

function toDateKey(date) {
    return date.toISOString ? date.toISOString().split('T')[0] : '';
}

async function updateStreak(uid) {
    try {
        const today = new Date();
        const todayKey = toDateKey(today);
        const ref = rtdb.ref('users/' + uid);
        const snap = await ref.once('value');
        const d = snap.val() || {};
        const lastVisit = d.lastCommunityVisit || '';
        const streak = d.communityStreak != null ? d.communityStreak : 0;

        let newStreak = streak;
        if (lastVisit === todayKey) {
            newStreak = streak;
        } else {
            const last = lastVisit ? new Date(lastVisit + 'T12:00:00') : null;
            const yesterdayKey = toDateKey(new Date(today.getTime() - MS_PER_DAY));
            if (!last || lastVisit === yesterdayKey) {
                newStreak = lastVisit === yesterdayKey ? streak + 1 : 1;
            } else {
                newStreak = 1;
            }
        }

        await ref.update({
            lastCommunityVisit: todayKey,
            communityStreak: newStreak
        });
        userStreak = newStreak;

        if (newStreak >= 2 && lastVisit === yesterdayKey) {
            await addHonorPoints(uid, 2);
            showNotification('Racha de ' + newStreak + ' días. +2 Honor.', 'success');
        }
    } catch (e) {
        userStreak = 0;
    }
}

async function pushActivity(type, html) {
    if (!currentUser) return;
    try {
        rtdb.ref('communityActivity').push({
            type,
            html,
            userId: currentUser.uid,
            userNick: userProfile.nickname,
            timestamp: Date.now()
        });
    } catch (e) { /* ignore */ }
    try {
        rtdb.ref('siteActivity').push({
            type,
            html,
            userId: currentUser.uid,
            userNick: userProfile.nickname,
            timestamp: Date.now()
        });
    } catch (e) { /* ignore */ }
}

async function checkDailyUploads(uid) {
    try {
        const today = new Date().toISOString().split('T')[0];
        const snap = await rtdb.ref('dailyUploads/' + uid + '/days/' + today).once('value');
        const val = snap.val();
        dailyUploadCount = val && val.count != null ? val.count : 0;
        dailyImageUploadCount = val && val.imageCount != null ? val.imageCount : 0;
    } catch (e) {
        dailyUploadCount = 0;
        dailyImageUploadCount = 0;
    }
    const badge = document.getElementById('remainingUploadsBadge');
    if (badge) {
        const rank = userProfile?.rank || 'tribal';
        badge.textContent = formatPhotoBadge(dailyImageUploadCount, rank);
    }
}

function playForgeEpicAnimation() {
    return new Promise((resolve) => {
        const overlay = document.getElementById('forgeEpicOverlay');
        if (!overlay) { resolve(); return; }
        overlay.classList.remove('phase-egg', 'phase-dragon', 'phase-done');
        overlay.classList.add('is-active');
        overlay.setAttribute('aria-hidden', 'false');
        requestAnimationFrame(() => {
            setTimeout(() => overlay.classList.add('phase-egg'), 500);
            setTimeout(() => overlay.classList.add('phase-dragon'), 1600);
            setTimeout(() => overlay.classList.add('phase-done'), 3800);
            setTimeout(() => {
                overlay.classList.remove('is-active', 'phase-egg', 'phase-dragon', 'phase-done');
                overlay.setAttribute('aria-hidden', 'true');
                resolve();
            }, 4500);
        });
    });
}

function buildForgeMediaHtml(data, title) {
    if (data.mediaType === 'video_local') {
        return `<video src="${escapeAttr(data.videoURL || '')}" preload="metadata" controls muted playsinline></video>`;
    }
    if (data.mediaType === 'image_local') {
        return `<img src="${escapeAttr(data.imageURL || '')}" alt="${escapeHtml(title)}" loading="lazy" onerror="this.src='${DEFAULT_AVATAR}'">`;
    }
    if (data.mediaType === 'embed') {
        return `<div class="forge-embed-shell"><iframe src="${escapeAttr(data.embedURL || '')}" loading="lazy" allowfullscreen referrerpolicy="strict-origin-when-cross-origin" sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-forms"></iframe></div>`;
    }
    return `<img src="${escapeHtml(data.imageURL || '')}" alt="${escapeHtml(title)}" onerror="this.src='${DEFAULT_AVATAR}'">`;
}

let forgeLatestListenerRef = null;
let forgeLatestRenderedKey = '';

function pickLatestForgeItem(snap) {
    if (!snap || !snap.exists()) return null;
    let latest = null;
    snap.forEach((child) => {
        const item = { id: child.key, ...child.val() };
        if (!latest || (item.timestamp || 0) > (latest.timestamp || 0)) latest = item;
    });
    return latest;
}

function renderForgeLatestShowcase(item) {
    const slot = document.getElementById('forgeLatestShowcase');
    if (!slot) return;
    if (!item) {
        slot.style.display = 'none';
        slot.innerHTML = '';
        forgeLatestRenderedKey = '';
        return;
    }
    const renderKey = item.id + ':' + (item.timestamp || 0) + ':' + (item.imageURL || item.videoURL || item.embedURL || '');
    if (forgeLatestRenderedKey === renderKey) return;
    forgeLatestRenderedKey = renderKey;

    const title = item.title || 'Sin título';
    const cacheBust = item.timestamp || Date.now();
    const mediaHtml = buildForgeMediaHtml(item, title).replace(
        /(src=")([^"]+)(")/g,
        (m, p1, url, p3) => `${p1}${url}${url.indexOf('?') >= 0 ? '&' : '?'}v=${cacheBust}${p3}`
    );
    const reactions = item.reactions || { fire: 0, precision: 0, troll: 0 };
    const reactedBy = item.reactedBy || {};
    const myReaction = currentUser ? reactedBy[currentUser.uid] : null;
    slot.style.display = 'block';
    slot.innerHTML = `
        <div class="forge-latest-label"><i class="fas fa-fire-alt"></i> Último recuerdo forjado</div>
        <div class="forge-latest-media">${mediaHtml}</div>
        <div class="forge-latest-meta">
            <strong>${escapeHtml(title)}</strong>
            <span>${escapeHtml(item.userNick || 'Jugador')} · ${new Date(item.timestamp || Date.now()).toLocaleString('es-ES', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
        </div>
        <div class="forge-latest-reactions" data-image-id="${escapeAttr(item.id)}">
            <button type="button" class="forge-reaction-btn ${myReaction === 'fire' ? 'active' : ''}" data-reaction="fire" title="Fuego">🔥 ${reactions.fire || 0}</button>
            <button type="button" class="forge-reaction-btn ${myReaction === 'precision' ? 'active' : ''}" data-reaction="precision" title="Precisión">🎯 ${reactions.precision || 0}</button>
            <button type="button" class="forge-reaction-btn ${myReaction === 'troll' ? 'active' : ''}" data-reaction="troll" title="Troll">🤡 ${reactions.troll || 0}</button>
        </div>`;
    const reactWrap = slot.querySelector('.forge-latest-reactions');
    if (reactWrap) {
        reactWrap.addEventListener('click', (e) => {
            const btn = e.target.closest('.forge-reaction-btn');
            if (btn) addReactionToImage(item.id, btn.getAttribute('data-reaction'));
        });
    }
}

function initForgeLatestLive() {
    if (forgeLatestListenerRef) {
        forgeLatestListenerRef.off();
        forgeLatestListenerRef = null;
    }
    const ref = rtdb.ref('communityImages').orderByChild('timestamp').limitToLast(1);
    const apply = (snap) => renderForgeLatestShowcase(pickLatestForgeItem(snap));
    ref.once('value').then(apply);
    ref.on('value', apply);
    forgeLatestListenerRef = ref;
}

function setForgeMode(mode) {
    forgeUploadMode = mode === 'video_local' ? 'video_local' : 'image_local';
    const videoBtn = document.getElementById('forgeModeVideoBtn');
    const imageBtn = document.getElementById('forgeModeImageBtn');
    const fileFields = document.getElementById('forgeFileFields');
    const imageFields = document.getElementById('forgeImageFields');
    const titleField = document.getElementById('forgeTitleField');
    const fileInput = document.getElementById('fileUploadInput');
    const imageInput = document.getElementById('forgeImageInput');
    const previewArea = document.getElementById('forgePreviewArea');
    const previewVideo = document.getElementById('forgePreviewVideo');
    const previewImg = document.getElementById('forgePreviewImage');

    if (videoBtn) videoBtn.classList.toggle('active', forgeUploadMode === 'video_local');
    if (imageBtn) imageBtn.classList.toggle('active', forgeUploadMode === 'image_local');
    if (fileFields) fileFields.style.display = forgeUploadMode === 'video_local' ? 'block' : 'none';
    if (imageFields) imageFields.style.display = forgeUploadMode === 'image_local' ? 'block' : 'none';
    if (titleField) titleField.style.display = 'block';
    if (previewArea) previewArea.style.display = 'flex';
    if (previewImg) previewImg.style.display = 'none';
    if (previewVideo) {
        previewVideo.style.display = 'none';
        previewVideo.pause();
        previewVideo.removeAttribute('src');
        previewVideo.load();
    }
    if (fileInput) fileInput.value = '';
    if (imageInput) imageInput.value = '';
    currentForgeSelection = null;
}

function populateForgeGameSelectFromPlayzone() {
    const select = document.getElementById('forgeGameSelect');
    if (!select) return;
    const games = (window.PlayzoneGames && Array.isArray(window.PlayzoneGames.all)) ? window.PlayzoneGames.all : [];
    if (!games.length) {
        select.innerHTML = `
            <option value="Counter-Strike 2">Counter-Strike 2</option>
            <option value="Valorant">Valorant</option>
            <option value="League of Legends">League of Legends</option>
        `;
        return;
    }
    const options = games
        .filter((g) => g && g.id && g.id !== 'Otro')
        .map((g) => `<option value="${escapeAttr(g.id)}">${escapeHtml(g.id)}</option>`)
        .join('');
    select.innerHTML = options || '<option value="Counter-Strike 2">Counter-Strike 2</option>';
}

document.getElementById('forgeUploadArea').addEventListener('click', () => {
    if (forgeUploadMode === 'video_local') document.getElementById('fileUploadInput').click();
    else document.getElementById('forgeImageInput').click();
});
document.getElementById('forgeModeVideoBtn').addEventListener('click', () => setForgeMode('video_local'));
document.getElementById('forgeModeImageBtn').addEventListener('click', () => setForgeMode('image_local'));
document.getElementById('triggerFileUpload').addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    setForgeMode('video_local');
    document.getElementById('fileUploadInput').click();
});
document.getElementById('triggerImageUpload').addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    setForgeMode('image_local');
    document.getElementById('forgeImageInput').click();
});
document.getElementById('forgeFileFields').addEventListener('click', (e) => {
    if (e.target && e.target.id === 'fileUploadInput') return;
    document.getElementById('fileUploadInput').click();
});
document.getElementById('forgeImageFields').addEventListener('click', (e) => {
    if (e.target && e.target.id === 'forgeImageInput') return;
    document.getElementById('forgeImageInput').click();
});
setForgeMode('image_local');
populateForgeGameSelectFromPlayzone();

document.getElementById('forgeImageInput').addEventListener('change', function(e) {
    const file = e.target.files[0];
    if (!file) return;
    const rank = userProfile?.rank || 'tribal';
    if (isPhotoLimitReached(dailyImageUploadCount, rank)) {
        showNotification('Límite de fotos de hoy alcanzado.', 'error');
        e.target.value = '';
        return;
    }
    if (!FORGE_ALLOWED_IMAGE_TYPES.includes(file.type)) {
        showNotification('Usa JPG, PNG o WebP.', 'error');
        e.target.value = '';
        return;
    }
    if (file.size > FORGE_IMAGE_MAX_BYTES) {
        showNotification('La imagen es demasiado grande (máx. 12MB).', 'error');
        e.target.value = '';
        return;
    }
    currentForgeSelection = { type: 'image_local', file: file };
    const previewArea = document.getElementById('forgePreviewArea');
    const img = document.getElementById('forgePreviewImage');
    const video = document.getElementById('forgePreviewVideo');
    if (video) { video.style.display = 'none'; video.removeAttribute('src'); }
    if (img) {
        img.style.display = 'block';
        img.src = URL.createObjectURL(file);
    }
    if (previewArea) previewArea.style.display = 'flex';
});

document.getElementById('fileUploadInput').addEventListener('change', function(e) {
    const file = e.target.files[0];
    if (file) {
        if (dailyUploadCount >= FORGE_VIDEO_DAILY_LIMIT) {
            showNotification('Límite diario de videos alcanzado. ¡Vuelve mañana!', 'error');
            return;
        }
        const isVideo = file.type.startsWith('video/');
        if (!isVideo || !FORGE_ALLOWED_VIDEO_TYPES.includes(file.type)) {
            showNotification('Formato no permitido. Usa .mp4 o .webm.', 'error');
            e.target.value = '';
            return;
        }
        const maxAllowed = FORGE_VIDEO_MAX_BYTES;
        if (file.size > maxAllowed) {
            showNotification('Archivo demasiado grande. Máximo 20MB (video).', 'error');
            e.target.value = '';
            return;
        }
        currentForgeSelection = { type: 'video_local', file };
        const previewArea = document.getElementById('forgePreviewArea');
        const img = document.getElementById('forgePreviewImage');
        const video = document.getElementById('forgePreviewVideo');
        img.style.display = 'none';
        video.style.display = 'block';
        video.src = URL.createObjectURL(file);
        previewArea.style.display = 'flex';
    }
});

let isForgeUploading = false;

document.getElementById('submitForgeBtn').addEventListener('click', async () => {
    if (isForgeUploading) return;
    const file = document.getElementById('fileUploadInput').files[0];
    const imageFile = document.getElementById('forgeImageInput').files[0];
    const titleInputValue = document.getElementById('forgeImageTitle').value.trim();
    const game = document.getElementById('forgeGameSelect').value;
    const rank = userProfile?.rank || 'tribal';
    if (!titleInputValue) {
        showNotification('Añade un título para tu proeza.', 'error');
        return;
    }
    if (forgeUploadMode === 'video_local' && !file) {
        showNotification('Selecciona un video local.', 'error');
        return;
    }
    if (forgeUploadMode === 'video_local' && (!FORGE_ALLOWED_VIDEO_TYPES.includes(file.type) || file.size > FORGE_VIDEO_MAX_BYTES)) {
        showNotification('El video no cumple formato o tamaño permitido.', 'error');
        return;
    }
    if (forgeUploadMode === 'image_local' && !imageFile) {
        showNotification('Selecciona una foto para subir.', 'error');
        return;
    }
    if (forgeUploadMode === 'image_local' && isPhotoLimitReached(dailyImageUploadCount, rank)) {
        showNotification('Límite de fotos de hoy alcanzado.', 'error');
        return;
    }
    if (forgeUploadMode === 'image_local' && (!FORGE_ALLOWED_IMAGE_TYPES.includes(imageFile.type) || imageFile.size > FORGE_IMAGE_MAX_BYTES)) {
        showNotification('La foto no cumple formato o tamaño permitido.', 'error');
        return;
    }
    if (forgeUploadMode === 'video_local' && dailyUploadCount >= FORGE_VIDEO_DAILY_LIMIT) {
        showNotification('Límite diario de videos alcanzado. ¡Vuelve mañana!', 'error');
        return;
    }
    const user = auth.currentUser;
    if (!user) {
        showNotification('Debes iniciar sesión. Recarga la página.', 'error');
        return;
    }
    const submitBtn = document.getElementById('submitForgeBtn');
    if (!submitBtn) { isForgeUploading = false; return; }
    isForgeUploading = true;
    submitBtn.disabled = true;
    const originalText = submitBtn.textContent;
    submitBtn.textContent = 'Subiendo…';

    let weeklyUrlReservationRef = null;
    try {
        if (forgeUploadMode !== 'image_local' && (userProfile?.communityHonor || 0) < FORGE_UPLOAD_COST_HONOR) {
            showNotification(`Necesitas ${FORGE_UPLOAD_COST_HONOR} de Honor para competir en Clips de la Semana.`, 'error');
            return;
        }
        const cooldown = await acquireForgePublishCooldown(currentUser.uid);
        if (!cooldown.ok) {
            const remaining = Math.max(1, Math.ceil((FORGE_PUBLISH_COOLDOWN_MS - (cooldown.now - cooldown.previous)) / 1000));
            showNotification(`Espera ${remaining}s antes de publicar otra proeza.`, 'error');
            return;
        }
        const title = titleInputValue;
        await user.getIdToken(true);
        let mediaType = forgeUploadMode;
        let videoUrl = '';
        let embedUrl = '';
        let imageUrl = '';
        if (forgeUploadMode === 'video_local' && file) {
            mediaType = 'video_local';
            const storageRef = storage.ref(`community_clips/${user.uid}/${Date.now()}_${file.name}`);
            const uploadTask = await storageRef.put(file);
            videoUrl = await uploadTask.ref.getDownloadURL();
        } else if (forgeUploadMode === 'image_local' && imageFile) {
            mediaType = 'image_local';
            if (!window.SGImageUtils || !window.SGImageUtils.compressImageToBlob) {
                showNotification('Error: utilidad de imagen no cargada. Recarga la página.', 'error');
                return;
            }
            submitBtn.textContent = 'Optimizando foto…';
            const blob = await window.SGImageUtils.compressImageToBlob(imageFile, { maxDim: 1920, quality: 0.85, targetBytes: 800 * 1024 });
            const todayKey = new Date().toISOString().split('T')[0];
            const storageRef = storage.ref(`community_images/${user.uid}/${todayKey}_${Date.now()}.jpg`);
            const uploadTask = await storageRef.put(blob, { contentType: 'image/jpeg' });
            imageUrl = await uploadTask.ref.getDownloadURL();
        }

        const ts = Date.now();
        const imageRef = await rtdb.ref('communityImages').push({
            userId: currentUser.uid,
            userNick: userProfile.nickname,
            userPhoto: userProfile.photoURL || DEFAULT_AVATAR,
            title,
            game,
            mediaType,
            imageURL: imageUrl,
            videoURL: mediaType === 'video_local' ? videoUrl : '',
            embedURL: mediaType === 'embed' ? embedUrl : '',
            userVisualFx: (userProfile.communityLegendFx === 'legendary' && (userProfile.communityHonor || 0) >= LEGEND_FX_HONOR_REQUIRED) ? 'legendary' : null,
            timestamp: ts,
            reactions: { fire: 0, precision: 0, troll: 0 },
            reactedBy: {}
        });
        if (weeklyUrlReservationRef && mediaType === 'embed') {
            await weeklyUrlReservationRef.update({
                imageId: imageRef.key || '',
                committedAt: Date.now()
            });
        }
        const imageId = imageRef.key;
        renderForgeLatestShowcase({
            id: imageId,
            userId: currentUser.uid,
            userNick: userProfile.nickname,
            title,
            mediaType,
            imageURL: imageUrl,
            videoURL: mediaType === 'video_local' ? videoUrl : '',
            embedURL: mediaType === 'embed' ? embedUrl : '',
            timestamp: ts
        });
        await rtdb.ref(`${GLOBAL_CHAT_NODE}/${GLOBAL_CHAT_ROOM_ID}/messages`).push({
            userId: currentUser.uid,
            userNick: userProfile.nickname,
            userPhoto: userProfile.photoURL || DEFAULT_AVATAR,
            nick: userProfile.nickname,
            photoURL: userProfile.photoURL || DEFAULT_AVATAR,
            type: 'forge_image',
            imageId,
            mediaType,
            imageURL: imageUrl,
            videoURL: mediaType === 'video_local' ? videoUrl : '',
            embedURL: mediaType === 'embed' ? embedUrl : '',
            title,
            game,
            timestamp: ts,
            reactions: { fire: 0, precision: 0, troll: 0 },
            reactedBy: {}
        });
        const today = new Date().toISOString().split('T')[0];
        const nextClipCount = forgeUploadMode === 'video_local' ? dailyUploadCount + 1 : dailyUploadCount;
        const nextImageCount = forgeUploadMode === 'image_local' ? dailyImageUploadCount + 1 : dailyImageUploadCount;
        await rtdb.ref('dailyUploads/' + currentUser.uid + '/days/' + today).set({ count: nextClipCount, imageCount: nextImageCount });
        if (forgeUploadMode !== 'image_local') {
            await addHonorPoints(currentUser.uid, -FORGE_UPLOAD_COST_HONOR);
        }
        const activityLabel = forgeUploadMode === 'image_local' ? 'forjó una foto' : 'forjó un clip';
        await pushActivity('forge', `<strong>${escapeHtml(userProfile.nickname)}</strong> ${activityLabel}: ${escapeHtml(title)}`);
        try {
            await rtdb.ref('forgerSealThisWeek/' + currentUser.uid).set(Date.now());
            const userSnap = await rtdb.ref('users/' + currentUser.uid + '/firstForgeAt').once('value');
            if (!userSnap.exists()) await rtdb.ref('users/' + currentUser.uid).update({ firstForgeAt: Date.now() });
        } catch (e) { /* ignore */ }
        const grantedTokens = await addTokens(currentUser.uid, FORGE_UPLOAD_TOKEN_REWARD, imageId);
        showNotification(
            forgeUploadMode === 'image_local'
                ? (grantedTokens > 0
                    ? `Recuerdo forjado. +${grantedTokens} Tokens.`
                    : 'Recuerdo forjado correctamente.')
                : (grantedTokens > 0
                    ? `Video publicado. -${FORGE_UPLOAD_COST_HONOR} Honor. +${grantedTokens} Tokens.`
                    : `Video publicado. -${FORGE_UPLOAD_COST_HONOR} Honor.`),
            grantedTokens > 0 ? 'success' : 'info'
        );
        dailyUploadCount = nextClipCount;
        dailyImageUploadCount = nextImageCount;
        await checkDailyUploads(currentUser.uid);
        document.getElementById('forgePreviewArea').style.display = 'none';
        document.getElementById('fileUploadInput').value = '';
        const forgeImageInput = document.getElementById('forgeImageInput');
        if (forgeImageInput) forgeImageInput.value = '';
        document.getElementById('forgeImageTitle').value = '';
        const pv = document.getElementById('forgePreviewVideo');
        if (pv) { pv.pause(); pv.removeAttribute('src'); pv.load(); }

        await playForgeEpicAnimation();
        loadGallery();
        setTimeout(loadGallery, 400);
        currentForgeSelection = null;
        isForgeUploading = false;
        submitBtn.disabled = false;
        submitBtn.textContent = originalText;
    } catch (err) {
        if (weeklyUrlReservationRef) {
            try { await weeklyUrlReservationRef.remove(); } catch (e) { /* ignore */ }
        }
        showNotification('Error: ' + (err.message || 'Storage no disponible'), 'error');
        isForgeUploading = false;
        submitBtn.disabled = false;
        submitBtn.textContent = originalText;
    } finally {
        isForgeUploading = false;
        submitBtn.disabled = false;
        submitBtn.textContent = originalText;
    }
});

function getWeekStart() {
    return getStartOfWeekMs(Date.now(), 0);
}

async function addReactionToImage(imageId, reactionType) {
    if (!currentUser || !['fire', 'precision', 'troll'].includes(reactionType)) return;
    const ref = rtdb.ref('communityImages/' + imageId);
    try {
        const beforeSnap = await ref.once('value');
        const before = beforeSnap.val() || {};
        const prevReaction = (before.reactedBy || {})[currentUser.uid] || null;
        const ownerId = before.userId || null;
        await ref.transaction((current) => {
            const data = current || {};
            const reactions = data.reactions || { fire: 0, precision: 0, troll: 0 };
            const reactedBy = data.reactedBy || {};
            const prev = reactedBy[currentUser.uid];
            if (prev === reactionType) {
                reactions[reactionType] = Math.max(0, (reactions[reactionType] || 0) - 1);
                delete reactedBy[currentUser.uid];
            } else {
                if (prev) reactions[prev] = Math.max(0, (reactions[prev] || 0) - 1);
                reactions[reactionType] = (reactions[reactionType] || 0) + 1;
                reactedBy[currentUser.uid] = reactionType;
            }
            return { ...data, reactions, reactedBy };
        });
        if (!prevReaction && ownerId && ownerId !== currentUser.uid) {
            await addHonorPoints(currentUser.uid, FORGE_VOTE_REWARD_HONOR);
        }
        await maybeAnnounceClipMomentum(imageId);
        const updatedSnap = await ref.once('value');
        if (updatedSnap.exists()) {
            forgeLatestRenderedKey = '';
            renderForgeLatestShowcase({ id: imageId, ...updatedSnap.val() });
        }
        loadGallery();
    } catch (e) {
        showNotification('No se pudo registrar la reacción', 'error');
    }
}

async function addReactionFromChat(imageId, reactionType, messageId) {
    if (!currentUser || !messageId) return;
    await addReactionToImage(imageId, reactionType);
    try {
        const imgSnap = await rtdb.ref('communityImages/' + imageId).once('value');
        const d = imgSnap.val();
        if (d && d.reactions && d.reactedBy) {
            const msgRef = rtdb.ref(`${GLOBAL_CHAT_NODE}/${GLOBAL_CHAT_ROOM_ID}/messages/${messageId}`);
            await msgRef.update({ reactions: d.reactions, reactedBy: d.reactedBy });
        }
    } catch (e) { /* silencio si falla sync a mensaje */ }
}

async function maybeAnnounceClipMomentum(imageId) {
    try {
        const snap = await rtdb.ref('communityImages/' + imageId).once('value');
        const d = snap.val();
        if (!d) return;
        const fireVotes = (d.reactions && d.reactions.fire) || 0;
        const recent = Date.now() - (d.timestamp || 0) < (6 * 60 * 60 * 1000);
        if (!recent || fireVotes < 5) return;
        const milestone = fireVotes >= 20 ? '20' : fireVotes >= 10 ? '10' : '5';
        const gateRef = rtdb.ref('clipMomentumAnnouncements/' + imageId + '_' + milestone);
        const gateSnap = await gateRef.once('value');
        if (gateSnap.exists()) return;
        await gateRef.set({ at: Date.now(), milestone });
        await rtdb.ref(`${GLOBAL_CHAT_NODE}/${GLOBAL_CHAT_ROOM_ID}/messages`).push({
            userId: NEXUS_BOT_UID,
            userNick: 'Nexo Bot',
            userPhoto: 'community.png',
            text: `🔥 ¡El clip de ${d.userNick || 'Jugador'} está en racha! Míralo en La Forja.`,
            type: 'bot',
            timestamp: firebase.database.ServerValue.TIMESTAMP
        });
    } catch (e) { /* ignore */ }
}

function renderWeeklyWinnerSpotlight(item) {
    const emptyEl = document.getElementById('weeklyWinnerEmpty');
    const playerEl = document.getElementById('weeklyWinnerPlayer');
    const iframeEl = document.getElementById('weeklyWinnerIframe');
    const titleEl = document.getElementById('weeklyWinnerTitle');
    const authorEl = document.getElementById('weeklyWinnerAuthor');
    if (!emptyEl || !playerEl || !iframeEl || !titleEl || !authorEl) return;
    if (!item) {
        emptyEl.style.display = 'block';
        playerEl.style.display = 'none';
        iframeEl.removeAttribute('src');
        iframeEl.style.display = 'none';
        return;
    }
    emptyEl.style.display = 'none';
    playerEl.style.display = 'grid';
    titleEl.textContent = item.title || 'Sin título';
    authorEl.textContent = `Forjado por ${item.userNick || 'Jugador'} · 🔥 ${((item.reactions || {}).fire || 0)} fuego`;
    if (item.mediaType === 'embed' && item.embedURL) {
        iframeEl.style.display = 'block';
        iframeEl.src = item.embedURL;
        const mediaSlot = playerEl.querySelector('.weekly-winner-media-fallback');
        if (mediaSlot) mediaSlot.remove();
    } else {
        iframeEl.removeAttribute('src');
        iframeEl.style.display = 'none';
        let mediaSlot = playerEl.querySelector('.weekly-winner-media-fallback');
        if (!mediaSlot) {
            mediaSlot = document.createElement('div');
            mediaSlot.className = 'weekly-winner-media-fallback';
            playerEl.insertBefore(mediaSlot, playerEl.querySelector('.weekly-winner-meta'));
        }
        mediaSlot.innerHTML = buildForgeMediaHtml(item, item.title || '');
    }
}

async function loadGallery() {
    try {
        const snap = await rtdb.ref('communityImages').orderByChild('timestamp').limitToLast(50).once('value');
        if (!snap.exists() || !snap.hasChildren()) return;

        const items = [];
        snap.forEach((child) => items.push({ id: child.key, ...child.val() }));

        const now = Date.now();
        const thisWeekStart = getStartOfWeekMs(now, 0);
        const prevWeekStart = getStartOfWeekMs(now, -1);
        const nextWeekAfterPrev = getStartOfWeekMs(now, 0);
        let thisWeekWinner = null;
        let previousWeekWinner = null;
        let maxFireThisWeek = -1;
        let maxFirePrevWeek = -1;
        items.forEach((item) => {
            const ts = item.timestamp || 0;
            const fireVotes = ((item.reactions || {}).fire || 0);
            if (ts >= thisWeekStart && fireVotes > maxFireThisWeek) {
                maxFireThisWeek = fireVotes;
                thisWeekWinner = item;
            }
            if (ts >= prevWeekStart && ts < nextWeekAfterPrev && fireVotes > maxFirePrevWeek) {
                maxFirePrevWeek = fireVotes;
                previousWeekWinner = item;
            }
        });

        if (thisWeekWinner) {
            rtdb.ref('weeklyClipWinners/' + thisWeekStart).transaction((cur) => {
                if (cur && cur.imageId) return cur;
                return {
                    imageId: thisWeekWinner.id,
                    userId: thisWeekWinner.userId,
                    userNick: thisWeekWinner.userNick || 'Jugador',
                    title: thisWeekWinner.title || 'Sin título',
                    fireVotes: (thisWeekWinner.reactions?.fire || 0),
                    timestamp: Date.now()
                };
            });
        }
        if (previousWeekWinner) {
            rtdb.ref('weeklyClipWinners/' + prevWeekStart).transaction((cur) => {
                if (cur && cur.imageId) return cur;
                return {
                    imageId: previousWeekWinner.id,
                    userId: previousWeekWinner.userId,
                    userNick: previousWeekWinner.userNick || 'Jugador',
                    title: previousWeekWinner.title || 'Sin título',
                    fireVotes: (previousWeekWinner.reactions?.fire || 0),
                    timestamp: Date.now(),
                    prizeGranted: false
                };
            }).then(async ({ snapshot }) => {
                const winnerNode = snapshot?.val() || {};
                if (winnerNode.userId && winnerNode.prizeGranted !== true) {
                    await addHonorPoints(winnerNode.userId, WEEKLY_GRAND_PRIZE_HONOR);
                    await rtdb.ref('users/' + winnerNode.userId).update({
                        temporaryRankBoost: {
                            rank: 'divisional_commander',
                            until: Date.now() + (30 * 24 * 60 * 60 * 1000)
                        }
                    });
                    await rtdb.ref('weeklyClipWinners/' + prevWeekStart).update({ prizeGranted: true, prizeGrantedAt: Date.now() });
                }
            }).catch(() => {});
        }

        renderWeeklyWinnerSpotlight(previousWeekWinner);
    } catch (e) { /* ignore weekly stats */ }
}

function openImageViewer(id, data) {
    const url = data.imageURL || data.videoURL || data.embedURL || '';
    const title = data.title || 'Sin título';
    if (url) window.open(url, '_blank');
    showNotification(title, 'info');
}

async function loadThreads() {
    const threadsDiv = document.getElementById('warCouncilThreads');
    if (!threadsDiv) return;
    threadsDiv.innerHTML = '<div class="nexus-skeleton-text"></div>'.repeat(3);
    try {
        const snap = await rtdb.ref('forumThreads').orderByChild('lastReplyAt').limitToLast(50).once('value');
        threadsDiv.innerHTML = '';
        if (!snap.exists() || !snap.hasChildren()) {
            threadsDiv.innerHTML = '<p class="threads-empty-state">Ningún tema aún. <strong>Crea uno</strong> o publica una Llamada a batalla.</p>';
            return;
        }
        const items = [];
        snap.forEach((child) => items.push({ id: child.key, ...child.val() }));
        let list = items.sort((a, b) => (b.lastReplyAt || 0) - (a.lastReplyAt || 0));
        if (filterBattleCallsOnly) list = list.filter((t) => t.isHelpRequest);
        list = list.slice(0, 15);
        if (list.length === 0) {
            threadsDiv.innerHTML = '<p class="threads-empty-state">No hay Llamadas a batalla activas.</p>';
            return;
        }
        list.forEach((item) => {
            const data = item;
            const threadEl = document.createElement('div');
            threadEl.className = 'thread-item' + (data.isHelpRequest ? ' thread-item-help' : '') + (data.isResolved ? ' thread-item-resolved' : '');
            const mentorBadge = data.authorMentorAvailable ? '<span class="thread-mentor-badge" title="Mentor disponible"><i class="fas fa-hands-helping"></i> Mentor</span>' : '';
            const resolvedBadge = data.isResolved ? '<span class="thread-resolved-badge" title="Llamada resuelta">✓ Resuelta</span>' : '';
            const helpBadge = data.isHelpRequest ? '<span class="thread-help-badge" title="Llamada a batalla">📯</span>' : '';
            threadEl.innerHTML = `
                <div class="thread-title">${helpBadge}${resolvedBadge}${escapeHtml(data.title)} ${mentorBadge}</div>
                <div class="thread-meta">
                    <span class="community-user-link" data-community-uid="${escapeAttr(data.authorId || '')}" data-community-nick="${escapeAttr(data.authorNick || '')}"><i class="fas fa-user"></i> ${escapeHtml(data.authorNick || 'Anónimo')}</span>
                    <span><i class="fas fa-reply"></i> ${data.replyCount || 0}</span>
                    <span><i class="fas fa-gamepad"></i> ${escapeHtml(data.game || 'general')}</span>
                </div>`;
            bindCommunityUserClicks(threadEl);
            threadEl.addEventListener('click', () => openThread(item.id, data));
            threadsDiv.appendChild(threadEl);
        });
    } catch (e) {
        threadsDiv.innerHTML = '<p class="threads-empty-state">Error al cargar hilos. Revisa permisos Realtime Database.</p>';
    }
}

function openThread(id, data) {
    const modal = document.getElementById('threadDetailModal');
    const box = document.getElementById('threadDetailContent');
    if (!modal || !box) {
        showNotification(data.title || 'Tema del foro', 'info');
        return;
    }
    const replies = Array.isArray(data.replies) ? data.replies : [];
    const resolvedBlock = data.isResolved ? `
        <div class="thread-detail-resolved">
            <i class="fas fa-check-circle"></i>
            <div>
                <strong>Llamada resuelta</strong>
                <p>${escapeHtml(data.resolutionSummary || 'La comunidad ayudó a cerrar este caso.')}</p>
                ${data.resolvedByNick ? `<small>Por ${escapeHtml(data.resolvedByNick)} · ${data.resolvedAt ? new Date(data.resolvedAt).toLocaleDateString('es-ES') : ''}</small>` : ''}
            </div>
        </div>` : '';
    const repliesHtml = replies.map((r) => `
        <div class="thread-reply-item${r.isResolution ? ' thread-reply-resolution' : ''}${r.isMentor ? ' thread-reply-mentor' : ''}">
            <div class="thread-reply-head">
                <span class="community-user-link" data-community-uid="${escapeAttr(r.authorId || '')}" data-community-nick="${escapeAttr(r.authorNick || '')}">${escapeHtml(r.authorNick || 'Jugador')}</span>
                ${r.isMentor ? '<span class="thread-mentor-badge"><i class="fas fa-hands-helping"></i> Mentor</span>' : ''}
                <span class="thread-reply-time">${r.timestamp ? new Date(r.timestamp).toLocaleString('es-ES', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''}</span>
            </div>
            <p>${escapeHtml(r.body || '')}</p>
        </div>`).join('');
    box.innerHTML = `
        <h2>${escapeHtml(data.title || 'Hilo del Consejo')}</h2>
        ${resolvedBlock}
        <div class="thread-detail-op">
            <div class="thread-detail-author">
                <span class="community-user-link" data-community-uid="${escapeAttr(data.authorId || '')}" data-community-nick="${escapeAttr(data.authorNick || '')}">${escapeHtml(data.authorNick || 'Anónimo')}</span>
                · ${escapeHtml(data.game || 'general')} · ${data.createdAt ? new Date(data.createdAt).toLocaleDateString('es-ES') : ''}
            </div>
            <p class="thread-detail-body">${escapeHtml(data.firstPost || '').replace(/\n/g, '<br>')}</p>
        </div>
        ${replies.length ? `<div class="thread-detail-replies"><h3>Respuestas (${replies.length})</h3>${repliesHtml}</div>` : ''}`;
    bindCommunityUserClicks(box);
    modal.style.display = 'flex';
}

document.getElementById('openNewThreadBtn').addEventListener('click', () => {
    document.getElementById('newThreadModal').style.display = 'flex';
});

document.getElementById('submitNewThread').addEventListener('click', async () => {
    const title = document.getElementById('newThreadTitle').value.trim();
    const game = document.getElementById('newThreadGame').value;
    const body = document.getElementById('newThreadBody').value.trim();
    if (!title || !body) {
        showNotification('Título y mensaje son obligatorios', 'error');
        return;
    }
    try {
        const now = Date.now();
        await rtdb.ref('forumThreads').push({
            title,
            game,
            authorId: currentUser.uid,
            authorNick: userProfile.nickname,
            authorPhoto: userProfile.photoURL || DEFAULT_AVATAR,
            authorMentorAvailable: !!userProfile.mentorAvailable,
            createdAt: now,
            lastReplyAt: now,
            replyCount: 0,
            firstPost: body
        });
        await addHonorPoints(currentUser.uid, 5);
        await pushActivity('forum', `<strong>${escapeHtml(userProfile.nickname)}</strong> creó el tema «${escapeHtml(title)}»`);
        closeModal('newThreadModal');
        document.getElementById('newThreadTitle').value = '';
        document.getElementById('newThreadBody').value = '';
        loadThreads();
        showNotification('Tema creado. ¡Que la batalla comience!', 'success');
    } catch (e) {
        showNotification('Error al crear tema: ' + (e.message || 'Revisa permisos'), 'error');
    }
});

// Chat global: mismo backend que Dashboard (Realtime Database = globalChat/main/messages)
const GLOBAL_CHAT_NODE = 'globalChat';
const GLOBAL_CHAT_ROOM_ID = 'main';
let globalChatQuery = null;
let globalChatListener = null;
const BOT_EVENT_INTERVAL_MS = 15 * 60 * 1000;
const NEXUS_BOT_UID = 'nexus_bot';
/** Pausado: no lanzar cofres/trivias aleatorias del Nexo Bot. */
const CAMPFIRE_BOT_EVENTS_ENABLED = false;
const FORGER_SEAL_MS = 7 * 24 * 60 * 60 * 1000;
let forgerSealByUid = {};
const TRIVIA_POOL = [
    { q: '¿En qué mapa de CS:GO se juega "B" en un sitio con techo verde?', a: 'mirage' },
    { q: '¿Qué arma tiene el número 1 en el slot de rifle en CS:GO?', a: 'awp' },
    { q: '¿Cuántos jugadores por equipo en Valorant competitivo?', a: '5' },
    { q: '¿Agente de Valorant que pone humo con flecha?', a: 'sova' },
    { q: '¿Mapa de CS:GO con reloj gigante?', a: 'nuke' },
    { q: '¿Arma que hace "dink" con casco en CS:GO?', a: 'deagle' },
    { q: '¿Cuántas rondas para ganar un half en CS2 competitivo?', a: '13' },
    { q: '¿Agente de Valorant con teleportación?', a: 'omen' },
    { q: '¿Cuál es el eco round típico (sin armas)?', a: 'pistol' },
    { q: '¿Nombre del mapa de CS con tren?', a: 'train' },
    { q: '¿Rifle más barato del CT en CS?', a: 'famas' },
    { q: '¿Siglas de "Last Player Standing"?', a: 'lps' },
    { q: '¿Qué significan las siglas AWP?', a: 'magnum' }
];

function getBotRef() {
    return rtdb.ref('globalChatBot/' + GLOBAL_CHAT_ROOM_ID);
}

function tryLaunchBotEvent() {
    if (!CAMPFIRE_BOT_EVENTS_ENABLED) return;
    if (!currentUser) return;
    const botRef = getBotRef();
    const now = Date.now();
    botRef.once('value').then((snap) => {
        const d = snap.val() || {};
        const last = d.lastEventAt || 0;
        if (now - last < BOT_EVENT_INTERVAL_MS) return;
        const eventType = Math.random() < 0.5 ? 'loot' : 'trivia';
        botRef.transaction((cur) => {
            const c = cur || {};
            if ((c.lastEventAt || 0) >= now - BOT_EVENT_INTERVAL_MS) return undefined;
            if (eventType === 'loot') {
                return { lastEventAt: now, eventType: 'loot', lootEventId: null, lootClaimedBy: null };
            } else {
                const t = TRIVIA_POOL[Math.floor(Math.random() * TRIVIA_POOL.length)];
                return { lastEventAt: now, eventType: 'trivia', triviaQuestion: t.q, triviaAnswer: (t.a || '').toLowerCase(), triviaClaimedBy: null };
            }
        }).then(({ committed, snapshot }) => {
            if (!committed || !snapshot.val()) return;
            const v = snapshot.val();
            const messagesRef = rtdb.ref(`${GLOBAL_CHAT_NODE}/${GLOBAL_CHAT_ROOM_ID}/messages`);
            if (v.eventType === 'loot') {
                const lootTexts = [
                    '🎁 ¡Cofre desbloqueado! Escribe !loot para reclamar.',
                    '📦 Cofre de suministros disponible. !loot para reclamar.',
                    '🎁 Cofre listo. Escribe !loot'
                ];
                const msg = {
                    userId: NEXUS_BOT_UID,
                    userNick: 'Nexo Bot',
                    userPhoto: 'community.png',
                    text: lootTexts[Math.floor(Math.random() * lootTexts.length)],
                    type: 'bot',
                    timestamp: firebase.database.ServerValue.TIMESTAMP
                };
                messagesRef.push(msg).then((pushRef) => {
                    getBotRef().update({ lootEventId: pushRef.key });
                });
            } else if (v.eventType === 'trivia' && v.triviaQuestion) {
                const suffixes = [' Responde con la respuesta correcta.', ' (una palabra)', ''];
                const suf = suffixes[Math.floor(Math.random() * suffixes.length)];
                messagesRef.push({
                    userId: NEXUS_BOT_UID,
                    userNick: 'Nexo Bot',
                    userPhoto: 'community.png',
                    text: '❓ ' + v.triviaQuestion + suf,
                    type: 'bot',
                    timestamp: firebase.database.ServerValue.TIMESTAMP
                });
            }
        });
    });
}

let globalChatBotTimer = null;

function startGlobalChatBotTimer() {
    if (!CAMPFIRE_BOT_EVENTS_ENABLED) {
        stopGlobalChatBotTimer();
        return;
    }
    if (globalChatBotTimer) return;
    tryLaunchBotEvent();
    globalChatBotTimer = setInterval(tryLaunchBotEvent, BOT_EVENT_INTERVAL_MS + 60000);
}

function stopGlobalChatBotTimer() {
    if (globalChatBotTimer) {
        clearInterval(globalChatBotTimer);
        globalChatBotTimer = null;
    }
}

function loadChatMessages() {
    const chatDiv = document.getElementById('campfireMessages');
    if (!chatDiv) return;

    rtdb.ref('forgerSealThisWeek').on('value', (snap) => {
        const val = snap.val();
        forgerSealByUid = val || {};
    });

    // Fuego de Campamento 2.0: el motor dedicado toma el control del render.
    if (window.SGCampfire && typeof window.SGCampfire.boot === 'function') {
        if (globalChatQuery && globalChatListener) {
            try { globalChatQuery.off('value', globalChatListener); } catch (e) { /* noop */ }
            globalChatQuery = null;
            globalChatListener = null;
        }
        window.SGCampfire.boot();
        startGlobalChatBotTimer();
        return;
    }

    chatDiv.innerHTML = '<p class="campfire-empty-state campfire-loading"><i class="fas fa-spinner fa-spin"></i> Cargando chat...</p>';
    try {
        if (globalChatQuery && globalChatListener) {
            globalChatQuery.off('value', globalChatListener);
        }
        const messagesRef = rtdb.ref(`${GLOBAL_CHAT_NODE}/${GLOBAL_CHAT_ROOM_ID}/messages`);
        globalChatQuery = messagesRef.orderByChild('timestamp').limitToLast(50);
        globalChatListener = (snapshot) => {
            chatDiv.innerHTML = '';
            if (!snapshot.exists() || !snapshot.hasChildren()) {
                chatDiv.innerHTML = '<p class="campfire-empty-state">Nadie ha escrito aún. ¡Sé el primero!</p>';
            } else {
                const items = [];
                snapshot.forEach((child) => {
                    const val = child.val();
                    if (val) items.push({ id: child.key, ...val });
                });
                items.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
                const now = Date.now();
                items.forEach((msg) => {
                    const isForgeImage = msg.type === 'forge_image' && msg.imageId;
                    if (isForgeImage) {
                        const r = msg.reactions || { fire: 0, precision: 0, troll: 0 };
                        const reactedBy = msg.reactedBy || {};
                        const myR = reactedBy[currentUser?.uid];
                        const mediaType = msg.mediaType || (msg.videoURL ? 'video_local' : (msg.embedURL ? 'embed' : 'image'));
                        const mediaHtml = mediaType === 'video_local'
                            ? `<video src="${escapeAttr(msg.videoURL || '')}" controls muted playsinline></video>`
                            : mediaType === 'embed'
                                ? `<a href="${escapeAttr(msg.embedURL || '#')}" target="_blank" rel="noopener" class="forge-embed-link">Ver clip externo</a>`
                                : `<img src="${escapeAttr(msg.imageURL || '')}" alt="" onerror="this.style.display='none'">`;
                        const msgEl = document.createElement('div');
                        msgEl.className = 'campfire-message campfire-message-forge';
                        msgEl.innerHTML = `
                            <img src="${msg.userPhoto || msg.photoURL || DEFAULT_AVATAR}" class="message-avatar community-user-link" data-community-uid="${escapeAttr(msg.userId || '')}" data-community-nick="${escapeAttr(msg.userNick || msg.nick || '')}" alt="" onerror="this.src='${DEFAULT_AVATAR}'">
                            <div class="message-bubble message-forge-card">
                                <span class="message-author community-user-link" data-community-uid="${escapeAttr(msg.userId || '')}" data-community-nick="${escapeAttr(msg.userNick || msg.nick || '')}">${escapeHtml(msg.userNick || msg.nick || 'Anónimo')} subió una imagen</span>
                                <div class="message-forge-preview">${mediaHtml}</div>
                                <span class="message-forge-title">${escapeHtml(msg.title || 'Sin título')}</span>
                                <div class="message-forge-reactions" data-image-id="${escapeAttr(msg.imageId)}" data-msg-id="${escapeAttr(msg.id)}">
                                    <button type="button" class="forge-reaction-btn ${myR === 'fire' ? 'active' : ''}" data-r="fire">🔥 ${r.fire || 0}</button>
                                    <button type="button" class="forge-reaction-btn ${myR === 'precision' ? 'active' : ''}" data-r="precision">🎯 ${r.precision || 0}</button>
                                    <button type="button" class="forge-reaction-btn ${myR === 'troll' ? 'active' : ''}" data-r="troll">🤡 ${r.troll || 0}</button>
                                </div>
                            </div>`;
                        msgEl.querySelector('.message-forge-reactions').addEventListener('click', (e) => {
                            const btn = e.target.closest('.forge-reaction-btn');
                            if (btn && currentUser) addReactionFromChat(msg.imageId, btn.getAttribute('data-r'), msg.id);
                        });
                        bindCommunityUserClicks(msgEl);
                        chatDiv.appendChild(msgEl);
                        return;
                    }
                    const nick = (msg.userNick || msg.nick || 'Anónimo').substring(0, 30);
                    const photo = msg.userPhoto || msg.photoURL || DEFAULT_AVATAR;
                    const text = (msg.text || '').substring(0, 500);
                    const isBot = msg.type === 'bot' || msg.userId === 'nexus_bot';
                    if (isBot) return;
                    const pres = presenceByUid[msg.userId];
                    const statusInfo = !isBot && pres && pres.status ? PLAYER_STATUSES.find((s) => s.value === pres.status) : null;
                    const statusBadge = statusInfo ? `<span class="message-status-badge" title="${escapeHtml(statusInfo.label)}">${statusInfo.emoji}</span>` : '';
                    const sealTs = forgerSealByUid[msg.userId];
                    const showForgerSeal = !isBot && sealTs && (now - (typeof sealTs === 'number' ? sealTs : 0)) < FORGER_SEAL_MS;
                    const forgerBadge = showForgerSeal ? ' <span class="forger-seal-badge" title="Forjador esta semana">⚒</span>' : '';
                    const msgEl = document.createElement('div');
                    msgEl.className = 'campfire-message' + (isBot ? ' campfire-message-bot' : '');
                    msgEl.innerHTML = `
                        <img src="${isBot ? 'community.png' : photo}" class="message-avatar${isBot ? '' : ' community-user-link'}" ${isBot ? '' : `data-community-uid="${escapeAttr(msg.userId || '')}" data-community-nick="${escapeAttr(nick)}"`} alt="" onerror="this.src='${DEFAULT_AVATAR}'">
                        <div class="message-bubble">
                            <span class="message-author${isBot ? '' : ' community-user-link'}" ${isBot ? '' : `data-community-uid="${escapeAttr(msg.userId || '')}" data-community-nick="${escapeAttr(nick)}"`}>${statusBadge}${escapeHtml(nick)}${forgerBadge}</span>
                            <div class="message-text">${parseMentions(escapeHtml(text))}</div>
                        </div>`;
                    if (!isBot) bindCommunityUserClicks(msgEl);
                    chatDiv.appendChild(msgEl);
                });
            }
            chatDiv.scrollTop = chatDiv.scrollHeight;
        };
        globalChatQuery.on('value', globalChatListener, (err) => {
            console.error('[Comunidad] Error al cargar chat global:', err);
            chatDiv.innerHTML = '<p class="campfire-empty-state">No se pudo cargar el chat. Revisa reglas de Realtime Database (globalChat).</p>';
        });
        startGlobalChatBotTimer();
    } catch (e) {
        console.error('[Comunidad] loadChatMessages:', e);
        chatDiv.innerHTML = '<p class="campfire-empty-state">Chat no disponible. Revisa la consola.</p>';
    }
}

function parseMentions(text) {
    return text.replace(/@(\w+)/g, '<span class="message-mention" data-mention="$1">@$1</span>');
}

// Composer legacy: solo se enlaza si la página aún usa el input antiguo.
(function bindLegacyCampfireComposer() {
    const legacySend = document.getElementById('sendCampfireMessage');
    const legacyInput = document.getElementById('campfireMessageInput');
    if (legacySend) legacySend.addEventListener('click', sendMessage);
    if (legacyInput) legacyInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') sendMessage(); });
})();

function sendMessage() {
    const input = document.getElementById('campfireMessageInput');
    const text = (input && input.value) ? input.value.trim() : '';
    if (!text || !currentUser) return;
    const rawText = text;
    const nick = userProfile.nickname || currentUser.displayName || 'Jugador';
    const photo = userProfile.photoURL || currentUser.photoURL || DEFAULT_AVATAR;

    const maybeHandleBotCommands = () => {
        const botRef = getBotRef();
        botRef.once('value').then((snap) => {
            const d = snap.val() || {};
            let claimed = false;
            const lower = rawText.toLowerCase();
            if (lower === '!loot' && d.lootEventId && !d.lootClaimedBy) {
                claimed = true;
                botRef.update({ lootClaimedBy: currentUser.uid }).then(() => {
                    addHonorPoints(currentUser.uid, 25);
                    pushActivity('honor', `${escapeHtml(nick)} reclamó el Cofre de suministros (+25 Honor)`);
                    showNotification('¡Cofre reclamado! +25 Honor', 'success');
                    input.value = '';
                    rtdb.ref(`${GLOBAL_CHAT_NODE}/${GLOBAL_CHAT_ROOM_ID}/messages`).push({
                        userId: NEXUS_BOT_UID,
                        userNick: 'Nexo Bot',
                        userPhoto: 'community.png',
                        text: `🎉 ¡${escapeHtml(nick)} ha reclamado el cofre! +25 Honor.`,
                        type: 'bot',
                        timestamp: firebase.database.ServerValue.TIMESTAMP
                    });
                });
            } else if (d.triviaAnswer && !d.triviaClaimedBy && lower === (d.triviaAnswer || '').toLowerCase()) {
                claimed = true;
                botRef.update({ triviaClaimedBy: currentUser.uid }).then(() => {
                    addHonorPoints(currentUser.uid, 15);
                    showNotification('¡Respuesta correcta! +15 Honor', 'success');
                    input.value = '';
                    rtdb.ref(`${GLOBAL_CHAT_NODE}/${GLOBAL_CHAT_ROOM_ID}/messages`).push({
                        userId: NEXUS_BOT_UID,
                        userNick: 'Nexo Bot',
                        userPhoto: 'community.png',
                        text: `✅ ¡${escapeHtml(nick)} acertó la trivia! +15 Honor.`,
                        type: 'bot',
                        timestamp: firebase.database.ServerValue.TIMESTAMP
                    });
                });
            }
            if (!claimed) doSendMessage();
        });
    };

    function doSendMessage() {
        const messageData = {
            userId: currentUser.uid,
            nick: nick,
            userNick: nick,
            photoURL: photo,
            userPhoto: photo,
            text: rawText.substring(0, 500),
            timestamp: firebase.database.ServerValue.TIMESTAMP
        };
        const ref = rtdb.ref(`${GLOBAL_CHAT_NODE}/${GLOBAL_CHAT_ROOM_ID}/messages`);
        ref.push(messageData).then(() => {
            pushActivity('chat', `<strong>${escapeHtml(nick)}</strong> en el Fuego de Campamento`);
            input.value = '';
            rtdb.ref('users/' + currentUser.uid + '/firstChatAt').once('value').then((snap) => {
                if (!snap.exists()) rtdb.ref('users/' + currentUser.uid).update({ firstChatAt: Date.now() }).catch(() => {});
            });
        }).catch((e) => {
            showNotification('No se pudo enviar el mensaje. Revisa reglas de Realtime Database (globalChat).', 'error');
        });
    }

    if (rawText.toLowerCase() === '!loot' || rawText.length > 0) {
        maybeHandleBotCommands();
    }
}

let heraldRtdbActivityItems = [];
let heraldRtdbItems = [];
let heraldNewsItems = [];

const HERALD_SIMULATED_NICKS = ['ShadowX', 'NexusPro', 'ValorantMaster', 'CS2Elite', 'FrostByte', 'Phoenix99', 'RavenClaw', 'StormBreaker', 'IronForge', 'DarkKnight', 'SilverArrow', 'CrimsonBlade', 'ThunderWolff', 'MysticTiger', 'WildHawk', 'NightOwl', 'SwiftFox', 'GoldenEagle', 'BlueDragon', 'RedPhoenix', 'SteelWolf', 'FireMage', 'IceQueen', 'WindRider', 'EarthShaker'];
const HERALD_SIMULATED_TEMPLATES = [
    { type: 'forge', tpl: (n) => `<strong>${n}</strong> forjó una imagen en la galería.` },
    { type: 'forum', tpl: (n) => `<strong>${n}</strong> abrió un tema en el Foro.` },
    { type: 'chat', tpl: (n) => `<strong>${n}</strong> conversó en el Fuego de Campamento.` },
    { type: 'honor', tpl: (n) => `<strong>${n}</strong> ganó Honor en la comunidad.` },
    { type: 'nexus', tpl: (n) => `<strong>${n}</strong> subió de nivel en Nexus.` }
];

function getSimulatedHeraldItems() {
    const now = Date.now();
    const items = [];
    const used = new Set();
    for (let i = 0; i < 35; i++) {
        const nick = HERALD_SIMULATED_NICKS[Math.floor(Math.random() * HERALD_SIMULATED_NICKS.length)];
        const t = HERALD_SIMULATED_TEMPLATES[Math.floor(Math.random() * HERALD_SIMULATED_TEMPLATES.length)];
        const ts = now - Math.random() * 24 * 60 * 60 * 1000;
        const key = `${nick}-${t.type}-${Math.floor(ts / 3600000)}`;
        if (used.has(key)) continue;
        used.add(key);
        items.push({ type: t.type, html: t.tpl(nick), _sort: ts, _simulated: true });
    }
    return items;
}

function loadHeraldFeed() {
    const feedDiv = document.getElementById('heraldFeed');
    if (!feedDiv) return;
    const renderItems = (items) => {
        feedDiv.innerHTML = '';
        const firstActivity = { type: 'system', html: 'Se abrió la <strong>Comunidad del Nexo</strong>.', _sort: Infinity };
        const toShow = [firstActivity, ...(items || []).slice(0, 14)];
        if (toShow.length === 0) {
            feedDiv.innerHTML = '<div class="herald-empty-state"><i class="fas fa-bell"></i> Actividad reciente de la red aparecerá aquí.</div>';
            return;
        }
        toShow.forEach(act => {
            const item = document.createElement('div');
            item.className = 'herald-item';
            let icon = 'fa-bell';
            if (act.type === 'system') icon = 'fa-door-open';
            else if (act.type === 'forum') icon = 'fa-scroll';
            else if (act.type === 'chat') icon = 'fa-fire';
            else if (act.type === 'forge') icon = 'fa-image';
            else if (act.type === 'honor') icon = 'fa-crown';
            else if (act.type === 'dashboard_comment') icon = 'fa-comment';
            else if (act.type === 'dashboard_news' || act.type === 'dashboard_event') icon = 'fa-bullhorn';
            else if (act.type && String(act.type).indexOf('nexus') !== -1) icon = 'fa-bolt';
            else if (act.type && String(act.type).indexOf('dashboard') !== -1) icon = 'fa-tachometer-alt';
            const html = act.html || act.text || 'Nueva actividad';
            item.innerHTML = `<div class="herald-icon"><i class="fas ${icon}"></i></div><div class="herald-text">${html}</div>`;
            feedDiv.appendChild(item);
        });
    };

    const mergeAndRender = () => {
        const simulated = getSimulatedHeraldItems();
        const merged = [...heraldRtdbActivityItems, ...heraldRtdbItems, ...heraldNewsItems, ...simulated];
        merged.sort((a, b) => (b._sort || 0) - (a._sort || 0));
        renderItems(merged.slice(0, 25));
    };

    try {
        rtdb.ref('communityActivity').orderByChild('timestamp').limitToLast(25).on('value', (snapshot) => {
            heraldRtdbActivityItems = [];
            if (snapshot.exists() && snapshot.hasChildren()) {
                snapshot.forEach((child) => {
                    const d = child.val();
                    heraldRtdbActivityItems.push({ ...d, _sort: d.timestamp || 0 });
                });
            }
            mergeAndRender();
        });
    } catch (e) {
        heraldRtdbActivityItems = [];
        mergeAndRender();
    }

    try {
        rtdb.ref('siteActivity').orderByChild('timestamp').limitToLast(30).on('value', (snap) => {
            const val = snap.val();
            heraldRtdbItems = [];
            if (val) {
                Object.keys(val).forEach(k => heraldRtdbItems.push({ ...val[k], _sort: val[k].timestamp || 0 }));
            }
            mergeAndRender();
        });
    } catch (e) { /* optional */ }

    try {
        rtdb.ref('news_events').orderByKey().limitToLast(8).on('value', (snap) => {
            heraldNewsItems = [];
            if (snap.exists() && snap.hasChildren()) {
                snap.forEach((child) => {
                    const d = child.val();
                    const ts = d.createdAt || d.date ? new Date(d.date).getTime() : 0;
                    const label = d.type === 'event' ? 'evento' : 'anuncio';
                    heraldNewsItems.push({
                        type: d.type === 'event' ? 'dashboard_event' : 'dashboard_news',
                        html: `<strong>${escapeHtml(d.title || 'Sin título')}</strong> — nuevo ${label} en el Dashboard`,
                        _sort: ts
                    });
                });
            }
            mergeAndRender();
        });
    } catch (e) { /* optional */ }
}

function initPresence() {
    if (!currentUser || !rtdb) return;
    try {
        const uid = currentUser.uid;
        presenceRef = rtdb.ref('presence/' + uid);
        const onDisconnect = rtdb.ref().child('presence').child(uid).onDisconnect();
        onDisconnect.set(null);
        const status = (userProfile && userProfile.status) || null;
        presenceRef.set({ online: true, nick: userProfile.nickname, since: Date.now(), status: status || null });

        rtdb.ref('presence').on('value', (snap) => {
            const val = snap.val();
            presenceByUid = val || {};
            const count = val ? Object.keys(val).length : 0;
            const el = document.getElementById('onlineCount');
            if (el) el.textContent = count;
            const menuCount = document.getElementById('cfPresenceMenuCount');
            if (menuCount) menuCount.textContent = count;
            if (window.SGCampfire && typeof window.SGCampfire.refreshPresence === 'function') {
                window.SGCampfire.refreshPresence(count);
            }
        });
        initPlayerStatusSelector();
    } catch (e) {
        const el = document.getElementById('onlineCount');
        if (el) el.textContent = '—';
        const menuCount = document.getElementById('cfPresenceMenuCount');
        if (menuCount) menuCount.textContent = '—';
    }
}

function initPlayerStatusSelector() {
    const container = document.getElementById('playerStatusSelectorContainer');
    if (!container) return;
    const current = (userProfile && userProfile.status) || '';
    container.innerHTML = '';
    PLAYER_STATUSES.forEach((s) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'cf-status-option' + (s.value === current ? ' active' : '');
        btn.setAttribute('data-status', s.value);
        btn.innerHTML = '<span>' + s.emoji + '</span><span>' + s.label + '</span>';
        btn.addEventListener('click', () => {
            const v = s.value;
            if (!presenceRef) return;
            presenceRef.update({ status: v || null });
            if (userProfile) userProfile.status = v || null;
            rtdb.ref('users/' + currentUser.uid).update({ status: v || null }).catch(() => {});
            container.querySelectorAll('.cf-status-option').forEach((b) => {
                b.classList.toggle('active', b.getAttribute('data-status') === v);
            });
            if (window.SGCampfire && typeof window.SGCampfire.setPresenceLabel === 'function') {
                window.SGCampfire.setPresenceLabel(s);
            }
        });
        container.appendChild(btn);
    });
}

function initSiteActivityListener() {
    try {
        rtdb.ref('siteActivity').limitToLast(5).on('value', () => { if (typeof loadHeraldFeed === 'function') loadHeraldFeed(); });
    } catch (e) {}
}

let lastBattleCallTimestamp = 0;
let filterBattleCallsOnly = false;
let battleHornCount = 0;
function initBattleCallListener() {
    try {
        rtdb.ref('battleCalls/latest').on('value', (snap) => {
            const d = snap.val();
            if (!d || !d.timestamp) return;
            if (d.authorId === currentUser.uid && Date.now() - d.timestamp < 3000) return;
            if (d.timestamp <= lastBattleCallTimestamp) return;
            lastBattleCallTimestamp = d.timestamp;
            const msg = `📯 ¡Llamada a Batalla! ${escapeHtml(d.authorNick || 'Alguien')}: ${escapeHtml(d.title || '')} (${escapeHtml(d.game || '')})`;
            showBattleCallToast(msg);
            playCornetSound();
        });
        rtdb.ref('forumThreads').on('value', () => { updateBattleHornCount(); });
    } catch (e) {}
}

function updateBattleHornCount() {
    try {
        rtdb.ref('forumThreads').once('value').then((snap) => {
            let count = 0;
            if (snap.exists() && snap.hasChildren()) {
                snap.forEach((child) => { if (child.val() && child.val().isHelpRequest) count++; });
            }
            battleHornCount = count;
            const badge = document.getElementById('battleHornCount');
            const numEl = document.getElementById('battleHornNum');
            const btn = document.getElementById('filterBattleCallsBtn');
            if (badge) badge.style.display = count > 0 ? 'inline-flex' : 'none';
            if (numEl) numEl.textContent = count;
            if (btn) btn.style.display = count > 0 ? 'inline-flex' : 'none';
        });
    } catch (e) {}
}

const btnFilter = document.getElementById('filterBattleCallsBtn');
if (btnFilter) btnFilter.addEventListener('click', function() {
    filterBattleCallsOnly = !filterBattleCallsOnly;
    this.classList.toggle('active', filterBattleCallsOnly);
    loadThreads();
});

async function loadAnnals() {
    const section = document.getElementById('annalsSection');
    const content = document.getElementById('annalsContent');
    if (!section || !content || !currentUser) return;
    try {
        const snap = await rtdb.ref('users/' + currentUser.uid).once('value');
        const d = snap.val() || {};
        const firstForge = d.firstForgeAt;
        const firstChat = d.firstChatAt;
        const items = [];
        const now = Date.now();
        if (firstForge) {
            const days = Math.max(0, Math.floor((now - firstForge) / MS_PER_DAY));
            items.push({ text: 'Subiste tu primera imagen a la Forja', days });
        }
        if (firstChat) {
            const days = Math.max(0, Math.floor((now - firstChat) / MS_PER_DAY));
            items.push({ text: 'Escribiste tu primer mensaje en el Fuego de Campamento', days });
        }
        if (items.length === 0) {
            section.style.display = 'none';
            return;
        }
        section.style.display = 'block';
        content.innerHTML = items.map((i) =>
            `<div class="annals-item">${escapeHtml(i.text)} <span class="annals-days">Hace ${i.days} días</span></div>`
        ).join('');
    } catch (e) {
        section.style.display = 'none';
    }
}

function showBattleCallToast(message) {
    let container = document.querySelector('.battle-call-toast-container');
    if (!container) {
        container = document.createElement('div');
        container.className = 'battle-call-toast-container';
        document.body.appendChild(container);
    }
    const toast = document.createElement('div');
    toast.className = 'battle-call-toast';
    toast.innerHTML = `<i class="fas fa-trumpet"></i> ${message}`;
    container.appendChild(toast);
    setTimeout(() => toast.classList.add('visible'), 10);
    setTimeout(() => {
        toast.classList.remove('visible');
        setTimeout(() => toast.remove(), 300);
    }, 6000);
}

function playCornetSound() {
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
    } catch (e) { /* ignore */ }
}

function closeModal(modalId) {
    const el = document.getElementById(modalId);
    if (el) el.style.display = 'none';
}

document.getElementById('callToBattleBtn').addEventListener('click', () => {
    document.getElementById('battleCallModal').style.display = 'flex';
});

document.getElementById('submitBattleCall').addEventListener('click', async () => {
    const game = document.getElementById('battleGameSelect').value;
    const helpType = document.getElementById('battleHelpTypeSelect').value;
    const description = document.getElementById('battleDescription').value.trim();
    const videoLink = document.getElementById('battleVideoLink').value.trim();
    if (!description) {
        showNotification('Describe tu batalla para enviar la llamada', 'error');
        return;
    }
    try {
        const title = `[AYUDA] ${helpType} en ${game}`;
        const now = Date.now();
        await rtdb.ref('forumThreads').push({
            title,
            game,
            authorId: currentUser.uid,
            authorNick: userProfile.nickname,
            authorPhoto: userProfile.photoURL || DEFAULT_AVATAR,
            authorMentorAvailable: !!userProfile.mentorAvailable,
            createdAt: now,
            lastReplyAt: now,
            replyCount: 0,
            firstPost: `${description}\n\nEnlace: ${videoLink || 'N/A'}`,
            isHelpRequest: true
        });
        await addHonorPoints(currentUser.uid, 15);
        await pushActivity('forum', `<strong>${escapeHtml(userProfile.nickname)}</strong> lanzó una Llamada a batalla`);
        try {
            rtdb.ref('battleCalls/latest').set({
                timestamp: Date.now(),
                authorId: currentUser.uid,
                authorNick: userProfile.nickname,
                title,
                game
            });
        } catch (e) { /* ignore */ }
        closeModal('battleCallModal');
        document.getElementById('battleDescription').value = '';
        document.getElementById('battleVideoLink').value = '';
        loadThreads();
        showNotification('¡Llamada a batalla enviada! Los veteranos te ayudarán.', 'success');
    } catch (e) {
        showNotification('Error al publicar: ' + (e.message || 'Revisa permisos'), 'error');
    }
});

function updateMiniProfile() {
    if (!userProfile) return;
    const nick = userProfile.nickname || 'Jugador';
    const photo = userProfile.photoURL || DEFAULT_AVATAR;
    const content = document.getElementById('miniProfileContent');
    if (content) {
        const rankLabel = userProfile.rankLabel || RANK_LABELS[userProfile?.rank] || 'Tribal';
        content.innerHTML = `
            <div class="mini-profile-avatar-wrap" id="miniProfileAvatarWrap">
                <img src="${photo}" class="mini-profile-avatar community-user-link" data-community-uid="${escapeAttr(currentUser.uid)}" data-community-nick="${escapeAttr(nick)}" alt="" onerror="this.src='${DEFAULT_AVATAR}'">
            </div>
            <div class="mini-profile-info">
                <h4 class="community-user-link" data-community-uid="${escapeAttr(currentUser.uid)}" data-community-nick="${escapeAttr(nick)}">${escapeHtml(nick)}</h4>
                <p class="mini-profile-rank">${escapeHtml(rankLabel)}</p>
                <div class="mini-profile-honor-row" data-streamer-hide>
                    <span class="mini-honor-label">Honor</span>
                    <span class="mini-honor-value honor-tier-${getHonorTier(userProfile.communityHonor ?? 0)}" id="miniHonorValue" title="${escapeHtml(honorTierLabel(getHonorTier(userProfile.communityHonor ?? 0)))}">${userProfile.communityHonor ?? 0}</span>
                </div>
            </div>
            <span class="profile-expand-hint"><i class="fas fa-chevron-down"></i> Click para expandir</span>`;
        bindCommunityUserClicks(content);
        applyCommunityProfileFrame();
    }
    const mentorWrap = document.getElementById('mentorToggleWrap');
    const mentorCheck = document.getElementById('mentorAvailableCheckbox');
    if (mentorWrap && mentorCheck) {
        const canBeMentor = (userProfile.communityHonor || 0) >= 200;
        mentorWrap.style.display = canBeMentor ? 'block' : 'none';
        mentorCheck.checked = !!userProfile.mentorAvailable;
        mentorCheck.onchange = () => setMentorAvailable(mentorCheck.checked);
        if (userProfile.mentorAvailable) {
            rtdb.ref('mentors/list/' + currentUser.uid).set({
                nick: userProfile.nickname,
                photoURL: userProfile.photoURL || DEFAULT_AVATAR,
                communityHonor: userProfile.communityHonor || 0
            }).catch(() => {});
        }
    }
    const bar = document.getElementById('honorBarFill');
    const pts = document.getElementById('honorPoints');
    const honor = userProfile.communityHonor ?? 0;
    const pct = Math.min((honor / 1000) * 100, 100);
    if (bar) { bar.style.width = pct + '%'; bar.setAttribute('aria-valuenow', honor); }
    if (pts) {
        pts.textContent = honor;
        pts.className = 'honor-display-value honor-tier-' + getHonorTier(honor);
        pts.title = honorTierLabel(getHonorTier(honor));
    }
    const miniHonor = document.getElementById('miniHonorValue');
    if (miniHonor) {
        miniHonor.textContent = honor;
        miniHonor.className = 'mini-honor-value honor-tier-' + getHonorTier(honor);
        miniHonor.title = honorTierLabel(getHonorTier(honor));
    }

    const streakWrap = document.getElementById('streakWrap');
    const streakCountEl = document.getElementById('streakCount');
    if (streakWrap && streakCountEl) {
        if (userStreak > 0) {
            streakWrap.style.display = 'flex';
            streakCountEl.textContent = userStreak;
        } else {
            streakWrap.style.display = 'none';
        }
    }
}

async function setMentorAvailable(value) {
    if (!currentUser) return;
    try {
        await rtdb.ref('users/' + currentUser.uid).update({ mentorAvailable: !!value });
        userProfile.mentorAvailable = !!value;
        const mentorsRef = rtdb.ref('mentors/list/' + currentUser.uid);
        if (value) {
            await mentorsRef.set({
                nick: userProfile.nickname,
                photoURL: userProfile.photoURL || DEFAULT_AVATAR,
                communityHonor: userProfile.communityHonor || 0
            });
        } else {
            await mentorsRef.remove();
        }
        loadMentorsList();
        showNotification(value ? 'Ahora apareces como Mentor disponible' : 'Mentor desactivado', 'info');
    } catch (e) {
        showNotification('Error al actualizar', 'error');
    }
}

async function loadMentorsList() {
    const listDiv = document.getElementById('mentorsList');
    if (!listDiv) return;
    try {
        const snap = await rtdb.ref('mentors/list').once('value');
        listDiv.innerHTML = '';
        if (!snap.exists() || !snap.hasChildren()) {
            listDiv.innerHTML = '<p class="mentors-empty">Ningún mentor disponible. ¡Sube de Honor y activa la etiqueta!</p>';
            return;
        }
        const items = [];
        snap.forEach((child) => items.push({ uid: child.key, ...child.val() }));
        items.sort((a, b) => (b.communityHonor || 0) - (a.communityHonor || 0));
        items.forEach((item) => {
            const memberEl = document.createElement('div');
            memberEl.className = 'mentor-item community-user-link';
            memberEl.dataset.communityUid = item.uid;
            memberEl.dataset.communityNick = item.nick || 'Mentor';
            memberEl.innerHTML = `
                <img src="${item.photoURL || DEFAULT_AVATAR}" alt="" onerror="this.src='${DEFAULT_AVATAR}'">
                <span>${escapeHtml(item.nick || 'Mentor')}</span>
                <button type="button" class="friend-chat-btn" data-community-uid="${escapeAttr(item.uid)}" data-community-nick="${escapeAttr(item.nick || 'Mentor')}" data-community-action="chat" title="Mensaje"><i class="fas fa-comment"></i></button>`;
            memberEl.addEventListener('click', (e) => {
                if (e.target.closest('.friend-chat-btn')) return;
                openCommunityUser(item.uid, item.nick);
            });
            const chatBtn = memberEl.querySelector('.friend-chat-btn');
            if (chatBtn) chatBtn.addEventListener('click', (e) => { e.stopPropagation(); openCommunityUser(item.uid, item.nick, 'chat'); });
            listDiv.appendChild(memberEl);
        });
    } catch (e) {
        listDiv.innerHTML = '<p class="mentors-empty">No se pudo cargar.</p>';
    }
}

async function loadFeaturedMembers() {
    const listDiv = document.getElementById('featuredMembersList');
    if (!listDiv) return;
    try {
        // PZ-017: users solo lo puede leer Commander/Boss; el ranking de honor
        // lee publicProfiles, que ya trae nick/photoURL/communityHonor.
        const snap = await rtdb.ref('publicProfiles').orderByChild('communityHonor').limitToLast(5).once('value');
        listDiv.innerHTML = '';
        if (!snap.exists() || !snap.hasChildren()) {
            listDiv.innerHTML = '<p class="featured-empty-state">Aún no hay miembros con honor. ¡Sé el primero!</p>';
            return;
        }
        const items = [];
        snap.forEach((child) => items.push({ id: child.key, ...child.val() }));
        items.sort((a, b) => (b.communityHonor || 0) - (a.communityHonor || 0));
        items.forEach((item) => {
            const data = item;
            const nick = data.nick || data.nickname || 'Jugador';
            const photo = data.photoURL || DEFAULT_AVATAR;
            const honor = data.communityHonor || 0;
            const memberEl = document.createElement('div');
            memberEl.className = 'featured-member-item community-user-link';
            memberEl.dataset.communityUid = item.id;
            memberEl.dataset.communityNick = nick;
            memberEl.innerHTML = `
                <img src="${photo}" alt="" onerror="this.src='${DEFAULT_AVATAR}'">
                <span>${escapeHtml(nick)}</span>
                <span class="featured-honor honor-tier-${getHonorTier(honor)}"><i class="fas fa-crown"></i> ${honor}</span>`;
            memberEl.addEventListener('click', () => openCommunityUser(item.id, nick));
            listDiv.appendChild(memberEl);
        });
    } catch (e) {
        listDiv.innerHTML = '<p class="featured-empty-state">No se pudo cargar. Revisa índice Realtime Database (communityHonor).</p>';
    }
}

const shareCommunityBtn = document.getElementById('shareCommunityBtn');
if (shareCommunityBtn) {
    shareCommunityBtn.addEventListener('click', async () => {
        const url = window.location.origin + '/community?ref=' + encodeURIComponent(currentUser?.uid || '');
        const text = 'Únete al Nexo de StudiosGamesRS — forja recuerdos, pide ayuda y conecta con tu escuadrón.';
        try {
            if (navigator.share) {
                await navigator.share({ title: 'El Nexo — Comunidad', text, url });
            } else {
                await navigator.clipboard.writeText(url);
                showNotification('Enlace copiado. Compártelo con tus amigos.', 'success');
            }
        } catch (e) {
            showNotification('No se pudo compartir. Copia: ' + url, 'info');
        }
    });
}

let reportSelectedUserId = null;
let reportSelectedUserNick = null;

document.getElementById('reportPlayerSearch').addEventListener('input', debounce(function() {
    const q = (this.value || '').trim();
    const results = document.getElementById('reportPlayerResults');
    if (!results) return;
    if (q.length < 2) { results.innerHTML = ''; results.classList.remove('open'); return; }
    results.innerHTML = '<div class="search-loading">Buscando…</div>';
    results.classList.add('open');
    // PZ-017: el buscador de "reportar jugador" solo necesita el nick, lee publicProfiles.
    rtdb.ref('publicProfiles').once('value').then((snap) => {
        const ql = q.toLowerCase();
        let html = '';
        const val = snap.val();
        if (val && typeof val === 'object') {
            Object.keys(val).forEach(uid => {
                if (uid === currentUser.uid) return;
                const d = val[uid];
                const nick = (d.nick || d.nickname || d.displayName || '').toString().toLowerCase();
                if (!nick || nick.indexOf(ql) === -1) return;
                const label = escapeHtml(d.nick || d.nickname || d.displayName || uid);
                html += `<div class="search-result-item" data-uid="${uid}" data-nick="${escapeAttr(label)}"><i class="fas fa-user"></i> ${label}</div>`;
            });
        }
        results.innerHTML = html || '<div class="search-no-results">Sin resultados</div>';
        results.querySelectorAll('.search-result-item').forEach(el => {
            el.addEventListener('click', () => {
                reportSelectedUserId = el.dataset.uid;
                reportSelectedUserNick = el.dataset.nick;
                document.getElementById('reportSelectedLabel').textContent = 'Reportar a: ' + reportSelectedUserNick;
                document.getElementById('reportSelectedPlayer').style.display = 'flex';
                document.getElementById('reportPlayerResults').innerHTML = '';
                results.classList.remove('open');
                document.getElementById('reportPlayerSearch').value = reportSelectedUserNick;
            });
        });
    }).catch(() => { results.innerHTML = ''; });
}, 300));

document.getElementById('reportClearSelection').addEventListener('click', () => {
    reportSelectedUserId = null;
    reportSelectedUserNick = null;
    document.getElementById('reportSelectedPlayer').style.display = 'none';
    document.getElementById('reportPlayerSearch').value = '';
});

document.getElementById('submitReport').addEventListener('click', async () => {
    if (!reportSelectedUserId || !reportSelectedUserNick) {
        showNotification('Selecciona un jugador a reportar', 'error');
        return;
    }
    const reason = document.getElementById('reportReason').value.trim();
    if (!reason) {
        showNotification('Escribe el motivo del reporte', 'error');
        return;
    }
    try {
        if (typeof firebase.functions !== 'function') {
            showNotification('Reportes no disponibles (Functions).', 'error');
            return;
        }
        await firebase.functions().httpsCallable('submitCommunityReport')({
            reportedUserId: reportSelectedUserId,
            reportedUserNick: reportSelectedUserNick,
            reason: reason.substring(0, 500)
        });
        closeModal('reportPlayerModal');
        showNotification('Reporte enviado. Los Commanders lo revisarán.', 'success');
    } catch (e) {
        const msg = (e && e.message) || '';
        showNotification('Error al enviar el reporte: ' + (msg || 'Revisa permisos'), 'error');
    }
});

const communitySearchInputEl = document.getElementById('communitySearchInput');
const communitySearchResultsEl = document.getElementById('communitySearchResults');
if (communitySearchInputEl && communitySearchResultsEl) {
    document.addEventListener('click', function(e) {
        if (!e.target.closest('.search-input-container')) {
            communitySearchResultsEl.classList.remove('open');
        }
    });
}
document.getElementById('communitySearchInput').addEventListener('input', debounce(function() {
    const q = (this.value || '').trim();
    const results = document.getElementById('communitySearchResults');
    if (!results) return;
    if (q.length < 2) { results.innerHTML = ''; results.classList.remove('open'); return; }
    results.innerHTML = '<div class="search-loading">Buscando…</div>';
    results.classList.add('open');
    const ql = q.toLowerCase();
    const byUid = {};
    function addUser(uid, nick) {
        if (!uid || uid === (currentUser && currentUser.uid)) return;
        const n = (nick || '').toString().toLowerCase();
        if (!n || n.indexOf(ql) === -1) return;
        byUid[uid] = nick || 'Usuario';
    }
    Promise.all([
        // PZ-017: búsqueda global de usuarios sobre publicProfiles (solo nick/avatar), no sobre users.
        rtdb.ref('publicProfiles').once('value'),
        rtdb.ref('forumThreads').orderByChild('lastReplyAt').limitToLast(50).once('value'),
        rtdb.ref('communityImages').orderByChild('timestamp').limitToLast(50).once('value')
    ]).then(([usersSnap, threadsSnap, imagesSnap]) => {
        const rtdbVal = usersSnap.val();
        if (rtdbVal && typeof rtdbVal === 'object') {
            Object.keys(rtdbVal).forEach(uid => {
                const u = rtdbVal[uid];
                const nick = u && (u.nick || u.nickname || u.displayName);
                addUser(uid, nick);
            });
        }
        let html = '';
        Object.keys(byUid).forEach(uid => {
            html += `<div class="search-result-item" data-action="user" data-uid="${escapeAttr(uid)}"><i class="fas fa-user"></i> ${escapeHtml(byUid[uid])}</div>`;
        });
        const threadsVal = threadsSnap.val();
        if (threadsVal && typeof threadsVal === 'object') {
            Object.keys(threadsVal).forEach(id => {
                const d = threadsVal[id];
                const title = (d.title || '').toLowerCase();
                if (title.indexOf(ql) === -1) return;
                const short = (d.title || '').substring(0, 45);
                html += `<div class="search-result-item" data-action="thread" data-id="${escapeAttr(id)}" data-title="${escapeAttr(d.title || '')}"><i class="fas fa-scroll"></i> ${escapeHtml(short)}${(d.title || '').length > 45 ? '…' : ''}</div>`;
            });
        }
        const imagesVal = imagesSnap.val();
        if (imagesVal && typeof imagesVal === 'object') {
            Object.keys(imagesVal).forEach(id => {
                const d = imagesVal[id];
                const title = (d.title || '').toLowerCase();
                const author = (d.userNick || '').toLowerCase();
                if (title.indexOf(ql) === -1 && author.indexOf(ql) === -1) return;
                const short = (d.title || '').substring(0, 35) || 'Imagen';
                html += `<div class="search-result-item" data-action="image" data-id="${escapeAttr(id)}" data-url="${escapeAttr(d.imageURL || '')}" data-title="${escapeAttr(d.title || '')}"><i class="fas fa-image"></i> ${escapeHtml(short)}${(d.title || '').length > 35 ? '…' : ''}</div>`;
            });
        }
        results.innerHTML = html || '<div class="search-no-results">Sin resultados</div>';
        results.querySelectorAll('.search-result-item[data-action]').forEach(el => {
            el.addEventListener('click', function() {
                const action = this.getAttribute('data-action');
                if (action === 'user') window.location.href = '/dashboard?uid=' + encodeURIComponent(this.getAttribute('data-uid') || '');
                else if (action === 'thread') openThread(this.getAttribute('data-id') || '', { title: this.getAttribute('data-title') || '' });
                else if (action === 'image') openImageViewer(this.getAttribute('data-id') || '', { imageURL: this.getAttribute('data-url') || '', title: this.getAttribute('data-title') || '' });
            });
        });
    }).catch(() => { results.innerHTML = '<div class="search-no-results">Error al buscar</div>'; });
}, 300));

function debounce(fn, ms) {
    let t;
    return function() { clearTimeout(t); t = setTimeout(() => fn.apply(this, arguments), ms); };
}

function escapeHtml(s) {
    if (s == null) return '';
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
}

function escapeAttr(s) {
    if (s == null) return '';
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function showNotification(message, type) {
    let container = document.querySelector('.notification-container');
    if (!container) {
        container = document.createElement('div');
        container.className = 'notification-container';
        document.body.appendChild(container);
    }
    const notif = document.createElement('div');
    notif.className = `notification-item ${type}`;
    const icon = type === 'success' ? 'fa-check-circle' : type === 'error' ? 'fa-exclamation-circle' : 'fa-info-circle';
    notif.innerHTML = `<i class="fas ${icon}"></i> ${message}`;
    container.appendChild(notif);
    setTimeout(() => notif.remove(), 5000);
}

window.logout = () => {
    if (presenceRef) try { presenceRef.remove(); } catch (e) {}
    if (globalChatQuery && globalChatListener) try { globalChatQuery.off('value', globalChatListener); } catch (e) {}
    auth.signOut().then(() => { window.location.href = '/login'; });
};

window.closeModal = closeModal;
window.openThread = openThread;
window.openImageViewer = openImageViewer;

// ========== NUEVAS FUNCIONALIDADES UX ==========

function initThemeFury() {
    const stored = localStorage.getItem('nexusThemeFury');
    const toggle = document.getElementById('themeFuryToggle');
    if (!toggle) return;
    toggle.checked = stored === 'true';
    document.body.classList.toggle('theme-fury', toggle.checked);
    toggle.addEventListener('change', () => {
        document.body.classList.toggle('theme-fury', toggle.checked);
        localStorage.setItem('nexusThemeFury', toggle.checked ? 'true' : 'false');
        showNotification(toggle.checked ? 'Modo Furia de Dragón activado' : 'Modo estándar', 'info');
    });
}

function initStreamerMode() {
    const stored = localStorage.getItem('nexusStreamerMode');
    const toggle = document.getElementById('streamerModeToggle');
    if (!toggle) return;
    toggle.checked = stored === 'true';
    document.body.classList.toggle('streamer-mode', toggle.checked);
    toggle.addEventListener('change', () => {
        document.body.classList.toggle('streamer-mode', toggle.checked);
        localStorage.setItem('nexusStreamerMode', toggle.checked ? 'true' : 'false');
        showNotification(toggle.checked ? 'Modo Streamer: datos sensibles ocultos' : 'Modo normal', 'info');
    });
}

function initProfileScroll() {
    const content = document.getElementById('miniProfileContent');
    const expanded = document.getElementById('profileScrollExpanded');
    const statsEl = document.getElementById('profileScrollStats');
    if (!content || !expanded) return;
    const toggle = () => {
        const isOpen = expanded.classList.toggle('open');
        content.setAttribute('aria-expanded', isOpen);
        expanded.setAttribute('aria-hidden', !isOpen);
        if (isOpen && statsEl && userProfile) {
            const honor = userProfile.communityHonor ?? 0;
            const rankLabel = userProfile.rankLabel || RANK_LABELS[userProfile.rank] || userProfile.rank || 'Tribal';
            const mainGame = userProfile.mainGame || 'Sin juego';
            const nexusLevel = userProfile.nexusLevel ?? 1;
            statsEl.innerHTML = `
                <p class="honor-exact-value" data-streamer-hide>Honor: <strong>${honor}</strong></p>
                <p class="honor-exact-value" data-streamer-hide>Rango: <strong>${escapeHtml(rankLabel)}</strong></p>
                <p class="honor-exact-value" data-streamer-hide>Nivel Nexus: <strong>${nexusLevel}</strong></p>
                <p class="honor-exact-value" data-streamer-hide>Juego favorito: <strong>${escapeHtml(mainGame)}</strong></p>
                <a href="/dashboard" class="profile-scroll-link">Ver perfil completo <i class="fas fa-external-link-alt"></i></a>`;
        }
    };
    content.addEventListener('click', (e) => { if (!e.target.closest('a')) toggle(); });
    content.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
}

function initAchievements() {
    const grid = document.getElementById('achievementsGrid');
    if (!grid) return;
    const achievements = [
        { id: 'first_forge', icon: 'fa-image', label: 'Primera forja', check: () => userProfile && !!userProfile.communityHonor },
        { id: 'streak_7', icon: 'fa-fire', label: 'Racha 7 días', check: () => userStreak >= 7 },
        { id: 'honor_100', icon: 'fa-crown', label: '100 Honor', check: () => (userProfile?.communityHonor ?? 0) >= 100 },
        { id: 'mentor', icon: 'fa-hands-helping', label: 'Mentor', check: () => userProfile?.mentorAvailable },
        { id: 'veteran', icon: 'fa-shield-alt', label: 'Veterano', check: () => (userProfile?.communityHonor ?? 0) >= 500 }
    ];
    grid.innerHTML = achievements.map((a) => {
        const unlocked = a.check();
        return `<div class="achievement-medal ${unlocked ? '' : 'locked'}" title="${escapeHtml(a.label)}" data-tooltip="${escapeHtml(a.label)}">
            <i class="fas ${a.icon}"></i>
        </div>`;
    }).join('');
}

function initDragDropPanels() {
    const main = document.getElementById('community-main');
    if (!main || !main.querySelector('.nexus-draggable-panel')) return;
    const panels = Array.from(main.querySelectorAll('.nexus-draggable-panel'));
    let dragged = null;

    const loadOrder = () => {
        try {
            const o = localStorage.getItem('nexusPanelOrder');
            return o ? JSON.parse(o) : ['left', 'center', 'right'];
        } catch (e) { return ['left', 'center', 'right']; }
    };

    const saveOrder = (order) => {
        localStorage.setItem('nexusPanelOrder', JSON.stringify(order));
        if (currentUser) rtdb.ref('users/' + currentUser.uid + '/communityLayout').set({ panelOrder: order }).catch(() => {});
    };

    const reorder = (order) => {
        order.forEach((id) => {
            const el = panels.find((p) => p.getAttribute('data-panel-id') === id);
            if (el) main.appendChild(el);
        });
    };

    const syncFromStorage = async () => {
        let order = loadOrder();
        if (currentUser) {
            try {
                const snap = await rtdb.ref('users/' + currentUser.uid + '/communityLayout/panelOrder').once('value');
                if (snap.exists() && Array.isArray(snap.val())) order = snap.val();
            } catch (e) {}
        }
        reorder(order);
    };

    syncFromStorage();

    panels.forEach((panel) => {
        panel.setAttribute('draggable', 'true');
        panel.addEventListener('dragstart', (e) => { dragged = panel; panel.classList.add('dragging'); });
        panel.addEventListener('dragend', () => { dragged = null; panel.classList.remove('dragging'); panels.forEach((p) => p.classList.remove('drag-over')); });
        panel.addEventListener('dragover', (e) => { e.preventDefault(); if (dragged && dragged !== panel) panel.classList.add('drag-over'); });
        panel.addEventListener('dragleave', () => panel.classList.remove('drag-over'));
        panel.addEventListener('drop', (e) => {
            e.preventDefault();
            panel.classList.remove('drag-over');
            if (!dragged || dragged === panel) return;
            const order = Array.from(main.querySelectorAll('.nexus-draggable-panel')).map((p) => p.getAttribute('data-panel-id'));
            saveOrder(order);
        });
    });
}

let ambientAudioCtx = null;
let ambientOsc = null;

function initAudioAmbient() {
    const btn = document.getElementById('audioAmbientToggle');
    if (!btn) return;
    const stored = localStorage.getItem('nexusAudioAmbient') === 'true';
    let playing = false;

    const startAmbient = () => {
        try {
            const Ctx = window.AudioContext || window.webkitAudioContext;
            if (!Ctx) return;
            ambientAudioCtx = ambientAudioCtx || new Ctx();
            if (ambientAudioCtx.state === 'suspended') ambientAudioCtx.resume();
            ambientOsc = ambientAudioCtx.createOscillator();
            const gain = ambientAudioCtx.createGain();
            ambientOsc.connect(gain);
            gain.connect(ambientAudioCtx.destination);
            ambientOsc.type = 'sine';
            ambientOsc.frequency.setValueAtTime(110, ambientAudioCtx.currentTime);
            gain.gain.setValueAtTime(0.03, ambientAudioCtx.currentTime);
            ambientOsc.start();
            playing = true;
            btn.classList.add('audio-playing');
        } catch (e) {}
    };

    const stopAmbient = () => {
        if (ambientOsc) try { ambientOsc.stop(); } catch (e) {}
        ambientOsc = null;
        playing = false;
        btn.classList.remove('audio-playing');
    };

    if (stored) startAmbient();

    btn.addEventListener('click', () => {
        if (playing) stopAmbient(); else startAmbient();
        localStorage.setItem('nexusAudioAmbient', playing ? 'true' : 'false');
    });
}

function initPlayerCardGenerator() {
    const btn = document.getElementById('generatePlayerCardBtn');
    if (!btn) return;
    btn.addEventListener('click', async () => {
        if (!userProfile || !currentUser) { showNotification('Carga tu perfil primero', 'error'); return; }
        const nick = userProfile.nickname || 'Jugador';
        const photo = userProfile.photoURL || DEFAULT_AVATAR;
        const honor = userProfile.communityHonor ?? 0;
        const rank = userProfile.rank || 'tribal';

        const canvas = document.createElement('canvas');
        canvas.width = 400;
        canvas.height = 200;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#0a0c0f';
        ctx.fillRect(0, 0, 400, 200);
        ctx.strokeStyle = '#e53935';
        ctx.lineWidth = 2;
        ctx.strokeRect(2, 2, 396, 196);

        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
            ctx.drawImage(img, 20, 20, 80, 80);
            ctx.fillStyle = '#f0f6fc';
            ctx.font = 'bold 24px "Orbitron"';
            ctx.fillText(nick.substring(0, 20), 115, 50);
            ctx.font = '16px sans-serif';
            ctx.fillStyle = '#ffb347';
            ctx.fillText('Honor: ' + honor + ' · ' + rank, 115, 85);
            ctx.fillStyle = '#8b949e';
            ctx.font = '12px sans-serif';
            ctx.fillText('StudiosGamesRS · El Nexo', 20, 180);

            const link = document.createElement('a');
            link.download = 'carta-nexo-' + nick.replace(/\s/g, '-') + '.png';
            link.href = canvas.toDataURL('image/png');
            link.click();
            showNotification('Carta exportada correctamente', 'success');
        };
        img.onerror = () => {
            ctx.fillStyle = '#333';
            ctx.fillRect(20, 20, 80, 80);
            ctx.fillStyle = '#f0f6fc';
            ctx.font = 'bold 24px "Orbitron"';
            ctx.fillText(nick.substring(0, 20), 115, 50);
            ctx.fillStyle = '#ffb347';
            ctx.fillText('Honor: ' + honor + ' · ' + rank, 115, 85);
            const link = document.createElement('a');
            link.download = 'carta-nexo-' + nick.replace(/\s/g, '-') + '.png';
            link.href = canvas.toDataURL('image/png');
            link.click();
            showNotification('Carta exportada', 'success');
        };
        img.src = photo.startsWith('data:') ? photo : (photo + '');
    });
}

function initNotificationsToggle() {
    const btn = document.getElementById('notificationsToggleBtn');
    if (!btn) return;
    btn.addEventListener('click', () => {
        if (!('Notification' in window)) { showNotification('Tu navegador no soporta notificaciones', 'error'); return; }
        if (Notification.permission === 'granted') { showNotification('Las notificaciones ya están activas', 'info'); return; }
        Notification.requestPermission().then((p) => {
            if (p === 'granted') {
                showNotification('Notificaciones activadas. Próximamente: avisos de torneos y mensajes.', 'success');
                new Notification('El Nexo', { body: '¡Rugido activado! Te avisaremos de torneos y mensajes.' });
            } else { showNotification('Notificaciones bloqueadas', 'info'); }
        });
    });
}

function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    try {
        navigator.serviceWorker.register('sw-community.js').then(() => {}).catch(() => {});
    } catch (e) {}
}
