// Background service worker — relays progress from content script to storage
// so the popup always has fresh data even when it was closed

const STORAGE_KEY = 'fbwiper';

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'PROGRESS') {
    chrome.storage.local.set({
      [STORAGE_KEY]: {
        running: true,
        deleted: msg.deleted,
        lastUpdate: Date.now(),
      }
    });
  }

  if (msg.type === 'DONE') {
    chrome.storage.local.set({
      [STORAGE_KEY]: {
        running: false,
        deleted: msg.deleted,
        lastUpdate: Date.now(),
      }
    });
  }
});
