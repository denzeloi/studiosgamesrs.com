/* ============================================================
   PLAYZONE MECHANICS - 30 mecánicas asombrosas Studiosgamesrs
   Motivación, engagement y experiencia épica
   ============================================================ */

(function() {
  'use strict';

  const STORAGE = {
    streak: 'playzone_streak',
    lastVisit: 'playzone_lastVisit',
    tipsSeen: 'playzone_tipsSeen',
    filters: 'playzone_savedFilters',
    sortMode: 'playzone_sortMode',
    missionsJoined: 'playzone_missionsJoined',
    firstJoinEver: 'playzone_firstJoinEver',
    showTipIndex: 'playzone_showTipIndex'
  };

  const TIPS = [
    '💡 Las misiones con 1 plaza restante se llenan rápido. ¡Únete antes que nadie!',
    '⚔️ Tu juego principal te da misiones recomendadas. Configúralo en tu perfil.',
    '🏆 Racha diaria: entra cada día a PlayZone para subir de nivel.',
    '🎯 Presiona J para unirte rápidamente a la primera misión disponible.',
    '🔥 Las misiones "activas" brillan más. Son las que buscan jugadores.',
    '👑 El creador de la misión tiene una corona dorada.',
    '⏱️ Revisa el horario de cada misión para no perderte.',
    '💬 Envía solicitud de chat a jugadores que te interesen.',
    '🎭 Usa el botón Teatro para enfocarte solo en las misiones.',
    '🔔 Si tienes misión activa, revísala antes de unirte a otra.'
  ];

  function get(key, def) {
    try {
      const v = localStorage.getItem(key);
      return v !== null ? JSON.parse(v) : def;
    } catch (e) { return def; }
  }
  function set(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {}
  }

  function today() { return new Date().toDateString(); }

  function initStreak() {
    const last = get(STORAGE.lastVisit, null);
    let streak = get(STORAGE.streak, 0);
    const now = today();
    if (last) {
      const lastD = new Date(last);
      const todayD = new Date();
      const diff = Math.floor((todayD - lastD) / (24 * 60 * 60 * 1000));
      if (diff === 0) { /* mismo día, no cambia */ }
      else if (diff === 1) streak++;
      else streak = 1;
    } else streak = 1;
    set(STORAGE.lastVisit, now);
    set(STORAGE.streak, streak);
    return streak;
  }

  function showStreakBadge(streak) {
    let badge = document.getElementById('mechanics-streak-badge');
    if (!badge) return;
    const joined = get(STORAGE.missionsJoined, 0);
    let txt = '🔥 ' + streak + ' días';
    if (joined >= 10) txt += ' · ⚔️ Veterano';
    badge.textContent = txt;
    badge.title = 'Racha: ' + streak + ' días' + (joined >= 10 ? ' · ' + joined + ' misiones completadas' : '');
    badge.className = 'mechanics-streak-badge' + (streak >= 7 ? ' mechanics-streak-gold' : '');
    badge.style.display = 'inline-flex';
  }

  function showTipOfDay() {
    const idx = get(STORAGE.showTipIndex, 0) % TIPS.length;
    set(STORAGE.showTipIndex, idx + 1);
    const el = document.getElementById('mechanics-tip');
    if (!el) return;
    el.textContent = TIPS[idx];
    el.className = 'mechanics-tip-box';
    el.style.display = 'block';
    el.style.animation = 'mechanics-fadeIn 0.5s ease-out';
  }

  function showWelcomeBack(nick) {
    const streak = get(STORAGE.streak, 0);
    const joined = get(STORAGE.missionsJoined, 0);
    const msg = nick ? '¡Bienvenido de nuevo, ' + nick + '!' : '¡Bienvenido a PlayZone!';
    showMechToast(msg + (streak > 1 ? ' 🔥 Racha: ' + streak + ' días' : ''));
  }

  function showMechToast(text, type) {
    let t = document.getElementById('mechanics-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'mechanics-toast';
      t.className = 'mechanics-toast';
      document.body.appendChild(t);
    }
    t.textContent = text;
    t.className = 'mechanics-toast mechanics-toast-show' + (type === 'success' ? ' mechanics-toast-success' : type === 'error' ? ' mechanics-toast-error' : '');
    clearTimeout(t._t);
    t._t = setTimeout(function() {
      t.classList.remove('mechanics-toast-show');
    }, 3500);
  }

  function playJoinSound() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.connect(g);
      g.connect(ctx.destination);
      o.frequency.value = 523;
      o.type = 'sine';
      g.gain.setValueAtTime(0.15, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.2);
      o.start(ctx.currentTime);
      o.stop(ctx.currentTime + 0.2);
    } catch (e) {}
  }

  function createConfetti() {
    const colors = ['#e53935', '#ff5252', '#4caf50', '#2196f3', '#ff1744'];
    const c = document.createElement('div');
    c.className = 'mechanics-confetti-container';
    c.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:99999;';
    for (let i = 0; i < 40; i++) {
      const p = document.createElement('div');
      const tx = (Math.random() - 0.5) * 200;
      const ty = -250 - Math.random() * 150;
      p.className = 'mechanics-confetti';
      p.style.cssText = 'position:absolute;width:8px;height:8px;background:' + colors[i % colors.length] + ';left:50%;top:50%;--tx:' + tx + 'px;--ty:' + ty + 'px;animation:mechanics-confetti-fly 1.5s ease-out forwards;transform:rotate(' + (i * 15) + 'deg);';
      p.style.animationDelay = (i * 0.03) + 's';
      c.appendChild(p);
    }
    document.body.appendChild(c);
    setTimeout(function() { c.remove(); }, 2000);
  }

  function renderMissionsCount(count) {
    const el = document.getElementById('mechanics-missions-count');
    if (!el) return;
    el.textContent = count + ' misiones';
  }

  function applySort(filtered, mode) {
    if (mode === 'slots') {
      return filtered.slice().sort(function(a, b) {
        const sa = (a.maxParticipants || 5) - Object.keys(a.participants || {}).length;
        const sb = (b.maxParticipants || 5) - Object.keys(b.participants || {}).length;
        return sa - sb;
      });
    }
    if (mode === 'tokens') {
      return filtered.slice().sort(function(a, b) {
        return (b.tokenPrize || 0) - (a.tokenPrize || 0);
      });
    }
    if (mode === 'newest') {
      return filtered.slice().reverse();
    }
    return filtered;
  }

  function loadSavedFilters() {
    const f = get(STORAGE.filters, {});
    ['filterMissionGame', 'filterMissionType', 'filterMissionSkill'].forEach(function(id) {
      const el = document.getElementById(id);
      if (el && f[id] !== undefined) el.value = f[id];
    });
  }

  function saveFilters() {
    const f = {};
    ['filterMissionGame', 'filterMissionType', 'filterMissionSkill'].forEach(function(id) {
      const el = document.getElementById(id);
      if (el) f[id] = el.value;
    });
    set(STORAGE.filters, f);
  }

  window.PlayzoneMechanics = {
    init: function() {
      const streak = initStreak();
      showStreakBadge(streak);
      showTipOfDay();
      if (currentUserData && currentUserData.nick) showWelcomeBack(currentUserData.nick);
      loadSavedFilters();
    },
    onJoinSuccess: function(isFirstEver) {
      let joined = get(STORAGE.missionsJoined, 0);
      joined++;
      set(STORAGE.missionsJoined, joined);
      if (isFirstEver) {
        set(STORAGE.firstJoinEver, true);
        createConfetti();
        showMechToast('¡Primera misión completada! 🎉 ¡Sigue así!', 'success');
      }
      playJoinSound();
    },
    getSortMode: function() { return get(STORAGE.sortMode, 'default'); },
    setSortMode: function(mode) { set(STORAGE.sortMode, mode); },
    applySort: applySort,
    saveFilters: saveFilters,
    getMissionsJoined: function() { return get(STORAGE.missionsJoined, 0); },
    isFirstJoinEver: function() { return !get(STORAGE.firstJoinEver, false); },
    showToast: showMechToast
  };
})();
