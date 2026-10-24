# Heimdall

Chrome extension (Manifest V3) that records audio only, video only, or audio plus video.
Several tabs can be recorded at once.

## Load it

1. Open `chrome://extensions` and turn on Developer mode.
2. Click Load unpacked and select this folder.
3. Pin the Heimdall icon.

## Use it

1. Open the tab you want to record and click the icon.
2. Pick Audio only, Video only or Audio + video, then a source and audio inputs.
3. Click Start recording. A small recorder window opens. Stop saves the file to Downloads/Heimdall and closes the window.
4. For a second tab, switch to it and click the icon again. Each recording gets its own window.

## How concurrent recordings stay separate

Each recorder window owns its streams, its `AudioContext` and its `MediaRecorder`.
The service worker only opens windows and holds no recording state. Chunks are stored
in IndexedDB under a per-session id while recording. They are deleted once the file is
saved to Downloads, unless "keep a copy" is on. Anything left over expires after 7 days.

## Files

| File | Role |
| --- | --- |
| `manifest.json` | MV3 manifest, permissions |
| `background.js` | Opens a recorder window per session |
| `popup.*` | Mode, source and audio selection |
| `recorder.*` | Capture, audio mixing, MediaRecorder, save |
| `library.*` | Kept copies and recovered recordings (7-day expiry) |
| `db.js`, `media.js` | Storage and shared helpers |

## Known limits

- Output is WebM. Saving writes the duration into the header (`webm.js`), but Chrome adds
  no seek index, so jumping around in long files can be coarse in some editors.
- Chrome cannot capture `chrome://` pages or the Web Store.
