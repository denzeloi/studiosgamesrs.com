/**
 * Marcos y fondos de perfil — Dashboard y avatares comunitarios.
 */
(function(global) {
  'use strict';

  var CFG = global.SGProfileCustomizationConfig || { builtinFrames: {}, freeUnlockIds: ['default'] };
  var state = {
    db: null,
    currentUid: null,
    profileUid: null,
    userData: null,
    isOwn: false,
    assets: { frame: {}, background: {} },
    assetsLoaded: false,
    assetsPromise: null
  };

  var FRAME_CLASSES = ['profile-frame-default', 'profile-frame-nexus-ember', 'profile-frame-dragon-guard', 'profile-frame-golden-nexus'];

  function getCustomization(ud) {
    return (ud && ud.profileCustomization) ? ud.profileCustomization : {};
  }

  function getEquippedFrameId(cust) {
    return cust.equippedFrame || cust.equippedFrameId || cust.frameId || null;
  }

  function getEquippedBackgroundId(cust) {
    return cust.equippedBackground || cust.equippedBackgroundId || cust.backgroundId || null;
  }

  function isUnlocked(cust, type, id) {
    if (!id) return false;
    if (type === 'frame' && CFG.freeUnlockIds && CFG.freeUnlockIds.indexOf(id) !== -1) return true;
    var unlocked = cust.unlocked || cust.owned || {};
    if (unlocked[id]) return true;
    if (unlocked[type] && unlocked[type][id]) return true;
    return false;
  }

  function loadAssets(db) {
    if (state.assetsLoaded) return Promise.resolve(state.assets);
    if (state.assetsPromise) return state.assetsPromise;
    state.assetsPromise = db.ref('profileCustomizationAssets').once('value').then(function(snap) {
      state.assets = { frame: {}, background: {} };
      if (snap.exists()) {
        snap.forEach(function(typeSnap) {
          var bucket = typeSnap.key === 'background' ? 'background' : 'frame';
          typeSnap.forEach(function(ch) {
            var val = ch.val() || {};
            state.assets[bucket][ch.key] = Object.assign({ id: ch.key }, val);
          });
        });
      }
      state.assetsLoaded = true;
      return state.assets;
    }).catch(function() {
      state.assetsLoaded = true;
      return state.assets;
    });
    return state.assetsPromise;
  }

  function ensureFrameOverlay(container) {
    if (!container) return null;
    if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
    var overlay = container.querySelector('.profile-photo-frame-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.className = 'profile-photo-frame-overlay';
      overlay.setAttribute('aria-hidden', 'true');
      container.appendChild(overlay);
    }
    return overlay;
  }

  function clearFrameClasses(el) {
    if (!el) return;
    FRAME_CLASSES.forEach(function(cls) { el.classList.remove(cls); });
  }

  function getFrameLayoutClass(layout) {
    var layouts = CFG.frameLayouts || {};
    var key = layout || CFG.defaultFrameLayout || 'wide';
    if (layouts[key] && layouts[key].cssClass) return layouts[key].cssClass;
    return 'frame-layout-wide';
  }

  function clearFrameLayoutClasses(overlay) {
    if (!overlay) return;
    overlay.classList.remove('frame-layout-wide', 'frame-layout-standard', 'frame-layout-ornate');
  }

  function getFramePreviewAvatarSrc() {
    var img = document.querySelector('#profileImageContainer img, .profile-image-container img');
    return (img && img.src) ? img.src : '/dragon_profile_studiosgamesrs.png';
  }

  function buildFrameAssetPreviewHtml(item) {
    var layoutClass = getFrameLayoutClass(item.data.frameLayout);
    var url = esc(item.data.imageUrl || '');
    return '<div class="profile-customization-frame-preview-wrap">' +
      '<div class="profile-customization-frame-preview-stage has-profile-frame">' +
      '<img src="' + esc(getFramePreviewAvatarSrc()) + '" alt="">' +
      '<div class="profile-photo-frame-overlay ' + layoutClass + '" style="background-image:url(\'' + url + '\')"></div>' +
      '</div></div>';
  }

  function resolveFrameAsset(frameId) {
    if (!frameId) return null;
    if (CFG.builtinFrames && CFG.builtinFrames[frameId]) {
      return { type: 'builtin', data: CFG.builtinFrames[frameId] };
    }
    if (state.assets.frame[frameId]) {
      return { type: 'image', data: state.assets.frame[frameId] };
    }
    return null;
  }

  function applyFrameToContainer(container, profileCard, frameId) {
    var overlay = ensureFrameOverlay(container);
    clearFrameClasses(profileCard);
    if (overlay) {
      overlay.style.backgroundImage = '';
      clearFrameLayoutClasses(overlay);
    }
    if (container) container.classList.remove('has-profile-frame');

    if (!frameId) return;

    var resolved = resolveFrameAsset(frameId);
    if (!resolved) return;

    if (resolved.type === 'builtin' && resolved.data.cssClass) {
      if (profileCard) profileCard.classList.add(resolved.data.cssClass);
      return;
    }
    if (resolved.type === 'image' && resolved.data.imageUrl && overlay) {
      overlay.style.backgroundImage = 'url("' + String(resolved.data.imageUrl).replace(/"/g, '') + '")';
      overlay.classList.add(getFrameLayoutClass(resolved.data.frameLayout));
      if (container) container.classList.add('has-profile-frame');
    }
  }

  function getProfileBgElement() {
    return document.querySelector('.profile-stage > .profile-customization-bg')
      || document.querySelector('.profile-customization-bg');
  }

  function getProfileStageElement() {
    return document.getElementById('profileStage')
      || document.querySelector('.profile-stage');
  }

  function applyBackground(bgId) {
    var stage = getProfileStageElement();
    var bgEl = getProfileBgElement();
    if (!bgEl || !stage) return;

    if (!bgId || !state.assets.background[bgId] || !state.assets.background[bgId].imageUrl) {
      bgEl.style.backgroundImage = '';
      stage.classList.remove('has-profile-bg');
      return;
    }

    var url = String(state.assets.background[bgId].imageUrl).replace(/"/g, '');
    bgEl.style.backgroundImage = 'url("' + url + '")';
    bgEl.style.backgroundSize = 'cover';
    bgEl.style.backgroundPosition = 'center center';
    bgEl.style.backgroundRepeat = 'no-repeat';
    stage.classList.add('has-profile-bg');
  }

  function updateLivePreview(type, id) {
    var box = document.getElementById('profileCustomizationLivePreview');
    var bgLayer = box && box.querySelector('.profile-customization-live-preview-bg');
    var avatar = document.getElementById('profileCustomizationLiveAvatar');
    if (!box || !bgLayer) return;

    if (avatar) avatar.src = getFramePreviewAvatarSrc();

    if (type === 'background' && id && state.assets.background[id] && state.assets.background[id].imageUrl) {
      var u = String(state.assets.background[id].imageUrl).replace(/"/g, '');
      bgLayer.style.backgroundImage = 'url("' + u + '")';
      box.classList.add('active');
      box.setAttribute('aria-hidden', 'false');
      return;
    }

    bgLayer.style.backgroundImage = '';
    box.classList.remove('active');
    box.setAttribute('aria-hidden', 'true');
  }

  function buildBackgroundPreviewHtml(item) {
    var url = esc(item.data.imageUrl || '');
    return '<div class="profile-customization-bg-preview" style="background-image:url(\'' + url + '\');" role="img" aria-label="Vista previa del fondo"></div>';
  }

  function applyDashboardTheme(cust) {
    var theme = cust.dashboardTheme || 'red';
    document.body.classList.toggle('dashboard-theme-gold', theme === 'gold');
    var redBtn = document.getElementById('dashboardThemeRedBtn');
    var goldBtn = document.getElementById('dashboardThemeGoldBtn');
    if (redBtn) redBtn.classList.toggle('selected', theme !== 'gold');
    if (goldBtn) goldBtn.classList.toggle('selected', theme === 'gold');
  }

  function applyAppearance(userData) {
    var cust = getCustomization(userData);
    var container = document.getElementById('profileImageContainer');
    var card = document.querySelector('.profile-card');
    applyFrameToContainer(container, card, getEquippedFrameId(cust));
    applyBackground(getEquippedBackgroundId(cust));
    applyDashboardTheme(cust);
  }

  function applyAvatarFrame(container, userData) {
    if (!container) return;
    applyFrameToContainer(container, null, getEquippedFrameId(getCustomization(userData)));
  }

  function esc(s) {
    if (s == null) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function getUserTokens() {
    return (state.userData && typeof state.userData.tokens === 'number') ? state.userData.tokens : 0;
  }

  function renderModalLists() {
    var framesList = document.getElementById('profileCustomizationFramesList');
    var bgList = document.getElementById('profileCustomizationBackgroundsList');
    if (!framesList || !bgList) return;

    var cust = getCustomization(state.userData);
    var equippedFrame = getEquippedFrameId(cust);
    var equippedBg = getEquippedBackgroundId(cust);

    var frameItems = [];
    Object.keys(CFG.builtinFrames || {}).forEach(function(id) {
      frameItems.push({ id: id, type: 'frame', source: 'builtin', data: CFG.builtinFrames[id] });
    });
    Object.keys(state.assets.frame).forEach(function(id) {
      frameItems.push({ id: id, type: 'frame', source: 'asset', data: state.assets.frame[id] });
    });

    framesList.innerHTML = '<h4 class="profile-customization-section-title">Marcos de foto</h4><div class="profile-customization-items-grid">' +
      frameItems.map(function(item) {
        var unlocked = isUnlocked(cust, 'frame', item.id);
        var cost = item.data.tokenCost || 0;
        var selected = equippedFrame === item.id;
        var preview = item.source === 'builtin'
          ? '<div class="profile-customization-item-preview profile-customization-preview-' + esc(item.id) + '"></div>'
          : buildFrameAssetPreviewHtml(item);
        return '<button type="button" class="profile-customization-item' + (selected ? ' selected' : '') + (unlocked ? '' : ' locked') + '" data-item-type="frame" data-item-id="' + esc(item.id) + '" data-item-cost="' + cost + '">' +
          preview +
          '<div class="profile-customization-item-title">' + esc(item.data.name || item.id) + '</div>' +
          '<div class="profile-customization-item-meta"><span class="profile-customization-item-cost">' + (unlocked ? 'Desbloqueado' : cost + ' tokens') + '</span>' +
          (selected ? '<span class="profile-customization-item-status">Equipado</span>' : '') + '</div></button>';
      }).join('') + '</div>';

    var bgItems = Object.keys(state.assets.background).map(function(id) {
      return { id: id, data: state.assets.background[id] };
    });
    bgList.innerHTML = '<h4 class="profile-customization-section-title">Fondos de perfil (banner)</h4>' +
      (bgItems.length
        ? '<div class="profile-customization-items-grid">' + bgItems.map(function(item) {
            var unlocked = isUnlocked(cust, 'background', item.id);
            var cost = item.data.tokenCost || 0;
            var selected = equippedBg === item.id;
            return '<button type="button" class="profile-customization-item' + (selected ? ' selected' : '') + (unlocked ? '' : ' locked') + '" data-item-type="background" data-item-id="' + esc(item.id) + '" data-item-cost="' + cost + '">' +
              buildBackgroundPreviewHtml(item) +
              '<div class="profile-customization-item-title">' + esc(item.data.name || item.id) + '</div>' +
              '<div class="profile-customization-item-meta"><span class="profile-customization-item-cost">' + (unlocked ? 'Desbloqueado' : cost + ' tokens') + '</span>' +
              (selected ? '<span class="profile-customization-item-status">Equipado</span>' : '') + '</div></button>';
          }).join('') + '</div>'
        : '<p class="profile-customization-modal-intro">Aún no hay fondos publicados.</p>');

    framesList.querySelectorAll('.profile-customization-item').forEach(bindItemClick);
    bgList.querySelectorAll('.profile-customization-item').forEach(bindItemClick);
  }

  function bindItemClick(btn) {
    btn.addEventListener('click', function() {
      var type = btn.getAttribute('data-item-type');
      var id = btn.getAttribute('data-item-id');
      if (type === 'background') updateLivePreview('background', id);
      handleItemAction(type, id, parseInt(btn.getAttribute('data-item-cost'), 10) || 0);
    });
    btn.addEventListener('mouseenter', function() {
      if (btn.getAttribute('data-item-type') === 'background') {
        updateLivePreview('background', btn.getAttribute('data-item-id'));
      }
    });
  }

  function purchaseViaFunction(type, id) {
    if (typeof firebase === 'undefined' || !firebase.functions) {
      return Promise.reject(new Error('Cloud Functions no disponibles.'));
    }
    return firebase.functions().httpsCallable('purchaseProfileCustomizationItem')({
      type: type,
      itemId: id,
      equipAfter: true
    }).then(function(res) { return res.data || {}; });
  }

  function handleItemAction(type, id, cost) {
    if (!state.db || !state.currentUid || !state.isOwn) return;
    var cust = getCustomization(state.userData);
    var unlocked = isUnlocked(cust, type, id);
    var equipKey = type === 'background' ? 'equippedBackground' : 'equippedFrame';

    if (!unlocked) {
      purchaseViaFunction(type, id).then(function(result) {
        if (!state.userData.profileCustomization) state.userData.profileCustomization = {};
        if (!state.userData.profileCustomization.unlocked) state.userData.profileCustomization.unlocked = {};
        state.userData.profileCustomization.unlocked[id] = true;
        if (result.tokensSpent > 0 && typeof state.userData.tokens === 'number') {
          state.userData.tokens -= result.tokensSpent;
          var tv = document.getElementById('tokensValue');
          if (tv) {
            tv.textContent = String(state.userData.tokens);
            tv.style.color = state.userData.tokens === 0 ? '#ff2222' : '#58f658';
          }
        }
        var equipKey = type === 'background' ? 'equippedBackground' : 'equippedFrame';
        state.userData.profileCustomization[equipKey] = id;
        applyAppearance(state.userData);
        updateLivePreview(type, id);
        renderModalLists();
        if (typeof showFloatingMessage === 'function') {
          showFloatingMessage('success', result.alreadyOwned ? 'Ítem equipado.' : 'Ítem desbloqueado y equipado.');
        }
      }).catch(function(err) {
        var msg = (err && err.message) ? err.message : 'No se pudo desbloquear el ítem.';
        if (typeof showFloatingMessage === 'function') showFloatingMessage('error', msg);
        else alert(msg);
      });
      return;
    }

    if (cust[equipKey] === id) {
      unequipItem(type);
      return;
    }
    equipItem(type, id);
  }

  function equipItem(type, id) {
    var key = type === 'background' ? 'equippedBackground' : 'equippedFrame';
    return state.db.ref('users/' + state.currentUid + '/profileCustomization/' + key).set(id).then(function() {
      if (!state.userData.profileCustomization) state.userData.profileCustomization = {};
      state.userData.profileCustomization[key] = id;
      applyAppearance(state.userData);
      updateLivePreview(type, id);
      renderModalLists();
      if (typeof showFloatingMessage === 'function') showFloatingMessage('success', 'Apariencia actualizada.');
    }).catch(function(err) {
      var msg = (err && err.message) ? err.message : 'No se pudo equipar el ítem.';
      if (typeof showFloatingMessage === 'function') showFloatingMessage('error', msg);
    });
  }

  function unequipItem(type) {
    var key = type === 'background' ? 'equippedBackground' : 'equippedFrame';
    return state.db.ref('users/' + state.currentUid + '/profileCustomization/' + key).remove().then(function() {
      if (state.userData.profileCustomization) delete state.userData.profileCustomization[key];
      applyAppearance(state.userData);
      if (type === 'background') updateLivePreview('background', null);
      renderModalLists();
    });
  }

  function openModal() {
    var modal = document.getElementById('profileCustomizationModal');
    if (!modal) return;
    state.assetsLoaded = false;
    state.assetsPromise = null;
    loadAssets(state.db).then(function() {
      var cust = getCustomization(state.userData);
      updateLivePreview('background', getEquippedBackgroundId(cust));
      renderModalLists();
      modal.style.display = 'flex';
    });
  }

  global.closeProfileCustomizationModal = function() {
    var modal = document.getElementById('profileCustomizationModal');
    if (modal) modal.style.display = 'none';
  };

  function setupCustomizeButton() {
    var btn = document.getElementById('customizeProfileBtn');
    if (!btn || btn.dataset.bound === '1') return;
    btn.dataset.bound = '1';
    btn.style.display = state.isOwn ? '' : 'none';
    btn.addEventListener('click', openModal);

    var redBtn = document.getElementById('dashboardThemeRedBtn');
    var goldBtn = document.getElementById('dashboardThemeGoldBtn');
    if (redBtn && redBtn.dataset.bound !== '1') {
      redBtn.dataset.bound = '1';
      redBtn.addEventListener('click', function() {
        if (!state.db || !state.currentUid) return;
        state.db.ref('users/' + state.currentUid + '/profileCustomization/dashboardTheme').set('red').then(function() {
          if (!state.userData.profileCustomization) state.userData.profileCustomization = {};
          state.userData.profileCustomization.dashboardTheme = 'red';
          applyDashboardTheme(state.userData.profileCustomization);
        });
      });
    }
    if (goldBtn && goldBtn.dataset.bound !== '1') {
      goldBtn.dataset.bound = '1';
      goldBtn.addEventListener('click', function() {
        if (!state.db || !state.currentUid) return;
        state.db.ref('users/' + state.currentUid + '/profileCustomization/dashboardTheme').set('gold').then(function() {
          if (!state.userData.profileCustomization) state.userData.profileCustomization = {};
          state.userData.profileCustomization.dashboardTheme = 'gold';
          applyDashboardTheme(state.userData.profileCustomization);
        });
      });
    }
  }

  global.initProfileCustomization = function(profileUid, userData, isOwn, db, currentUid) {
    if (!db) return;
    state.db = db;
    state.profileUid = profileUid;
    state.userData = userData || {};
    state.isOwn = !!isOwn;
    state.currentUid = currentUid || profileUid;
    loadAssets(db).then(function() {
      applyAppearance(userData);
      if (isOwn) setupCustomizeButton();
    });
  };

  global.SGProfileCustomization = {
    init: function() {},
    loadAssets: loadAssets,
    applyAppearance: applyAppearance,
    applyAvatarFrame: applyAvatarFrame,
    getCustomization: getCustomization,
    getEquippedFrameId: getEquippedFrameId
  };
})(typeof window !== 'undefined' ? window : this);
