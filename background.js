// Opens one recorder window per recording. The worker keeps no recording
// state, so any number of sessions can run side by side.

// Starting size only. The recorder window resizes itself to fit its content.
const RECORDER_SIZE = { width: 360, height: 170 };

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'open-recorder') {
    openRecorder(message.params)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true; // keep the channel open for the async response
  }
});

async function openRecorder(params) {
  const query = new URLSearchParams(params).toString();
  await chrome.windows.create({
    url: chrome.runtime.getURL(`recorder.html?${query}`),
    type: 'popup',
    ...RECORDER_SIZE,
  });
}
