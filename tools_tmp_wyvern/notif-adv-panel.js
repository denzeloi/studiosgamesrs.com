var notifAdvancedInited = false;

function initNotifAdvancedPanel() {
  if (notifAdvancedInited) return;
  var launchBtn = document.getElementById('notifAdvLaunchBtn');
  if (!window.SGCreatureViewer || !window.SGLevels || !launchBtn) return;
  var Sensor = window.SGNexusSensor;
  if (!Sensor || typeof Sensor.previewLevelOverlay !== 'function') return;
  notifAdvancedInited = true;
  var SG = window.SGLevels;

  var levelInput = document.getElementById('notifAdvLevel');
  var charSel = document.getElementById('notifAdvCharacter');
  var clipSel = document.getElementById('notifAdvClip');
  var tierNameInput = document.getElementById('notifAdvTierName');
  var accessNameInput = document.getElementById('notifAdvAccessName');
  var taglineInput = document.getElementById('notifAdvTagline');
  var rewardsList = document.getElementById('notifAdvRewardsList');
  var loadDefaultsBtn = document.getElementById('notifAdvLoadDefaultsBtn');
  var addRewardBtn = document.getElementById('notifAdvAddRewardBtn');
  var closeBtn = document.getElementById('notifAdvCloseBtn');

  var REWARD_TYPE_OPTIONS = Sensor.rewardKinds || {
    tokens: 'Tokens', frame: 'Marco', background: 'Fondo', badge: 'Insignia', perk: 'Beneficio'
  };

  function rewardTypeOptionsHtml(selected) {
    return Object.keys(REWARD_TYPE_OPTIONS).map(function(key) {
      var sel = key === selected ? ' selected' : '';
      return '<option value="' + key + '"' + sel + '>' + REWARD_TYPE_OPTIONS[key] + '</option>';
    }).join('');
  }

  function addRewardRow(reward) {
    reward = reward || {};
    var row = document.createElement('div');
    row.className = 'sg-notif-reward-row';
    row.innerHTML =
      '<select class="comms-input comms-select" data-role="type">' + rewardTypeOptionsHtml(reward.type || 'perk') + '</select>' +
      '<input type="text" class="comms-input" data-role="name" maxlength="60" placeholder="Nombre" value="' + escAttr(reward.name || '') + '">' +
      '<input type="number" class="comms-input" data-role="amount" min="0" placeholder="Cant." value="' + (reward.amount ? Number(reward.amount) : '') + '">' +
      '<input type="text" class="comms-input" data-role="desc" maxlength="140" placeholder="Descripción" value="' + escAttr(reward.description || '') + '">' +
      '<button type="button" class="comms-btn comms-btn-ghost sg-notif-reward-remove" title="Quitar"><i class="fas fa-times"></i></button>';
    row.querySelector('.sg-notif-reward-remove').addEventListener('click', function() { row.remove(); });
    rewardsList.appendChild(row);
  }

  function escAttr(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  }

  function collectRewards() {
    var rows = rewardsList ? rewardsList.querySelectorAll('.sg-notif-reward-row') : [];
    var out = [];
    rows.forEach(function(row) {
      var name = (row.querySelector('[data-role="name"]').value || '').trim();
      if (!name) return;
      var amount = Number(row.querySelector('[data-role="amount"]').value) || 0;
      out.push({
        type: row.querySelector('[data-role="type"]').value || 'perk',
        name: name,
        amount: amount,
        description: (row.querySelector('[data-role="desc"]').value || '').trim()
      });
    });
    return out;
  }

  function loadLevelDefaults() {
    var level = Math.max(1, Math.min(100, Number(levelInput.value) || 10));
    levelInput.value = level;
    var tier = (typeof SG.tierForLevel === 'function') ? SG.tierForLevel(level) : null;
    if (tier) {
      tierNameInput.value = tier.name || '';
      accessNameInput.value = tier.accessName || '';
      taglineInput.value = tier.tagline || '';
      if (typeof Sensor.defaultTierAnimation === 'function') {
        var pick = Sensor.defaultTierAnimation(tier.index);
        fillCharacterSelect(charSel, pick.characterId);
        fillClipSelect(clipSel, charSel.value, pick.clip);
      }
    }
    rewardsList.innerHTML = '';
    var rewards = (typeof SG.rewardsForLevel === 'function') ? (SG.rewardsForLevel(level) || []) : [];
    if (rewards.length) {
      rewards.forEach(addRewardRow);
    } else {
      addRewardRow({ type: 'perk', name: '', amount: 0, description: '' });
    }
  }

  fillCharacterSelect(charSel, 'golem-tortoise');
  fillClipSelect(clipSel, charSel.value, 'roar');
  if (charSel) charSel.addEventListener('change', function() { fillClipSelect(clipSel, charSel.value, null); });

  if (loadDefaultsBtn) loadDefaultsBtn.addEventListener('click', loadLevelDefaults);
  if (addRewardBtn) addRewardBtn.addEventListener('click', function() { addRewardRow({ type: 'perk' }); });

  if (launchBtn) {
    launchBtn.addEventListener('click', function() {
      Sensor.previewLevelOverlay({
        level: Math.max(1, Math.min(100, Number(levelInput.value) || 10)),
        characterId: charSel.value,
        clip: clipSel.value,
        tierName: (tierNameInput.value || '').trim(),
        accessName: (accessNameInput.value || '').trim(),
        tagline: (taglineInput.value || '').trim(),
        rewards: collectRewards()
      });
    });
  }
  if (closeBtn) closeBtn.addEventListener('click', function() { Sensor.closeLevelOverlay(); });

  // Arranca ya cargado con algo coherente en vez de un formulario vacío.
  loadLevelDefaults();
}
