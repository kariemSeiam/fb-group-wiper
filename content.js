// FB Group Post Wiper — content script
// Runs inside facebook.com/groups/* pages

const STORAGE_KEY = 'fbwiper';

const state = {
  running: false,
  deleted: 0,
  sessionDeleted: 0,
  scrollStrikes: 0,
};

const MAX_SCROLL_STRIKES = 8;
const DELAY_AFTER_DELETE = 1400;   // ms between deletes
const DELAY_MENU_OPEN    = 800;
const DELAY_CONFIRM      = 900;
const DELAY_SCROLL       = 2200;

const delay = ms => new Promise(r => setTimeout(r, ms));

// ─── Core deletion step ────────────────────────────────────────────────────

async function deleteOnePost() {
  // Find the first post action button not marked as skipped
  const btn = document.querySelector(
    '[aria-label^="Actions for this post"]:not([data-wiper-skip])'
  );
  if (!btn) return 'NOT_FOUND';

  btn.click();
  await delay(DELAY_MENU_OPEN);

  // Find the remove/delete option — works for both admin-remove and own-post-delete
  const items = Array.from(document.querySelectorAll('[role=menuitem]'));
  const removeItem = items.find(m =>
    m.textContent.includes('Remove post')    ||
    m.textContent.includes('Delete post')    ||
    m.textContent.includes('إزالة المنشور') ||
    m.textContent.includes('حذف المنشور')
  );

  if (!removeItem) {
    // Not a deletable post (e.g. pinned system post) — mark and skip
    btn.setAttribute('data-wiper-skip', '1');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await delay(400);
    return 'SKIPPED';
  }

  removeItem.click();
  await delay(DELAY_CONFIRM);

  // Confirm dialog
  const allBtns = Array.from(document.querySelectorAll('button, [role=button]'));
  const confirmBtn = allBtns.find(b =>
    b.textContent.trim() === 'Confirm' ||
    b.textContent.trim() === 'تأكيد'
  );

  if (!confirmBtn) {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await delay(400);
    return 'NO_CONFIRM';
  }

  confirmBtn.click();
  state.deleted++;
  state.sessionDeleted++;
  await delay(DELAY_AFTER_DELETE);
  return 'DELETED';
}

// ─── Main loop ─────────────────────────────────────────────────────────────

async function runLoop() {
  state.scrollStrikes = 0;

  while (state.running) {
    const result = await deleteOnePost();

    if (result === 'DELETED') {
      state.scrollStrikes = 0;
      await saveState();
      notifyProgress();
    } else {
      state.scrollStrikes++;

      if (state.scrollStrikes >= MAX_SCROLL_STRIKES) {
        // Exhausted scroll — check if we're actually at the bottom
        const atBottom = (window.innerHeight + window.scrollY) >= document.body.scrollHeight - 200;
        if (atBottom) {
          await finish();
          return;
        }
        state.scrollStrikes = 0;
      }

      window.scrollBy({ top: 1200, behavior: 'smooth' });
      await delay(DELAY_SCROLL);
    }
  }

  await saveState();
}

// ─── State persistence ─────────────────────────────────────────────────────

async function loadState() {
  return new Promise(resolve => {
    chrome.storage.local.get(STORAGE_KEY, data => {
      resolve(data[STORAGE_KEY] || { running: false, deleted: 0 });
    });
  });
}

async function saveState() {
  return new Promise(resolve => {
    chrome.storage.local.set({
      [STORAGE_KEY]: {
        running: state.running,
        deleted: state.deleted,
        lastUpdate: Date.now(),
      }
    }, resolve);
  });
}

// ─── Notifications ─────────────────────────────────────────────────────────

function notifyProgress() {
  chrome.runtime.sendMessage({
    type: 'PROGRESS',
    deleted: state.deleted,
    sessionDeleted: state.sessionDeleted,
  }).catch(() => {}); // popup might be closed — that's fine
}

async function finish() {
  state.running = false;
  await saveState();
  chrome.runtime.sendMessage({
    type: 'DONE',
    deleted: state.deleted,
  }).catch(() => {});
}

// ─── Message listener (from popup) ─────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'START') {
    if (!state.running) {
      state.running = true;
      state.deleted = msg.deleted || 0;
      state.sessionDeleted = 0;
      runLoop();
    }
    sendResponse({ ok: true, deleted: state.deleted });
    return true;
  }

  if (msg.type === 'STOP') {
    state.running = false;
    saveState();
    sendResponse({ ok: true, deleted: state.deleted });
    return true;
  }

  if (msg.type === 'STATUS') {
    sendResponse({ running: state.running, deleted: state.deleted });
    return true;
  }
});

// ─── Auto-resume on page load ───────────────────────────────────────────────

(async () => {
  const saved = await loadState();
  state.deleted = saved.deleted || 0;

  if (saved.running) {
    // Wait for page to finish rendering before starting
    await delay(3500);
    state.running = true;
    state.sessionDeleted = 0;
    runLoop();
  }
})();
