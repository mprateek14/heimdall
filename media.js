// Helpers shared by the recorder window and the library page.

import { addDuration } from './webm.js';

const MIME_CANDIDATES = {
  audio: ['audio/webm;codecs=opus', 'audio/webm'],
  video: ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'],
  both: ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'],
};

export function pickMimeType(mode) {
  return MIME_CANDIDATES[mode].find((m) => MediaRecorder.isTypeSupported(m)) || '';
}

export function formatDuration(ms) {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function formatSize(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function fileName(session) {
  const slug = (session.title || 'recording')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  const stamp = new Date(session.startedAt).toISOString().slice(0, 19).replace(/[:T]/g, '-');
  return `heimdall-${slug || 'recording'}-${stamp}.webm`;
}

export function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// Asks Chrome how long the recording really is. NaN if it can't tell.
export function measureDuration(blob) {
  return new Promise((resolve) => {
    const el = document.createElement('video');
    const url = URL.createObjectURL(blob);
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      URL.revokeObjectURL(url);
      resolve(value);
    };
    const check = () => Number.isFinite(el.duration) && finish(el.duration);
    el.preload = 'metadata';
    el.muted = true;
    el.onerror = () => finish(NaN);
    el.ondurationchange = check;
    el.onloadedmetadata = () => {
      if (!check()) el.currentTime = 1e7;
    };
    setTimeout(() => finish(NaN), 8000);
    el.src = url;
  });
}

// Blob to save: the stored recording with a duration written into its header.
export async function prepareDownload(blob, session) {
  const measured = await measureDuration(blob);
  const seconds = Number.isFinite(measured) ? measured : (session.durationMs || 0) / 1000;
  return addDuration(blob, seconds);
}

// MediaRecorder output has no duration in its header, so the player reports
// Infinity and refuses to seek. Seeking far past the end makes Chrome scan the
// file and learn the real length. This fixes playback only, not the saved file.
export function fixDuration(el) {
  el.addEventListener(
    'loadedmetadata',
    () => {
      if (el.duration !== Infinity) return;
      el.currentTime = 1e7;
      el.addEventListener(
        'timeupdate',
        () => {
          el.currentTime = 0;
        },
        { once: true },
      );
    },
    { once: true },
  );
}
