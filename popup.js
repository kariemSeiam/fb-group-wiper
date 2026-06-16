const STORAGE_KEY = 'fbwiper';

const $ = id => document.getElementById(id);

// ─── UI helpers ─────────────────────────────────────────────────────────────

function setRunning(deleted) {
  $('counter').textContent  = Number(deleted || 0).toLocaleString();
  $('counter').className    = 'counter';
  $('dot').className        = 'dot active';
  $('status').textContent   = 'Deleting posts…';
  $('status').className     = 'status running';
  $('startBtn').classList.add('hidden');
  $('stopBtn').classList.remove('hidden');
  $('resetBtn').classList.add('hidden');
  $('note').textContent     = 'Keep the Facebook tab open. You can minimize it.';
}

function setStopped(deleted) {
  const count = Number(deleted || 0);
  $('counter').textContent  = count.toLocaleString();
  $('counter').className    = 'counter' + (count > 0 ? ' done' : '');
  $('dot').className        = 'dot';
  $('status').textContent   = count > 0 ? 'Paused — click Start to continue' : 'Ready';
  $('status').className     = 'status';
  $('startBtn').classList.remove('hidden');
  $('stopBtn').classList.add('hidden');
  $('resetBtn').classList.toggle('hidden', count === 0);
  $('note').textContent     = count > 0
    ? 'Progress saved. Will resume where it left off.'
    : 'You must be on a facebook.com/groups/… page and be an admin.';
}

function setDone(deleted) {
  const count = Number(deleted || 0);
  $('counter').textContent  = count.toLocaleString();
  $('counter').className    = 'counter done';
  $('dot').className        = 'dot';
  $('status').textContent   = 'Feed is clear!';
  $('status').className     = 'status done';
  $('startBtn').classList.remove('hidden');
  $('stopBtn').classList.add('hidden');
  $('resetBtn').classList.remove('hidden');
}

function setWarn(msg) {
  $('status').textContent = msg;
  $('status').className   = 'status warn';
}

// ─── Tab helpers ────────────────────────────────────────────────────────────

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function isGroupPage(tab) {
  return tab && tab.url && /facebook\.com\/groups\/[^/]+/.test(tab.url);
}

async function sendToContent(tab, msg) {
  return chrome.tabs.sendMessage(tab.id, msg);
}

// ─── Init ───────────────────────────────────────────────────────────────────

async function init() {
  const saved = await chrome.storage.local.get(STORAGE_KEY);
  const data  = saved[STORAGE_KEY] || { running: false, deleted: 0 };

  if (data.running) {
    setRunning(data.deleted);
  } else {
    setStopped(data.deleted);
  }
}

// ─── Start ──────────────────────────────────────────────────────────────────

$('startBtn').addEventListener('click', async () => {
  const tab = await getActiveTab();

  if (!isGroupPage(tab)) {
    setWarn('⚠️  Go to a Facebook group first');
    return;
  }

  const saved = await chrome.storage.local.get(STORAGE_KEY);
  const prev  = saved[STORAGE_KEY] || {};

  try {
    await sendToContent(tab, { type: 'START', deleted: prev.deleted || 0 });
    await chrome.storage.local.set({ [STORAGE_KEY]: { ...prev, running: true } });
    setRunning(prev.deleted || 0);
  } catch (e) {
    setWarn('⚠️  Reload the Facebook page, then try again');
  }
});

// ─── Stop ───────────────────────────────────────────────────────────────────

$('stopBtn').addEventListener('click', async () => {
  const tab = await getActiveTab();
  try { await sendToContent(tab, { type: 'STOP' }); } catch (_) {}

  const saved = await chrome.storage.local.get(STORAGE_KEY);
  const data  = saved[STORAGE_KEY] || {};
  await chrome.storage.local.set({ [STORAGE_KEY]: { ...data, running: false } });
  setStopped(data.deleted || 0);
});

// ─── Reset ──────────────────────────────────────────────────────────────────

$('resetBtn').addEventListener('click', async () => {
  await chrome.storage.local.set({ [STORAGE_KEY]: { running: false, deleted: 0 } });
  setStopped(0);
});

// ─── Live updates (poll storage every 1.5s while popup is open) ─────────────

init();

setInterval(async () => {
  const saved = await chrome.storage.local.get(STORAGE_KEY);
  const data  = saved[STORAGE_KEY] || {};
  $('counter').textContent = Number(data.deleted || 0).toLocaleString();

  if (data.running) {
    $('dot').className = 'dot active';
  }
}, 1500);
