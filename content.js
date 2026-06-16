// Group Post Wiper — content script (DOM engine)
// Runs inside facebook.com/groups/* pages.
//
// Why DOM and not the private GraphQL API:
//   • The group feed's posts are delivered by Facebook's route/SSR query, which a
//     standalone pagination call can't reproduce — so a "just ask GraphQL for the
//     posts" harvester returns an empty feed. Facebook reliably *renders* the posts,
//     though, so the DOM is the dependable source of truth.
//   • Deleting through the real post menu uses the same affordance a human does. It
//     works for every post type and for both your own posts ("Delete post") and
//     other members' posts ("Remove post"), and it doesn't depend on internal
//     doc_ids that Facebook rotates — so it keeps working over time.
//
// Strategy (proven on a 7.9k-member group with a decade of history):
//   1. Delete the top visible post via its menu, with polling (no fixed-timing races).
//   2. When nothing is left in view, scroll to load more.
//   3. When a whole pass deletes nothing, reload the page — Facebook re-renders the
//      feed from the server, surfacing the next-oldest posts. Repeat.
//   4. After a couple of consecutive empty passes, the group is clear → done.
//   Progress + the empty-pass counter are persisted, so multi-day runs resume
//   cleanly across reloads and browser restarts.

(() => {
'use strict';

// ─── Storage keys ────────────────────────────────────────────────────────────
const STORAGE_KEY = 'fbwiper';
const LOG_KEY     = 'fbwiper_log';
const SPEED_KEY   = 'fbwiper_speed';

// ─── Tunables ────────────────────────────────────────────────────────────────
const SPEED_PROFILES = {           // gap between deletes (ms), jittered → human cadence
  safe:     { min: 4200, max: 6800 },
  balanced: { min: 2600, max: 4200 },
  fast:     { min: 1200, max: 2300 },
};
const MAX_SCROLL_STRIKES   = 10;   // consecutive scrolls with NO new content before a pass ends
const MAX_SCROLLS_PER_PASS = 22;   // hard cap so a pass always ends and RELOADS (reload = "find more")
const EMPTY_PASSES_TO_STOP = 5;    // consecutive deep-scrolled+reloaded empty passes ⇒ truly clear
const STUCK_PASSES_LIMIT   = 6;    // zero-delete-but-failing passes before pausing for the user
const SCROLL_GAP           = 2600; // ms to wait after a scroll for lazy content
const MENU_TIMEOUT         = 7000; // ms to wait for menu / dialog to appear
const POST_RELOAD_SETTLE   = 4000; // ms to let the feed render after a reload
const FAIL_BACKOFF_STEP    = 2500; // ms added to the gap per consecutive failure (rate-limit)
const FAIL_BACKOFF_MAX     = 30000;// cap on the adaptive backoff

// ─── Runtime state ──────────────────────────────────────────────────────────
const S = {
  running: false,
  done: false,
  deleted: 0,
  emptyPasses: 0,    // consecutive passes that found nothing removable
  stuckPasses: 0,    // consecutive passes that deleted 0 but hit failures (rate-limit)
  passDeleted: 0,
  passFailures: 0,
  failBackoff: 0,    // adaptive extra delay while Facebook is pushing back
  lastError: '',
  gapMin: SPEED_PROFILES.balanced.min,
  gapMax: SPEED_PROFILES.balanced.max,
};

const sleep  = ms => new Promise(r => setTimeout(r, ms));
const jitter = (a, b) => Math.floor(a + Math.random() * (b - a));

function applySpeed(profile) {
  const p = SPEED_PROFILES[profile] || SPEED_PROFILES.balanced;
  S.gapMin = p.min; S.gapMax = p.max;
}

// Poll a predicate until it returns truthy or the timeout elapses.
function waitFor(fn, timeout = MENU_TIMEOUT, step = 180) {
  return new Promise(resolve => {
    const t0 = Date.now();
    const tick = () => {
      let v = null;
      try { v = fn(); } catch { /* ignore */ }
      if (v) return resolve(v);
      if (Date.now() - t0 >= timeout) return resolve(null);
      setTimeout(tick, step);
    };
    tick();
  });
}

// ─── Persistence + logging ───────────────────────────────────────────────────
function save() {
  return new Promise(res => {
    chrome.storage.local.set({
      [STORAGE_KEY]: {
        running: S.running, done: S.done, deleted: S.deleted,
        emptyPasses: S.emptyPasses, stuckPasses: S.stuckPasses,
        lastUpdate: Date.now(), lastError: S.lastError,
      },
    }, res);
  });
}

function logLine(text) {
  chrome.storage.local.get(LOG_KEY, data => {
    const log = data[LOG_KEY] || [];
    log.push(`${new Date().toISOString().slice(11, 19)}  ${text}`);
    while (log.length > 200) log.shift();
    chrome.storage.local.set({ [LOG_KEY]: log });
  });
}

function notify(type) {
  chrome.runtime.sendMessage({ type, deleted: S.deleted, lastError: S.lastError }).catch(() => {});
}

// ─── Delete one post through its menu (polling, no fixed-timing races) ────────
// Returns true only if the confirm dialog actually closed (= deletion accepted).
function closeMenus() {
  document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  document.body.dispatchEvent(new KeyboardEvent('keyup',   { key: 'Escape', bubbles: true }));
}

const REMOVE_RE = /Remove post|Delete post|إزالة المنشور|حذف المنشور/;

// Open the post menu and wait for it to render. We first wait for the menu to
// appear at all, then keep polling for the Remove/Delete item — Facebook renders
// menu items progressively, so reading too early makes real posts look like
// undeletable system posts. A single click only (re-clicking toggles it shut).
async function openMenuFindRemove(btn) {
  btn.click();

  // 1) wait for the menu to open at all
  const opened = await waitFor(() =>
    document.querySelectorAll('[role=menuitem]').length ? true : null, 5000);
  if (!opened) return { item: null, menuOpened: false };

  // 2) wait for the Remove/Delete item specifically (it can render late)
  const item = await waitFor(() => {
    const items = Array.from(document.querySelectorAll('[role=menuitem]'));
    return items.find(m => REMOVE_RE.test(m.textContent)) || null;
  }, 6000);

  return { item: item || null, menuOpened: true };
}

async function deleteTopPost() {
  const btn = document.querySelector('[aria-label^="Actions for this post"]:not([data-wiper-tried])');
  if (!btn) return { ok: false, none: true };

  btn.setAttribute('data-wiper-tried', '1');     // don't re-pick this node within the pass

  const { item: removeItem, menuOpened } = await openMenuFindRemove(btn);

  if (!removeItem) {
    closeMenus();
    // Menu opened but has no remove/delete option → a system post (group
    // created, renamed, members joined, pinned announcement). Skip it.
    return { ok: false, reason: menuOpened ? 'system-post' : 'menu-did-not-open' };
  }

  removeItem.click();

  // Wait for the confirm dialog, then click its confirm button.
  const confirmBtn = await waitFor(() => {
    const dlg = document.querySelector('[role=dialog]');
    if (!dlg) return null;
    const btns = Array.from(dlg.querySelectorAll('[role=button], button'));
    return btns.find(b => /^(Confirm|Delete|Remove|تأكيد|حذف|إزالة)$/.test(b.textContent.trim())) || null;
  }, 6000);

  if (!confirmBtn) { closeMenus(); return { ok: false, reason: 'no-confirm' }; }
  confirmBtn.click();

  // Deletion is accepted once the dialog closes.
  const closed = await waitFor(() => document.querySelector('[role=dialog]') ? null : true, 8000);
  if (!closed) { closeMenus(); return { ok: false, reason: 'dialog-stayed-open' }; }
  return { ok: true };
}

// ─── One pass = delete everything renderable on this page load ────────────────
async function runPass() {
  S.passDeleted = 0;
  S.passFailures = 0;
  let scrollStrikes = 0;
  let totalScrolls = 0;
  let consecutiveFails = 0;

  while (S.running) {
    const res = await deleteTopPost();

    if (res.ok) {
      S.deleted++; S.passDeleted++;
      consecutiveFails = 0; scrollStrikes = 0;
      S.failBackoff = Math.max(0, S.failBackoff - FAIL_BACKOFF_STEP); // recover speed
      S.lastError = '';
      logLine(`🗑 deleted (total ${S.deleted})`);
      await save(); notify('PROGRESS');
      await sleep(jitter(S.gapMin, S.gapMax) + S.failBackoff);
      continue;
    }

    if (res.none) {
      // Nothing untried in view — scroll to pull in more (older) posts. Keep
      // going as long as the page is still growing or new posts appear; only
      // count a "strike" when a scroll loads nothing new. This drains the whole
      // feed depth before a pass concludes it's empty.
      const beforeH = document.documentElement.scrollHeight;
      const beforeN = document.querySelectorAll('[aria-label^="Actions for this post"]:not([data-wiper-tried])').length;

      window.scrollTo(0, document.documentElement.scrollHeight);
      await sleep(SCROLL_GAP);
      // a nudge back up then down helps Facebook trigger the next page
      window.scrollBy(0, -200); await sleep(300);
      window.scrollTo(0, document.documentElement.scrollHeight); await sleep(400);

      const afterH = document.documentElement.scrollHeight;
      const afterN = document.querySelectorAll('[aria-label^="Actions for this post"]:not([data-wiper-tried])').length;

      totalScrolls++;
      if (afterN > beforeN) {
        scrollStrikes = 0;            // a real new post appeared — keep pulling
      } else if (afterH > beforeH + 80) {
        scrollStrikes = 0;            // page grew (maybe just comments) — keep pulling a bit
      } else {
        scrollStrikes++;
      }
      // End the pass when the feed depth is exhausted OR we've scrolled a lot —
      // either way reload to let Facebook re-render the next batch from the top.
      if (scrollStrikes > MAX_SCROLL_STRIKES || totalScrolls >= MAX_SCROLLS_PER_PASS) break;
      continue;
    }

    // 'system-post' = no Remove/Delete option (created group / renamed / joined
    // / pinned announcement). It genuinely can't be deleted — skip quietly and
    // count it as progress, NOT as a failure.
    if (res.reason === 'system-post') {
      logLine('· skipped a system post (not deletable)');
      scrollStrikes = 0;
      await sleep(500);
      continue;
    }

    // Any other reason (menu-did-not-open / no-confirm / dialog-stayed-open) is
    // a TRANSIENT miss — almost always Facebook rate-limiting after many fast
    // deletes. The post is still there, so this must NOT be read as "clear".
    // Slow down (adaptive backoff) and move on; the post is retried next pass.
    S.passFailures++;
    consecutiveFails++;
    S.failBackoff = Math.min(S.failBackoff + FAIL_BACKOFF_STEP, FAIL_BACKOFF_MAX);
    S.lastError = 'Facebook is slowing deletions — backing off';
    logLine(`⚠ could not remove a post [${res.reason || '?'}] — slowing down`);
    if (consecutiveFails >= 8) break;     // end pass; mainLoop reloads + cools down
    await sleep(1500 + S.failBackoff);
  }
}

// ─── Main controller: passes + reloads until the feed is genuinely clear ──────
async function mainLoop() {
  S.running = true;
  S.done = false;
  await save();
  notify('PROGRESS');

  await runPass();

  if (!S.running) {                      // paused mid-pass by the user
    await save();
    logLine(`⏸ paused at ${S.deleted}`);
    notify('PROGRESS');
    return;
  }

  // ── Decide what this pass means ──
  if (S.passDeleted > 0) {
    // Real progress → keep going.
    S.emptyPasses = 0;
    S.stuckPasses = 0;
    logLine(`— pass: removed ${S.passDeleted}, continuing`);
  } else if (S.passFailures > 0) {
    // Deleted nothing, but posts ARE there and kept failing (rate-limit). The
    // feed is NOT clear — cool down and retry. Bail out only after many such
    // passes so we never loop forever on a permanently-stuck post.
    S.emptyPasses = 0;
    S.stuckPasses++;
    logLine(`— pass: 0 removed but ${S.passFailures} blocked (rate-limit ${S.stuckPasses}/${STUCK_PASSES_LIMIT})`);
    if (S.stuckPasses >= STUCK_PASSES_LIMIT) {
      S.running = false;
      S.done = false;
      S.lastError = 'Facebook is rate-limiting. Some posts remain — press Start later to resume.';
      await save();
      logLine('⏸ paused — Facebook is rate-limiting. Wait a while, then press Start to resume.');
      notify('PROGRESS');
      return;
    }
  } else {
    // Nothing removable at all (only system posts / empty feed).
    S.emptyPasses++;
    logLine(`— pass: nothing removable (empty streak ${S.emptyPasses}/${EMPTY_PASSES_TO_STOP})`);
    if (S.emptyPasses >= EMPTY_PASSES_TO_STOP) {
      S.running = false;
      S.done = true;
      await save();
      logLine(`✓ done — feed clear. Total removed: ${S.deleted}`);
      notify('DONE');
      return;
    }
  }

  // Cool-down grows while rate-limited so Facebook can recover before we reload.
  const cooldown = 700 + S.stuckPasses * 15000;
  await save();
  logLine(S.stuckPasses > 0 ? `↻ cooling down ${Math.round(cooldown/1000)}s, then retrying` : '↻ reloading for next pass');
  await sleep(cooldown);
  location.reload();
}

// ─── Messages from the popup ──────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
  if (msg.type === 'START') {
    if (msg.speed) applySpeed(msg.speed);
    if (!S.running) {
      if (typeof msg.deleted === 'number') S.deleted = msg.deleted;
      S.emptyPasses = 0;          // a fresh Start re-verifies the whole feed
      S.stuckPasses = 0;          // and resets any prior rate-limit cooldown
      S.failBackoff = 0;
      S.lastError = '';
      S.done = false;
      mainLoop();
    }
    sendResponse({ ok: true, deleted: S.deleted });
    return true;
  }
  if (msg.type === 'SPEED')  { applySpeed(msg.speed); sendResponse({ ok: true }); return true; }
  if (msg.type === 'STOP')   { S.running = false; save(); sendResponse({ ok: true, deleted: S.deleted }); return true; }
  if (msg.type === 'STATUS') { sendResponse({ running: S.running, deleted: S.deleted, lastError: S.lastError }); return true; }
});

// ─── Auto-resume after a reload / browser restart ─────────────────────────────
(async () => {
  const data = await new Promise(res => chrome.storage.local.get([STORAGE_KEY, SPEED_KEY], res));
  const saved = data[STORAGE_KEY] || {};
  S.deleted     = saved.deleted     || 0;
  S.emptyPasses = saved.emptyPasses || 0;
  S.stuckPasses = saved.stuckPasses || 0;
  applySpeed(data[SPEED_KEY] || 'balanced');

  if (saved.running) {
    await sleep(POST_RELOAD_SETTLE);   // let the feed render first
    mainLoop();
  }
})();

})();
