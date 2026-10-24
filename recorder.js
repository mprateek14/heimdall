// One recorder window = one session. Everything below is local to this page:
// its own streams, its own AudioContext, its own MediaRecorder. That is what
// keeps audio from several simultaneous recordings apart.

import * as db from './db.js';
import { pickMimeType, formatDuration, fileName, download, fixDuration, prepareDownload } from './media.js';

const params = new URLSearchParams(location.search);
const mode = params.get('mode'); // audio | video | both
const source = params.get('source'); // tab | desktop
const wantDisplayAudio = params.get('tabAudio') === '1';
const wantMic = params.get('mic') === '1';
const keepCopy = params.get('keep') === '1';
const streamId = params.get('streamId');
const pageTitle = params.get('title') || 'Recording';

const MODE_LABELS = { audio: 'Audio only', video: 'Video only', both: 'Audio + video' };
const needsDisplay = mode !== 'audio' || wantDisplayAudio;

const $ = (id) => document.getElementById(id);
const session = {
  id: crypto.randomUUID(),
  title: pageTitle,
  mode,
  source,
  mimeType: '',
  startedAt: Date.now(),
  endedAt: null,
  durationMs: 0,
  size: 0,
  status: 'recording',
};

const ownedStreams = []; // every raw stream we opened, so cleanup can stop them all
let displayStream = null;
let audioCtx = null;
let mixBus = null;
let analyser = null;
let recorder = null;
let writeChain = Promise.resolve();
let bytesWritten = 0;
let meterTimer = null;
let tickTimer = null;
let recordedMs = 0;
let segmentStart = 0;
let finishing = false;

document.title = `Heimdall - ${pageTitle}`;
$('title').textContent = pageTitle;
$('badge').textContent = MODE_LABELS[mode] || mode;

function setStatus(text) {
  $('status').textContent = text;
}

function setMessage(text, isError = false) {
  const el = $('message');
  el.textContent = text;
  el.hidden = !text;
  el.classList.toggle('error', isError);
}

async function closeWindow() {
  const win = await chrome.windows.getCurrent();
  chrome.windows.remove(win.id);
}

// Keep the window just big enough for what is on screen.
let lastHeight = 0;
async function fitWindow() {
  const height = Math.ceil($('app').offsetHeight + (window.outerHeight - window.innerHeight));
  if (Math.abs(height - lastHeight) < 2) return;
  lastHeight = height;
  const win = await chrome.windows.getCurrent();
  chrome.windows.update(win.id, { height });
}
new ResizeObserver(fitWindow).observe($('app'));

// Hands the file to Chrome's download manager and resolves once it is on disk.
async function saveToDisk(blob, name) {
  const url = URL.createObjectURL(blob);
  try {
    const id = await chrome.downloads.download({
      url,
      filename: `Heimdall/${name}`,
      conflictAction: 'uniquify',
    });
    await new Promise((resolve, reject) => {
      const settle = (state) => {
        if (state === 'complete') resolve();
        else if (state === 'interrupted') reject(new Error('The download was interrupted or cancelled.'));
        else return false;
        chrome.downloads.onChanged.removeListener(onChanged);
        return true;
      };
      const onChanged = (delta) => delta.id === id && delta.state && settle(delta.state.current);
      chrome.downloads.onChanged.addListener(onChanged);
      // The download may have finished before the listener was attached.
      chrome.downloads.search({ id }).then(([item]) => item && settle(item.state));
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

function elapsed() {
  return recordedMs + (segmentStart ? performance.now() - segmentStart : 0);
}

function pickDesktop(withAudio) {
  return new Promise((resolve, reject) => {
    const sources = ['screen', 'window', 'tab'];
    if (withAudio) sources.push('audio');
    chrome.desktopCapture.chooseDesktopMedia(sources, (id, options) => {
      if (!id) reject(new Error('Screen sharing was cancelled.'));
      else resolve({ id, audio: Boolean(options?.canRequestAudioTrack) });
    });
  });
}

async function openDisplayStream() {
  let chromeSource = 'tab';
  let id = streamId;
  let audioAllowed = true;

  if (source === 'desktop') {
    const picked = await pickDesktop(wantDisplayAudio);
    chromeSource = 'desktop';
    id = picked.id;
    audioAllowed = picked.audio;
  }
  if (!id) throw new Error('No capture source was provided.');

  const target = { mandatory: { chromeMediaSource: chromeSource, chromeMediaSourceId: id } };
  const constraints = {};
  // Desktop capture refuses audio-only requests, so ask for video and drop it later.
  if (mode !== 'audio' || chromeSource === 'desktop') constraints.video = target;
  if (wantDisplayAudio && audioAllowed) constraints.audio = target;

  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  ownedStreams.push(stream);

  if (wantDisplayAudio && stream.getAudioTracks().length === 0) {
    setMessage(
      chromeSource === 'desktop'
        ? 'No system audio was shared. Tick "Share audio" in the picker next time.'
        : 'This tab produced no audio track.',
      true,
    );
  }
  if (mode === 'audio') stream.getVideoTracks().forEach((t) => t.stop());
  return stream;
}

async function openMicStream() {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true },
  });
  ownedStreams.push(stream);
  return stream;
}

function buildAudioGraph(displayAudioTracks, micStream) {
  audioCtx = new AudioContext();
  const destination = audioCtx.createMediaStreamDestination();
  mixBus = audioCtx.createGain();
  mixBus.connect(destination);

  if (displayAudioTracks.length) {
    const node = audioCtx.createMediaStreamSource(new MediaStream(displayAudioTracks));
    node.connect(mixBus);
    // Tab capture silences the tab for the user. Playing the same audio back
    // through this page's output keeps it audible. Screen capture is left
    // alone, because replaying system audio would be captured again.
    if (source === 'tab') node.connect(audioCtx.destination);
  }
  if (micStream) {
    // The mic goes to the recording only. Playing it back would echo.
    audioCtx.createMediaStreamSource(micStream).connect(mixBus);
  }

  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 512;
  mixBus.connect(analyser);
  return destination.stream.getAudioTracks()[0];
}

function startMeter() {
  const data = new Uint8Array(analyser.fftSize);
  $('meter-wrap').hidden = false;
  meterTimer = setInterval(() => {
    analyser.getByteTimeDomainData(data);
    let peak = 0;
    for (const v of data) peak = Math.max(peak, Math.abs(v - 128));
    $('meter-bar').style.width = `${Math.min(100, (peak / 128) * 140)}%`;
  }, 80);
}

async function acquire() {
  const recordTracks = [];
  let displayAudioTracks = [];

  if (needsDisplay) {
    displayStream = await openDisplayStream();
    displayAudioTracks = displayStream.getAudioTracks();
    for (const track of displayStream.getTracks()) {
      track.addEventListener('ended', () => stopRecording('The shared source ended.'));
    }
  }

  let micStream = null;
  if (wantMic) {
    try {
      micStream = await openMicStream();
    } catch (err) {
      if (!displayAudioTracks.length) throw new Error('Microphone access was denied.');
      setMessage('Microphone access was denied, recording without it.', true);
    }
  }

  if (mode !== 'audio') recordTracks.push(...displayStream.getVideoTracks());
  if (mode !== 'video' && (displayAudioTracks.length || micStream)) {
    recordTracks.push(buildAudioGraph(displayAudioTracks, micStream));
  }
  if (mode !== 'video' && !recordTracks.some((t) => t.kind === 'audio')) {
    throw new Error('No audio is available to record.');
  }
  if (mode !== 'audio' && !recordTracks.some((t) => t.kind === 'video')) {
    throw new Error('No video is available to record.');
  }
  return new MediaStream(recordTracks);
}

// An AudioContext created without a user gesture can start suspended, which
// would record silence. Wait briefly for it to run, otherwise ask for a click.
async function audioContextRunning() {
  if (!audioCtx) return true;
  await Promise.race([audioCtx.resume(), new Promise((r) => setTimeout(r, 400))]);
  return audioCtx.state === 'running';
}

function showPreview(stream) {
  if (mode === 'audio') return;
  const preview = $('preview');
  preview.srcObject = new MediaStream(stream.getVideoTracks());
  preview.hidden = false;
  preview.play().catch(() => {});
}

function beginRecording(stream) {
  session.mimeType = pickMimeType(mode);
  const options = { audioBitsPerSecond: 128_000 };
  if (session.mimeType) options.mimeType = session.mimeType;
  if (mode !== 'audio') options.videoBitsPerSecond = 6_000_000;

  recorder = new MediaRecorder(stream, options);
  session.mimeType = recorder.mimeType || session.mimeType;

  recorder.ondataavailable = (event) => {
    if (!event.data.size) return;
    bytesWritten += event.data.size;
    writeChain = writeChain.then(() => db.addChunk(session.id, event.data));
  };
  recorder.onerror = (event) => setMessage(`Recorder error: ${event.error?.message || 'unknown'}`, true);
  recorder.onstop = finalize;

  db.putSession(session);
  recorder.start(1000);
  segmentStart = performance.now();

  $('dot').hidden = false;
  $('dot').className = 'dot live';
  $('begin').hidden = true;
  $('pause').hidden = false;
  $('stop').hidden = false;
  setStatus('Recording');
  setMessage('');
  tickTimer = setInterval(() => {
    $('timer').textContent = formatDuration(elapsed());
  }, 250);
  if (analyser) startMeter();
}

function togglePause() {
  if (!recorder) return;
  if (recorder.state === 'recording') {
    recorder.pause();
    recordedMs += performance.now() - segmentStart;
    segmentStart = 0;
    $('pause').textContent = 'Resume';
    $('dot').className = 'dot paused';
    setStatus('Paused');
  } else if (recorder.state === 'paused') {
    recorder.resume();
    segmentStart = performance.now();
    $('pause').textContent = 'Pause';
    $('dot').className = 'dot live';
    setStatus('Recording');
  }
}

function stopRecording(reason) {
  if (!recorder || recorder.state === 'inactive') return;
  if (reason) setMessage(reason);
  recorder.stop();
}

function releaseResources() {
  clearInterval(tickTimer);
  clearInterval(meterTimer);
  ownedStreams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
  if (audioCtx && audioCtx.state !== 'closed') audioCtx.close();
  $('preview').srcObject = null;
}

async function finalize() {
  if (finishing) return;
  finishing = true;
  recordedMs = elapsed();
  segmentStart = 0;
  releaseResources();

  $('controls').hidden = true;
  $('dot').hidden = true;
  $('meter-wrap').hidden = true;
  $('preview').hidden = true;
  $('timer').textContent = formatDuration(recordedMs);
  setStatus('Saving...');

  await writeChain;
  session.endedAt = Date.now();
  session.durationMs = Math.round(recordedMs);
  session.size = bytesWritten;
  session.status = 'done';

  if (bytesWritten === 0) {
    await db.deleteSession(session.id);
    setStatus('Nothing recorded');
    setMessage('No audio or video data was captured.', true);
    showCloseOnly();
    return;
  }
  await db.updateSession(session.id, session);

  const blob = await db.getBlob(session.id, session.mimeType);
  try {
    await saveToDisk(await prepareDownload(blob, session), fileName(session));
    if (!keepCopy) await db.deleteSession(session.id);
    await closeWindow();
  } catch (err) {
    showFallback(blob, err);
  }
}

// Automatic save failed. The recording is still stored, so offer a manual save.
function showFallback(blob, err) {
  setStatus('Not saved yet');
  setMessage(`${err.message || err} The recording is kept in Heimdall for 7 days.`, true);

  const player = mode === 'audio' ? $('playback-audio') : $('playback');
  player.src = URL.createObjectURL(blob);
  player.hidden = false;
  fixDuration(player);

  $('download').onclick = async () => {
    download(await prepareDownload(blob, session), fileName(session));
  };
  $('close').onclick = closeWindow;
  $('result').hidden = false;
}

function showCloseOnly() {
  const close = document.createElement('button');
  close.textContent = 'Close';
  close.onclick = closeWindow;
  $('app').append(close);
}

function fail(err) {
  console.error(err);
  releaseResources();
  setStatus('Could not start');
  setMessage(err.message || String(err), true);
  $('dot').hidden = true;
  showCloseOnly();
}

window.addEventListener('beforeunload', (event) => {
  if (recorder && recorder.state !== 'inactive') {
    event.preventDefault();
    event.returnValue = '';
  }
});

$('pause').onclick = togglePause;
$('stop').onclick = () => stopRecording();

(async function main() {
  db.purgeExpired().catch(() => {});
  try {
    const stream = await acquire();
    showPreview(stream);
    $('controls').hidden = false;

    if (await audioContextRunning()) {
      beginRecording(stream);
    } else {
      setStatus('Ready');
      setMessage('Click start to begin. Chrome needs a click before it will record audio.');
      $('begin').hidden = false;
      $('begin').onclick = async () => {
        await audioCtx.resume();
        beginRecording(stream);
      };
    }
  } catch (err) {
    fail(err);
  }
})();
