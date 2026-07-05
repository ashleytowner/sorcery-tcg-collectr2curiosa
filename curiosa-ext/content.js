'use strict';

// ===========================================================================
// Curiosa tRPC API — discovered from curiosa-trace.json
// ===========================================================================

const TRPC_BASE = '/api/trpc';

// XPath kept only for the Recorder's MutationObserver scope.
const QUICK_SEARCH_XPATH =
  '//*[@id="__next"]/main/div/div/div[2]/div/div[2]/div/div/div/div/div/div';

// ===========================================================================
// Inject the page-world script for fetch/XHR shim
// ===========================================================================

(function injectPageScript() {
  try {
    const s = document.createElement('script');
    s.src = chrome.runtime.getURL('inject.js');
    s.onload = () => s.remove();
    (document.head || document.documentElement).appendChild(s);
  } catch (e) {
    console.warn('[curiosa-ext] inject failed', e);
  }
})();

// ===========================================================================
// Utilities
// ===========================================================================

function resolveContainer() {
  const r = document.evaluate(
    QUICK_SEARCH_XPATH,
    document,
    null,
    XPathResult.FIRST_ORDERED_NODE_TYPE,
    null,
  );
  return r && r.singleNodeValue;
}

function getCssPath(el) {
  if (!(el instanceof Element)) return '';
  const parts = [];
  let node = el;
  while (node && node.nodeType === 1 && parts.length < 8) {
    let part = node.nodeName.toLowerCase();
    if (node.id) { part += `#${node.id}`; parts.unshift(part); break; }
    if (node.className && typeof node.className === 'string') {
      const cls = node.className.trim().split(/\s+/).slice(0, 2).join('.');
      if (cls) part += `.${cls}`;
    }
    const parent = node.parentNode;
    if (parent && parent.children) {
      const same = [...parent.children].filter(c => c.nodeName === node.nodeName);
      if (same.length > 1) {
        const i = same.indexOf(node) + 1;
        part += `:nth-of-type(${i})`;
      }
    }
    parts.unshift(part);
    node = node.parentNode;
  }
  return parts.join(' > ');
}

function truncate(s, n) {
  if (typeof s !== 'string') return null;
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function summarize(el) {
  if (!(el instanceof Element)) return null;
  return {
    tag: el.tagName.toLowerCase(),
    id: el.id || null,
    classes: typeof el.className === 'string' ? el.className : null,
    text: truncate((el.textContent || '').trim(), 120),
    attrs: Object.fromEntries(
      [...el.attributes].slice(0, 12).map(a => [a.name, truncate(a.value, 120)]),
    ),
    path: getCssPath(el),
    outerHTML: truncate(el.outerHTML, 800),
  };
}

function normalizeName(s) {
  return (s || '')
    .toLowerCase()
    .replace(/\s*\(foil\)\s*$/i, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ===========================================================================
// Recorder
// ===========================================================================

const recorder = {
  active: false,
  events: [],
  stats: { events: 0, mutations: 0, network: 0 },
  observer: null,
  handlers: {},

  start() {
    if (this.active) return;
    this.active = true;
    this.events.length = 0;
    this.stats = { events: 0, mutations: 0, network: 0 };

    const onEvent = (type) => (e) => {
      if (!this.active) return;
      const target = e.target;
      const entry = {
        kind: 'event',
        type,
        target: summarize(target),
        timestamp: Date.now(),
      };
      if (type === 'input' || type === 'change') {
        entry.value = truncate(target && target.value, 200);
      }
      if (type === 'keydown') {
        entry.key = e.key;
      }
      this.push(entry);
      this.stats.events++;
    };
    this.handlers = {
      click: onEvent('click'),
      input: onEvent('input'),
      change: onEvent('change'),
      keydown: onEvent('keydown'),
    };
    for (const [t, h] of Object.entries(this.handlers)) {
      document.addEventListener(t, h, true);
    }

    // Mutation observer — try Quick Search container, else fall back to body
    const root = resolveContainer() || document.body;
    this.observer = new MutationObserver((records) => {
      if (!this.active) return;
      for (const m of records) {
        const entry = {
          kind: 'mutation',
          type: m.type,
          target: summarize(m.target),
          added: [...m.addedNodes].slice(0, 5).map(n => summarize(n)).filter(Boolean),
          removed: [...m.removedNodes].slice(0, 5).map(n => summarize(n)).filter(Boolean),
          attribute: m.attributeName || null,
          timestamp: Date.now(),
        };
        if (!entry.added.length && !entry.removed.length && !entry.attribute) continue;
        this.push(entry);
        this.stats.mutations++;
      }
    });
    this.observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'value', 'aria-expanded', 'aria-selected', 'disabled'],
      characterData: false,
    });

    this.push({ kind: 'meta', type: 'start', url: location.href, timestamp: Date.now() });
    chrome.runtime.sendMessage({ type: 'recorderStarted' }).catch(() => {});
  },

  stop() {
    if (!this.active) return;
    this.active = false;
    for (const [t, h] of Object.entries(this.handlers)) {
      document.removeEventListener(t, h, true);
    }
    this.handlers = {};
    if (this.observer) { this.observer.disconnect(); this.observer = null; }
    this.push({ kind: 'meta', type: 'stop', timestamp: Date.now() });
    this.persist();
  },

  push(entry) {
    this.events.push(entry);
    // throttled persist
    if (this.events.length % 20 === 0) this.persist();
  },

  persist() {
    chrome.runtime.sendMessage({
      type: 'persistTrace',
      trace: this.events,
      stats: this.stats,
      recording: this.active,
    }).catch(() => {});
  },

  ingestNetwork(payload) {
    if (!this.active) return;
    this.push({
      kind: 'network',
      ...payload,
    });
    this.stats.network++;
  },
};

// Listen for page-world network events
window.addEventListener('message', (e) => {
  if (e.source !== window) return;
  const data = e.data;
  if (!data || data.source !== '__curiosa_ext__') return;
  recorder.ingestNetwork(data.payload);
});

// ===========================================================================
// tRPC client (same-origin fetch from content script carries session cookies)
// ===========================================================================

async function trpcSearchVariants(query) {
  const input = encodeURIComponent(JSON.stringify({ 0: { json: { query } } }));
  const url = `${TRPC_BASE}/search.variants?batch=1&input=${input}`;
  const resp = await fetch(url, {
    credentials: 'include',
    headers: { accept: 'application/json' },
  });
  if (!resp.ok) throw new Error(`search HTTP ${resp.status}`);
  const data = await resp.json();
  return (data && data[0] && data[0].result && data[0].result.data && data[0].result.data.json) || [];
}

async function trpcUpdatePickle({ cardId, variantId, quantity, notes }) {
  const hasNotes = typeof notes === 'string' && notes.trim().length > 0;
  const body = hasNotes
    ? { 0: { json: { cardId, variantId, quantity, notes } } }
    : {
        0: {
          json: { cardId, variantId, quantity, notes: null },
          meta: { values: { notes: ['undefined'] } },
        },
      };
  const resp = await fetch(`${TRPC_BASE}/collection.updatePickle?batch=1`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`updatePickle HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }
  const data = await resp.json().catch(() => null);
  const node = data && data[0];
  if (node && node.error) {
    throw new Error(`tRPC error: ${node.error.message || JSON.stringify(node.error)}`);
  }
  return true;
}

// ===========================================================================
// Variant matcher
// ===========================================================================

function pickVariant(variants, row) {
  const wantFinish = (row.variance || '').toLowerCase() === 'foil' ? 'Foil' : 'Standard';
  const wantSet = (row.set || '').toLowerCase().trim();
  const wantName = normalizeName(row.name);

  const enriched = variants
    .map(v => {
      const variant = (v && v.data && v.data.variant) || null;
      if (!variant) return null;
      // card lives at variant.card, NOT v.data.card
      const card = variant.card || null;
      const setName = (variant.setCard && variant.setCard.set && variant.setCard.set.name) || '';
      const cardName = (card && card.name) || (v && v.label ? v.label.split(' - ')[0] : '');
      const cardId = variant.cardId || (card && card.id) || null;
      if (!cardId || !variant.id) return null;
      return {
        v,
        variantId: variant.id,
        cardId,
        slug: variant.slug || '',
        finish: variant.finish || '',
        setName,
        cardName,
        normName: normalizeName(cardName),
      };
    })
    .filter(Boolean);

  if (!enriched.length) return null;

  const sameName = enriched.filter(e => e.normName === wantName);
  const pool = sameName.length ? sameName : enriched;

  // exact: finish + set
  let hit = pool.find(e => e.finish === wantFinish && e.setName.toLowerCase() === wantSet);
  if (hit) return hit;

  // finish + setName contains wanted (handles "Gothic" vs "Gothic | Booster" labels)
  hit = pool.find(e => e.finish === wantFinish && wantSet && e.setName.toLowerCase().includes(wantSet));
  if (hit) return hit;

  // finish only (single set, or set not filled in CSV)
  const finishOnly = pool.filter(e => e.finish === wantFinish);
  if (finishOnly.length === 1) return finishOnly[0];

  // last resort: any variant with matching name
  return pool[0] || null;
}

// ===========================================================================
// Replayer
// ===========================================================================

const replayer = {
  async addRow(row) {
    let variants;
    try {
      variants = await trpcSearchVariants(row.name);
    } catch (err) {
      return { ok: false, reason: `search failed: ${err.message}` };
    }

    if (!variants.length) {
      return { ok: false, reason: 'no search results' };
    }

    const match = pickVariant(variants, row);
    if (!match) {
      return { ok: false, reason: `no ${row.variance || 'Standard'} variant in set "${row.set || ''}"` };
    }
    if (!match.cardId || !match.variantId) {
      return { ok: false, reason: 'matched variant missing ids' };
    }

    try {
      await trpcUpdatePickle({
        cardId: match.cardId,
        variantId: match.variantId,
        quantity: row.quantity,
        notes: row.notes || null,
      });
    } catch (err) {
      return { ok: false, reason: err.message };
    }

    return {
      ok: true,
      matchedSlug: match.slug,
      matchedSet: match.setName,
      matchedFinish: match.finish,
    };
  },
};

// ===========================================================================
// Message router
// ===========================================================================

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === 'recordStart') { recorder.start(); sendResponse({ ok: true }); return; }
      if (msg.type === 'recordStop') { recorder.stop(); sendResponse({ ok: true }); return; }
      if (msg.type === 'replayRow') {
        const result = await replayer.addRow(msg.payload);
        sendResponse(result);
        return;
      }
      sendResponse({ ok: false, reason: 'unknown message' });
    } catch (err) {
      sendResponse({ ok: false, reason: err.message });
    }
  })();
  return true; // keep channel open
});

// Restore recorder if it was active before a navigation
chrome.runtime.sendMessage({ type: 'getStats' }).then((resp) => {
  if (resp && resp.recording) {
    recorder.start();
  }
}).catch(() => {});

console.log('[curiosa-ext] content script loaded.');
