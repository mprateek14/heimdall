const DEFAULTS = { mode: 'both', source: 'tab', tabAudio: true, mic: false, keepCopy: false };

const $ = (id) => document.getElementById(id);
const startButton = $('start');
const notice = $('notice');

let settings = { ...DEFAULTS };

async function loadSettings() {
  const stored = await chrome.storage.local.get('settings');
  settings = { ...DEFAULTS, ...stored.settings };
}

function saveSettings() {
  chrome.storage.local.set({ settings });
}

function renderSegmented(groupId, value) {
  for (const button of $(groupId).querySelectorAll('button')) {
    button.setAttribute('aria-checked', String(button.dataset.value === value));
  }
}

function render() {
  renderSegmented('mode', settings.mode);
  renderSegmented('source', settings.source);

  const hasAudio = settings.mode !== 'video';
  $('audio-section').hidden = !hasAudio;
  $('tabAudio').checked = settings.tabAudio;
  $('mic').checked = settings.mic;
  $('keepCopy').checked = settings.keepCopy;
  $('tabAudioLabel').textContent = settings.source === 'tab' ? 'Tab audio' : 'System audio';
  notice.textContent = '';
}

function bindSegmented(groupId, key) {
  $(groupId).addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    settings[key] = button.dataset.value;
    saveSettings();
    render();
  });
}

bindSegmented('mode', 'mode');
bindSegmented('source', 'source');

$('tabAudio').addEventListener('change', (e) => {
  settings.tabAudio = e.target.checked;
  saveSettings();
});
$('mic').addEventListener('change', (e) => {
  settings.mic = e.target.checked;
  saveSettings();
});
$('keepCopy').addEventListener('change', (e) => {
  settings.keepCopy = e.target.checked;
  saveSettings();
});

async function start() {
  const { mode, source } = settings;
  const wantsAudio = mode !== 'video';
  const tabAudio = wantsAudio && settings.tabAudio;
  const mic = wantsAudio && settings.mic;

  if (wantsAudio && !tabAudio && !mic) {
    notice.textContent = 'Pick at least one audio source.';
    return;
  }

  // Audio-only from the mic alone needs no tab or screen stream at all.
  const needsDisplay = mode !== 'audio' || tabAudio;
  const params = {
    mode,
    source,
    tabAudio: tabAudio ? '1' : '0',
    mic: mic ? '1' : '0',
    keep: settings.keepCopy ? '1' : '0',
  };

  startButton.disabled = true;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    params.title = tab?.title || 'Recording';

    // The tab stream id needs the activeTab grant from this popup click, so
    // it has to be requested here. The screen picker runs in the recorder window.
    if (needsDisplay && source === 'tab') {
      if (!tab || tab.id === undefined) throw new Error('No active tab found.');
      const captured = await chrome.tabCapture.getCapturedTabs();
      if (captured.some((c) => c.tabId === tab.id && c.status === 'active')) {
        throw new Error('This tab is already being recorded.');
      }
      params.streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
    }

    const reply = await chrome.runtime.sendMessage({ type: 'open-recorder', params });
    if (!reply?.ok) throw new Error(reply?.error || 'Could not open the recorder.');
    window.close();
  } catch (err) {
    notice.textContent = err.message || String(err);
    startButton.disabled = false;
  }
}

startButton.addEventListener('click', start);

loadSettings().then(render);
