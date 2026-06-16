// FB Group Post Wiper — content script (engine v2)
// Runs inside facebook.com/groups/* pages.
//
// Strategy (see README "How it works"):
//   1. Harvest the current top of the group feed via GraphQL (read-only, fast).
//   2. Delete each post via the same GraphQL mutation Facebook's own UI fires,
//      ONE AT A TIME with human-like jitter (protects the account).
//   3. Deleting advances the feed window, so we re-harvest the new top and
//      repeat — we never need to scroll back to 2014; the feed refills from the
//      oldest remaining posts each round.
//   4. If a post resists the admin mutation (own posts / odd story types), we
//      fall back to clicking it through the real menu (DOM), exactly like a human.
//   5. Tokens (fb_dtsg) are re-read every round because Facebook rotates them.
//   6. Everything is logged to chrome.storage so a multi-day run is resumable
//      and auditable.

(() => {
'use strict';

// ─── Constants captured from Facebook's own traffic ─────────────────────────

const DOC_FEED   = '36136119256033316';                       // GroupsCometFeedRegularStoriesPaginationQuery
const NAME_FEED  = 'GroupsCometFeedRegularStoriesPaginationQuery';
const DOC_DELETE = '24487184117551286';                       // useGroupRemovePostAsAdminMutation
const NAME_DELETE = 'useGroupRemovePostAsAdminMutation';

const STORAGE_KEY = 'fbwiper';
const SKIP_KEY    = 'fbwiper_skip';   // story ids that resisted every method
const LOG_KEY     = 'fbwiper_log';    // rolling audit log

// Pacing (ms). Jittered so the cadence looks human, not robotic.
const DELETE_MIN_GAP = 2600;
const DELETE_MAX_GAP = 4200;
const ROUND_GAP      = 2500;          // pause between harvest rounds
const HARVEST_COUNT  = 30;            // posts requested per harvest
const EMPTY_ROUNDS_TO_STOP = 3;       // consecutive empty harvests => done
const MAX_BACKOFF    = 5 * 60 * 1000; // 5 min cap on rate-limit backoff

const RELAY_PROVIDERS = {
  '__relay_internal__pv__GHLShouldChangeAdIdFieldNamerelayprovider': true,
  '__relay_internal__pv__GHLShouldChangeSponsoredDataFieldNamerelayprovider': true,
  '__relay_internal__pv__CometFeedStory_enable_reactor_facepilerelayprovider': false,
  '__relay_internal__pv__CometFeedStory_enable_social_bubblesrelayprovider': false,
  '__relay_internal__pv__CometFeedStory_enable_post_permalink_white_space_clickrelayprovider': false,
  '__relay_internal__pv__CometUFICommentActionLinksRewriteEnabledrelayprovider': false,
  '__relay_internal__pv__CometUFICommentAvatarStickerAnimatedImagerelayprovider': false,
  '__relay_internal__pv__IsWorkUserrelayprovider': false,
  '__relay_internal__pv__TestPilotShouldIncludeDemoAdUseCaserelayprovider': false,
  '__relay_internal__pv__FBReels_deprecate_short_form_video_context_gkrelayprovider': true,
  '__relay_internal__pv__FBReels_enable_view_dubbed_audio_type_gkrelayprovider': true,
  '__relay_internal__pv__CometFeedShareMedia_shouldPrefetchShareImagerelayprovider': false,
  '__relay_internal__pv__CometImmersivePhotoCanUserDisable3DMotionrelayprovider': false,
  '__relay_internal__pv__WorkCometIsEmployeeGKProviderrelayprovider': false,
  '__relay_internal__pv__IsMergQAPollsrelayprovider': false,
  '__relay_internal__pv__FBReelsMediaFooter_comet_enable_reels_ads_gkrelayprovider': true,
  '__relay_internal__pv__CometUFIReactionsEnableShortNamerelayprovider': false,
  '__relay_internal__pv__CometUFICommentAutoTranslationTyperelayprovider': 'ORIGINAL',
  '__relay_internal__pv__CometUFIShareActionMigrationrelayprovider': true,
  '__relay_internal__pv__CometUFISingleLineUFIrelayprovider': false,
  '__relay_internal__pv__relay_provider_comet_ufi_ssr_seo_deferrelayprovider': true,
  '__relay_internal__pv__CometUFI_dedicated_comment_routable_dialog_gkrelayprovider': true,
  '__relay_internal__pv__ReelsIFUCard_reelsIFULikeCountrelayprovider': false,
  '__relay_internal__pv__FBReelsIFUTileContent_reelsIFUPlayOnHoverrelayprovider': true,
  '__relay_internal__pv__GroupsCometGYSJFeedItemHeightrelayprovider': 206,
  '__relay_internal__pv__ShouldEnableBakedInTextStoriesrelayprovider': false,
  '__relay_internal__pv__StoriesShouldIncludeFbNotesrelayprovider': false,
};

// ─── Runtime state ──────────────────────────────────────────────────────────

const S = {
  running: false,
  deleted: 0,
  sessionDeleted: 0,
  mutationSeq: 100,
  skip: new Set(),
  lastError: '',
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
const jitter = (min, max) => Math.floor(min + Math.random() * (max - min));

// ─── Token extraction (re-read each round — fb_dtsg rotates) ────────────────

function readTokens() {
  const scriptText = () => Array.from(document.querySelectorAll('script')).map(s => s.textContent);

  let dtsg = document.querySelector('[name="fb_dtsg"]')?.value || null;
  let lsd  = null;
  if (!dtsg || !lsd) {
    for (const t of scriptText()) {
      if (!dtsg) { const m = t.match(/"DTSGInitialData",\[\],\{"token":"([^"]+)"/); if (m) dtsg = m[1]; }
      if (!lsd)  { const m = t.match(/"LSD",\[\],\{"token":"([^"]+)"/);            if (m) lsd  = m[1]; }
      if (dtsg && lsd) break;
    }
  }

  const cuser = document.cookie.split(';').map(c => c.trim())
    .find(c => c.startsWith('c_user='))?.split('=')[1] || null;

  // Numeric group id — try several patterns, then fall back to URL slug resolve.
  let groupId = null;
  for (const t of scriptText()) {
    const m = t.match(/"groupID":"(\d+)"/) || t.match(/"group_id":"(\d+)"/)
           || t.match(/\\"group_id\\":\\"(\d+)\\"/) || t.match(/"GroupCometID","(\d+)"/);
    if (m) { groupId = m[1]; break; }
  }

  return { dtsg, lsd, cuser, groupId };
}

// ─── GraphQL POST (uses the page's own session/cookies) ─────────────────────

async function graphql(apiName, docId, variables, tok) {
  const body = new URLSearchParams({
    av: tok.cuser, __user: tok.cuser, __a: '1',
    fb_dtsg: tok.dtsg, lsd: tok.lsd,
    fb_api_caller_class: 'RelayModern',
    fb_api_req_friendly_name: apiName,
    variables: JSON.stringify(variables),
    server_timestamps: 'true',
    doc_id: docId,
  }).toString();

  const res = await fetch('/api/graphql/', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-fb-friendly-name': apiName,
      'x-fb-lsd': tok.lsd,
    },
    body,
    credentials: 'include',
  });

  const text = await res.text();
  // FB sometimes prefixes "for (;;);" anti-JSON-hijack guard.
  const clean = text.replace(/^for \(;;\);/, '').split('\n')[0];
  return JSON.parse(clean);
}

// ─── Story-id helpers ────────────────────────────────────────────────────────
// A real post's feed node id base64-decodes to "S:_I{authorId}:VK:{postId}".

function decodeStory(nodeId) {
  if (!nodeId || typeof nodeId !== 'string') return null;
  let decoded;
  try { decoded = atob(nodeId); } catch { return null; }
  const m = decoded.match(/:_[A-Za-z]?(\d+):VK:(\d+)/) || decoded.match(/(\d{6,}):VK:(\d{6,})/);
  if (!m) return null;
  return { storyId: nodeId, authorId: m[1], postId: m[2] };
}

const NON_POST_UNIT = /(SectionHeader|Recommendation|PeopleYouMayKnow|Pymk|Suggested|Ad$|AdUnit|Survey|Bloks|Notif)/i;

// ─── Harvest: read the current top of the feed, return deletable posts ───────

async function harvest(tok) {
  const variables = {
    count: HARVEST_COUNT,
    feedLocation: 'GROUP', feedType: 'DISCUSSION', feedbackSource: 0,
    filterTopicId: null, focusCommentID: null,
    privacySelectorRenderLocation: 'COMET_STREAM', referringStoryRenderLocation: null,
    renderLocation: 'group', scale: 1, sortingSetting: 'CHRONOLOGICAL',
    stream_initial_count: 1, useDefaultActor: false, id: tok.groupId,
    ...RELAY_PROVIDERS,
  };

  let resp;
  try {
    resp = await graphql(NAME_FEED, DOC_FEED, variables, tok);
  } catch (e) {
    // Some groups reject CHRONOLOGICAL — retry with the default sort once.
    variables.sortingSetting = 'TOP_POSTS';
    resp = await graphql(NAME_FEED, DOC_FEED, variables, tok);
  }

  if (resp.errors) { S.lastError = 'feed: ' + (resp.errors[0]?.message || 'error'); }

  const feed = resp?.data?.node?.group_feed;
  const edges = feed?.edges || [];

  const posts = [];
  for (const e of edges) {
    const n = e?.node;
    if (!n) continue;
    if (NON_POST_UNIT.test(n.__typename || '')) continue;

    // Primary: decode the node id.
    let info = decodeStory(n.id);

    // Fallback: some units wrap the real story one level down.
    if (!info && n.comet_sections) {
      const buried = findEncodedId(n);
      if (buried) info = decodeStory(buried);
    }

    if (info && !S.skip.has(info.storyId)) posts.push(info);
  }
  return posts;
}

// Depth-limited search for a base64 story id anywhere in a node subtree.
function findEncodedId(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 5) return null;
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'id' && typeof v === 'string' && decodeStory(v)) return v;
    if (v && typeof v === 'object') {
      const r = findEncodedId(v, depth + 1);
      if (r) return r;
    }
  }
  return null;
}

// ─── Delete one post via the admin-remove GraphQL mutation ──────────────────

async function deleteViaGraphQL(post, tok) {
  S.mutationSeq += 1;
  const variables = {
    input: {
      actor_id: tok.cuser,
      client_mutation_id: String(S.mutationSeq),
      admin_notes: '',
      group_id: tok.groupId,
      selected_rules: [],
      send_warning: false,
      share_feedback: false,
      source: 'group_mall',
      story_id: post.storyId,
    },
    profileID: post.authorId,
  };

  let resp;
  try {
    resp = await graphql(NAME_DELETE, DOC_DELETE, variables, tok);
  } catch (e) {
    S.lastError = 'del-net: ' + e.message;
    return { ok: false, rateLimited: /1357054|limit|temporar/i.test(e.message) };
  }

  if (resp.errors && resp.errors.length) {
    const msg = resp.errors[0]?.message || JSON.stringify(resp.errors[0] || {});
    S.lastError = 'del: ' + msg.slice(0, 80);
    return { ok: false, rateLimited: /1357054|temporar|too many|rate/i.test(msg) };
  }

  // A successful admin-remove returns a mutation payload (not strictly checked —
  // absence of errors + HTTP 200 is FB's success signal here).
  return { ok: true };
}

// ─── DOM fallback: delete the first visible post like a human would ─────────
// Used when GraphQL rejects a post type. Uses POLLING (waitFor) instead of
// fixed sleeps — this is what fixes the original "skips because menu wasn't
// ready yet" bug.

function waitFor(fn, timeout = 6000, step = 200) {
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

async function deleteViaDOM() {
  const menuBtn = document.querySelector('[aria-label^="Actions for this post"]:not([data-wiper-tried])');
  if (!menuBtn) return { ok: false, exhausted: true };

  menuBtn.setAttribute('data-wiper-tried', '1');
  menuBtn.scrollIntoView({ block: 'center' });
  menuBtn.click();

  // Wait until the menu actually renders its items.
  const removeItem = await waitFor(() => {
    const items = Array.from(document.querySelectorAll('[role=menuitem]'));
    return items.find(m =>
      /Remove post|Delete post|إزالة المنشور|حذف المنشور/.test(m.textContent)
    ) || null;
  });

  if (!removeItem) {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return { ok: false };
  }

  removeItem.click();

  // Wait for the confirm dialog.
  const confirmBtn = await waitFor(() => {
    const btns = Array.from(document.querySelectorAll('[role=dialog] [role=button], [role=dialog] button'));
    return btns.find(b => /^(Confirm|تأكيد)$/.test(b.textContent.trim())) || null;
  });

  if (!confirmBtn) {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return { ok: false };
  }

  confirmBtn.click();

  // Wait until the dialog closes (= deletion accepted).
  const closed = await waitFor(() => !document.querySelector('[role=dialog]') ? true : null, 6000);
  return { ok: !!closed };
}

// ─── Persistence + logging ──────────────────────────────────────────────────

function save() {
  return new Promise(res => {
    chrome.storage.local.set({
      [STORAGE_KEY]: { running: S.running, deleted: S.deleted, lastUpdate: Date.now(), lastError: S.lastError },
      [SKIP_KEY]: Array.from(S.skip),
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

function notify(type, extra = {}) {
  chrome.runtime.sendMessage({ type, deleted: S.deleted, sessionDeleted: S.sessionDeleted, lastError: S.lastError, ...extra }).catch(() => {});
}

// ─── Main loop ───────────────────────────────────────────────────────────────

async function mainLoop() {
  let emptyRounds = 0;          // consecutive harvests that yielded nothing
  let backoff = 0;             // rate-limit backoff (ms)
  let consecutiveFail = 0;     // consecutive delete failures (token-staleness signal)
  let deletedSinceReload = 0;  // periodic reload counter (refreshes fb_dtsg)
  let tokenMisses = 0;

  S.running = true;
  await save();                // persist running:true so a reload auto-resumes
  logLine(`▶ started (already deleted ${S.deleted})`);
  notify('PROGRESS');

  // Reload helper — saves first so auto-resume continues after navigation.
  async function reloadToRefresh(reason) {
    logLine(`↻ reload (${reason})`);
    await save();
    await sleep(800);
    location.reload();
  }

  while (S.running) {
    const tok = readTokens();
    if (!tok.dtsg || !tok.cuser || !tok.groupId) {
      tokenMisses++;
      S.lastError = 'Reading page… (reload the group if this persists)';
      logLine(`✗ missing tokens (${tokenMisses})`);
      notify('PROGRESS');
      if (tokenMisses >= 4) { await reloadToRefresh('token read failed'); return; }
      await sleep(6000);
      continue;
    }
    tokenMisses = 0;

    // 1) Harvest current top of feed (GraphQL, authoritative).
    let posts = [];
    try {
      posts = await harvest(tok);
    } catch (e) {
      S.lastError = 'harvest: ' + e.message;
      logLine('✗ harvest failed: ' + e.message.slice(0, 60));
      consecutiveFail++;
      if (consecutiveFail >= 5) { await reloadToRefresh('harvest errors'); return; }
      await sleep(6000);
      continue;
    }

    if (posts.length === 0) {
      // GraphQL sees nothing deletable. Give the DOM one chance — a post type
      // GraphQL can't parse might still be visible and clickable.
      const domResult = await deleteViaDOM();
      if (domResult.ok) {
        S.deleted++; S.sessionDeleted++; deletedSinceReload++;
        emptyRounds = 0; consecutiveFail = 0;
        logLine(`🗑 dom-deleted (total ${S.deleted})`);
        await save(); notify('PROGRESS');
        await sleep(jitter(DELETE_MIN_GAP, DELETE_MAX_GAP));
        continue;
      }

      emptyRounds++;
      logLine(`· empty ${emptyRounds}/${EMPTY_ROUNDS_TO_STOP}`);
      if (emptyRounds >= EMPTY_ROUNDS_TO_STOP) break;  // genuinely clear → done
      // NB: do NOT reload here — GraphQL harvest already queried the server,
      // so a reload would return the same empty result and could loop forever.
      await sleep(ROUND_GAP);
      continue;
    }

    emptyRounds = 0;

    // 2) Delete each harvested post — serially, with human-like jitter.
    let rateLimitHit = false;
    for (const post of posts) {
      if (!S.running) break;

      const r = await deleteViaGraphQL(post, tok);

      if (r.ok) {
        S.deleted++; S.sessionDeleted++; deletedSinceReload++;
        consecutiveFail = 0; backoff = 0;
        logLine(`🗑 ${post.postId} (total ${S.deleted})`);
        await save(); notify('PROGRESS');
        await sleep(jitter(DELETE_MIN_GAP, DELETE_MAX_GAP));
        continue;
      }

      if (r.rateLimited) {
        backoff = Math.min(backoff ? backoff * 2 : 30000, MAX_BACKOFF);
        S.lastError = `Rate limited — pausing ${Math.round(backoff / 1000)}s`;
        logLine(`⏳ rate limited, backoff ${Math.round(backoff / 1000)}s`);
        notify('PROGRESS');
        await sleep(backoff);
        rateLimitHit = true;
        break; // re-harvest with a fresh token after backoff
      }

      // GraphQL refused this specific post — try the DOM path once.
      const dom = await deleteViaDOM();
      if (dom.ok) {
        S.deleted++; S.sessionDeleted++; deletedSinceReload++;
        consecutiveFail = 0;
        logLine(`🗑 ${post.postId} via dom (total ${S.deleted})`);
        await save(); notify('PROGRESS');
        await sleep(jitter(DELETE_MIN_GAP, DELETE_MAX_GAP));
      } else {
        consecutiveFail++;
        S.skip.add(post.storyId);
        logLine(`⚠ skipped ${post.postId} (${S.lastError})`);
        await save();
        // A burst of failures usually means a stale fb_dtsg — refresh it.
        if (consecutiveFail >= 5) { await reloadToRefresh('delete failures'); return; }
      }
    }

    // Periodically reload to refresh fb_dtsg on long (multi-day) runs.
    if (!rateLimitHit && deletedSinceReload >= 120) {
      await reloadToRefresh('token refresh');
      return;
    }

    await sleep(ROUND_GAP);
  }

  S.running = false;
  await save();

  if (emptyRounds >= EMPTY_ROUNDS_TO_STOP) {
    logLine(`✓ done — feed clear. Total ${S.deleted}` + (S.skip.size ? `, ${S.skip.size} skipped` : ''));
    notify('DONE');
  } else {
    logLine(`⏸ paused at ${S.deleted}`);
    notify('PROGRESS');
  }
}

// ─── Message handlers (from popup) ──────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'START') {
    if (!S.running) {
      S.running = true;
      S.deleted = msg.deleted || S.deleted || 0;
      S.sessionDeleted = 0;
      S.lastError = '';
      mainLoop();
    }
    sendResponse({ ok: true, deleted: S.deleted });
    return true;
  }
  if (msg.type === 'STOP') {
    S.running = false;
    save();
    sendResponse({ ok: true, deleted: S.deleted });
    return true;
  }
  if (msg.type === 'STATUS') {
    sendResponse({ running: S.running, deleted: S.deleted, lastError: S.lastError });
    return true;
  }
});

// ─── Auto-resume after a reload / browser restart ───────────────────────────

(async () => {
  const data = await new Promise(res => chrome.storage.local.get([STORAGE_KEY, SKIP_KEY], res));
  const saved = data[STORAGE_KEY] || {};
  S.deleted = saved.deleted || 0;
  S.skip = new Set(data[SKIP_KEY] || []);

  if (saved.running) {
    await sleep(4000); // let the feed render first
    S.running = true;
    S.sessionDeleted = 0;
    mainLoop();
  }
})();

})();
