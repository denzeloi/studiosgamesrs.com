/* Tournament Details — hero video reel (Studiosgamesrs)
 *
 * Plays a fixed sequence of muted background clips inside the tournament hero.
 * Each clip crossfades into the next one CROSSFADE_MS before it would loop back,
 * so the reel never shows a hard cut or a reset frame.
 */
(function () {
  'use strict';

  var CLIPS = [
    { src: 'videos/arena/arena-01-cs2-intro.mp4', poster: 'videos/arena/arena-01-cs2-intro.jpg' },
    { src: 'videos/arena/arena-02-cs2-edit.mp4', poster: 'videos/arena/arena-02-cs2-edit.jpg', soften: true },
    { src: 'videos/arena/arena-03-counterstrike.mp4', poster: 'videos/arena/arena-03-counterstrike.jpg' }
  ];

  var CROSSFADE_MS = 1000;
  var CROSSFADE_S = CROSSFADE_MS / 1000;

  var hero = null;
  var layer = null;
  var slots = [];
  var index = 0;
  var frontSlot = 0;
  var swapping = false;
  var rafId = 0;
  var enabled = true;
  var visible = true;
  var inView = true;

  function prefersReducedMotion() {
    return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function makeSlot(clip) {
    var v = document.createElement('video');
    v.className = 'td-hero-video-slot';
    v.muted = true;
    v.defaultMuted = true;
    v.playsInline = true;
    v.setAttribute('playsinline', '');
    v.setAttribute('webkit-playsinline', '');
    v.setAttribute('muted', '');
    v.setAttribute('aria-hidden', 'true');
    v.loop = false;
    v.controls = false;
    v.preload = 'auto';
    v.tabIndex = -1;
    if (clip) applyClip(v, clip);
    return v;
  }

  function applyClip(v, clip) {
    v.poster = clip.poster || '';
    v.src = clip.src;
    v.classList.toggle('is-soft', !!clip.soften);
  }

  /* Loads the upcoming clip into the hidden slot so the crossfade never stalls. */
  function stageNext() {
    var back = slots[1 - frontSlot];
    var next = CLIPS[(index + 1) % CLIPS.length];
    if (!back || !next) return;
    if (back.dataset.clipSrc === next.src) return;
    back.dataset.clipSrc = next.src;
    applyClip(back, next);
    try { back.load(); } catch (e) { /* ignore */ }
  }

  function playSlot(v) {
    if (!v) return;
    var p = v.play();
    if (p && typeof p.catch === 'function') {
      p.catch(function () { waitForGesture(); });
    }
  }

  var gestureBound = false;
  function waitForGesture() {
    if (gestureBound) return;
    gestureBound = true;
    var resume = function () {
      gestureBound = false;
      document.removeEventListener('pointerdown', resume);
      document.removeEventListener('keydown', resume);
      if (enabled) playSlot(slots[frontSlot]);
    };
    document.addEventListener('pointerdown', resume, { once: true });
    document.addEventListener('keydown', resume, { once: true });
  }

  function advance() {
    if (swapping) return;
    swapping = true;

    var front = slots[frontSlot];
    var back = slots[1 - frontSlot];

    try { back.currentTime = 0; } catch (e) { /* ignore */ }
    playSlot(back);

    back.classList.add('is-front');
    front.classList.remove('is-front');
    frontSlot = 1 - frontSlot;
    index = (index + 1) % CLIPS.length;

    window.setTimeout(function () {
      try {
        front.pause();
        front.currentTime = 0;
      } catch (e) { /* ignore */ }
      swapping = false;
      stageNext();
    }, CROSSFADE_MS);
  }

  function tick() {
    rafId = window.requestAnimationFrame(tick);
    if (!enabled || swapping) return;
    var v = slots[frontSlot];
    if (!v || v.paused || !isFinite(v.duration) || v.duration <= 0) return;
    if (v.duration - v.currentTime <= CROSSFADE_S) advance();
  }

  function syncPlayback() {
    var shouldRun = enabled && visible && inView;
    var v = slots[frontSlot];
    if (!v) return;
    if (shouldRun) {
      if (v.paused) playSlot(v);
    } else if (!v.paused) {
      v.pause();
    }
  }

  function observeViewport() {
    if (!('IntersectionObserver' in window)) return;
    var io = new IntersectionObserver(function (entries) {
      inView = entries[0].isIntersecting;
      syncPlayback();
    }, { threshold: 0.01 });
    io.observe(hero);
  }

  function init() {
    hero = document.getElementById('tdBanner');
    if (!hero || hero.querySelector('.td-hero-video')) return;

    layer = document.createElement('div');
    layer.className = 'td-hero-video';
    layer.setAttribute('aria-hidden', 'true');

    if (prefersReducedMotion()) {
      layer.classList.add('is-static');
      layer.style.backgroundImage = 'url("' + CLIPS[0].poster + '")';
      hero.insertBefore(layer, hero.firstChild);
      hero.classList.add('has-reel');
      return;
    }

    slots = [makeSlot(CLIPS[0]), makeSlot(null)];
    slots[0].dataset.clipSrc = CLIPS[0].src;
    slots[0].classList.add('is-front');
    layer.appendChild(slots[0]);
    layer.appendChild(slots[1]);

    hero.insertBefore(layer, hero.firstChild);
    hero.classList.add('has-reel');

    slots[0].addEventListener('loadeddata', function () {
      layer.classList.add('is-ready');
    }, { once: true });

    playSlot(slots[0]);
    stageNext();
    observeViewport();
    rafId = window.requestAnimationFrame(tick);

    document.addEventListener('visibilitychange', function () {
      visible = !document.hidden;
      syncPlayback();
    });
  }

  /* Lets tournament-details.js stop the reel once the tournament is closed. */
  window.TDHeroVideo = {
    setActive: function (on) {
      enabled = !!on;
      if (hero) hero.classList.toggle('reel-paused', !enabled);
      syncPlayback();
    },
    destroy: function () {
      if (rafId) window.cancelAnimationFrame(rafId);
      rafId = 0;
      slots.forEach(function (v) {
        try { v.pause(); } catch (e) { /* ignore */ }
      });
      if (layer && layer.parentNode) layer.parentNode.removeChild(layer);
      if (hero) hero.classList.remove('has-reel');
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
