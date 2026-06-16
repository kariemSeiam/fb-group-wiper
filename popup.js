'use strict';

const STORAGE_KEY = 'fbwiper';
const SPEED_KEY   = 'fbwiper_speed';
const LOG_KEY     = 'fbwiper_log';

const $ = id => document.getElementById(id);

const SPEED_NOTES = {
  safe:     { note: 'Gentlest pace — safest for an account you care about.', warn: false },
  balanced: { note: 'Steady pace — recommended for most groups.',           warn: false },
  fast:     { note: '⚠ Faster, but higher chance Facebook makes it slow down.', warn: true },
};

let currentSpeed = 'balanced';
let logOpen = false;
let displayed = 0;   // for count-up animation

// ── version from manifest ──
try { $('ver').textContent = 'v' + chrome.runtime.getManifest().version.split('.').slice(0,2).join('.'); } catch {}

// ─────────────────────────────────────────────────────────────────────────────
// Tab helpers
// ─────────────────────────────────────────────────────────────────────────────

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}
function isGroupPage(tab) {
  return tab && tab.url && /^https:\/\/www\.facebook\.com\/groups\/[^/]+/.test(tab.url);
}
function send(tab, msg) { return chrome.tabs.sendMessage(tab.id, msg); }

// ─────────────────────────────────────────────────────────────────────────────
// Counter animation
// ─────────────────────────────────────────────────────────────────────────────

function animateTo(target) {
  target = Number(target) || 0;
  if (target === displayed) { $('counter').textContent = target.toLocaleString(); return; }
  const step = Math.max(1, Math.ceil(Math.abs(target - displayed) / 12));
  const tick = () => {
    if (displayed < target) displayed = Math.min(target, displayed + step);
    else if (displayed > target) displayed = Math.max(target, displayed - step);
    $('counter').textContent = displayed.toLocaleString();
    if (displayed !== target) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// ─────────────────────────────────────────────────────────────────────────────
// State rendering
// ─────────────────────────────────────────────────────────────────────────────

function setStatus(cls, text) {
  const el = $('status');
  el.className = 'status' + (cls ? ' ' + cls : '');
  $('statusText').textContent = text;
}

function render(state, onGroup) {
  const deleted = Number(state.deleted || 0);
  animateTo(deleted);

  if (state.running) {
    $('counter').className = 'counter';
    $('startBtn').classList.add('hidden');
    $('stopBtn').classList.remove('hidden');
    setStatus('run', state.lastError ? state.lastError : 'Deleting…');
    $('note').classList.add('hidden');
    return;
  }

  // not running
  $('stopBtn').classList.add('hidden');
  $('startBtn').classList.remove('hidden');

  if (state.done) {
    $('counter').className = 'counter done';
    setStatus('done', 'Feed is clear');
    $('note').classList.add('hidden');
  } else if (deleted > 0) {
    $('counter').className = 'counter';
    setStatus('', 'Paused · ' + deleted.toLocaleString() + ' done');
    $('note').classList.add('hidden');
  } else {
    $('counter').className = 'counter idle';
    setStatus('', onGroup ? 'Ready' : 'Open a group page');
    $('note').classList.toggle('hidden', !!onGroup);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Speed selector
// ─────────────────────────────────────────────────────────────────────────────

function paintSpeed(speed) {
  currentSpeed = speed;
  document.querySelectorAll('#seg button').forEach(b =>
    b.classList.toggle('on', b.dataset.speed === speed));
  const info = SPEED_NOTES[speed] || SPEED_NOTES.balanced;
  $('segNote').textContent = info.note;
  $('segNote').classList.toggle('warn', info.warn);
}

document.querySelectorAll('#seg button').forEach(btn => {
  btn.addEventListener('click', async () => {
    const speed = btn.dataset.speed;
    paintSpeed(speed);
    await chrome.storage.local.set({ [SPEED_KEY]: speed });
    // apply live if running
    const tab = await getActiveTab();
    if (isGroupPage(tab)) { try { await send(tab, { type: 'SPEED', speed }); } catch {} }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Actions
// ─────────────────────────────────────────────────────────────────────────────

$('startBtn').addEventListener('click', async () => {
  const tab = await getActiveTab();
  if (!isGroupPage(tab)) { setStatus('warn', 'Go to a Facebook group first'); return; }

  const saved = await chrome.storage.local.get(STORAGE_KEY);
  const prev = saved[STORAGE_KEY] || {};
  try {
    await send(tab, { type: 'START', deleted: prev.deleted || 0, speed: currentSpeed });
    await chrome.storage.local.set({ [STORAGE_KEY]: { ...prev, running: true, done: false } });
    render({ ...prev, running: true }, true);
  } catch {
    setStatus('warn', 'Reload the group page, then Start');
  }
});

$('stopBtn').addEventListener('click', async () => {
  const tab = await getActiveTab();
  try { await send(tab, { type: 'STOP' }); } catch {}
  const saved = await chrome.storage.local.get(STORAGE_KEY);
  const data = saved[STORAGE_KEY] || {};
  await chrome.storage.local.set({ [STORAGE_KEY]: { ...data, running: false } });
  render({ ...data, running: false }, isGroupPage(tab));
});

$('reset').addEventListener('click', async (e) => {
  e.preventDefault();
  await chrome.storage.local.set({ [STORAGE_KEY]: { running: false, deleted: 0, done: false, emptyPasses: 0, stuckPasses: 0 } });
  await chrome.storage.local.remove([LOG_KEY, 'fbwiper_skip']);
  displayed = 0;
  $('log').textContent = '(nothing yet)';
  const tab = await getActiveTab();
  render({ deleted: 0, running: false }, isGroupPage(tab));
});

// ─────────────────────────────────────────────────────────────────────────────
// Activity log
// ─────────────────────────────────────────────────────────────────────────────

$('logBar').addEventListener('click', async () => {
  logOpen = !logOpen;
  $('log').classList.toggle('hidden', !logOpen);
  $('logBar').classList.toggle('open', logOpen);
  if (logOpen) await refreshLog();
});

async function refreshLog() {
  const d = await chrome.storage.local.get(LOG_KEY);
  const lines = d[LOG_KEY] || [];
  $('log').textContent = lines.length ? lines.slice(-80).join('\n') : '(nothing yet)';
  $('log').scrollTop = $('log').scrollHeight;
}

// ─────────────────────────────────────────────────────────────────────────────
// Init + live polling
// ─────────────────────────────────────────────────────────────────────────────

async function init() {
  const d = await chrome.storage.local.get([STORAGE_KEY, SPEED_KEY]);
  paintSpeed(d[SPEED_KEY] || 'balanced');
  const state = d[STORAGE_KEY] || { running: false, deleted: 0 };
  displayed = Number(state.deleted || 0);
  const tab = await getActiveTab();
  render(state, isGroupPage(tab));
}

init();

setInterval(async () => {
  const d = await chrome.storage.local.get(STORAGE_KEY);
  const state = d[STORAGE_KEY] || {};
  const tab = await getActiveTab();
  render(state, isGroupPage(tab));
  if (logOpen) refreshLog();
}, 1200);
