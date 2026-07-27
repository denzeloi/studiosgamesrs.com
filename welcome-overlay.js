/**
 * StudiosGamesRS — Welcome / Epic Notification Overlay + Creature Viewer
 * ========================================================================
 * Este archivo expone DOS cosas independientes:
 *
 * 1) window.SGCreatureViewer — módulo reutilizable (sin dependencias de
 *    página) que sabe renderizar un personaje 3D animado (Three.js, canvas
 *    transparente) dentro de cualquier <canvas>. Lo usan tanto el overlay
 *    de bienvenida/torneo/broadcast del Dashboard como la mini-preview en
 *    vivo del Commander Panel (sección Broadcast, solo Boss of the State),
 *    para evitar duplicar la lógica de Three.js.
 *
 * 2) La lógica del overlay a pantalla completa en sí (DOM inyectado,
 *    mismo mecanismo que tribunal-user-overlay.js pero con un ambiente
 *    dorado/legendario, celebratorio). Esta parte SOLO corre en la página
 *    de Dashboard. Dispara en 3 casos:
 *      a) Primer login (users/{uid}/welcomeOverlaySeen)
 *      b) Nueva invitación a torneo para el equipo del usuario
 *         (tournamentInvites/{teamId} — visible para capitán Y roster)
 *      c) Broadcast en vivo activado por Boss of the State (siteBroadcast/current)
 */
(function () {
  'use strict';

  // =========================================================================
  // PARTE 1 — SGCreatureViewer: visor 3D reutilizable (Three.js perezoso)
  // =========================================================================
  // El sitio se sirve desde dos orígenes: studiosgamesrs.com (Apache/cPanel)
  // y studiosgamesrs.web.app (Firebase Hosting). Los .glb (~34MB) y el logo
  // viven solo en Firebase, así que se piden siempre desde ahí salvo que ya
  // estemos en ese mismo origen.
  var SG_CDN = /studiosgamesrs\.web\.app$/i.test(window.location.hostname)
    ? '' : 'https://studiosgamesrs.web.app';

  if (!window.SGCreatureViewer) {
    var THREE_VERSION = '0.160.0';
    var threeModPromise = null;
    var threeMod = null; // { THREE, GLTFLoader } una vez cargado

    // Config de personajes/animaciones. Fácil de extender: agregar otro
    // characterId con su propio basePath + mapa de clips.
    var CHARACTERS = {
      'golem-tortoise': {
        label: 'Golem Tortuga',
        basePath: SG_CDN + '/models/golem-tortoise/',
        clips: {
          idle: 'golem-idle.glb',
          awake: 'golem-awake.glb',
          roar: 'golem-roar.glb',
          walk: 'golem-walk.glb',
          hurt: 'golem-hurt.glb',
          faint: 'golem-faint.glb'
        },
        loopClip: 'idle',
        // El modelo viene mirando hacia atrás; se gira para quedar de frente
        // con un leve tres cuartos.
        yawDeg: 200,
        // Qué hacer cuando termina el clip de entrada, para que cada
        // notificación conserve su propia personalidad en pantalla:
        //   loop = repetirlo, idle = pasar a reposo, hold = congelar el final
        postEntrance: {
          idle: 'loop',
          awake: 'idle',
          roar: 'loop',
          walk: 'loop',
          hurt: 'idle',
          faint: 'hold'
        }
      }
    };

    // Los addons de Three (GLTFLoader, DRACOLoader) importan 'three' como
    // especificador desnudo, que solo resuelve si la página declara un
    // <script type="importmap"> (dashboard y commander-panel lo tienen). Si
    // faltara, se recurre a esm.sh, que sirve los mismos módulos con sus
    // imports ya resueltos. Los tres módulos se piden siempre al mismo origen
    // para no acabar con dos instancias distintas de Three en memoria.
    var THREE_SOURCES = [
      {
        name: 'jsdelivr',
        three: 'https://cdn.jsdelivr.net/npm/three@' + THREE_VERSION + '/build/three.module.js',
        gltf: 'https://cdn.jsdelivr.net/npm/three@' + THREE_VERSION + '/examples/jsm/loaders/GLTFLoader.js',
        draco: 'https://cdn.jsdelivr.net/npm/three@' + THREE_VERSION + '/examples/jsm/loaders/DRACOLoader.js'
      },
      {
        name: 'esm.sh',
        three: 'https://esm.sh/three@' + THREE_VERSION,
        gltf: 'https://esm.sh/three@' + THREE_VERSION + '/examples/jsm/loaders/GLTFLoader.js',
        draco: 'https://esm.sh/three@' + THREE_VERSION + '/examples/jsm/loaders/DRACOLoader.js'
      }
    ];

    function importTrio(src) {
      return Promise.all([import(src.three), import(src.gltf), import(src.draco)]);
    }

    function loadThree() {
      if (threeModPromise) return threeModPromise;
      threeModPromise = importTrio(THREE_SOURCES[0]).catch(function (err) {
        sgLog('Three no cargó desde ' + THREE_SOURCES[0].name + ', probando ' + THREE_SOURCES[1].name, (err && err.message) || err);
        return importTrio(THREE_SOURCES[1]);
      }).then(function (mods) {
        // Los .glb se comprimieron con Draco (gltf-transform --compress draco)
        // para bajarlos de ~90MB a ~5.5MB; GLTFLoader necesita un DRACOLoader
        // explícito para poder decodificar esa geometría, si no falla con
        // "No DRACOLoader instance provided."
        var dracoLoader = new mods[2].DRACOLoader();
        dracoLoader.setDecoderPath('https://cdn.jsdelivr.net/npm/three@' + THREE_VERSION + '/examples/jsm/libs/draco/');
        threeMod = { THREE: mods[0], GLTFLoader: mods[1].GLTFLoader, dracoLoader: dracoLoader };
        return threeMod;
      });
      return threeModPromise;
    }

    /** Crea un visor 3D independiente atado a un <canvas>. */
    function createViewer(canvasEl) {
      var renderer = null, scene = null, camera = null, mixer = null, clock = null;
      var resizeObs = null;
      var currentModelRoot = null;
      var gen = 0;
      var rafId = null;
      var paused = true;

      function ensureScene() {
        if (renderer) return;
        var THREE = threeMod.THREE;
        renderer = new THREE.WebGLRenderer({ canvas: canvasEl, alpha: true, antialias: true });
        renderer.setClearColor(0x000000, 0);
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

        scene = new THREE.Scene();
        camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
        camera.position.set(0, 1.4, 5.2);

        // Ambiente volcánico: cielo gris frío, rebote de lava desde abajo y
        // contraluz rojo, en línea con la paleta roja/negra/gris del sitio.
        var hemi = new THREE.HemisphereLight(0x9aa2b0, 0x9c3010, 1.35);
        scene.add(hemi);
        var key = new THREE.DirectionalLight(0xffcaa8, 1.85);
        key.position.set(3, 5, 4);
        scene.add(key);
        var rim = new THREE.DirectionalLight(0xff3e14, 1.2);
        rim.position.set(-4, 2, -3);
        scene.add(rim);
        var lava = new THREE.PointLight(0xff5a1e, 1.6, 16, 2);
        lava.position.set(0, -1.7, 1.6);
        scene.add(lava);

        clock = new THREE.Clock();

        if (typeof ResizeObserver !== 'undefined' && canvasEl.parentElement) {
          resizeObs = new ResizeObserver(function () { resizeRenderer(); });
          resizeObs.observe(canvasEl.parentElement);
        }
        resizeRenderer();
      }

      function resizeRenderer() {
        if (!renderer || !canvasEl || !canvasEl.parentElement) return;
        var w = canvasEl.parentElement.clientWidth || 320;
        var h = canvasEl.parentElement.clientHeight || 320;
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
      }

      function frameModel(root, character) {
        var THREE = threeMod.THREE;
        var yaw = (character && typeof character.yawDeg === 'number') ? character.yawDeg : 0;
        // Se rota antes de medir para que el encuadre y el centrado tengan en
        // cuenta la orientación final.
        root.rotation.y = yaw * Math.PI / 180;
        // IMPORTANTE: hay que forzar updateMatrixWorld antes de medir con
        // Box3, si no las matrices de los huesos/nodos del glTF (recién
        // cargado, aún no renderizado) están sin resolver y Box3 mide un
        // tamaño casi cero -> la cámara enfoca el vacío y "no se ve nada".
        root.updateMatrixWorld(true);
        var box = new THREE.Box3().setFromObject(root);
        var size = new THREE.Vector3();
        box.getSize(size);
        var targetHeight = 2.4;
        var scale = size.y > 0 ? targetHeight / size.y : 1;
        root.scale.setScalar(scale);
        root.updateMatrixWorld(true);

        var box2 = new THREE.Box3().setFromObject(root);
        var size2 = new THREE.Vector3();
        box2.getSize(size2);
        var center2 = new THREE.Vector3();
        box2.getCenter(center2);
        root.position.x -= center2.x;
        root.position.z -= center2.z;
        root.position.y -= box2.min.y - 0.55;

        var dist = size2.y * 1.9 + 1.6;
        camera.position.set(0, size2.y * 0.55, dist);
        camera.lookAt(0, size2.y * 0.42, 0);

        // El modelo quedaba pegado al borde superior y los clips en los que el
        // golem se alza (rugido) se recortaban por arriba, con el borde
        // inferior desperdiciado. Se baja un 15% del alto visible del cuadro.
        var drop = (character && typeof character.frameDrop === 'number') ? character.frameDrop : 0.15;
        var visibleHeight = 2 * dist * Math.tan((camera.fov * Math.PI / 180) / 2);
        root.position.y -= visibleHeight * drop;
        root.updateMatrixWorld(true);
      }

      function loadModel(characterId, clipName, onProgress) {
        var character = CHARACTERS[characterId];
        if (!character) return Promise.reject(new Error('Personaje desconocido: ' + characterId));
        var file = character.clips[clipName];
        if (!file) return Promise.reject(new Error('Animación desconocida: ' + clipName));
        return loadThree().then(function () {
          ensureScene();
          function attempt(triesLeft) {
            return new Promise(function (resolve, reject) {
              var loader = new threeMod.GLTFLoader();
              loader.setDRACOLoader(threeMod.dracoLoader);
              loader.load(character.basePath + file, resolve, function (evt) {
                if (onProgress && evt && evt.total) onProgress(evt.loaded / evt.total);
              }, reject);
            }).catch(function (err) {
              // Cada .glb pesa ~5.5MB: un corte de red o un 404 puntual del CDN
              // no debe dejar la notificación muerta, se reintenta una vez.
              if (triesLeft <= 0) throw err;
              sgLog('reintentando ' + file, (err && err.message) || err);
              return new Promise(function (r) { setTimeout(r, 800); })
                .then(function () { return attempt(triesLeft - 1); });
            });
          }
          return attempt(1);
        });
      }

      function clearCurrentModel() {
        if (currentModelRoot && scene) {
          scene.remove(currentModelRoot);
          currentModelRoot.traverse(function (obj) {
            if (obj.geometry) obj.geometry.dispose();
            if (obj.material) {
              var mats = Array.isArray(obj.material) ? obj.material : [obj.material];
              mats.forEach(function (m) {
                if (!m) return;
                Object.keys(m).forEach(function (k) {
                  if (m[k] && m[k].isTexture) m[k].dispose();
                });
                m.dispose();
              });
            }
          });
        }
        currentModelRoot = null;
        if (mixer) { mixer.stopAllAction(); mixer = null; }
      }

      function renderLoop(token) {
        if (token !== gen || paused) return;
        rafId = requestAnimationFrame(function () { renderLoop(token); });
        var dt = clock ? clock.getDelta() : 0;
        if (mixer) mixer.update(dt);
        if (renderer && scene && camera) renderer.render(scene, camera);
      }

      /**
       * Reproduce entranceClip una vez y pasa a la animación de loop del
       * personaje (con fade rápido vía opacidad del canvas). onReady(err)
       * se llama cuando el modelo de entrada ya cargó (o falló).
       */
      function playEntrance(characterId, entranceClip, onReady, onProgress) {
        var character = CHARACTERS[characterId];
        var token = ++gen;
        paused = false;

        var loopClip = (character && character.loopClip) || 'idle';
        var post = (character && character.postEntrance && character.postEntrance[entranceClip]) || 'idle';
        if (entranceClip === loopClip) post = 'loop';

        loadModel(characterId, entranceClip, onProgress).catch(function (err) {
          // Si el clip pedido no se puede traer, es mejor mostrar al personaje
          // en reposo que dejar el escenario vacío con un mensaje de error.
          if (entranceClip === loopClip) throw err;
          sgLog('no se pudo cargar "' + entranceClip + '", se usa "' + loopClip + '"', (err && err.message) || err);
          post = 'loop';
          return loadModel(characterId, loopClip, onProgress);
        }).then(function (gltf) {
          if (token !== gen) return;
          var THREE = threeMod.THREE;
          clearCurrentModel();
          currentModelRoot = gltf.scene;
          frameModel(currentModelRoot, character);
          scene.add(currentModelRoot);
          mixer = new THREE.AnimationMixer(currentModelRoot);
          var clip = gltf.animations && gltf.animations[0];
          var action = clip ? mixer.clipAction(clip) : null;
          if (action) {
            if (post === 'loop') {
              action.setLoop(THREE.LoopRepeat);
            } else {
              action.setLoop(THREE.LoopOnce);
              action.clampWhenFinished = true;
            }
            action.play();
          }
          if (canvasEl.style) {
            canvasEl.style.transition = 'opacity 0.2s ease';
            canvasEl.style.opacity = '1';
          }
          renderLoop(token);
          if (typeof onReady === 'function') onReady(null);

          if (action && post === 'idle') {
            // El modelo de reposo (otros ~5.5MB) se pide recién ahora, con el
            // clip de entrada ya en pantalla: así la notificación aparece con
            // la mitad de descarga y no se duplica la espera inicial.
            var loopPromise = loadModel(characterId, loopClip);
            mixer.addEventListener('finished', function swapToLoop() {
              if (token !== gen) return;
              loopPromise.then(function (loopGltf) {
                if (token !== gen) return;
                if (canvasEl.style) canvasEl.style.opacity = '0';
                setTimeout(function () {
                  if (token !== gen) return;
                  clearCurrentModel();
                  currentModelRoot = loopGltf.scene;
                  frameModel(currentModelRoot, character);
                  scene.add(currentModelRoot);
                  mixer = new THREE.AnimationMixer(currentModelRoot);
                  var loopAnimClip = loopGltf.animations && loopGltf.animations[0];
                  if (loopAnimClip) mixer.clipAction(loopAnimClip).play();
                  if (canvasEl.style) canvasEl.style.opacity = '1';
                }, 160);
              }).catch(function () {});
            });
          }
        }).catch(function (err) {
          if (typeof onReady === 'function') onReady(err || new Error('load_failed'));
        });
      }

      function pause() {
        paused = true;
        if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
      }
      function resume() {
        if (!paused) return;
        paused = false;
        renderLoop(gen);
      }
      function dispose() {
        gen++;
        pause();
        clearCurrentModel();
        if (resizeObs) { resizeObs.disconnect(); resizeObs = null; }
        if (renderer) { renderer.dispose(); renderer = null; }
        scene = null; camera = null; clock = null;
      }
      function resize() { resizeRenderer(); }

      return { playEntrance: playEntrance, pause: pause, resume: resume, dispose: dispose, resize: resize };
    }

    window.SGCreatureViewer = { CHARACTERS: CHARACTERS, create: createViewer };
  }

  // =========================================================================
  // PARTE 2 — Overlay de Dashboard (bienvenida / invitación / broadcast)
  // =========================================================================
  if (window.__sgWelcomeOverlayBooted) return;
  window.__sgWelcomeOverlayBooted = true;

  function isDashboardPage() {
    return /\/dashboard(\.html)?(\/|$|\?)/i.test(window.location.pathname || '') ||
      window.location.pathname === '/dashboard';
  }
  if (!isDashboardPage()) return;

  var LOGO_SRC = '/logo-studiosgamesrs.png';
  var ASSET_VERSION = '20260727clips';

  /**
   * Si welcome-overlay.css no llegó a cargar (p.ej. no está subido al
   * servidor Apache), el overlay se insertaría sin estilos y aparecería como
   * un bloque enorme al final de la página en vez de una capa. Se detecta y
   * se carga la copia del CDN.
   */
  var stylesheetChecked = false;
  function ensureStylesheet() {
    if (stylesheetChecked || !document.body) return;
    stylesheetChecked = true;
    var probe = document.createElement('div');
    probe.className = 'sg-welcome-overlay';
    probe.style.cssText = '';
    document.body.appendChild(probe);
    var styled = window.getComputedStyle(probe).position === 'fixed';
    document.body.removeChild(probe);
    if (styled) return;
    sgLog('welcome-overlay.css no está aplicado; recuperándolo del CDN');
    // Se descarga el texto y se inyecta como <style>: un <link> cross-origin
    // no siempre llega a aplicar sus reglas, esto sí es determinista.
    fetch((SG_CDN || '') + '/welcome-overlay.css?v=' + ASSET_VERSION).then(function (r) {
      return r.ok ? r.text() : Promise.reject(new Error('HTTP ' + r.status));
    }).then(function (css) {
      var style = document.createElement('style');
      style.id = 'sgWelcomeOverlayFallbackCss';
      style.textContent = css;
      document.head.appendChild(style);
      sgLog('estilos del overlay restaurados desde el CDN');
    }).catch(function (e) {
      sgLog('no se pudo recuperar el CSS del overlay:', e && e.message);
    });
  }

  /** Traza de diagnóstico: visible en la consola del navegador. */
  function sgLog() {
    try {
      var args = ['[SG-Overlay]'].concat(Array.prototype.slice.call(arguments));
      console.log.apply(console, args);
    } catch (e) {}
  }

  function weFx(el, keyframes, opts) {
    if (!el || typeof window.Motion === 'undefined' || !window.Motion.animate) return null;
    try { return window.Motion.animate(el, keyframes, opts); } catch (e) { return null; }
  }

  var overlayEl = null, canvasEl = null, titleEl = null, textEl = null, btnEl = null,
    loadingEl = null, backdropEl = null;
  var isOpen = false;
  var queue = [];
  var viewer = null;
  var embers = null;
  var currentPriority = 0; // 0=normal (welcome/invite), 1=broadcast (interrumpe)

  /**
   * Brasas que suben, con el mismo lenguaje visual que las del chat de
   * comunidad (campfire-chat.js), aquí a pantalla completa. Solo corre
   * mientras el overlay está abierto para no gastar CPU de fondo.
   */
  function createEmbers(canvas) {
    if (!canvas || !canvas.getContext) return null;
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return null;
    var ctx = canvas.getContext('2d');
    if (!ctx) return null;
    var parts = [];
    var raf = null;
    var running = false;

    function resize() {
      var r = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, Math.floor(r.width));
      canvas.height = Math.max(1, Math.floor(r.height));
    }

    function spawn() {
      return {
        x: Math.random() * canvas.width,
        y: canvas.height + Math.random() * 40,
        r: 0.7 + Math.random() * 2.1,
        // Más recorrido que en el chat: aquí tienen que subir toda la pantalla.
        vy: 0.6 + Math.random() * 1.6,
        vx: (Math.random() - 0.5) * 0.5,
        life: 0,
        max: 320 + Math.random() * 420
      };
    }

    function frame() {
      if (!running) return;
      raf = requestAnimationFrame(frame);
      if (document.hidden) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      var target = Math.min(110, Math.round(canvas.width * canvas.height / 22000));
      if (parts.length < target) parts.push(spawn());
      for (var i = parts.length - 1; i >= 0; i -= 1) {
        var p = parts[i];
        p.life += 1;
        p.y -= p.vy;
        p.x += p.vx + Math.sin(p.life / 30) * 0.25;
        if (p.life > p.max || p.y < -14) { parts.splice(i, 1); continue; }
        var alpha = Math.max(0, 0.6 * (1 - p.life / p.max));
        var grd = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r * 4);
        grd.addColorStop(0, 'rgba(255, 190, 120, ' + alpha + ')');
        grd.addColorStop(0.4, 'rgba(255, 120, 50, ' + (alpha * 0.7) + ')');
        grd.addColorStop(1, 'rgba(229, 57, 53, 0)');
        ctx.fillStyle = grd;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r * 4, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    window.addEventListener('resize', function () { if (running) resize(); });

    return {
      start: function () {
        if (running) return;
        running = true;
        resize();
        frame();
      },
      stop: function () {
        running = false;
        if (raf) cancelAnimationFrame(raf);
        raf = null;
        parts.length = 0;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
    };
  }

  function createOverlayDOM() {
    if (overlayEl) return overlayEl;
    ensureStylesheet();
    overlayEl = document.createElement('div');
    overlayEl.id = 'sgWelcomeOverlay';
    overlayEl.className = 'sg-welcome-overlay';
    overlayEl.setAttribute('aria-label', 'StudiosGamesRS');
    overlayEl.innerHTML =
      '<div class="sg-welcome-overlay-backdrop">' +
        '<div class="sg-welcome-overlay-photo" id="sgWelcomePhoto"></div>' +
        '<div class="sg-welcome-overlay-ember"></div>' +
        '<canvas class="sg-welcome-overlay-embers" id="sgWelcomeEmbers"></canvas>' +
      '</div>' +
      '<div class="sg-welcome-overlay-box">' +
        '<button type="button" class="sg-welcome-close-x" id="sgWelcomeCloseX" aria-label="Cerrar"><i class="fas fa-times"></i></button>' +
        '<img class="sg-welcome-logo" src="' + LOGO_SRC + '" alt="StudiosGamesRS" ' +
          'onerror="this.onerror=null;this.src=\'' + (SG_CDN || '') + '/logo-studiosgamesrs.png\';" />' +
        '<div class="sg-welcome-stage">' +
          '<div class="sg-welcome-stage-glow"></div>' +
          '<canvas class="sg-welcome-canvas" id="sgWelcomeCanvas" style="opacity:0;"></canvas>' +
          '<div class="sg-welcome-stage-loading" id="sgWelcomeLoading">Cargando…</div>' +
        '</div>' +
        '<h2 class="sg-welcome-title" id="sgWelcomeTitle"></h2>' +
        '<p class="sg-welcome-text" id="sgWelcomeText"></p>' +
        '<button type="button" class="sg-welcome-btn" id="sgWelcomeBtn">Continuar</button>' +
      '</div>';
    (document.body || document.documentElement).appendChild(overlayEl);

    backdropEl = overlayEl.querySelector('.sg-welcome-overlay-backdrop');
    // La imagen se asigna desde JS (no desde el CSS) porque cuando el CSS se
    // inyecta como <style>, un url() relativo se resolvería contra el dominio
    // de la página y no contra el CDN donde vive la imagen.
    var photoEl = overlayEl.querySelector('#sgWelcomePhoto');
    if (photoEl) photoEl.style.backgroundImage = "url('" + (SG_CDN || '') + "/overlay-volcano.jpg')";
    canvasEl = overlayEl.querySelector('#sgWelcomeCanvas');
    titleEl = overlayEl.querySelector('#sgWelcomeTitle');
    textEl = overlayEl.querySelector('#sgWelcomeText');
    btnEl = overlayEl.querySelector('#sgWelcomeBtn');
    loadingEl = overlayEl.querySelector('#sgWelcomeLoading');
    embers = createEmbers(overlayEl.querySelector('#sgWelcomeEmbers'));
    // Si el visor 3D no está disponible, el overlay igual debe mostrarse
    // (logo + texto + botón); nunca debe romperse por culpa de Three.js.
    try {
      viewer = window.SGCreatureViewer ? window.SGCreatureViewer.create(canvasEl) : null;
    } catch (e) {
      sgLog('no se pudo crear el visor 3D', e);
      viewer = null;
    }

    backdropEl.addEventListener('click', function () { closeOverlay(); });
    overlayEl.querySelector('#sgWelcomeCloseX').addEventListener('click', function () { closeOverlay(); });
    btnEl.addEventListener('click', function () {
      var action = btnEl.getAttribute('data-action');
      closeOverlay();
      if (action === 'go-competition-hub') {
        setTimeout(function () { window.location.href = '/competition-hub'; }, 200);
      }
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && isOpen) closeOverlay();
    });

    return overlayEl;
  }

  function escapeHtml(s) {
    var div = document.createElement('div');
    div.textContent = String(s == null ? '' : s);
    return div.innerHTML;
  }

  // ---------- Contenido por modo ----------
  function fillContent(mode, payload) {
    if (mode === 'welcome') {
      titleEl.textContent = '¡Bienvenido a StudiosGamesRS!';
      textEl.innerHTML = 'Has llegado al mundo de <strong>StudiosGamesRS.com</strong>. ' +
        'En <strong>Play Zone</strong> encuentra amigos, coordina misiones y gana tokens jugando en equipo. ' +
        'En <strong>Nexus</strong> sube de rango, gana XP real y desbloquea recompensas de creador.';
      btnEl.textContent = 'Comenzar la aventura';
      btnEl.removeAttribute('data-action');
      return { characterId: 'golem-tortoise', clip: 'awake' };
    }
    if (mode === 'tournament-invite') {
      var tName = (payload && payload.tournamentName) || 'un torneo';
      var by = (payload && payload.invitedBy) || 'la organización';
      titleEl.textContent = '¡Invitación a Torneo!';
      textEl.innerHTML = 'Tu equipo fue invitado al torneo <strong>' + escapeHtml(tName) + '</strong> por ' +
        escapeHtml(by) + '. ¡Prepárense para la batalla!';
      btnEl.textContent = 'Ver torneo';
      btnEl.setAttribute('data-action', 'go-competition-hub');
      return { characterId: 'golem-tortoise', clip: 'roar' };
    }
    if (mode === 'broadcast') {
      titleEl.textContent = (payload && payload.title) || 'StudiosGamesRS';
      textEl.textContent = (payload && payload.message) || '';
      btnEl.textContent = 'Entendido';
      btnEl.removeAttribute('data-action');
      var charId = (payload && payload.characterId) || 'golem-tortoise';
      var clip = (payload && payload.animation) || 'awake';
      if (!window.SGCreatureViewer.CHARACTERS[charId]) charId = 'golem-tortoise';
      if (!window.SGCreatureViewer.CHARACTERS[charId].clips[clip]) clip = 'awake';
      return { characterId: charId, clip: clip };
    }
    titleEl.textContent = 'StudiosGamesRS';
    textEl.textContent = '';
    btnEl.textContent = 'Continuar';
    btnEl.removeAttribute('data-action');
    return { characterId: 'golem-tortoise', clip: 'idle' };
  }

  // ---------- Apertura / cierre ----------
  function showOverlay(mode, payload, priority) {
    priority = priority || 0;
    if (isOpen) {
      if (priority > currentPriority) {
        // Un broadcast interrumpe lo que se esté mostrando (welcome/invite).
        queue = []; // no tiene sentido reencolar algo que ya fue interrumpido
        openNow(mode, payload, priority);
      } else {
        queue.push({ mode: mode, payload: payload, priority: priority });
      }
      return;
    }
    openNow(mode, payload, priority);
  }

  function openNow(mode, payload, priority) {
    isOpen = true;
    currentPriority = priority || 0;
    createOverlayDOM();
    if (loadingEl) { loadingEl.style.display = ''; loadingEl.textContent = 'Cargando…'; }
    if (canvasEl) canvasEl.style.opacity = '0';
    var pick = fillContent(mode, payload);
    overlayEl.classList.add('sg-welcome-overlay-visible');
    if (embers) embers.start();
    weFx(overlayEl.querySelector('.sg-welcome-logo'), { opacity: [0, 1], y: [-10, 0] }, { duration: 0.4, ease: 'easeOut' });
    weFx(titleEl, { opacity: [0, 1], y: [10, 0] }, { duration: 0.4, delay: 0.1, ease: 'easeOut' });
    weFx(textEl, { opacity: [0, 1] }, { duration: 0.4, delay: 0.18, ease: 'easeOut' });
    weFx(btnEl, { opacity: [0, 1], scale: [0.9, 1] }, { duration: 0.35, delay: 0.24, ease: 'easeOut' });
    if (viewer) {
      viewer.playEntrance(pick.characterId, pick.clip, function (err) {
        if (loadingEl) {
          if (err) { loadingEl.textContent = 'No se pudo cargar la animación.'; }
          else { loadingEl.style.display = 'none'; }
        }
      }, function (ratio) {
        // El modelo pesa ~5.5MB: sin esto la primera vez parece que se colgó.
        if (loadingEl) loadingEl.textContent = 'Invocando… ' + Math.min(100, Math.round(ratio * 100)) + '%';
      });
    }
  }

  function closeOverlay() {
    if (!isOpen || !overlayEl) return;
    isOpen = false;
    currentPriority = 0;
    overlayEl.classList.remove('sg-welcome-overlay-visible');
    if (viewer) viewer.pause();
    if (embers) setTimeout(function () { if (!isOpen) embers.stop(); }, 400);
    setTimeout(function () {
      var next = queue.shift();
      if (next) showOverlay(next.mode, next.payload, next.priority);
    }, 450);
  }

  // ---------- Trigger 1: primer login ----------
  function checkFirstLogin(uid, db) {
    db.ref('users/' + uid + '/welcomeOverlaySeen').once('value').then(function (snap) {
      if (snap.val() === true) return;
      db.ref('users/' + uid + '/welcomeOverlaySeen').set(true).catch(function () {});
      showOverlay('welcome', null, 0);
    }).catch(function () {});
  }

  // ---------- Trigger 2: invitación a torneo nueva (capitán + roster) ----------
  function getSeenInvites(uid) {
    try {
      var raw = localStorage.getItem('sgWelcomeSeenInvites_' + uid);
      return raw ? JSON.parse(raw) : {};
    } catch (e) { return {}; }
  }
  function markInviteSeen(uid, key) {
    try {
      var seen = getSeenInvites(uid);
      seen[key] = 1;
      localStorage.setItem('sgWelcomeSeenInvites_' + uid, JSON.stringify(seen));
    } catch (e) {}
  }

  function listenForTournamentInvites(uid, db) {
    db.ref('users/' + uid + '/teamId').on('value', function (teamSnap) {
      var teamId = teamSnap.val();
      if (!teamId || typeof teamId !== 'string') return;
      db.ref('tournamentInvites/' + teamId).on('value', function (invSnap) {
        if (!invSnap.exists()) return;
        var seen = getSeenInvites(uid);
        var newest = null;
        invSnap.forEach(function (child) {
          var key = teamId + '_' + child.key;
          if (seen[key]) return;
          var v = child.val() || {};
          if (!newest || (v.timestamp || 0) > (newest.ts || 0)) {
            newest = { key: key, ts: v.timestamp || 0, tournamentName: v.tournamentName, invitedBy: v.invitedBy };
          }
        });
        if (!newest) return;
        var isFresh = newest.ts && (Date.now() - newest.ts) < 60 * 60 * 1000;
        invSnap.forEach(function (child) { markInviteSeen(uid, teamId + '_' + child.key); });
        if (isFresh) {
          showOverlay('tournament-invite', { tournamentName: newest.tournamentName, invitedBy: newest.invitedBy }, 0);
        }
      }, function () { /* permission-denied si el usuario dejó el equipo entre listeners: ignorar */ });
    });
  }

  // ---------- Trigger 3: broadcast en vivo (Boss of the State) ----------
  function getLastSeenBroadcastTs() {
    try { return parseInt(localStorage.getItem('sgWelcomeLastBroadcastTs') || '0', 10) || 0; } catch (e) { return 0; }
  }
  function setLastSeenBroadcastTs(ts) {
    try { localStorage.setItem('sgWelcomeLastBroadcastTs', String(ts)); } catch (e) {}
  }

  function listenForBroadcast(db) {
    sgLog('escuchando siteBroadcast/current…');
    db.ref('siteBroadcast/current').on('value', function (snap) {
      var v = snap.val();
      sgLog('broadcast recibido:', v);
      if (!v || v.active !== true) { sgLog('sin transmisión activa'); return; }
      var ts = v.triggeredAt || 0;
      var lastSeen = getLastSeenBroadcastTs();
      if (!ts || ts <= lastSeen) {
        sgLog('transmisión ya vista (ts ' + ts + ' <= visto ' + lastSeen + '); usa ?sgtest=1 para forzarla');
        return;
      }
      // Marcar como vista SOLO después de abrirla, para que un fallo no
      // "queme" el anuncio y lo deje invisible para siempre.
      showOverlay('broadcast', {
        title: v.title, message: v.message, characterId: v.characterId, animation: v.animation
      }, 1);
      setLastSeenBroadcastTs(ts);
    }, function (err) {
      sgLog('ERROR leyendo siteBroadcast (¿reglas de Firebase?):', err && err.message);
    });
  }

  // ---------- Bootstrap ----------
  /** /dashboard?sgtest=1 fuerza el overlay sin depender de auth ni de la BD. */
  function checkTestFlag() {
    var q = String(window.location.search || '');
    if (q.indexOf('sgtest=1') === -1) return false;
    sgLog('modo prueba (?sgtest=1): forzando overlay');
    showOverlay('broadcast', {
      title: 'Prueba de transmisión',
      message: 'Si ves esto y al golem animado, el overlay funciona correctamente en tu navegador.',
      characterId: 'golem-tortoise',
      animation: 'roar'
    }, 1);
    return true;
  }

  function bootAuth() {
    sgLog('script cargado en', window.location.host + window.location.pathname);
    ensureStylesheet();
    checkTestFlag();
    if (typeof firebase === 'undefined' || !firebase.auth) {
      sgLog('firebase no disponible: no se activan los disparadores');
      return;
    }
    firebase.auth().onAuthStateChanged(function (user) {
      if (!user) { sgLog('sin sesión iniciada'); return; }
      sgLog('sesión detectada:', user.uid);
      var db = firebase.database();
      db.ref('users/' + user.uid + '/blocked').once('value').then(function (snap) {
        if (snap.val() === true) return;
        checkFirstLogin(user.uid, db);
        listenForTournamentInvites(user.uid, db);
        listenForBroadcast(db);
      }).catch(function () {
        checkFirstLogin(user.uid, db);
        listenForTournamentInvites(user.uid, db);
        listenForBroadcast(db);
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootAuth);
  } else {
    bootAuth();
  }

  window.SGWelcomeOverlay = { showOverlay: showOverlay, closeOverlay: closeOverlay };
})();
