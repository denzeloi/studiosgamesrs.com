/* ============================================================
   SHARED HEADER - StudiosGamesRS
   Furia, Streamer, Audio, Carta de Jugador, Bandeja de Notificaciones
   ============================================================ */

(function() {
    'use strict';

    const DEFAULT_AVATAR = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0MCIgaGVpZ2h0PSI0MCIgdmlld0JveD0iMCAwIDQwIDQwIj48Y2lyY2xlIGN4PSIyMCIgY3k9IjIwIiByPSIyMCIgZmlsbD0iIzMzMyIvPjxjaXJjbGUgY3g9IjIwIiBjeT0iMTUiIHI9IjYiIGZpbGw9IiM2NjYiLz48Y2lyY2xlIGN4PSIyMCIgY3k9IjMwIiByPSI5IiBmaWxsPSIjNjY2Ii8+PC9zdmc+';
    const RANK_LABELS = { commander: 'Commander', divisional_commander: 'Comandante Divisional', tribal_warrior: 'Guerrero Tribal', tribal: 'Tribal' };

    function showToast(msg, type) {
        if (typeof showNotification === 'function') showNotification(msg, type || 'info');
        else if (typeof showFloatingMessage === 'function') showFloatingMessage(type || 'info', msg);
        else console.log('[SGRS]', msg);
    }

    function getDb() {
        if (typeof firebase !== 'undefined' && firebase.database) return firebase.database();
        return null;
    }

    function getAuthUser() {
        if (typeof firebase !== 'undefined' && firebase.auth && firebase.auth().currentUser) return firebase.auth().currentUser;
        return null;
    }

    function initThemeFury() {
        const toggle = document.getElementById('themeFuryToggle');
        if (!toggle) return;
        toggle.checked = localStorage.getItem('nexusThemeFury') === 'true';
        document.body.classList.toggle('theme-fury', toggle.checked);
        toggle.addEventListener('change', function() {
            document.body.classList.toggle('theme-fury', this.checked);
            localStorage.setItem('nexusThemeFury', this.checked ? 'true' : 'false');
            showToast(this.checked ? 'Modo Furia activado' : 'Modo estándar', 'info');
        });
    }

    function initStreamerMode() {
        const toggle = document.getElementById('streamerModeToggle');
        if (!toggle) return;
        toggle.checked = localStorage.getItem('nexusStreamerMode') === 'true';
        document.body.classList.toggle('streamer-mode', toggle.checked);
        toggle.addEventListener('change', function() {
            document.body.classList.toggle('streamer-mode', this.checked);
            localStorage.setItem('nexusStreamerMode', this.checked ? 'true' : 'false');
            showToast(this.checked ? 'Modo Streamer: datos sensibles ocultos' : 'Modo normal', 'info');
        });
    }

    /* Pistas de música: nombre del archivo sin extensión (se prueba .mp3 y .ogg) */
    var AMBIENT_TRACKS = {
        default: 'deuslower-medieval-ambient-236809',   /* Música de página + partida en vivo */
        liveMatch: 'deuslower-medieval-ambient-236809', /* Cuando el usuario entra a jugar partida en vivo */
        track2: 'track2',   /* Segunda pista (añadir archivo track2.mp3 / track2.ogg) */
        track3: 'track3'    /* Tercera pista (añadir archivo track3.mp3 / track3.ogg) */
    };
    var ambientAudio = null;
    var ambientCtx = null, ambientNodes = [], ambientMelodyInterval = null;
    var useFile = true;
    var currentTrackId = 'default';
    var ambientPlaying = false;
    var ambientBtnRef = null;

    function getTrackFilename(trackId) {
        var base = AMBIENT_TRACKS[trackId] || AMBIENT_TRACKS.default;
        return 'audio/' + base;
    }

    function initAudioAmbient() {
        var btn = document.getElementById('audioAmbientToggle');
        if (!btn) return;
        ambientBtnRef = btn;
        var playing = false;
        var stored = localStorage.getItem('nexusAudioAmbient') === 'true';

        function stop() {
            if (ambientAudio) {
                try { ambientAudio.pause(); ambientAudio.currentTime = 0; } catch (e) {}
            }
            ambientNodes.forEach(function(n) {
                try { if (n.osc) n.osc.stop(); } catch (e) {}
            });
            ambientNodes = [];
            if (ambientMelodyInterval) clearInterval(ambientMelodyInterval);
            ambientMelodyInterval = null;
            playing = false;
            ambientPlaying = false;
            btn.classList.remove('audio-playing');
        }

        function startSynthesized() {
            try {
                var Ctx = window.AudioContext || window.webkitAudioContext;
                if (!Ctx) return;
                ambientCtx = ambientCtx || new Ctx();
                if (ambientCtx.state === 'suspended') ambientCtx.resume();
                var droneGain = ambientCtx.createGain();
                droneGain.gain.setValueAtTime(0.018, ambientCtx.currentTime);
                droneGain.connect(ambientCtx.destination);
                var d2 = ambientCtx.createOscillator();
                d2.type = 'sine';
                d2.frequency.setValueAtTime(73.42, ambientCtx.currentTime);
                d2.connect(droneGain);
                d2.start();
                ambientNodes.push({ osc: d2 });
                var a2 = ambientCtx.createOscillator();
                a2.type = 'sine';
                a2.frequency.setValueAtTime(110, ambientCtx.currentTime);
                a2.connect(droneGain);
                a2.start();
                ambientNodes.push({ osc: a2 });
                var dorian = [293.66, 329.63, 349.23, 392, 440, 392, 349.23, 329.63];
                var step = 0;
                function playNextNote() {
                    if (!playing || !ambientCtx) return;
                    var osc = ambientCtx.createOscillator();
                    var g = ambientCtx.createGain();
                    osc.type = 'triangle';
                    osc.frequency.setValueAtTime(dorian[step % dorian.length], ambientCtx.currentTime);
                    osc.connect(g);
                    g.connect(ambientCtx.destination);
                    var t = ambientCtx.currentTime;
                    g.gain.setValueAtTime(0, t);
                    g.gain.linearRampToValueAtTime(0.04, t + 0.15);
                    g.gain.linearRampToValueAtTime(0.02, t + 0.8);
                    g.gain.linearRampToValueAtTime(0, t + 1.5);
                    osc.start(t);
                    osc.stop(t + 1.6);
                    step++;
                }
                playNextNote();
                ambientMelodyInterval = setInterval(playNextNote, 2800);
            } catch (e) {}
        }

        function loadAndPlayTrack(trackId) {
            currentTrackId = trackId in AMBIENT_TRACKS ? trackId : 'default';
            var base = getTrackFilename(currentTrackId).replace('audio/', '');
            if (!ambientAudio) {
                ambientAudio = new Audio();
                ambientAudio.loop = true;
                ambientAudio.volume = 0.35;
                var triedOgg = false;
                ambientAudio.addEventListener('error', function err() {
                    if (!triedOgg) {
                        triedOgg = true;
                        ambientAudio.src = 'audio/' + base + '.ogg';
                    } else {
                        useFile = false;
                        startSynthesized();
                    }
                });
                ambientAudio.addEventListener('canplaythrough', function onReady() {
                    ambientAudio.removeEventListener('canplaythrough', onReady);
                    try { ambientAudio.play(); } catch (e) { useFile = false; startSynthesized(); }
                });
            }
            ambientAudio.src = 'audio/' + base + '.mp3';
            try { ambientAudio.play(); } catch (e) {}
        }

        function start(trackId) {
            stop();
            var t = trackId != null ? trackId : currentTrackId;
            if (useFile) {
                loadAndPlayTrack(t);
            } else {
                startSynthesized();
            }
            playing = true;
            ambientPlaying = true;
            btn.classList.add('audio-playing');
        }

        if (stored) start();
        btn.addEventListener('click', function() {
            if (playing) stop(); else start();
            localStorage.setItem('nexusAudioAmbient', playing ? 'true' : 'false');
        });

        window.StudiosGamesRS = window.StudiosGamesRS || {};
        window.StudiosGamesRS.setAmbientTrack = function(trackId) {
            currentTrackId = trackId in AMBIENT_TRACKS ? trackId : 'default';
            if (ambientPlaying && ambientAudio && useFile) {
                var base = getTrackFilename(currentTrackId).replace('audio/', '');
                ambientAudio.src = 'audio/' + base + '.mp3';
                ambientAudio.addEventListener('error', function tryOgg() {
                    ambientAudio.removeEventListener('error', tryOgg);
                    ambientAudio.src = 'audio/' + base + '.ogg';
                });
                try { ambientAudio.play(); } catch (e) {}
            }
        };
        window.StudiosGamesRS.playAmbientForLiveMatch = function() {
            if (localStorage.getItem('nexusAudioAmbient') !== 'true') return;
            currentTrackId = 'liveMatch';
            if (ambientBtnRef && ambientPlaying === false) start('liveMatch');
            else if (ambientPlaying && ambientAudio && useFile) {
                var base = AMBIENT_TRACKS.liveMatch;
                ambientAudio.src = 'audio/' + base + '.mp3';
                ambientAudio.onerror = function() { ambientAudio.src = 'audio/' + base + '.ogg'; };
                try { ambientAudio.play(); } catch (e) {}
            }
        };
    }

    function getPlayerData() {
        if (window.userProfile && window.currentUser) return { profile: window.userProfile, uid: window.currentUser.uid, photo: window.userProfile.photoURL };
        if (window.currentUserData) {
            const u = window.currentUserData;
            return { profile: { nickname: u.nick, mainGame: u.mainGame, rank: u.rango || u.rank, rankLabel: RANK_LABELS[(u.rango||u.rank||'').toLowerCase()] || (u.rango||'Tribal') }, uid: u.uid, photo: u.photoURL };
        }
        if (window.State && window.State.user) {
            const u = window.State.user;
            return { profile: { nickname: u.username, mainGame: u.mainGame || 'Sin juego', rank: u.rank || 'tribal', rankLabel: u.rank || 'Tribal' }, uid: u.uid, photo: u.photoURL };
        }
        return null;
    }

    function initPlayerCardGenerator() {
        const btn = document.getElementById('generatePlayerCardBtn');
        if (!btn) return;
        btn.addEventListener('click', async function() {
            const data = getPlayerData();
            const user = getAuthUser() || (data && data.uid ? { uid: data.uid } : null);
            if (!data || !user) { showToast('Inicia sesión y carga tu perfil primero', 'error'); return; }

            let tournamentMatches = 0;
            const db = getDb();
            if (db && user.uid) {
                try {
                    const snap = await db.ref('users/' + user.uid + '/tournamentMatches').once('value');
                    if (snap.exists()) tournamentMatches = parseInt(snap.val(), 10) || 0;
                } catch (e) {}
            }

            const p = data.profile;
            const nick = (p.nickname || p.nick || 'Jugador').substring(0, 20);
            const photo = data.photo || DEFAULT_AVATAR;
            const mainGame = p.mainGame || 'Sin juego';
            const rankLabel = p.rankLabel || RANK_LABELS[(p.rank||'').toLowerCase()] || 'Tribal';

            const canvas = document.createElement('canvas');
            canvas.width = 420;
            canvas.height = 220;
            const ctx = canvas.getContext('2d');

            ctx.fillStyle = '#0a0c0f';
            ctx.fillRect(0, 0, 420, 220);
            ctx.strokeStyle = '#e53935';
            ctx.lineWidth = 2;
            ctx.strokeRect(2, 2, 416, 216);

            ctx.fillStyle = '#1a1c20';
            ctx.fillRect(10, 10, 100, 50);
            ctx.fillStyle = '#fff';
            ctx.font = 'bold 14px "Cinzel Decorative", serif';
            ctx.fillText('Studios', 18, 32);
            ctx.fillStyle = '#e53935';
            ctx.fillText('gamesrs', 18, 48);

            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = function() {
                ctx.drawImage(img, 20, 70, 90, 90);
                ctx.fillStyle = '#f0f6fc';
                ctx.font = 'bold 22px "Orbitron", sans-serif';
                ctx.fillText(nick, 125, 95);
                ctx.font = '14px sans-serif';
                ctx.fillStyle = '#ffb347';
                ctx.fillText('Rango: ' + rankLabel, 125, 120);
                ctx.fillText('Juego: ' + mainGame.substring(0, 18), 125, 140);
                ctx.fillText('Partidas en torneos: ' + tournamentMatches, 125, 160);
                ctx.fillStyle = '#666';
                ctx.font = '11px sans-serif';
                ctx.fillText('StudiosGamesRS · studiosgamesrs.com', 20, 208);

                const link = document.createElement('a');
                link.download = 'carta-sgrs-' + nick.replace(/\s/g, '-') + '.png';
                link.href = canvas.toDataURL('image/png');
                link.click();
                showToast('Carta exportada correctamente', 'success');
            };
            img.onerror = function() {
                ctx.fillStyle = '#333';
                ctx.fillRect(20, 70, 90, 90);
                ctx.fillStyle = '#f0f6fc';
                ctx.font = 'bold 22px "Orbitron"';
                ctx.fillText(nick, 125, 95);
                ctx.fillStyle = '#ffb347';
                ctx.font = '14px sans-serif';
                ctx.fillText('Rango: ' + rankLabel, 125, 120);
                ctx.fillText('Juego: ' + mainGame.substring(0, 18), 125, 140);
                ctx.fillText('Partidas en torneos: ' + tournamentMatches, 125, 160);
                const link = document.createElement('a');
                link.download = 'carta-sgrs-' + nick.replace(/\s/g, '-') + '.png';
                link.href = canvas.toDataURL('image/png');
                link.click();
                showToast('Carta exportada', 'success');
            };
            img.src = photo.startsWith('data:') ? photo : (photo || DEFAULT_AVATAR);
        });
    }

    function initNotificationsDropdown() {
        const btn = document.getElementById('notificationsToggleBtn');
        if (!btn) return;

        var legacyPanel = document.getElementById('notificationsPanel');
        if (legacyPanel) legacyPanel.remove();

        /* Panel unificado en HTML (shared-notifications.js) — no crear el dropdown legacy */
        if (document.getElementById('headerNotificationsPanel') || window.SGNotifications) {
            return;
        }

        btn.style.position = 'relative';

        const panel = document.createElement('div');
        panel.id = 'notificationsPanel';
        panel.className = 'notifications-dropdown';
        panel.innerHTML = '' +
            '<div class="notifications-header">' +
                '<span>Notifications</span>' +
                '<div class="notifications-actions">' +
                    '<button type="button" class="notif-refresh" aria-label="Refresh">Refresh</button>' +
                    '<button type="button" class="notif-close" aria-label="Close">&times;</button>' +
                '</div>' +
            '</div>' +
            '<div class="notifications-list"></div>' +
            '<div class="notifications-empty" style="display:none;">No notifications yet</div>';
        document.body.appendChild(panel);
        let badge = document.getElementById('headerNotifBadge');
        if (!badge) {
            badge = document.createElement('span');
            badge.id = 'headerNotifBadge';
            badge.className = 'header-notif-badge';
            badge.style.display = 'none';
            btn.appendChild(badge);
        }

        let isOpen = false;
        let refreshTimer = null;
        const SECTION = {
            SYSTEM: 'System',
            CHAT: 'Messages',
            MATCHES: 'Upcoming',
            VISITS: 'Profile visitors'
        };

        function toggle() {
            isOpen = !isOpen;
            panel.classList.toggle('open', isOpen);
            if (isOpen) {
                loadNotifications();
                if (!refreshTimer) refreshTimer = setInterval(refreshBadgeCount, 30000);
            } else if (refreshTimer) {
                clearInterval(refreshTimer);
                refreshTimer = null;
            }
        }

        function close() {
            isOpen = false;
            panel.classList.remove('open');
            if (refreshTimer) {
                clearInterval(refreshTimer);
                refreshTimer = null;
            }
        }

        btn.addEventListener('click', toggle);
        panel.querySelector('.notif-close').addEventListener('click', close);
        panel.querySelector('.notif-refresh').addEventListener('click', loadNotifications);
        document.addEventListener('click', function(e) {
            if (isOpen && !panel.contains(e.target) && !btn.contains(e.target)) close();
        });

        function esc(text) {
            return String(text || '').replace(/[&<>"']/g, function(ch) {
                return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch];
            });
        }

        function parseTime(v) {
            if (typeof v === 'number') return v;
            if (typeof v === 'string') {
                const n = Date.parse(v);
                return Number.isFinite(n) ? n : 0;
            }
            return 0;
        }

        function updateTimeAgo(ts) {
            if (!ts) return '';
            const s = Math.floor((Date.now() - ts) / 1000);
            if (s < 60) return 'Now';
            if (s < 3600) return Math.floor(s / 60) + ' min';
            if (s < 86400) return Math.floor(s / 3600) + ' h';
            return Math.floor(s / 86400) + ' d';
        }

        async function getOwnUserData(db, uid) {
            try {
                const snap = await db.ref('users/' + uid).once('value');
                return snap.val() || {};
            } catch (e) {
                return {};
            }
        }

        async function gatherStoredNotifications(db, uid) {
            const out = [];
            try {
                const snap = await db.ref('users/' + uid + '/notifications').orderByChild('timestamp').limitToLast(30).once('value');
                if (snap.exists()) {
                    snap.forEach(function(c) {
                        const n = c.val() || {};
                        out.push({
                            id: c.key,
                            section: SECTION.SYSTEM,
                            text: n.text || 'Notification',
                            icon: n.icon || '🔔',
                            link: n.link || null,
                            read: !!n.read,
                            timestamp: parseTime(n.timestamp)
                        });
                    });
                }
            } catch (e) {}
            return out;
        }

        async function gatherChatNotifications(db, uid, ownUserData) {
            const out = [];
            try {
                const teamInviteSnap = await db.ref('teamInvites/' + uid).once('value');
                const teamInvitesCount = teamInviteSnap.exists() ? teamInviteSnap.numChildren() : 0;
                if (teamInvitesCount > 0) {
                    out.push({
                        id: 'team-invites',
                        section: SECTION.CHAT,
                        text: teamInvitesCount + ' team invite' + (teamInvitesCount > 1 ? 's' : '') + ' pending',
                        icon: '📨',
                        link: '/competition-hub',
                        read: false,
                        timestamp: Date.now() - 1000
                    });
                }
            } catch (e) {}

            try {
                const missionInviteSnap = await db.ref('playzoneChatInvites/' + uid).once('value');
                const missionInvitesCount = missionInviteSnap.exists() ? missionInviteSnap.numChildren() : 0;
                if (missionInvitesCount > 0) {
                    out.push({
                        id: 'mission-chat-invites',
                        section: SECTION.CHAT,
                        text: missionInvitesCount + ' mission chat invite' + (missionInvitesCount > 1 ? 's' : ''),
                        icon: '💬',
                        link: '/dashboard',
                        read: false,
                        timestamp: Date.now() - 1500
                    });
                }
            } catch (e) {}

            const seenRoot = (ownUserData.notificationSeen && ownUserData.notificationSeen.chat) || {};
            const chatChecks = [];
            if (ownUserData.teamId) chatChecks.push({ node: 'teamChats', chatId: ownUserData.teamId, label: 'Team chat' });

            try {
                const missionsSnap = await db.ref('missions').once('value');
                if (missionsSnap.exists()) {
                    missionsSnap.forEach(function(ch) {
                        const m = ch.val() || {};
                        if (m.participants && m.participants[uid]) {
                            chatChecks.push({ node: 'missionChats', chatId: ch.key, label: m.title || 'Mission chat' });
                        }
                    });
                }
            } catch (e) {}

            await Promise.all(chatChecks.map(async function(c) {
                try {
                    const snap = await db.ref(c.node + '/' + c.chatId + '/messages').orderByChild('timestamp').limitToLast(1).once('value');
                    if (!snap.exists()) return;
                    let last = null;
                    snap.forEach(function(m) { last = m.val() || null; });
                    if (!last) return;
                    const ts = parseTime(last.timestamp);
                    const fromMe = (last.userId && last.userId === uid);
                    const seenAt = parseTime(seenRoot[c.node] && seenRoot[c.node][c.chatId]);
                    if (!fromMe && ts > seenAt) {
                        out.push({
                            id: 'chat-' + c.node + '-' + c.chatId,
                            section: SECTION.CHAT,
                            text: c.label + ': ' + (last.text || 'New message'),
                            icon: '💬',
                            link: '/dashboard',
                            read: false,
                            timestamp: ts,
                            onClick: function() {
                                db.ref('users/' + uid + '/notificationSeen/chat/' + c.node + '/' + c.chatId).set(Date.now());
                            }
                        });
                    }
                } catch (e) {}
            }));

            return out;
        }

        async function gatherUpcomingNotifications(db, uid, ownUserData) {
            const out = [];
            const match = ownUserData && ownUserData.competitive && ownUserData.competitive.match ? ownUserData.competitive.match : null;
            if (match && match.opponent && match.opponent !== 'Ninguno') {
                const mt = parseTime(match.time);
                out.push({
                    id: 'competitive-match-upcoming',
                    section: SECTION.MATCHES,
                    text: 'Upcoming accepted match: vs ' + match.opponent + (match.tournament ? ' (' + match.tournament + ')' : ''),
                    icon: '🏁',
                    link: '/competition-hub',
                    read: false,
                    timestamp: mt || (Date.now() - 2000)
                });
            }

            try {
                const missionsSnap = await db.ref('missions').once('value');
                if (missionsSnap.exists()) {
                    missionsSnap.forEach(function(ch) {
                        const m = ch.val() || {};
                        if (!m.participants || !m.participants[uid]) return;
                        const at = parseTime(m.ingressTime || m.startAt || m.scheduledAt);
                        if (at && at >= Date.now() - (15 * 60 * 1000)) {
                            out.push({
                                id: 'mission-upcoming-' + ch.key,
                                section: SECTION.MATCHES,
                                text: 'Upcoming mission: ' + (m.title || 'Untitled mission'),
                                icon: '🎯',
                                link: '/playzone',
                                read: false,
                                timestamp: at
                            });
                        }
                    });
                }
            } catch (e) {}
            return out;
        }

        async function gatherProfileVisitors(db, uid) {
            const out = [];
            try {
                const snap = await db.ref('users/' + uid + '/profileVisitors').orderByChild('visitedAt').limitToLast(3).once('value');
                const items = [];
                if (snap.exists()) {
                    snap.forEach(function(c) { items.push({ id: c.key, ...c.val() }); });
                }
                items.sort(function(a, b) { return (parseTime(b.visitedAt) - parseTime(a.visitedAt)); });
                items.forEach(function(v) {
                    out.push({
                        id: 'profile-visitor-' + (v.visitorUid || v.id),
                        section: SECTION.VISITS,
                        text: (v.nick || 'A user') + ' visited your profile',
                        icon: '👀',
                        link: v.visitorUid ? ('/dashboard?uid=' + v.visitorUid) : null,
                        read: false,
                        timestamp: parseTime(v.visitedAt)
                    });
                });
            } catch (e) {}
            return out;
        }

        function renderNotificationList(items) {
            const list = panel.querySelector('.notifications-list');
            const empty = panel.querySelector('.notifications-empty');
            list.innerHTML = '';
            if (items.length === 0) {
                empty.style.display = 'block';
                empty.textContent = 'No notifications yet';
                return;
            }
            empty.style.display = 'none';
            let currentSection = '';
            items.forEach(function(n) {
                if (n.section !== currentSection) {
                    currentSection = n.section;
                    const group = document.createElement('div');
                    group.className = 'notif-item-group';
                    group.textContent = currentSection;
                    list.appendChild(group);
                }
                const timeAgo = updateTimeAgo(n.timestamp);
                const el = document.createElement('div');
                el.className = 'notif-item' + (n.read ? ' read' : '');
                el.innerHTML = '<div class="notif-icon">' + esc(n.icon || '🔔') + '</div><div class="notif-body"><div class="notif-text">' + esc(n.text || '') + '</div><div class="notif-time">' + esc(timeAgo) + '</div></div>';
                el.addEventListener('click', function() {
                    const user = getAuthUser();
                    const db = getDb();
                    if (typeof n.onClick === 'function') {
                        try { n.onClick(); } catch (e) {}
                    }
                    if (n.section === SECTION.SYSTEM && n.id && db && user) {
                        db.ref('users/' + user.uid + '/notifications/' + n.id).update({ read: true }).catch(function() {});
                    }
                    if (n.link) window.location.href = n.link;
                    close();
                });
                list.appendChild(el);
            });
        }

        async function collectNotifications() {
            const user = getAuthUser();
            if (!user) return { items: [], error: 'Sign in to view notifications' };
            const db = getDb();
            if (!db) return { items: [], error: 'Notifications unavailable' };

            const ownUserData = await getOwnUserData(db, user.uid);
            const [stored, chat, upcoming, visitors] = await Promise.all([
                gatherStoredNotifications(db, user.uid),
                gatherChatNotifications(db, user.uid, ownUserData),
                gatherUpcomingNotifications(db, user.uid, ownUserData),
                gatherProfileVisitors(db, user.uid)
            ]);

            const merged = stored.concat(chat, upcoming, visitors).sort(function(a, b) {
                return (parseTime(b.timestamp) - parseTime(a.timestamp));
            });
            return { items: merged, error: '' };
        }

        async function refreshBadgeCount() {
            const user = getAuthUser();
            const db = getDb();
            if (!user || !db) {
                badge.style.display = 'none';
                return;
            }
            try {
                const ownUserData = await getOwnUserData(db, user.uid);
                const [stored, chat, upcoming, visitors] = await Promise.all([
                    gatherStoredNotifications(db, user.uid),
                    gatherChatNotifications(db, user.uid, ownUserData),
                    gatherUpcomingNotifications(db, user.uid, ownUserData),
                    gatherProfileVisitors(db, user.uid)
                ]);
                const unreadStored = stored.filter(function(n) { return !n.read; }).length;
                const total = unreadStored + chat.length + upcoming.length + visitors.length;
                badge.textContent = total > 99 ? '99+' : String(total);
                badge.style.display = total > 0 ? 'block' : 'none';
            } catch (e) {
                badge.style.display = 'none';
            }
        }

        async function loadNotifications() {
            const list = panel.querySelector('.notifications-list');
            const empty = panel.querySelector('.notifications-empty');
            list.innerHTML = '';
            empty.style.display = 'none';
            list.innerHTML = '<div class="notif-item"><div class="notif-icon">⏳</div><div class="notif-body"><div class="notif-text">Loading notifications...</div></div></div>';
            const result = await collectNotifications();
            if (result.error) {
                list.innerHTML = '';
                empty.style.display = 'block';
                empty.textContent = result.error;
                badge.style.display = 'none';
                return;
            }
            renderNotificationList(result.items);
            refreshBadgeCount();
        }
        refreshBadgeCount();
    }

    function initNavDropdown() {
        var dd = document.getElementById('navDropdown');
        if (!dd) return;
        var trigger = dd.querySelector('.nav-dropdown-trigger');
        var menu = dd.querySelector('.nav-dropdown-menu');
        if (!trigger || !menu) return;
        trigger.addEventListener('click', function(e) {
            e.stopPropagation();
            dd.classList.toggle('open');
            trigger.setAttribute('aria-expanded', dd.classList.contains('open'));
        });
        document.addEventListener('click', function() {
            dd.classList.remove('open');
            trigger.setAttribute('aria-expanded', 'false');
        });
        menu.addEventListener('click', function(e) { e.stopPropagation(); });
    }

    function init() {
        initThemeFury();
        initStreamerMode();
        initEffectBrazas();
        initAudioAmbient();
        initPlayerCardGenerator();
        initNotificationsDropdown();
        initNavDropdown();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    window.StudiosGamesRS = window.StudiosGamesRS || {};
    window.StudiosGamesRS.addNotification = function(uid, text, icon, link) {
        if (window.SGNotifications && window.SGNotifications.push) {
            return window.SGNotifications.push(uid, { text: text, icon: icon, link: link });
        }
        const db = getDb();
        if (!db || !uid) return;
        db.ref('users/' + uid + '/notifications').push({
            text: text,
            icon: icon || '🔔',
            link: link || null,
            read: false,
            timestamp: Date.now()
        });
    };

    /* Toggle tema (brazas) - todas las páginas; Nexus puede sobrescribir en nexus-logic.js */
    function applyEffectBrazas(isOn) {
        if (isOn) document.body.classList.add('effect-brazas'); else document.body.classList.remove('effect-brazas');
        var icon = document.getElementById('theme-icon');
        if (icon) icon.className = isOn ? 'fas fa-fire' : 'fas fa-palette';
    }
    if (typeof window.toggleTheme !== 'function') {
        window.toggleTheme = function() {
            document.body.classList.toggle('effect-brazas');
            var isOn = document.body.classList.contains('effect-brazas');
            localStorage.setItem('nexus_effect_brazas', isOn ? '1' : '0');
            applyEffectBrazas(isOn);
            showToast(isOn ? 'Efecto brazas activado' : 'Efecto brazas desactivado', 'info');
        };
    }
    function initEffectBrazas() {
        var stored = localStorage.getItem('nexus_effect_brazas') === '1';
        applyEffectBrazas(stored);
    }

    /* Logout unificado - fallback si la página no define logout */
    if (typeof window.logout !== 'function') {
        window.logout = function() {
            if (typeof firebase !== 'undefined' && firebase.auth) {
                firebase.auth().signOut().then(function() { window.location.href = '/login'; });
            } else {
                window.location.href = '/login';
            }
        };
    }

    /* Volver al Dashboard - fallback para Community y Nexus */
    if (typeof window.returnToDashboard !== 'function') {
        window.returnToDashboard = function() { window.location.href = '/dashboard'; };
    }

    /* Tribunal overlay forzado — todas las páginas excepto Commander Panel */
    (function bootTribunalOverlayScript() {
        if (/commander-panel/i.test(window.location.pathname || '')) return;
        if (!document.querySelector('link[data-sg-tribunal-overlay-css]')) {
            var l = document.createElement('link');
            l.rel = 'stylesheet';
            l.href = '/tribunal-user-overlay.css?v=20260719c';
            l.setAttribute('data-sg-tribunal-overlay-css', '1');
            document.head.appendChild(l);
        }
        if (document.querySelector('script[data-sg-tribunal-overlay]')) return;
        var s = document.createElement('script');
        s.src = '/tribunal-user-overlay.js?v=20260719c';
        s.defer = true;
        s.setAttribute('data-sg-tribunal-overlay', '1');
        document.body.appendChild(s);
    })();
})();
