// Background service worker.
// The content script owns all persisted state (chrome.storage). This worker's
// only job is to surface progress on the toolbar icon badge, so the user can
// watch the count climb during a multi-day run without opening the popup.

function abbreviate(n) {
  n = Number(n) || 0;
  if (n < 1000) return String(n);
  if (n < 10000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return Math.round(n / 1000) + 'k';
}

function setBadge(text, color) {
  try {
    chrome.action.setBadgeBackgroundColor({ color });
    chrome.action.setBadgeText({ text });
  } catch (_) { /* action API not ready */ }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'PROGRESS') {
    setBadge(abbreviate(msg.deleted), '#e74c3c');
  } else if (msg.type === 'DONE') {
    setBadge('✓', '#2ecc71');
  }
});

// Restore the badge after the worker is respawned (MV3 workers are ephemeral).
chrome.storage.local.get('fbwiper', (data) => {
  const s = data.fbwiper;
  if (s && s.deleted) {
    setBadge(s.running ? abbreviate(s.deleted) : abbreviate(s.deleted), s.running ? '#e74c3c' : '#555');
  }
});
