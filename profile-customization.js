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

  // Clases que se limpian antes de aplicar otro marco. Se derivan de la
  // configuración: si se añadiera un marco built-in y su clase no estuviera
  // aquí, se quedaría pegada al contenedor al cambiar de marco.
  var FRAME_CLASSES = collectCssClasses(
    CFG.builtinFrames,
    ['profile-frame-default', 'profile-frame-nexus-ember', 'profile-frame-dragon-guard', 'profile-frame-golden-nexus']
  );
  var BACKGROUND_CLASSES = collectCssClasses(CFG.builtinBackgrounds, []);
  // Evita spam de marcos en el chat: 30s entre cambios de marco.
  var FRAME_EQUIP_COOLDOWN_MS = 30000;

  function collectCssClasses(catalog, seed) {
    var list = seed.slice();
    Object.keys(catalog || {}).forEach(function(id) {
      var item = catalog[id] || {};
      [item.cssClass, item.baseClass].forEach(function(cls) {
        if (cls && list.indexOf(cls) === -1) list.push(cls);
      });
    });
    return list;
  }

  function getCustomization(ud) {
    return (ud && ud.profileCustomization) ? ud.profileCustomization : {};
  }

  function getEquippedFrameId(cust) {
    return cust.equippedFrame || cust.equippedFrameId || cust.frameId || null;
  }

  function getEquippedBackgroundId(cust) {
    return cust.equippedBackground || cust.equippedBackgroundId || cust.backgroundId || null;
  }

  function getBuiltinCatalog(type) {
    return (type === 'background' ? CFG.builtinBackgrounds : CFG.builtinFrames) || {};
  }

  /** Cosmético que se gana subiendo de nivel (0 si no lo es). */
  function getUnlockLevel(type, id) {
    var item = getBuiltinCatalog(type)[id];
    if (!item || item.source !== 'level') return 0;
    return Number(item.unlockLevel) || 0;
  }

  /**
   * Nivel del jugador. `stats.level` es el espejo que escribe el servidor; si
   * viniera desfasado respecto a la XP, manda el que sale de la curva.
   */
  function getPlayerLevel() {
    var stats = (state.userData && state.userData.stats) || {};
    var level = Math.floor(Number(stats.level) || 0);
    var xp = Math.floor(Number(stats.xp != null ? stats.xp : state.userData && state.userData.xp) || 0);
    var levels = global.SGLevels;
    if (levels && xp > 0) level = Math.max(level, levels.levelFromXp(xp));
    return Math.max(1, level);
  }

  function isUnlocked(cust, type, id) {
    if (!id) return false;
    if (type === 'frame' && CFG.freeUnlockIds && CFG.freeUnlockIds.indexOf(id) !== -1) return true;
    var unlocked = cust.unlocked || cust.owned || {};
    if (unlocked[id]) return true;
    if (unlocked[type] && unlocked[type][id]) return true;
    // Red de seguridad: la entrega de premios la escribe el servidor en
    // unlocked/{id} (el cliente no puede), y el trigger puede tardar. Si el
    // jugador ya tiene el nivel, se le deja usar su premio al instante.
    var needed = getUnlockLevel(type, id);
    if (needed && getPlayerLevel() >= needed) return true;
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
    if (img && img.src) return img.src;
    // Silueta de reserva; el PNG que había aquí antes no existe en el sitio.
    return 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0MCIgaGVpZ2h0PSI0MCIgdmlld0JveD0iMCAwIDQwIDQwIj48Y2lyY2xlIGN4PSIyMCIgY3k9IjIwIiByPSIyMCIgZmlsbD0iIzMzMyIvPjxjaXJjbGUgY3g9IjIwIiBjeT0iMTUiIHI9IjYiIGZpbGw9IiM2NjYiLz48Y2lyY2xlIGN4PSIyMCIgY3k9IjMwIiByPSI5IiBmaWxsPSIjNjY2Ii8+PC9zdmc+';
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
    clearFrameClasses(container);
    if (overlay) {
      overlay.style.backgroundImage = '';
      clearFrameLayoutClasses(overlay);
    }
    if (container) container.classList.remove('has-profile-frame');

    if (!frameId || frameId === 'default') return;

    var resolved = resolveFrameAsset(frameId);
    if (!resolved) return;

    if (resolved.type === 'builtin' && resolved.data.cssClass) {
      // En dashboard la clase va a la card; en chat/mini-perfil al wrap del avatar.
      [resolved.data.cssClass, resolved.data.baseClass].forEach(function(cls) {
        if (!cls) return;
        if (profileCard) profileCard.classList.add(cls);
        if (container) container.classList.add(cls);
      });
      // Los marcos de nivel dibujan su anillo con CSS sobre el mismo overlay que
      // usan los PNG, así que necesitan su proporción y el recorte de la foto.
      if (resolved.data.cssRing && container && overlay) {
        overlay.classList.add(getFrameLayoutClass(resolved.data.frameLayout));
        container.classList.add('has-profile-frame');
      }
      return;
    }
    if (resolved.type === 'image' && resolved.data.imageUrl && overlay) {
      overlay.style.backgroundImage = 'url("' + String(resolved.data.imageUrl).replace(/"/g, '') + '")';
      overlay.classList.add(getFrameLayoutClass(resolved.data.frameLayout));
      if (container) container.classList.add('has-profile-frame');
    }
  }

  function applyFrameId(container, frameId) {
    if (!container) return;
    applyFrameToContainer(container, null, frameId);
  }

  function getProfileBgElement() {
    return document.querySelector('.profile-stage > .profile-customization-bg')
      || document.querySelector('.profile-customization-bg');
  }

  function getProfileStageElement() {
    return document.getElementById('profileStage')
      || document.querySelector('.profile-stage');
  }

  function clearBackgroundClasses(el) {
    if (!el) return;
    BACKGROUND_CLASSES.forEach(function(cls) { el.classList.remove(cls); });
  }

  /** Un fondo puede ser built-in (degradado CSS) o un PNG del catálogo RTDB. */
  function resolveBackgroundAsset(bgId) {
    if (!bgId) return null;
    if (CFG.builtinBackgrounds && CFG.builtinBackgrounds[bgId]) {
      return { type: 'builtin', data: CFG.builtinBackgrounds[bgId] };
    }
    if (state.assets.background[bgId] && state.assets.background[bgId].imageUrl) {
      return { type: 'image', data: state.assets.background[bgId] };
    }
    return null;
  }

  function applyBackground(bgId) {
    var stage = getProfileStageElement();
    var bgEl = getProfileBgElement();
    if (!bgEl || !stage) return;

    clearBackgroundClasses(bgEl);
    bgEl.style.backgroundImage = '';
    bgEl.style.backgroundSize = '';
    bgEl.style.backgroundPosition = '';
    bgEl.style.backgroundRepeat = '';

    var resolved = resolveBackgroundAsset(bgId);
    if (!resolved) {
      stage.classList.remove('has-profile-bg');
      return;
    }

    if (resolved.type === 'builtin') {
      // El degradado lo pone la clase; nada de background-image en línea, que
      // pisaría la regla CSS del fondo.
      if (resolved.data.baseClass) bgEl.classList.add(resolved.data.baseClass);
      if (resolved.data.cssClass) bgEl.classList.add(resolved.data.cssClass);
      stage.classList.add('has-profile-bg');
      return;
    }

    var url = String(resolved.data.imageUrl).replace(/"/g, '');
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

    clearBackgroundClasses(bgLayer);
    bgLayer.style.backgroundImage = '';

    var resolved = type === 'background' ? resolveBackgroundAsset(id) : null;
    if (resolved) {
      if (resolved.type === 'builtin') {
        if (resolved.data.baseClass) bgLayer.classList.add(resolved.data.baseClass);
        if (resolved.data.cssClass) bgLayer.classList.add(resolved.data.cssClass);
      } else {
        bgLayer.style.backgroundImage = 'url("' + String(resolved.data.imageUrl).replace(/"/g, '') + '")';
      }
      box.classList.add('active');
      box.setAttribute('aria-hidden', 'false');
      return;
    }

    box.classList.remove('active');
    box.setAttribute('aria-hidden', 'true');
  }

  function buildBackgroundPreviewHtml(item) {
    if (item.source === 'builtin') {
      return '<div class="profile-customization-bg-preview ' + esc(item.data.baseClass || '') + ' ' +
        esc(item.data.cssClass || '') + '" role="img" aria-label="Vista previa del fondo"></div>';
    }
    var url = esc(item.data.imageUrl || '');
    return '<div class="profile-customization-bg-preview" style="background-image:url(\'' + url + '\');" role="img" aria-label="Vista previa del fondo"></div>';
  }

  /** Los marcos de anillo CSS se previsualizan sobre un avatar de muestra. */
  function buildBuiltinFramePreviewHtml(item) {
    if (!item.data.cssRing) {
      return '<div class="profile-customization-item-preview profile-customization-preview-' + esc(item.id) + '"></div>';
    }
    return '<div class="profile-customization-frame-preview-wrap">' +
      '<div class="profile-customization-frame-preview-stage has-profile-frame ' +
      esc(item.data.baseClass || '') + ' ' + esc(item.data.cssClass || '') + '">' +
      '<img src="' + esc(getFramePreviewAvatarSrc()) + '" alt="">' +
      '<div class="profile-photo-frame-overlay ' + getFrameLayoutClass(item.data.frameLayout) + '"></div>' +
      '</div></div>';
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

  function buildItemPreviewHtml(item) {
    if (item.type === 'background') return buildBackgroundPreviewHtml(item);
    if (item.source === 'builtin') return buildBuiltinFramePreviewHtml(item);
    return buildFrameAssetPreviewHtml(item);
  }

  function renderItemCard(item, cust, equippedId) {
    var unlocked = isUnlocked(cust, item.type, item.id);
    var selected = equippedId === item.id;
    var isLevelItem = item.data.source === 'level';
    var lockedByLevel = isLevelItem && !unlocked;
    var cost = item.data.tokenCost || 0;
    var meta = unlocked
      ? 'Desbloqueado'
      : (isLevelItem ? (item.data.unlockLabel || ('Nivel ' + item.data.unlockLevel)) : cost + ' tokens');

    return '<button type="button" class="profile-customization-item' + (selected ? ' selected' : '') +
      (unlocked ? '' : ' locked') + (lockedByLevel ? ' locked-level' : '') +
      '" data-item-type="' + esc(item.type) + '" data-item-id="' + esc(item.id) + '" data-item-cost="' + cost + '">' +
      buildItemPreviewHtml(item) +
      '<div class="profile-customization-item-title">' + esc(item.data.name || item.id) + '</div>' +
      '<div class="profile-customization-item-meta">' +
      '<span class="profile-customization-item-cost' + (lockedByLevel ? ' profile-customization-item-unlock' : '') + '">' +
      esc(meta) + '</span>' +
      (selected ? '<span class="profile-customization-item-status">Equipado</span>' : '') +
      '</div></button>';
  }

  function gridHtml(items, cust, equippedId) {
    return '<div class="profile-customization-items-grid">' + items.map(function(item) {
      return renderItemCard(item, cust, equippedId);
    }).join('') + '</div>';
  }

  /**
   * Sección de premios de nivel. Se ordenan por nivel de desbloqueo, que es lo
   * mismo que agruparlos por tramo (cada tramo estrena una sola pieza), y los
   * que aún no tiene el jugador se enseñan bloqueados a propósito: son el
   * escaparate de lo que gana si sigue subiendo.
   */
  function levelSectionHtml(title, items, cust, equippedId) {
    if (!items.length) return '';
    var sorted = items.slice().sort(function(a, b) {
      return (Number(a.data.unlockLevel) || 0) - (Number(b.data.unlockLevel) || 0);
    });
    return '<h4 class="profile-customization-section-title">' + esc(title) + '</h4>' +
      '<p class="profile-customization-modal-intro">Se ganan subiendo de nivel Nexus. Vas por el nivel ' +
      getPlayerLevel() + '.</p>' + gridHtml(sorted, cust, equippedId);
  }

  function splitByLevelSource(items) {
    var shop = [];
    var level = [];
    items.forEach(function(item) {
      (item.data.source === 'level' ? level : shop).push(item);
    });
    return { shop: shop, level: level };
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
    var frames = splitByLevelSource(frameItems);

    framesList.innerHTML = '<h4 class="profile-customization-section-title">Marcos de foto</h4>' +
      gridHtml(frames.shop, cust, equippedFrame) +
      levelSectionHtml('Marcos de nivel Nexus', frames.level, cust, equippedFrame);

    var bgItems = [];
    Object.keys(CFG.builtinBackgrounds || {}).forEach(function(id) {
      bgItems.push({ id: id, type: 'background', source: 'builtin', data: CFG.builtinBackgrounds[id] });
    });
    Object.keys(state.assets.background).forEach(function(id) {
      bgItems.push({ id: id, type: 'background', source: 'asset', data: state.assets.background[id] });
    });
    var backgrounds = splitByLevelSource(bgItems);

    bgList.innerHTML = '<h4 class="profile-customization-section-title">Fondos de perfil (banner)</h4>' +
      (backgrounds.shop.length
        ? gridHtml(backgrounds.shop, cust, equippedBg)
        : '<p class="profile-customization-modal-intro">Aún no hay fondos publicados.</p>') +
      levelSectionHtml('Fondos de nivel Nexus', backgrounds.level, cust, equippedBg);

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
      var neededLevel = getUnlockLevel(type, id);
      if (neededLevel) {
        // No se compran: los entrega el servidor al subir de nivel.
        var locked = getBuiltinCatalog(type)[id] || {};
        var lockedMsg = 'Aún no es tuyo. Se desbloquea en el ' +
          (locked.unlockLabel || ('Nivel ' + neededLevel)).replace('Nivel', 'nivel') + '.';
        if (typeof showFloatingMessage === 'function') showFloatingMessage('info', lockedMsg);
        else alert(lockedMsg);
        return;
      }
      if (type === 'frame') {
        var lastBuy = Number(cust.lastFrameEquipAt || 0);
        var leftBuy = FRAME_EQUIP_COOLDOWN_MS - (Date.now() - lastBuy);
        if (lastBuy && leftBuy > 0) {
          var secsBuy = Math.ceil(leftBuy / 1000);
          var waitBuy = 'Espera ' + secsBuy + 's para cambiar de marco otra vez (anti-abuso del chat).';
          if (typeof showFloatingMessage === 'function') showFloatingMessage('info', waitBuy);
          else alert(waitBuy);
          return;
        }
      }
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
        var equipKeyBought = type === 'background' ? 'equippedBackground' : 'equippedFrame';
        state.userData.profileCustomization[equipKeyBought] = id;
        if (type === 'frame') {
          state.userData.profileCustomization.lastFrameEquipAt = Date.now();
          state.db.ref('users/' + state.currentUid + '/profileCustomization/lastFrameEquipAt')
            .set(state.userData.profileCustomization.lastFrameEquipAt).catch(function() {});
        }
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
    if (type === 'frame') {
      var last = Number((getCustomization(state.userData).lastFrameEquipAt) || 0);
      var left = FRAME_EQUIP_COOLDOWN_MS - (Date.now() - last);
      if (last && left > 0) {
        var secs = Math.ceil(left / 1000);
        var msgWait = 'Espera ' + secs + 's para cambiar de marco otra vez (anti-abuso del chat).';
        if (typeof showFloatingMessage === 'function') showFloatingMessage('info', msgWait);
        else alert(msgWait);
        return Promise.resolve();
      }
    }
    var updates = {};
    updates[key] = id;
    if (type === 'frame') updates.lastFrameEquipAt = Date.now();
    return state.db.ref('users/' + state.currentUid + '/profileCustomization').update(updates).then(function() {
      if (!state.userData.profileCustomization) state.userData.profileCustomization = {};
      state.userData.profileCustomization[key] = id;
      if (type === 'frame') state.userData.profileCustomization.lastFrameEquipAt = updates.lastFrameEquipAt;
      applyAppearance(state.userData);
      updateLivePreview(type, id);
      renderModalLists();
      if (typeof showFloatingMessage === 'function') {
        showFloatingMessage('success', type === 'frame'
          ? 'Marco equipado. Se verá en el chat en unos segundos.'
          : 'Apariencia actualizada.');
      }
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
    applyFrameId: applyFrameId,
    resolveFrameAsset: resolveFrameAsset,
    getCustomization: getCustomization,
    getEquippedFrameId: getEquippedFrameId,
    getEquippedBackgroundId: getEquippedBackgroundId,
    isUnlocked: isUnlocked,
    getPlayerLevel: getPlayerLevel,
    getUnlockLevel: getUnlockLevel,
    renderModalLists: renderModalLists,
    FRAME_CLASSES: FRAME_CLASSES,
    BACKGROUND_CLASSES: BACKGROUND_CLASSES,
    FRAME_EQUIP_COOLDOWN_MS: FRAME_EQUIP_COOLDOWN_MS
  };
})(typeof window !== 'undefined' ? window : this);
