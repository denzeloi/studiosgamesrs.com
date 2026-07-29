// Copia EXACTA de initCamCalibratePanel() (commander-panel.js) para probarla
// aislada, sin Firebase/auth reales. `db`/`currentCommanderUid`/`firebase`
// los define el HTML de prueba con un mock en memoria.
var camCalibrateInited = false;
var camCalibrateViewer = null;

function initCamCalibratePanel() {
  if (camCalibrateInited) return;
  var canvas = document.getElementById('camCalibCanvas');
  if (!db || !window.SGCreatureViewer || !canvas) return;
  var Sensor = window.SGNexusSensor;
  if (!Sensor || !Sensor.characterCameraPath) return;
  camCalibrateInited = true;
  var Viewer = window.SGCreatureViewer;

  var loadingEl = document.getElementById('camCalibLoading');
  var statusEl = document.getElementById('camCalibStatus');
  var charSel = document.getElementById('camCalibCharacter');
  var clipSel = document.getElementById('camCalibClip');
  var yawSlider = document.getElementById('camCalibYaw');
  var yawValueEl = document.getElementById('camCalibYawValue');
  var sizeSlider = document.getElementById('camCalibSize');
  var sizeValueEl = document.getElementById('camCalibSizeValue');
  var saveBtn = document.getElementById('camCalibSaveBtn');
  var resetBtn = document.getElementById('camCalibResetBtn');
  var stepBtns = document.querySelectorAll('#secCamCalibrateBlock [data-yaw-step]');
  var camRef = db.ref(Sensor.characterCameraPath);

  var savedForChar = null;
  var loadedBaseline = null;

  function currentSizeMult() { return Math.max(0.1, (Number(sizeSlider.value) || 100) / 100); }
  function currentYaw() { return Number(yawSlider.value) || 0; }

  function normalizeYaw(deg) {
    var d = ((Number(deg) || 0) % 360 + 360) % 360;
    return (d > 180) ? d - 360 : d;
  }

  function updateLabels() {
    yawValueEl.textContent = currentYaw() + '\u00b0';
    sizeValueEl.textContent = Math.round(currentSizeMult() * 100) + '%';
  }

  function applyLive() {
    updateLabels();
    Viewer.setCameraOverride(charSel.value, { yawDeg: currentYaw(), sizeMult: currentSizeMult() });
    var dirty = !loadedBaseline || loadedBaseline.yawDeg !== currentYaw() || loadedBaseline.sizeMult !== currentSizeMult();
    if (dirty) {
      statusEl.textContent = 'Cambios sin guardar (solo los ves t\u00fa) \u2014 pulsa "Guardar" para que se apliquen a todos.';
      statusEl.className = 'sg-hint sg-notif-row-custom';
    } else if (savedForChar) {
      statusEl.textContent = 'Usando tu configuraci\u00f3n guardada para este personaje.';
      statusEl.className = 'sg-hint';
    } else {
      statusEl.textContent = 'Usando el \u00e1ngulo/tama\u00f1o de f\u00e1brica (nunca se ha guardado nada para este personaje).';
      statusEl.className = 'sg-hint';
    }
  }

  function playCurrentClip() {
    if (!camCalibrateViewer) camCalibrateViewer = Viewer.create(canvas);
    var charId = charSel.value;
    var clip = clipSel.value;
    if (!charId || !clip) return;
    if (loadingEl) { loadingEl.style.display = ''; loadingEl.textContent = 'Cargando\u2026'; }
    camCalibrateViewer.playEntrance(charId, clip, function (err) {
      if (!loadingEl) return;
      if (err) loadingEl.textContent = 'No se pudo cargar la animaci\u00f3n.';
      else loadingEl.style.display = 'none';
    }, function (ratio) {
      if (loadingEl) loadingEl.textContent = 'Cargando\u2026 ' + Math.min(100, Math.round(ratio * 100)) + '%';
    });
  }

  function loadCharacter(charId) {
    fillClipSelect(clipSel, charId, null);
    camRef.child(charId).once('value').then(function (snap) {
      var val = snap.val();
      var factory = Viewer.factoryCamera(charId) || { yawDeg: 0, sizeMult: 1 };
      savedForChar = (val && typeof val.yawDeg === 'number') ?
        { yawDeg: val.yawDeg, sizeMult: (typeof val.sizeMult === 'number' && val.sizeMult > 0) ? val.sizeMult : 1 } :
        null;
      var use = savedForChar || factory;
      yawSlider.value = normalizeYaw(use.yawDeg);
      sizeSlider.value = Math.round((use.sizeMult || 1) * 100);
      loadedBaseline = { yawDeg: currentYaw(), sizeMult: currentSizeMult() };
      resetBtn.style.display = savedForChar ? '' : 'none';
      applyLive();
      playCurrentClip();
    }).catch(function (err) {
      console.warn('[CamCalibrate] no se pudo leer nexusCharacterCamera', err);
      playCurrentClip();
    });
  }

  fillCharacterSelect(charSel, 'wyvern-dragon');
  charSel.addEventListener('change', function () { loadCharacter(charSel.value); });
  clipSel.addEventListener('change', playCurrentClip);

  yawSlider.addEventListener('input', applyLive);
  sizeSlider.addEventListener('input', applyLive);
  stepBtns.forEach(function (btn) {
    btn.addEventListener('click', function () {
      var step = Number(btn.getAttribute('data-yaw-step')) || 0;
      var next = currentYaw() + step;
      if (next > 180) next -= 360;
      if (next < -180) next += 360;
      yawSlider.value = next;
      applyLive();
    });
  });

  saveBtn.addEventListener('click', function () {
    saveBtn.disabled = true;
    var payload = {
      yawDeg: currentYaw(),
      sizeMult: currentSizeMult(),
      updatedBy: currentCommanderUid,
      updatedAt: firebase.database.ServerValue.TIMESTAMP
    };
    camRef.child(charSel.value).set(payload).then(function () {
      savedForChar = { yawDeg: payload.yawDeg, sizeMult: payload.sizeMult };
      loadedBaseline = { yawDeg: payload.yawDeg, sizeMult: payload.sizeMult };
      resetBtn.style.display = '';
      statusEl.textContent = 'Guardado \u2713 \u2014 ya se aplica en todo el sitio para este personaje.';
      statusEl.className = 'sg-hint sg-notif-row-ok';
    }).catch(function (err) {
      console.error(err);
      statusEl.textContent = 'Error al guardar (revisa permisos/reglas).';
      statusEl.className = 'sg-hint sg-notif-row-err';
    }).finally(function () { saveBtn.disabled = false; });
  });

  resetBtn.addEventListener('click', function () {
    resetBtn.disabled = true;
    camRef.child(charSel.value).remove().then(function () {
      savedForChar = null;
      var factory = Viewer.factoryCamera(charSel.value) || { yawDeg: 0, sizeMult: 1 };
      yawSlider.value = normalizeYaw(factory.yawDeg);
      sizeSlider.value = Math.round((factory.sizeMult || 1) * 100);
      loadedBaseline = { yawDeg: currentYaw(), sizeMult: currentSizeMult() };
      Viewer.clearCameraOverride(charSel.value);
      resetBtn.style.display = 'none';
      applyLive();
    }).catch(function (err) {
      console.error(err);
      statusEl.textContent = 'Error al restablecer.';
      statusEl.className = 'sg-hint sg-notif-row-err';
    }).finally(function () { resetBtn.disabled = false; });
  });

  loadCharacter(charSel.value);
}
