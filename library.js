import * as db from './db.js';
import { formatDuration, formatSize, fileName, download, fixDuration, prepareDownload } from './media.js';

const MODE_LABELS = { audio: 'Audio only', video: 'Video only', both: 'Audio + video' };

const list = document.getElementById('list');
const empty = document.getElementById('empty');

function button(label, onClick, className = '') {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  b.className = className;
  b.addEventListener('click', onClick);
  return b;
}

function meta(session) {
  const parts = [MODE_LABELS[session.mode] || session.mode, new Date(session.startedAt).toLocaleString()];
  if (session.status === 'done') {
    parts.push(formatDuration(session.durationMs), formatSize(session.size));
  } else {
    parts.push('Unfinished (the window closed before Stop)');
  }
  const daysLeft = Math.max(0, Math.ceil((session.startedAt + db.RETENTION_MS - Date.now()) / 86_400_000));
  parts.push(`deleted in ${daysLeft} ${daysLeft === 1 ? 'day' : 'days'}`);
  return parts.join(' · ');
}

async function playInline(item, session) {
  const existing = item.querySelector('video, audio');
  if (existing) {
    existing.remove();
    return;
  }
  const blob = await db.getBlob(session.id, session.mimeType);
  const player = document.createElement(session.mode === 'audio' ? 'audio' : 'video');
  player.controls = true;
  player.src = URL.createObjectURL(blob);
  fixDuration(player);
  item.append(player);
  player.play().catch(() => {});
}

function render(session) {
  const item = document.createElement('li');
  const row = document.createElement('div');
  row.className = 'row';

  const info = document.createElement('div');
  info.className = 'info';
  const name = document.createElement('div');
  name.className = 'name';
  name.textContent = session.title;
  const details = document.createElement('div');
  details.className = 'meta';
  details.textContent = meta(session);
  info.append(name, details);

  const actions = document.createElement('div');
  actions.className = 'actions';
  actions.append(
    button('Play', () => playInline(item, session)),
    button('Download', async () => {
      const blob = await db.getBlob(session.id, session.mimeType);
      download(await prepareDownload(blob, session), fileName(session));
    }),
    button(
      'Delete',
      async () => {
        await db.deleteSession(session.id);
        item.remove();
        empty.hidden = list.children.length > 0;
      },
      'danger',
    ),
  );

  row.append(info, actions);
  item.append(row);
  return item;
}

(async function main() {
  await db.purgeExpired();
  const sessions = await db.listSessions();
  empty.hidden = sessions.length > 0;
  list.replaceChildren(...sessions.map(render));
})();
