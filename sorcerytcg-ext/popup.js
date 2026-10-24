'use strict';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
  tab: 'replay',
  rows: [],
  unmatched: [],
  added: new Set(),
  running: false,
  paused: false,
  currentIndex: 0,
  recording: false,
  recordStats: { events: 0, mutations: 0, network: 0 },
};

// ---------------------------------------------------------------------------
// CSV parsing (RFC 4180 minimal: handles quoted fields with embedded commas)
// ---------------------------------------------------------------------------

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') { inQuotes = false; }
      else { field += c; }
    } else {
      if (c === '"') { inQuotes = true; }
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (c === '\r') { /* skip */ }
      else { field += c; }
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function csvToCards(text) {
  const matrix = parseCsv(text).filter(r => r.length > 1);
  if (!matrix.length) return { cards: [], format: 'Unknown' };
  const header = matrix[0].map(h => h.replace(/^\uFEFF/, '').trim());
  const findColumn = (...names) => {
    for (const name of names) {
      const index = header.indexOf(name);
      if (index !== -1) return index;
    }
    return -1;
  };
  const idx = {
    name: findColumn('Product Name', 'Card Name'),
    set: findColumn('Set', 'Set Name'),
    variance: findColumn('Variance', 'Finish'),
    quantity: findColumn('Quantity'),
    notes: findColumn('Notes'),
    product: findColumn('Product'),
    cardSlug: findColumn('Card Slug'),
    printedAt: findColumn('Printed At'),
  };
  if (idx.name === -1 || idx.quantity === -1) {
    throw new Error(
      'Unsupported CSV: expected "Product Name" or "Card Name", plus "Quantity".',
    );
  }
  const format = header.includes('Card Name') ? 'Kurio' : 'Collectr';
  const out = [];
  for (let r = 1; r < matrix.length; r++) {
    const row = matrix[r];
    let name = (row[idx.name] || '').trim();
    if (!name) continue;
    const variance = (row[idx.variance] || 'Normal').trim();
    const set = idx.set >= 0 ? (row[idx.set] || '').trim() : '';
    const qty = parseInt(row[idx.quantity] || '0', 10) || 0;
    if (qty <= 0) continue;
    const notes = idx.notes >= 0 ? (row[idx.notes] || '').trim() : '';
    // Collectr puts printing details in repeated suffixes, for example
    // "Sorcerer (Foil) (Box Topper)". Remove known suffixes from the card name
    // while retaining product information for printing selection.
    let baseName = name;
    let product = idx.product >= 0 ? (row[idx.product] || '').trim() || null : null;
    let parsedVariance = variance;
    let suffix;
    do {
      suffix = baseName.match(/\s*\((foil|box topper)\)\s*$/i);
      if (suffix) {
        if (suffix[1].toLowerCase() === 'box topper') product = 'BoxTopper';
        if (suffix[1].toLowerCase() === 'foil') parsedVariance = 'Foil';
        baseName = baseName.slice(0, suffix.index).trim();
      }
    } while (suffix);
    out.push({
      row: r,
      name: baseName,
      displayName: name,
      set,
      variance: parsedVariance,
      product,
      quantity: qty,
      notes,
      cardSlug: idx.cardSlug >= 0 ? (row[idx.cardSlug] || '').trim() : '',
      printedAt: idx.printedAt >= 0 ? (row[idx.printedAt] || '').trim() : '',
    });
  }
  return { cards: out, format };
}

// ---------------------------------------------------------------------------
// Messaging helpers
// ---------------------------------------------------------------------------

async function getSorceryTab() {
  // Prefer the active tab if it's on Sorcery, else any Sorcery tab.
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (active && active.url && active.url.startsWith('https://sorcerytcg.com/')) {
    return active;
  }
  const tabs = await chrome.tabs.query({ url: 'https://sorcerytcg.com/*' });
  return tabs[0] || null;
}

async function ensureContentInjected(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js'],
    });
  } catch (e) {
    throw new Error(`Inject failed: ${e.message}`);
  }
}

async function sendToContent(message) {
  const tab = await getSorceryTab();
  if (!tab) throw new Error('No sorcerytcg.com tab open.');
  try {
    return await chrome.tabs.sendMessage(tab.id, message);
  } catch (err) {
    const msg = (err && err.message) || String(err);
    if (!/Receiving end does not exist|Could not establish connection/i.test(msg)) {
      throw err;
    }
    // Content script not present yet — inject it on demand and retry once.
    await ensureContentInjected(tab.id);
    // Tiny grace period so the script can register its onMessage listener.
    await new Promise(r => setTimeout(r, 100));
    return await chrome.tabs.sendMessage(tab.id, message);
  }
}

async function sendToBackground(message) {
  return chrome.runtime.sendMessage(message);
}

// ---------------------------------------------------------------------------
// UI wiring
// ---------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);

function setBadge(text, kind) {
  const el = $('tabBadge');
  el.textContent = text;
  el.className = `badge badge-${kind}`;
}

function log(msg, kind = '') {
  const pre = $('replayLog');
  const time = new Date().toLocaleTimeString();
  const line = `[${time}] ${msg}\n`;
  pre.textContent += line;
  pre.scrollTop = pre.scrollHeight;
}

function switchTab(name) {
  state.tab = name;
  document.querySelectorAll('.tab').forEach(t => {
    t.classList.toggle('active', t.dataset.tab === name);
  });
  document.querySelectorAll('.panel').forEach(p => {
    p.classList.toggle('hidden', p.dataset.panel !== name);
  });
}

document.querySelectorAll('.tab').forEach(t => {
  t.addEventListener('click', () => switchTab(t.dataset.tab));
});

// ---------------------------------------------------------------------------
// CSV input
// ---------------------------------------------------------------------------

$('csvFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const parsed = csvToCards(text);
    state.rows = parsed.cards;
    state.unmatched = [];
    state.added.clear();
    state.currentIndex = 0;
    const totalQty = state.rows.reduce((s, r) => s + r.quantity, 0);
    $('csvSummary').textContent =
      `${parsed.format}: ${state.rows.length} rows / ${totalQty} cards.`;
    $('replayStart').disabled = state.rows.length === 0;
    $('replayReset').disabled = false;
    $('progressBar').value = 0;
    $('progressBar').max = state.rows.length;
    $('progressLabel').textContent = `Ready. ${state.rows.length} rows queued.`;
    log(`Loaded ${file.name} (${parsed.format}): ${state.rows.length} rows.`);
  } catch (err) {
    $('csvSummary').textContent = `Error: ${err.message}`;
    log(`CSV error: ${err.message}`, 'err');
  }
});

// ---------------------------------------------------------------------------
// Delay slider
// ---------------------------------------------------------------------------

$('delayRange').addEventListener('input', (e) => {
  $('delayValue').value = e.target.value;
});

// ---------------------------------------------------------------------------
// Replay controls
// ---------------------------------------------------------------------------

$('replayStart').addEventListener('click', async () => {
  if (state.running && state.paused) {
    state.paused = false;
    $('replayPause').textContent = 'Pause';
    runReplay();
    return;
  }
  state.running = true;
  state.paused = false;
  $('replayStart').disabled = true;
  $('replayPause').disabled = false;
  $('replayPause').textContent = 'Pause';
  log(`Replay started: ${state.rows.length - state.currentIndex} rows.`);
  runReplay();
});

$('replayPause').addEventListener('click', () => {
  if (!state.running) return;
  state.paused = !state.paused;
  $('replayPause').textContent = state.paused ? 'Resume' : 'Pause';
  $('replayStart').disabled = !state.paused;
  if (state.paused) log('Paused.');
});

$('replayReset').addEventListener('click', () => {
  state.running = false;
  state.paused = false;
  state.currentIndex = 0;
  state.unmatched = [];
  state.added.clear();
  $('progressBar').value = 0;
  $('progressLabel').textContent = 'Reset.';
  $('replayStart').disabled = state.rows.length === 0;
  $('replayPause').disabled = true;
  $('downloadReport').disabled = true;
  log('Reset.');
});

async function runReplay() {
  const delay = parseInt($('delayRange').value, 10);
  const skipExisting = $('skipExisting').checked;

  while (state.running && !state.paused && state.currentIndex < state.rows.length) {
    const row = state.rows[state.currentIndex];
    const key = `${row.displayName}::${row.set}::${row.variance}`;
    if (skipExisting && state.added.has(key)) {
      log(`Skip (already added): ${row.displayName}`);
    } else {
      $('progressLabel').textContent = `Row ${state.currentIndex + 1}/${state.rows.length}: ${row.displayName}`;
      try {
        const result = await sendToContent({
          type: 'replayRow',
          payload: row,
        });
        if (result && result.ok) {
          state.added.add(key);
          const tag = result.matchedSlug
            ? ` [${result.matchedSlug}]`
            : '';
          log(`OK: ${row.displayName} x${row.quantity} (${row.variance})${tag}`);
        } else {
          const reason = (result && result.reason) || 'unknown';
          state.unmatched.push({ ...row, reason });
          log(`MISS: ${row.displayName} — ${reason}`);
          $('downloadReport').disabled = false;
        }
      } catch (err) {
        state.unmatched.push({ ...row, reason: err.message });
        log(`ERROR: ${row.displayName} — ${err.message}`);
        $('downloadReport').disabled = false;
      }
    }
    state.currentIndex++;
    $('progressBar').value = state.currentIndex;
    if (state.currentIndex < state.rows.length) {
      await sleep(delay);
    }
  }

  if (state.currentIndex >= state.rows.length) {
    state.running = false;
    $('replayStart').disabled = true;
    $('replayPause').disabled = true;
    $('progressLabel').textContent =
      `Done. ${state.currentIndex - state.unmatched.length} ok, ${state.unmatched.length} missed.`;
    log('Replay finished.');
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Report download
// ---------------------------------------------------------------------------

$('downloadReport').addEventListener('click', () => {
  const header = 'Product Name,Set,Variance,Quantity,Reason\n';
  const body = state.unmatched.map(r =>
    [r.displayName, r.set, r.variance, r.quantity, r.reason]
      .map(v => `"${String(v).replace(/"/g, '""')}"`)
      .join(',')
  ).join('\n');
  downloadBlob(header + body, 'sorcerytcg-report.csv', 'text/csv');
});

function downloadBlob(content, filename, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------------------------------------------------------------------------
// Recorder controls
// ---------------------------------------------------------------------------

$('recordStart').addEventListener('click', async () => {
  try {
    await sendToContent({ type: 'recordStart' });
    state.recording = true;
    $('recordStart').disabled = true;
    $('recordStop').disabled = false;
    $('downloadTrace').disabled = true;
    refreshStats();
    pollStats();
  } catch (err) {
    alert(err.message);
  }
});

$('recordStop').addEventListener('click', async () => {
  try {
    await sendToContent({ type: 'recordStop' });
    state.recording = false;
    $('recordStart').disabled = false;
    $('recordStop').disabled = true;
    $('downloadTrace').disabled = false;
    refreshStats();
  } catch (err) {
    alert(err.message);
  }
});

$('recordClear').addEventListener('click', async () => {
  await sendToBackground({ type: 'clearTrace' });
  state.recordStats = { events: 0, mutations: 0, network: 0 };
  refreshStats();
  $('downloadTrace').disabled = true;
});

$('downloadTrace').addEventListener('click', async () => {
  const resp = await sendToBackground({ type: 'getTrace' });
  const trace = (resp && resp.trace) || [];
  downloadBlob(JSON.stringify(trace, null, 2), 'sorcerytcg-trace.json', 'application/json');
});

function refreshStats() {
  $('statEvents').textContent = state.recordStats.events;
  $('statMutations').textContent = state.recordStats.mutations;
  $('statNetwork').textContent = state.recordStats.network;
}

async function pollStats() {
  if (!state.recording) return;
  try {
    const resp = await sendToBackground({ type: 'getStats' });
    if (resp && resp.stats) {
      state.recordStats = resp.stats;
      refreshStats();
    }
  } catch (_) { /* popup might be detached */ }
  if (state.recording) setTimeout(pollStats, 500);
}

// ---------------------------------------------------------------------------
// Init: check for a Sorcery tab
// ---------------------------------------------------------------------------

(async function init() {
  const tab = await getSorceryTab();
  if (tab) {
    setBadge('On Sorcery', 'ok');
  } else {
    setBadge('Open sorcerytcg.com', 'warn');
  }
  // Restore stats if a recording exists
  const resp = await sendToBackground({ type: 'getStats' }).catch(() => null);
  if (resp && resp.stats) {
    state.recordStats = resp.stats;
    state.recording = !!resp.recording;
    refreshStats();
    if (state.recording) {
      $('recordStart').disabled = true;
      $('recordStop').disabled = false;
      pollStats();
    } else if (resp.stats.events > 0) {
      $('downloadTrace').disabled = false;
    }
  }
})();
