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

    /**
     * Encuadre por defecto (el que usaba el golem). Cada personaje puede
     * sobreescribir solo lo que necesite en su propia clave `frame`, para que
     * sumar un personaje siga siendo rellenar una entrada del mapa:
     *   fit          = 'height' mide el modelo en reposo y coloca la cámara con
     *                  las constantes de abajo; 'hero' mide la silueta REAL del
     *                  clip y calcula la distancia sola (ver frameHero)
     *   targetHeight = alto al que se normaliza el modelo, sea cual sea su escala
     *   ground       = altura a la que quedan los pies antes de encuadrar
     *   distFactor/distPad = distancia de cámara = alto * factor + pad
     *   camHeight/lookHeight = altura de la cámara y del punto que mira,
     *                          en fracciones del alto ya normalizado
     *   drop         = cuánto se baja el modelo, en fracción del alto visible
     *   fillY/fillX  = solo en 'hero': fracción del cuadro que llena el alto y
     *                  cuántas veces el ancho puede desbordarlo
     */
    var DEFAULT_FRAME = {
      fit: 'height',
      targetHeight: 2.4,
      ground: 0.55,
      distFactor: 1.9,
      distPad: 1.6,
      camHeight: 0.55,
      lookHeight: 0.42,
      drop: 0.15,
      fillY: 0.72,
      fillX: 1.9
    };

    // Duración del encadenado entre un clip y el siguiente. Se empieza a
    // mezclar ANTES de que el clip acabe, que es lo que hace que la transición
    // se lea como un movimiento y no como un corte.
    var CROSSFADE = 0.42;

    // Config de personajes/animaciones. Fácil de extender: agregar otro
    // characterId con su propio basePath + mapa de clips.
    //
    // Hay dos formas de traer las animaciones y el visor entiende las dos:
    //   - un .glb por clip (golem y soldado): `clips` mapea clip -> archivo;
    //   - un solo .glb con todos los clips dentro (`bundle`, el dragón): ahí
    //     `clips` mapea clip -> nombre de la animación dentro del archivo.
    // Lo segundo es mucho mejor y es a lo que deberían migrar los demás: la
    // malla y las texturas se pagan una sola vez (el dragón entero con once
    // animaciones pesa 2,8 MB; el soldado, con ocho archivos, 16 MB).
    var CHARACTERS = {
      'golem-tortoise': {
        label: 'Golem Tortuga',
        basePath: SG_CDN + '/models/golem-tortoise/',
        backdrop: '/overlay-volcano.jpg',
        theme: 'ember',
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
      },
      'soldier-specops': {
        label: 'Soldado SpecOps',
        basePath: SG_CDN + '/models/soldier-specops/',
        backdrop: '/overlay-cs2-desert.jpg',
        theme: 'desert',
        clips: {
          idle: 'soldier-idle.glb',
          rifle_pose: 'soldier-rifle-pose.glb',
          talk: 'soldier-talk.glb',
          walk: 'soldier-walk.glb',
          run: 'soldier-run.glb',
          jump: 'soldier-jump.glb',
          crouch_walk: 'soldier-crouch-walk.glb',
          death: 'soldier-death.glb'
        },
        loopClip: 'idle',
        // Sol duro de tarde y rebote cálido de la arena, sin el rim rojo de
        // lava del golem.
        lights: {
          hemiSky: 0xbcd4ee, hemiGround: 0xc79a5e, hemiInt: 1.25,
          keyColor: 0xfff0cf, keyInt: 2.15, keyPos: [3.4, 5.2, 3.2],
          rimColor: 0xffd08a, rimInt: 0.95, rimPos: [-4, 2.4, -3],
          bounceColor: 0xd9a463, bounceInt: 0.9, bouncePos: [0, -1.6, 1.8]
        },
        // El modelo sale de la exportación mirando al frente (+Z), que es
        // justo hacia la cámara: no necesita giro, solo el tres cuartos leve.
        yawDeg: 20,
        // Silueta humana (1,93 de alto y estrecha): con la distancia del golem
        // se veía diminuta, así que la cámara se acerca y sube. No se acerca
        // más porque el clip de muerte desplaza al personaje más de un metro
        // al caer y tiene que seguir cabiendo en el cuadro.
        frame: {
          distFactor: 1.6,
          distPad: 1.05,
          camHeight: 0.62,
          lookHeight: 0.5
        },
        postEntrance: {
          idle: 'loop',
          // rifle_pose dura 0,38 s: es una POSE, no una animación. Sola se
          // corta antes de que al jugador le dé tiempo a mirarla, así que
          // nunca se usa como entrada suelta (ver ENTRANCES).
          rifle_pose: 'idle',
          talk: 'idle',
          walk: 'loop',
          run: 'loop',
          jump: 'idle',
          crouch_walk: 'loop',
          death: 'hold'
        }
      },
      'wyvern-dragon': {
        label: 'Wyvern Roja',
        basePath: SG_CDN + '/models/wyvern-dragon/',
        // Se reaprovecha el fondo del volcán: a un dragón rojo le sienta igual
        // de bien que al golem y no suma un archivo más que subir.
        backdrop: '/overlay-volcano.jpg',
        theme: 'wyvern',
        bundle: 'wyvern-dragon.glb',
        clips: {
          idle: 'idle',
          roar: 'roar',
          alert: 'alert',
          landing: 'landing',
          takeoff: 'takeoff',
          flying: 'flying',
          gliding: 'gliding',
          bite: 'bite',
          die: 'die',
          walking: 'walking',
          sleep_out: 'sleep_out'
        },
        loopClip: 'idle',
        // OJO: 'idle' y 'roar' mantienen al dragón agazapado y girado casi
        // todo el clip (se comprobó fotograma a fotograma con mixer.setTime,
        // no es un giro que cambie con el tiempo): no hay ningún ángulo en el
        // que "se yerga" a mirar de frente, así que no se busca un plano
        // frontal sino el mejor 3/4 de ESA pose agazapada. A 230° la cara
        // queda totalmente fuera de cuadro (se ve lomo, patas y cola); a 300°
        // se lee la boca abierta con el brillo de la garganta y el ala barre
        // el resto del encuadre dándole escala.
        yawDeg: 300,
        // Fragua: menos cielo que el golem, brasa más saturada y un contraluz
        // fuerte que recorta la membrana de las alas. Va más subido de lo que
        // pedirían las cifras del golem porque el dragón es casi negro y con una
        // clave suave se perdía contra el fondo del overlay.
        lights: {
          hemiSky: 0xa8c0e4, hemiGround: 0x5a1c10, hemiInt: 1.7,
          keyColor: 0xfff4e2, keyInt: 3.1, keyPos: [3.2, 5.4, 3.6],
          rimColor: 0xff5a28, rimInt: 2.3, rimPos: [-4.2, 2.2, -3.4],
          bounceColor: 0xff8a3a, bounceInt: 2.1, bouncePos: [0, -1.6, 1.9]
        },
        // Con las alas abiertas mide 21 de ancho por 5 de alto: normalizarlo por
        // el alto como a los demás lo dejaba como una tira diminuta en medio del
        // escenario. En 'hero' manda el alto de la pose y las puntas de las alas
        // se salen del cuadro a propósito, que es lo que lo hace imponente.
        // 0,65 deja ver la cabeza Y bastante ala; con 0,80 (valor viejo) la
        // cámara se acercaba tanto que solo entraba un primer plano de la
        // membrana del ala.
        frame: { fit: 'hero', fillY: 0.42, fillX: 1.05 },
        postEntrance: {
          idle: 'loop',
          roar: 'idle',
          alert: 'idle',
          landing: 'idle',
          takeoff: 'loop',
          flying: 'loop',
          gliding: 'loop',
          bite: 'idle',
          die: 'hold',
          walking: 'loop',
          sleep_out: 'idle'
        }
      }
    };

    /**
     * Calibración de cámara en vivo (rotación + tamaño), por personaje.
     * `CHARACTERS` arriba se queda intacto como el valor "de fábrica"; esto es
     * una capa aparte que el Commander Panel puede tocar en caliente mientras
     * el admin gira/acerca el modelo, y que shared-nexus-sensor.js rellena al
     * cargar la página con lo que haya guardado en Firebase
     * (`nexusCharacterCamera/{characterId}`). Como todos los visores leen de
     * aquí en cada frameModel(), "guardar" o "restablecer" se ve al instante
     * en cualquier pestaña sin recargar nada.
     *   yawDeg   = ángulo de la cámara, sustituye a character.yawDeg si está.
     *   sizeMult = 1 = tamaño de fábrica; >1 se ve más grande, <1 más chico.
     */
    var CAMERA_OVERRIDES = {};

    function cameraOverrideFor(characterId) {
      return (characterId && CAMERA_OVERRIDES[characterId]) || null;
    }

    /**
     * Coreografías de entrada: un aviso puede pedir varios clips seguidos y el
     * visor los encadena con mezcla, sin volver a descargar nada cuando el
     * personaje viene en un solo archivo. Existe porque una pose de 0,38 s
     * (el `rifle_pose` del soldado) no es una entrada: se cortaba enseguida y
     * el personaje se quedaba plantado en reposo.
     */
    var ENTRANCES = {
      'soldier-specops': {
        // Entra corriendo (en bucle, no solo un ciclo suelto: si no, apenas se
        // le ve dar una zancada antes de mezclarse con la pose y parece que
        // está manoseando el rifle en vez de corriendo) y se planta encarando
        // el arma. El segundo `hold` deja esa pose quieta un rato, que es lo
        // que hace que se lea antes de pasar a reposo. No se usa `jump` de
        // arranque aunque sea más vistoso: en el punto alto del salto la
        // cabeza se sale por arriba del cuadro.
        rifle_pose: [{ clip: 'run', hold: 0.9, loop: true }, { clip: 'rifle_pose', hold: 1.6 }]
      },
      'wyvern-dragon': {
        // 'alert' se descartó como preámbulo del rugido: su pose gira el
        // cuerpo de un modo tan distinto al de 'roar' que ningún yaw fijo deja
        // bien a los dos (con el yaw que luce el rugido, la alerta enseña el
        // lomo y ni se le ve la cabeza). Mejor entrar directo en 'roar', que sí
        // está afinado.
      }
    };

    /**
     * Traduce el clip pedido a la secuencia real que se va a reproducir. Un paso
     * puede venir como nombre suelto o como { clip, hold }, así que hay que
     * quedarse con el nombre antes de comprobar que el personaje lo tiene.
     */
    function stepsFor(characterId, clipName) {
      var byChar = ENTRANCES[characterId];
      var seq = byChar && byChar[clipName];
      if (!seq || !seq.length) return [clipName];
      var chars = CHARACTERS[characterId];
      // Si al personaje le falta alguno de los clips de la coreografía se cae
      // al clip suelto en vez de romper la entrada.
      for (var i = 0; i < seq.length; i += 1) {
        var key = (typeof seq[i] === 'string') ? seq[i] : (seq[i] && seq[i].clip);
        if (!chars || !chars.clips || !chars.clips[key]) return [clipName];
      }
      return seq.slice();
    }

    /**
     * Rig de luces por defecto (volcánico, el del golem). Cada personaje puede
     * dar el suyo en `lights` para que la escena 3D acompañe a su ambiente:
     * un rim rojo de lava sobre un soldado en el desierto quedaría fuera de
     * lugar. Se reaplica en cada entrada porque un mismo visor puede cambiar
     * de personaje (la vista previa del Commander Panel lo hace).
     */
    var DEFAULT_LIGHTS = {
      hemiSky: 0x9aa2b0, hemiGround: 0x9c3010, hemiInt: 1.35,
      keyColor: 0xffcaa8, keyInt: 1.85, keyPos: [3, 5, 4],
      rimColor: 0xff3e14, rimInt: 1.2, rimPos: [-4, 2, -3],
      bounceColor: 0xff5a1e, bounceInt: 1.6, bouncePos: [0, -1.7, 1.6]
    };

    function lightsOf(character) {
      var custom = (character && character.lights) || {};
      var out = {};
      Object.keys(DEFAULT_LIGHTS).forEach(function (k) {
        out[k] = (custom[k] === undefined) ? DEFAULT_LIGHTS[k] : custom[k];
      });
      return out;
    }

    function frameOf(character) {
      var custom = (character && character.frame) || {};
      var out = {};
      Object.keys(DEFAULT_FRAME).forEach(function (k) {
        out[k] = (custom[k] === undefined) ? DEFAULT_FRAME[k] : custom[k];
      });
      // El `drop` por defecto existe para compensar el encuadre por alto, que
      // deja al personaje demasiado arriba. En 'hero' la pose ya queda centrada
      // en el punto que mira la cámara, así que heredarlo solo servía para
      // bajar al bicho hasta que se le salían las patas por abajo.
      if (out.fit === 'hero' && custom.drop === undefined) out.drop = 0;
      return out;
    }

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
      var currentCharacterId = null;
      var disposed = false;
      var lightRig = null;
      var gen = 0;
      var rafId = null;
      var paused = true;
      // Coreografía en curso: qué clip suena, cuál viene y cuánto lleva.
      var sequence = null;

      function ensureScene() {
        if (renderer) return;
        var THREE = threeMod.THREE;
        renderer = new THREE.WebGLRenderer({ canvas: canvasEl, alpha: true, antialias: true });
        renderer.setClearColor(0x000000, 0);
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

        scene = new THREE.Scene();
        camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
        camera.position.set(0, 1.4, 5.2);

        lightRig = {
          hemi: new THREE.HemisphereLight(0xffffff, 0xffffff, 1),
          key: new THREE.DirectionalLight(0xffffff, 1),
          rim: new THREE.DirectionalLight(0xffffff, 1),
          bounce: new THREE.PointLight(0xffffff, 1, 16, 2)
        };
        scene.add(lightRig.hemi);
        scene.add(lightRig.key);
        scene.add(lightRig.rim);
        scene.add(lightRig.bounce);
        applyLighting(null);

        clock = new THREE.Clock();

        if (typeof ResizeObserver !== 'undefined' && canvasEl.parentElement) {
          resizeObs = new ResizeObserver(function () { resizeRenderer(); });
          resizeObs.observe(canvasEl.parentElement);
        }
        resizeRenderer();
      }

      function applyLighting(character) {
        if (!lightRig) return;
        var L = lightsOf(character);
        lightRig.hemi.color.setHex(L.hemiSky);
        lightRig.hemi.groundColor.setHex(L.hemiGround);
        lightRig.hemi.intensity = L.hemiInt;
        lightRig.key.color.setHex(L.keyColor);
        lightRig.key.intensity = L.keyInt;
        lightRig.key.position.set(L.keyPos[0], L.keyPos[1], L.keyPos[2]);
        lightRig.rim.color.setHex(L.rimColor);
        lightRig.rim.intensity = L.rimInt;
        lightRig.rim.position.set(L.rimPos[0], L.rimPos[1], L.rimPos[2]);
        lightRig.bounce.color.setHex(L.bounceColor);
        lightRig.bounce.intensity = L.bounceInt;
        lightRig.bounce.position.set(L.bouncePos[0], L.bouncePos[1], L.bouncePos[2]);
      }

      function resizeRenderer() {
        if (!renderer || !canvasEl || !canvasEl.parentElement) return;
        var w = canvasEl.parentElement.clientWidth || 320;
        var h = canvasEl.parentElement.clientHeight || 320;
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
      }

      /**
       * Caja que ocupa DE VERDAD el personaje mientras corre un clip. Box3 mide
       * la geometría en pose de reposo, que para un bicho con alas no dice
       * nada: el dragón mide 21 de ancho con las alas abiertas y 15 plegadas.
       * Aquí se aplica la deformación del esqueleto a una muestra de vértices
       * en varios instantes del clip y se une todo, así que el encuadre sale de
       * la silueta que el jugador va a ver.
       */
      function posedBox(root, mixer, clip) {
        var THREE = threeMod.THREE;
        var box = new THREE.Box3();
        var v = new THREE.Vector3();
        var action = mixer.clipAction(clip);
        mixer.stopAllAction();
        action.reset().play();
        var SAMPLES = 7;
        for (var s = 0; s < SAMPLES; s += 1) {
          mixer.setTime(clip.duration * s / (SAMPLES - 1));
          root.updateMatrixWorld(true);
          root.traverse(function (obj) {
            if (!obj.isMesh || !obj.geometry || !obj.geometry.attributes) return;
            var pos = obj.geometry.attributes.position;
            if (!pos) return;
            // Una muestra de ~900 vértices por malla basta para la silueta y
            // deja el cálculo en unos pocos milisegundos.
            var stride = Math.max(1, Math.ceil(pos.count / 900));
            var skin = obj.isSkinnedMesh && obj.skeleton &&
              (obj.applyBoneTransform || obj.boneTransform);
            for (var i = 0; i < pos.count; i += stride) {
              v.fromBufferAttribute(pos, i);
              if (skin) skin.call(obj, i, v);
              obj.localToWorld(v);
              box.expandByPoint(v);
            }
          });
        }
        mixer.stopAllAction();
        mixer.setTime(0);
        return box;
      }

      /**
       * Encuadre 'hero': la cámara se coloca sola a partir de la silueta del
       * clip. Llena `fillY` del alto del cuadro y deja que el ancho lo desborde
       * hasta `fillX` veces, para que a un dragón se le recorten las puntas de
       * las alas en vez de verse como una tira en medio de un escenario vacío.
       */
      function frameHero(root, character, mixer, clip, fr, sizeMult) {
        var THREE = threeMod.THREE;
        var box = posedBox(root, mixer, clip);
        var size = new THREE.Vector3();
        var center = new THREE.Vector3();
        box.getSize(size);
        box.getCenter(center);
        if (!(size.y > 0)) return false;

        // Se normaliza igual que los demás personajes (pero por el alto de la
        // POSE, no del reposo) para que el rig de luces, que está en unidades
        // absolutas, siga cayendo donde toca.
        var scale = fr.targetHeight / size.y;
        root.scale.setScalar(scale);
        size.multiplyScalar(scale);
        center.multiplyScalar(scale);

        var tanY = Math.tan((camera.fov * Math.PI / 180) / 2);
        var dist = Math.max(
          size.y / (2 * tanY * fr.fillY),
          size.x / (2 * tanY * camera.aspect * fr.fillX)
        ) / (sizeMult || 1);
        // La pose queda centrada en el punto que mira la cámara.
        root.position.set(-center.x, -center.y, -center.z);
        root.position.y -= 2 * dist * tanY * (fr.drop || 0);
        camera.position.set(0, 0, dist);
        camera.lookAt(0, 0, 0);
        root.updateMatrixWorld(true);
        return true;
      }

      function frameModel(root, character, mixer, clip, characterId) {
        var THREE = threeMod.THREE;
        var fr = frameOf(character);
        var override = cameraOverrideFor(characterId);
        var yaw = (override && typeof override.yawDeg === 'number') ? override.yawDeg :
          ((character && typeof character.yawDeg === 'number') ? character.yawDeg : 0);
        var sizeMult = (override && typeof override.sizeMult === 'number' && override.sizeMult > 0) ?
          override.sizeMult : 1;
        // Se rota antes de medir para que el encuadre y el centrado tengan en
        // cuenta la orientación final.
        root.rotation.y = yaw * Math.PI / 180;
        // IMPORTANTE: hay que forzar updateMatrixWorld antes de medir con
        // Box3, si no las matrices de los huesos/nodos del glTF (recién
        // cargado, aún no renderizado) están sin resolver y Box3 mide un
        // tamaño casi cero -> la cámara enfoca el vacío y "no se ve nada".
        root.updateMatrixWorld(true);
        if (fr.fit === 'hero' && mixer && clip &&
            frameHero(root, character, mixer, clip, fr, sizeMult)) {
          return;
        }
        var box = new THREE.Box3().setFromObject(root);
        var size = new THREE.Vector3();
        box.getSize(size);
        var scale = size.y > 0 ? fr.targetHeight / size.y : 1;
        root.scale.setScalar(scale);
        root.updateMatrixWorld(true);

        var box2 = new THREE.Box3().setFromObject(root);
        var size2 = new THREE.Vector3();
        box2.getSize(size2);
        var center2 = new THREE.Vector3();
        box2.getCenter(center2);
        root.position.x -= center2.x;
        root.position.z -= center2.z;
        root.position.y -= box2.min.y - fr.ground;

        var dist = (size2.y * fr.distFactor + fr.distPad) / sizeMult;
        camera.position.set(0, size2.y * fr.camHeight, dist);
        camera.lookAt(0, size2.y * fr.lookHeight, 0);

        // El modelo quedaba pegado al borde superior y los clips en los que el
        // golem se alza (rugido) se recortaban por arriba, con el borde
        // inferior desperdiciado; se baja una fracción del alto visible.
        var visibleHeight = 2 * dist * Math.tan((camera.fov * Math.PI / 180) / 2);
        root.position.y -= visibleHeight * fr.drop;
        root.updateMatrixWorld(true);
      }

      function loadModel(characterId, clipName, onProgress) {
        var character = CHARACTERS[characterId];
        if (!character) return Promise.reject(new Error('Personaje desconocido: ' + characterId));
        if (!character.clips || !character.clips[clipName]) {
          return Promise.reject(new Error('Animación desconocida: ' + clipName));
        }
        // Con `bundle` todos los clips viven en el mismo archivo, así que el
        // nombre del clip no decide qué se descarga.
        var file = character.bundle || character.clips[clipName];
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

      function disposeTree(root) {
        if (!root || typeof root.traverse !== 'function') return;
        root.traverse(function (obj) {
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

      function clearCurrentModel() {
        if (currentModelRoot && scene) {
          scene.remove(currentModelRoot);
          disposeTree(currentModelRoot);
        }
        currentModelRoot = null;
        currentCharacterId = null;
        sequence = null;
        if (mixer) { mixer.stopAllAction(); mixer = null; }
      }

      function renderLoop(token) {
        if (token !== gen || paused) return;
        rafId = requestAnimationFrame(function () { renderLoop(token); });
        var dt = clock ? clock.getDelta() : 0;
        if (mixer) mixer.update(dt);
        stepSequence(token, dt);
        if (renderer && scene && camera) renderer.render(scene, camera);
      }

      /**
       * Almacén de clips de un personaje. Con `bundle` los tiene todos desde el
       * primer momento; si no, va a buscar los que falten y se queda solo con
       * sus animaciones: la malla que venga en ese archivo se tira, porque las
       * pistas se enganchan por NOMBRE DE NODO al modelo que ya está en escena.
       * De ahí que se pueda encadenar sin cambiar de modelo (que era lo que se
       * veía como un salto) y sin volver a pagar malla ni texturas.
       */
      function makeClipStore(characterId, character, baseGltf, baseKey) {
        var store = {};

        function pick(gltf, key) {
          if (!gltf || !gltf.animations || !gltf.animations.length) return null;
          if (!character.bundle) return gltf.animations[0];
          var wanted = (character.clips && character.clips[key]) || key;
          for (var i = 0; i < gltf.animations.length; i += 1) {
            if (gltf.animations[i].name === wanted) return gltf.animations[i];
          }
          return null;
        }

        if (character.bundle) {
          Object.keys(character.clips || {}).forEach(function (k) {
            var c = pick(baseGltf, k);
            if (c) store[k] = c;
          });
        } else {
          var first = pick(baseGltf, baseKey);
          if (first) store[baseKey] = first;
        }

        return {
          get: function (key) { return store[key] || null; },
          /** Trae un clip que no esté aún. No molesta si ya se pidió. */
          prefetch: function (key) {
            if (!key || store[key] !== undefined) return;
            store[key] = null;
            loadModel(characterId, key).then(function (gltf) {
              var c = pick(gltf, key);
              if (c) store[key] = c;
              // La escena de ese archivo no se usa: solo se quería el clip.
              disposeTree(gltf && gltf.scene);
            }).catch(function (err) {
              sgLog('no se pudo traer el clip "' + key + '"', (err && err.message) || err);
            });
          }
        };
      }

      function armAction(clip, looping) {
        var THREE = threeMod.THREE;
        var action = mixer.clipAction(clip);
        action.reset();
        action.enabled = true;
        action.setEffectiveTimeScale(1);
        action.setEffectiveWeight(1);
        action.setLoop(looping ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
        action.clampWhenFinished = !looping;
        action.play();
        return action;
      }

      /**
       * Avanza la coreografía. Se lleva el reloj a mano en vez de escuchar el
       * evento 'finished' del mixer porque hay que empezar a mezclar ANTES de
       * que el clip termine: si se espera al final, el personaje ya se ha
       * quedado congelado y la transición se ve como un corte.
       */
      function stepSequence(token, dt) {
        var seq = sequence;
        if (!seq || seq.token !== token || seq.done || !seq.action) return;
        seq.elapsed += dt;
        var duration = seq.action.getClip().duration;
        // `hold` mantiene la pose congelada un rato antes de continuar: sin eso
        // una pose de 0,38 s pasa de largo sin que se llegue a leer.
        if (seq.elapsed < Math.max(0, duration - CROSSFADE) + seq.hold) return;

        var nextKey = null;
        var looping = false;
        // Solo el reposo final detiene la coreografía (`seq.done`); un paso
        // intermedio en bucle (p.ej. "run" repitiendo mientras dura su `hold`)
        // sigue teniendo que ceder el turno cuando le toque.
        var isFinalStep = false;
        if (seq.i + 1 < seq.steps.length) {
          nextKey = seq.steps[seq.i + 1].clip;
          looping = !!seq.steps[seq.i + 1].loop;
        } else if (seq.post === 'idle') {
          nextKey = seq.loopClip;
          looping = true;
          isFinalStep = true;
        } else {
          // 'hold': se queda en el último fotograma, que es justo lo que se
          // quiere en la animación de muerte.
          seq.done = true;
          return;
        }

        var nextClip = seq.store.get(nextKey);
        if (!nextClip) {
          // Todavía viajando: mejor dejar la pose quieta que dar un salto. Se
          // vuelve a intentar en el fotograma siguiente.
          return;
        }

        var prev = seq.action;
        var next = armAction(nextClip, looping);
        prev.crossFadeTo(next, CROSSFADE, false);
        // El clip que sale se apaga del todo al acabar la mezcla para que no
        // siga consumiendo interpolación con peso cero.
        setTimeout(function () {
          if (sequence === seq && seq.action !== prev) prev.stop();
        }, CROSSFADE * 1000 + 60);

        seq.i += 1;
        seq.action = next;
        seq.elapsed = 0;
        seq.hold = (seq.i < seq.steps.length && seq.steps[seq.i].hold) || 0;
        if (isFinalStep) seq.done = true;
        // Se adelanta la petición del clip que vendrá después.
        if (seq.i + 1 < seq.steps.length) seq.store.prefetch(seq.steps[seq.i + 1].clip);
        else if (seq.post === 'idle') seq.store.prefetch(seq.loopClip);
      }

      /**
       * Reproduce la entrada del personaje y la enlaza con su reposo. La entrada
       * puede ser un clip suelto o una coreografía de varios (ver ENTRANCES).
       * onReady(err) se llama cuando el modelo ya está en pantalla (o falló).
       */
      function playEntrance(characterId, entranceClip, onReady, onProgress) {
        var character = CHARACTERS[characterId];
        var token = ++gen;
        paused = false;
        sequence = null;

        var loopClip = (character && character.loopClip) || 'idle';
        var steps = stepsFor(characterId, entranceClip).map(function (s) {
          return (typeof s === 'string') ? { clip: s, hold: 0, loop: false } : s;
        });
        var lastKey = steps[steps.length - 1].clip;
        var post = (character && character.postEntrance && character.postEntrance[lastKey]) || 'idle';
        if (lastKey === loopClip && steps.length === 1) post = 'loop';

        loadModel(characterId, steps[0].clip, onProgress).catch(function (err) {
          // Si el clip pedido no se puede traer, es mejor mostrar al personaje
          // en reposo que dejar el escenario vacío con un mensaje de error.
          if (steps[0].clip === loopClip) throw err;
          sgLog('no se pudo cargar "' + steps[0].clip + '", se usa "' + loopClip + '"', (err && err.message) || err);
          steps = [{ clip: loopClip, hold: 0 }];
          post = 'loop';
          return loadModel(characterId, loopClip, onProgress);
        }).then(function (gltf) {
          if (token !== gen) return;
          var THREE = threeMod.THREE;
          clearCurrentModel();
          applyLighting(character);
          currentModelRoot = gltf.scene;
          scene.add(currentModelRoot);
          mixer = new THREE.AnimationMixer(currentModelRoot);

          currentCharacterId = characterId;
          var store = makeClipStore(characterId, character, gltf, steps[0].clip);
          var firstClip = store.get(steps[0].clip);
          // El encuadre necesita el mixer y el clip: mide la silueta animada.
          frameModel(currentModelRoot, character, mixer, firstClip, characterId);

          if (firstClip) {
            var looping = (steps.length === 1 && post === 'loop') || !!steps[0].loop;
            sequence = {
              token: token,
              steps: steps,
              i: 0,
              post: post,
              loopClip: loopClip,
              store: store,
              action: armAction(firstClip, looping),
              elapsed: 0,
              hold: steps[0].hold || 0,
              done: looping
            };
            // Lo que va después se pide ya, con la entrada en pantalla: cuando
            // el personaje viene en un solo archivo esto no descarga nada.
            if (steps.length > 1) store.prefetch(steps[1].clip);
            else if (post === 'idle') store.prefetch(loopClip);
          }

          if (canvasEl.style) {
            canvasEl.style.transition = 'opacity 0.2s ease';
            canvasEl.style.opacity = '1';
          }
          renderLoop(token);
          if (typeof onReady === 'function') onReady(null);
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
        disposed = true;
        pause();
        clearCurrentModel();
        if (resizeObs) { resizeObs.disconnect(); resizeObs = null; }
        if (renderer) { renderer.dispose(); renderer = null; }
        lightRig = null;
        scene = null; camera = null; clock = null;
      }
      function resize() { resizeRenderer(); }

      /**
       * Vuelve a encuadrar el modelo YA CARGADO con lo que haya ahora en
       * CAMERA_OVERRIDES, sin descargar nada de nuevo. Es lo que usa el
       * calibrador del Commander Panel para que arrastrar un control se vea
       * al instante, y lo que usa cualquier otra pestaña abierta cuando el
       * admin guarda o restablece un personaje.
       */
      function reframeCurrent() {
        if (!currentModelRoot || !currentCharacterId) return false;
        var character = CHARACTERS[currentCharacterId];
        var action = sequence && sequence.action;
        var clip = action ? action.getClip() : null;
        var wasTime = action ? action.time : 0;
        var wasPaused = paused;
        frameModel(currentModelRoot, character, mixer, clip, currentCharacterId);
        // frameHero (vía posedBox) para medir la silueta deja el mixer parado
        // en t=0; se retoma justo donde iba para que no se note el salto.
        if (action) {
          action.play();
          action.time = wasTime;
          if (mixer) mixer.update(0);
        }
        paused = wasPaused;
        return true;
      }

      return {
        playEntrance: playEntrance, pause: pause, resume: resume, dispose: dispose, resize: resize,
        reframe: reframeCurrent,
        getCharacterId: function () { return currentCharacterId; },
        isDisposed: function () { return disposed; }
      };
    }

    /**
     * Paletas de las brasas por ambiente. Viven aquí, junto a los personajes,
     * porque las usan los dos overlays (el del dashboard y el de Nexus) y no
     * pueden acabar diciendo cosas distintas.
     */
    var EMBER_PALETTES = {
      ember: ['255, 190, 120', '255, 120, 50', '229, 57, 53'],
      desert: ['246, 226, 178', '214, 168, 98', '146, 106, 58'],
      wyvern: ['255, 214, 140', '255, 96, 32', '176, 24, 12']
    };

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
      // Núcleo, medio y borde de cada partícula. El tema del desierto reutiliza
      // el mismo sistema como polvo en suspensión.
      var palette = EMBER_PALETTES.ember;
      var density = 22000;

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
        var target = Math.min(110, Math.round(canvas.width * canvas.height / density));
        if (parts.length < target) parts.push(spawn());
        for (var i = parts.length - 1; i >= 0; i -= 1) {
          var p = parts[i];
          p.life += 1;
          p.y -= p.vy;
          p.x += p.vx + Math.sin(p.life / 30) * 0.25;
          if (p.life > p.max || p.y < -14) { parts.splice(i, 1); continue; }
          var alpha = Math.max(0, 0.6 * (1 - p.life / p.max));
          var grd = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r * 4);
          grd.addColorStop(0, 'rgba(' + palette[0] + ', ' + alpha + ')');
          grd.addColorStop(0.4, 'rgba(' + palette[1] + ', ' + (alpha * 0.7) + ')');
          grd.addColorStop(1, 'rgba(' + palette[2] + ', 0)');
          ctx.fillStyle = grd;
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.r * 4, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      window.addEventListener('resize', function () { if (running) resize(); });

      return {
        setPalette: function (colors) {
          if (typeof colors === 'string') colors = EMBER_PALETTES[colors];
          if (colors && colors.length === 3) palette = colors;
        },
        /** Menos superficie que la pantalla entera pide más densidad. */
        setDensity: function (n) {
          if (typeof n === 'number' && n > 1000) density = n;
        },
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

    /**
     * API pública de calibración de cámara (rotación + tamaño). La usan tanto
     * el editor del Commander Panel (en vivo, sin guardar todavía) como
     * shared-nexus-sensor.js (al cargar lo que esté guardado en Firebase).
     * `active` avisa a TODOS los visores abiertos en la pestaña que se re-
     * encuadren ahora mismo, así que arrastrar un control se ve al instante
     * en la vista previa sin tener que crear un visor nuevo por cada cambio.
     */
    var activeViewers = [];
    function trackViewer(viewer) {
      activeViewers.push(viewer);
      return viewer;
    }
    function reframeAllViewers() {
      // Se aprovecha el paso para descartar visores ya destruidos, así la
      // lista no crece para siempre en una pestaña que abre y cierra vistas
      // previas todo el rato (el Commander Panel lo hace bastante).
      activeViewers = activeViewers.filter(function (v) { return !(v.isDisposed && v.isDisposed()); });
      activeViewers.forEach(function (v) {
        try { if (typeof v.reframe === 'function') v.reframe(); } catch (e) {}
      });
    }

    window.SGCreatureViewer = {
      CHARACTERS: CHARACTERS,
      EMBER_PALETTES: EMBER_PALETTES,
      create: function (canvasEl) { return trackViewer(createViewer(canvasEl)); },
      createEmbers: createEmbers,
      entranceFor: stepsFor,
      // Ángulo/tamaño "de fábrica" (los que trae CHARACTERS), para que el
      // botón "Restablecer" sepa a qué valor volver sin tener que adivinarlo.
      factoryCamera: function (characterId) {
        var c = CHARACTERS[characterId];
        return c ? { yawDeg: (typeof c.yawDeg === 'number') ? c.yawDeg : 0, sizeMult: 1 } : null;
      },
      getCameraOverride: function (characterId) {
        var o = cameraOverrideFor(characterId);
        return o ? { yawDeg: o.yawDeg, sizeMult: o.sizeMult } : null;
      },
      /** Pisa (en memoria, no en Firebase) el ángulo/tamaño de un personaje y reencuadra todo lo abierto. */
      setCameraOverride: function (characterId, overrides) {
        if (!characterId) return;
        var next = {};
        if (overrides && typeof overrides.yawDeg === 'number') next.yawDeg = overrides.yawDeg;
        if (overrides && typeof overrides.sizeMult === 'number' && overrides.sizeMult > 0) next.sizeMult = overrides.sizeMult;
        CAMERA_OVERRIDES[characterId] = next;
        reframeAllViewers();
      },
      /** Quita el pisado en memoria (vuelve a los valores de fábrica de CHARACTERS). */
      clearCameraOverride: function (characterId) {
        if (!characterId) return;
        delete CAMERA_OVERRIDES[characterId];
        reframeAllViewers();
      }
    };
  }

  // =========================================================================
  // PARTE 2 — Overlay de Dashboard (bienvenida / invitación / broadcast)
  // =========================================================================
  if (window.__sgWelcomeOverlayBooted) return;
  window.__sgWelcomeOverlayBooted = true;

  // La bienvenida, las invitaciones y los broadcasts siguen siendo cosa del
  // Dashboard; el aviso de resultado de partida corre en cualquier página que
  // cargue este script, porque el jugador puede estar en Play Zone o en el hub
  // cuando su servidor cierre la partida.
  function isDashboardPage() {
    return /\/dashboard(\.html)?(\/|$|\?)/i.test(window.location.pathname || '') ||
      window.location.pathname === '/dashboard';
  }

  var LOGO_SRC = '/logo-studiosgamesrs.png';
  var BADGE_SRC = '/badges/lealtad-320.png';
  var BADGE_CDN = (SG_CDN || 'https://studiosgamesrs.web.app') + BADGE_SRC;
  var ASSET_VERSION = '20260727welcome2';

  // Insignia de la campaña de bienvenida. El texto del tooltip se reutiliza en
  // el perfil del dashboard (dashboard-logic.js) para que digan lo mismo.
  var WELCOME_BADGE = {
    id: 'loyalty_trial',
    name: 'Lealtad',
    description: 'Reconoce el honor de haberte registrado entre los primeros de StudiosGamesRS.'
  };

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
    loadingEl = null, backdropEl = null, rewardsEl = null, photoEl = null;
  var isOpen = false;
  var queue = [];
  var viewer = null;
  var embers = null;
  // Prioridades: 0=invite, 1=broadcast, 2=bienvenida con premios (no la pisa un broadcast viejo).
  var currentPriority = 0;
  var welcomeBootDone = false;
  var pendingBroadcast = null;

  // Las brasas viven en SGCreatureViewer (parte 1) para que el overlay de Nexus
  // pueda usar exactamente las mismas.
  function createEmbers(canvas) {
    var api = window.SGCreatureViewer;
    return (api && typeof api.createEmbers === 'function') ? api.createEmbers(canvas) : null;
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
        '<div class="sg-welcome-rewards" id="sgWelcomeRewards" hidden></div>' +
        '<button type="button" class="sg-welcome-btn" id="sgWelcomeBtn">Continuar</button>' +
      '</div>';
    (document.body || document.documentElement).appendChild(overlayEl);

    backdropEl = overlayEl.querySelector('.sg-welcome-overlay-backdrop');
    photoEl = overlayEl.querySelector('#sgWelcomePhoto');
    canvasEl = overlayEl.querySelector('#sgWelcomeCanvas');
    titleEl = overlayEl.querySelector('#sgWelcomeTitle');
    textEl = overlayEl.querySelector('#sgWelcomeText');
    btnEl = overlayEl.querySelector('#sgWelcomeBtn');
    rewardsEl = overlayEl.querySelector('#sgWelcomeRewards');
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

  // ---------- Ambientación por personaje ----------
  // El fondo y la paleta salen de la ficha del personaje (CHARACTERS); un
  // aviso concreto puede pedir otros devolviendo backdrop/theme en fillContent.
  var DEFAULT_BACKDROP = '/overlay-volcano.jpg';

  function applyAmbience(pick) {
    var chars = (window.SGCreatureViewer && window.SGCreatureViewer.CHARACTERS) || {};
    var character = chars[pick && pick.characterId] || null;
    var backdrop = (pick && pick.backdrop) || (character && character.backdrop) || DEFAULT_BACKDROP;
    var theme = (pick && pick.theme) || (character && character.theme) || 'ember';
    // La imagen se asigna desde JS (no desde el CSS) porque cuando el CSS se
    // inyecta como <style>, un url() relativo se resolvería contra el dominio
    // de la página y no contra el CDN donde vive la imagen.
    if (photoEl) photoEl.style.backgroundImage = "url('" + (SG_CDN || '') + backdrop + "')";
    if (overlayEl) overlayEl.setAttribute('data-sg-theme', theme);
    if (embers) embers.setPalette(theme);
  }

  function escapeHtml(s) {
    var div = document.createElement('div');
    div.textContent = String(s == null ? '' : s);
    return div.innerHTML;
  }

  /** Tarjetas de recompensa bajo el texto. Vacío = se oculta el bloque. */
  function fillRewards(rewards) {
    if (!rewardsEl) return;
    if (!rewards || !rewards.length) {
      rewardsEl.hidden = true;
      rewardsEl.innerHTML = '';
      return;
    }
    rewardsEl.innerHTML = rewards.map(function (r, i) {
      var visual = r.image
        ? '<img class="sg-welcome-reward-badge" src="' + r.image + '" alt="' + escapeHtml(r.label) + '" ' +
            'onerror="this.onerror=null;this.src=\'' + BADGE_CDN + '\';" />'
        : '<i class="fas ' + escapeHtml(r.icon) + '"></i>';
      return '<div class="sg-welcome-reward' + (r.image ? ' is-badge' : '') + '" style="--sg-reward-delay:' + (i * 90) + 'ms"' +
          (r.description ? ' data-sg-tip="' + escapeHtml(r.description) + '"' : '') + '>' +
          '<span class="sg-welcome-reward-icon">' + visual + '</span>' +
          '<span class="sg-welcome-reward-value">' + escapeHtml(r.value) + '</span>' +
          '<span class="sg-welcome-reward-label">' + escapeHtml(r.label) + '</span>' +
          (r.description ? '<span class="sg-welcome-reward-tip">' + escapeHtml(r.description) + '</span>' : '') +
        '</div>';
    }).join('');
    rewardsEl.hidden = false;
  }

  // ---------- Contenido por modo ----------
  function fillContent(mode, payload) {
    if (mode === 'welcome') {
      var nick = (payload && payload.nick) ? String(payload.nick).slice(0, 24) : '';
      titleEl.textContent = nick ? '¡Hola ' + nick + ', bienvenido!' : '¡Bienvenido a StudiosGamesRS!';

      if (payload && payload.rewarded) {
        var pct = payload.boostPercent || 15;
        var tokens = payload.tokens || 30;
        textEl.innerHTML = 'Has llegado al mundo de <strong>StudiosGamesRS.com</strong>. ' +
          'Como <strong>recompensa de bienvenida</strong> te hemos otorgado un <strong>' + pct + '% de boost</strong> ' +
          'en experiencia de Nexus, <strong>' + tokens + ' tokens</strong> y una insignia distintiva.';
        fillRewards([
          {
            icon: 'fa-bolt',
            value: '+' + pct + '%',
            label: 'XP de Nexus',
            description: 'Boost del ' + pct + '% sobre toda la experiencia que ganes en Nexus durante ' +
              (payload.boostDays || 30) + ' días.'
          },
          {
            icon: 'fa-coins',
            value: '+' + tokens,
            label: 'Tokens',
            description: 'Úsalos en misiones de Play Zone, personalización de perfil y verificación de equipo.'
          },
          {
            image: BADGE_CDN,
            value: WELCOME_BADGE.name,
            label: 'Insignia',
            description: WELCOME_BADGE.description
          }
        ]);
        btnEl.textContent = 'Reclamar y comenzar';
      } else {
        textEl.innerHTML = 'Has llegado al mundo de <strong>StudiosGamesRS.com</strong>. ' +
          'En <strong>Play Zone</strong> encuentra amigos, coordina misiones y gana tokens jugando en equipo. ' +
          'En <strong>Nexus</strong> sube de rango, gana XP real y desbloquea recompensas de creador.';
        fillRewards(null);
        btnEl.textContent = 'Comenzar la aventura';
      }
      btnEl.removeAttribute('data-action');
      return { characterId: 'golem-tortoise', clip: 'awake' };
    }
    fillRewards(null);
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
    if (mode === 'tournament-result') {
      // Todo este payload lo escriben los servidores de partida, así que se
      // recorta y se escapa antes de tocar el HTML.
      var res = payload || {};
      var isWin = String(res.result || '').toLowerCase() !== 'loss';
      var rawTeam = res.teamName ? String(res.teamName).slice(0, 40) : '';
      var team = escapeHtml(rawTeam);
      var rival = escapeHtml(res.opponentName ? String(res.opponentName).slice(0, 40) : '');
      var tour = escapeHtml(res.tournamentName ? String(res.tournamentName).slice(0, 80) : '');
      var score = escapeHtml(res.score ? String(res.score).slice(0, 16) : '');
      var mapName = escapeHtml(res.map ? String(res.map).slice(0, 32) : '');

      var detail = '';
      if (rival) detail += ' ante <strong>' + rival + '</strong>';
      if (score) detail += ' por <strong>' + score + '</strong>';
      if (mapName) detail += ' en <strong>' + mapName + '</strong>';
      var inTournament = tour ? ', en el torneo <strong>' + tour + '</strong>' : '';

      if (isWin) {
        titleEl.textContent = rawTeam ? '¡Victoria de ' + rawTeam + '!' : '¡Victoria!';
        textEl.innerHTML = (team ? 'Tu equipo <strong>' + team + '</strong> se llevó la partida' : 'Se llevaron la partida') +
          detail + inTournament + '. Posición asegurada: sigan así en la próxima ronda.';
      } else {
        titleEl.textContent = 'Partida perdida';
        textEl.innerHTML = (team ? 'Tu equipo <strong>' + team + '</strong> cayó esta vez' : 'Cayeron esta vez') +
          detail + inTournament + '. Se pierde una partida, no el torneo: revisen el ronda a ronda y vayan a por la siguiente.';
      }
      btnEl.textContent = 'Ver torneo';
      btnEl.setAttribute('data-action', 'go-competition-hub');
      return { characterId: 'soldier-specops', clip: isWin ? 'rifle_pose' : 'death' };
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
      // La bienvenida con premios (prio 2) no debe ser pisada por un broadcast
      // de prueba/antiguo (prio 1). En ese caso el broadcast queda en cola.
      if (priority > currentPriority) {
        queue = [];
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
    applyAmbience(pick);
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

  // ---------- Trigger 1: bienvenida + recompensa de campaña ----------
  function finishWelcomeBoot(opts) {
    welcomeBootDone = true;
    // Si acabamos de mostrar la bienvenida con premios, descartar cualquier
    // broadcast encolado (p.ej. transmisión de prueba vieja en ventana privada).
    if (opts && opts.dropQueuedBroadcast) {
      pendingBroadcast = null;
      return;
    }
    if (pendingBroadcast) {
      var pb = pendingBroadcast;
      pendingBroadcast = null;
      showOverlay('broadcast', pb, 1);
    }
  }

  /** Bienvenida "clásica" (sin recompensa): solo la primera vez. */
  function showPlainWelcome(uid, db, nick) {
    db.ref('users/' + uid + '/welcomeOverlaySeen').once('value').then(function (snap) {
      if (snap.val() === true) {
        finishWelcomeBoot();
        return;
      }
      db.ref('users/' + uid + '/welcomeOverlaySeen').set(true).catch(function () {});
      showOverlay('welcome', { nick: nick }, 0);
      finishWelcomeBoot();
    }).catch(function () { finishWelcomeBoot(); });
  }

  /**
   * Mientras la campaña de bienvenida esté abierta, el overlay aparece para
   * cualquiera que aún no haya reclamado su recompensa —también las cuentas
   * que ya existían, no solo los registros nuevos—. El reclamo lo hace la
   * Cloud Function claimWelcomeReward (tokens, boost e insignia son de
   * escritura exclusiva del servidor) y solo se concede una vez por cuenta.
   */
  function checkWelcomeReward(uid, db) {
    Promise.all([
      db.ref('users/' + uid + '/welcomeReward/claimedAt').once('value'),
      db.ref('siteCampaigns/welcome').once('value'),
      db.ref('users/' + uid + '/nick').once('value')
    ]).then(function (snaps) {
      var alreadyClaimed = !!snaps[0].val();
      var cfg = snaps[1].val() || {};
      var nick = snaps[2].val() || '';
      var endsAt = Number(cfg.endsAt) || 0;
      var campaignOpen = cfg.active !== false && (!endsAt || Date.now() < endsAt);

      if (alreadyClaimed || !campaignOpen) {
        sgLog('bienvenida: ' + (alreadyClaimed ? 'recompensa ya reclamada' : 'campaña cerrada'));
        showPlainWelcome(uid, db, nick);
        return;
      }

      if (typeof firebase === 'undefined' || !firebase.functions) {
        showPlainWelcome(uid, db, nick);
        return;
      }

      firebase.functions().httpsCallable('claimWelcomeReward')({}).then(function (res) {
        var data = (res && res.data) || {};
        sgLog('recompensa de bienvenida otorgada', data);
        db.ref('users/' + uid + '/welcomeOverlaySeen').set(true).catch(function () {});
        // Prioridad 2: por encima de broadcasts, para que el saludo con
        // premios (boost, tokens, insignia) no lo tape un mensaje de prueba.
        showOverlay('welcome', {
          nick: data.nick || nick,
          rewarded: true,
          tokens: data.tokens || 30,
          boostPercent: data.boostPercent || 15,
          boostDays: 30,
          badgeName: WELCOME_BADGE.name
        }, 2);
        if (typeof window.refreshProfileNexusBadges === 'function') {
          setTimeout(function () { window.refreshProfileNexusBadges(); }, 1200);
        }
        finishWelcomeBoot({ dropQueuedBroadcast: true });
      }).catch(function (err) {
        // already-exists (dos pestañas a la vez) o campaña cerrada en el
        // servidor: no hay recompensa que anunciar, pero la bienvenida sí.
        sgLog('no se pudo reclamar la recompensa:', (err && err.message) || err);
        showPlainWelcome(uid, db, nick);
      });
    }).catch(function (e) {
      sgLog('no se pudo leer el estado de la bienvenida:', e && e.message);
      finishWelcomeBoot();
    });
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
        sgLog('transmisión ya vista (ts ' + ts + ' <= visto ' + lastSeen + '); usa ?sgtest=welcome para forzarla');
        return;
      }
      var payload = {
        title: v.title, message: v.message, characterId: v.characterId, animation: v.animation
      };
      // Esperar a que termine el boot de bienvenida/premios para no taparla
      // con un broadcast viejo (p.ej. en navegador privado sin localStorage).
      if (!welcomeBootDone) {
        pendingBroadcast = payload;
        setLastSeenBroadcastTs(ts);
        sgLog('broadcast en cola hasta terminar la bienvenida');
        return;
      }
      showOverlay('broadcast', payload, 1);
      setLastSeenBroadcastTs(ts);
    }, function (err) {
      sgLog('ERROR leyendo siteBroadcast (¿reglas de Firebase?):', err && err.message);
    });
  }

  // ---------- Trigger 4: resultado de partida de torneo (lo escribe el servidor) ----------
  // Los servidores privados escriben en tournamentMatchResults/{uid}/{matchId}
  // con credenciales de administrador; el cliente solo lee.
  //
  // Para no repetir avisos se combinan dos filtros: la marca persistente en
  // users/{uid}/notificationSeen/tournamentMatchResults/{matchId} (el mismo
  // sitio donde el resto del sitio guarda lo ya visto, así aguanta cambio de
  // página, de navegador y de dispositivo) y una ventana de frescura, que
  // evita que el histórico ya escrito antes de existir este aviso desfile en
  // pantalla la primera vez. localStorage hace de copia inmediata para que un
  // F5 rápido no alcance a mostrarlo dos veces si la escritura aún no subió.
  var MATCH_RESULT_MAX_AGE_MS = 30 * 60 * 1000;

  function getSeenMatchResults(uid) {
    try {
      var raw = localStorage.getItem('sgSeenMatchResults_' + uid);
      return raw ? JSON.parse(raw) : {};
    } catch (e) { return {}; }
  }
  function markMatchResultSeen(uid, db, matchId, seen) {
    seen[matchId] = 1;
    try { localStorage.setItem('sgSeenMatchResults_' + uid, JSON.stringify(seen)); } catch (e) {}
    db.ref('users/' + uid + '/notificationSeen/tournamentMatchResults/' + matchId)
      .set(Date.now()).catch(function () {});
  }

  function listenForMatchResults(uid, db) {
    var seen = getSeenMatchResults(uid);
    db.ref('users/' + uid + '/notificationSeen/tournamentMatchResults').once('value').then(function (snap) {
      var remote = snap.val() || {};
      Object.keys(remote).forEach(function (k) { seen[k] = 1; });
    }).catch(function () {}).then(function () {
      sgLog('escuchando tournamentMatchResults/' + uid + '…');
      db.ref('tournamentMatchResults/' + uid).on('child_added', function (snap) {
        var matchId = snap.key;
        var v = snap.val() || {};
        if (!matchId || seen[matchId]) return;
        markMatchResultSeen(uid, db, matchId, seen);
        var at = Number(v.at) || 0;
        if (!at || (Date.now() - at) > MATCH_RESULT_MAX_AGE_MS) {
          sgLog('resultado ' + matchId + ' es histórico, no se muestra');
          return;
        }
        // Prioridad 1, como el broadcast: nunca por encima de la bienvenida
        // con premios (prioridad 2), que se muestra una sola vez en la vida.
        showOverlay('tournament-result', {
          result: v.result,
          tournamentName: v.tournamentName,
          teamName: v.teamName,
          opponentName: v.opponentName,
          score: v.score,
          map: v.map
        }, 1);
      }, function (err) {
        sgLog('ERROR leyendo tournamentMatchResults (¿reglas de Firebase?):', err && err.message);
      });
    });
  }

  // ---------- Bootstrap ----------
  /**
   * Modos de prueba, sin necesidad de que exista nada en la base de datos:
   *   ?sgtest=welcome  (alias ?sgtest=1) — bienvenida con premios
   *   ?sgtest=win      — victoria en torneo de CS2
   *   ?sgtest=lose     (alias ?sgtest=loss) — derrota en torneo de CS2
   */
  function checkTestFlag() {
    var q = String(window.location.search || '');
    var wantsWin = q.indexOf('sgtest=win') !== -1;
    var wantsLoss = q.indexOf('sgtest=lose') !== -1 || q.indexOf('sgtest=loss') !== -1;
    if (wantsWin || wantsLoss) {
      sgLog('modo prueba: forzando resultado de torneo (' + (wantsWin ? 'victoria' : 'derrota') + ')');
      showOverlay('tournament-result', {
        result: wantsWin ? 'win' : 'loss',
        tournamentName: 'Studiosgamesrs CS2 Open',
        teamName: 'Los Pibes',
        opponentName: 'Rival FC',
        score: wantsWin ? '16-13' : '13-16',
        map: 'de_dust2'
      }, 2);
      return true;
    }
    var wantsWelcome = q.indexOf('sgtest=welcome') !== -1 || q.indexOf('sgtest=1') !== -1;
    if (!wantsWelcome) return false;
    sgLog('modo prueba: forzando overlay de bienvenida con premios');
    showOverlay('welcome', {
      nick: 'Comandante',
      rewarded: true,
      tokens: 30,
      boostPercent: 15,
      boostDays: 30
    }, 2);
    return true;
  }

  function bootAuth() {
    sgLog('script cargado en', window.location.host + window.location.pathname);
    ensureStylesheet();
    if (checkTestFlag()) return;
    if (typeof firebase === 'undefined' || !firebase.auth) {
      sgLog('firebase no disponible: no se activan los disparadores');
      return;
    }
    firebase.auth().onAuthStateChanged(function (user) {
      if (!user) { sgLog('sin sesión iniciada'); return; }
      sgLog('sesión detectada:', user.uid);
      var db = firebase.database();
      function startTriggers() {
        listenForMatchResults(user.uid, db);
        if (!isDashboardPage()) return;
        checkWelcomeReward(user.uid, db);
        listenForTournamentInvites(user.uid, db);
        listenForBroadcast(db);
      }
      db.ref('users/' + user.uid + '/blocked').once('value').then(function (snap) {
        if (snap.val() === true) return;
        startTriggers();
      }).catch(startTriggers);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootAuth);
  } else {
    bootAuth();
  }

  window.SGWelcomeOverlay = { showOverlay: showOverlay, closeOverlay: closeOverlay };
})();
