'use strict';

// ===========================================================================
// Sorcery APIs
// ===========================================================================

const TRPC_BASE = '/api/trpc';
const CATALOG_URL = 'https://api.sorcerytcg.com/api/cards';

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
    console.warn('[sorcerytcg-ext] inject failed', e);
  }
})();

// ===========================================================================
// Utilities
// ===========================================================================

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
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
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

    const root = document.body;
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
  if (!data || data.source !== '__sorcerytcg_ext__') return;
  recorder.ingestNetwork(data.payload);
});

// ===========================================================================
// API clients. The public catalogue resolves Collectr rows to printing IDs;
// the same-origin tRPC mutation carries the user's Sorcery session cookie.
// ===========================================================================

let cataloguePromise = null;

async function getCatalogue() {
  if (!cataloguePromise) {
    cataloguePromise = fetch(CATALOG_URL, {
      credentials: 'omit',
      headers: { accept: 'application/json' },
    }).then(async resp => {
      if (!resp.ok) throw new Error(`catalogue HTTP ${resp.status}`);
      const data = await resp.json();
      if (!Array.isArray(data)) throw new Error('catalogue returned an unexpected response');
      return data;
    }).catch(err => {
      cataloguePromise = null;
      throw err;
    });
  }
  return cataloguePromise;
}

async function trpcUpdateCard({ printingId, quantity, notes }) {
  const input = { printingId, quantity };
  if (typeof notes === 'string' && notes.trim()) input.notes = notes.trim();
  const body = { 0: { json: input } };
  const resp = await fetch(`${TRPC_BASE}/inventory.updateCard?batch=1`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    if (resp.status === 401) {
      throw new Error('not signed in to sorcerytcg.com');
    }
    throw new Error(`updateCard HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }
  const data = await resp.json().catch(() => null);
  const node = data && data[0];
  if (node && node.error) {
    throw new Error(`tRPC error: ${node.error.message || JSON.stringify(node.error)}`);
  }
  return true;
}

// ===========================================================================
// Printing matcher
// ===========================================================================

function wantedFinish(variance) {
  const value = (variance || '').toLowerCase();
  if (value.includes('rainbow')) return 'Rainbow';
  if (value.includes('foil')) return 'Foil';
  return 'Standard';
}

function pickPrinting(cards, row) {
  const wantFinish = wantedFinish(row.variance);
  const wantSet = normalizeName(row.set);
  const wantName = normalizeName(row.name);
  const sluggedCards = row.cardSlug
    ? cards.filter(card => card && card.slug === row.cardSlug)
    : [];
  const namedCards = sluggedCards.length
    ? sluggedCards
    : cards.filter(card => normalizeName(card && card.name) === wantName);
  if (!namedCards.length) return { error: 'card name not found in official catalogue' };

  let candidates = namedCards.flatMap(card =>
    (card.printings || []).map(printing => ({ card, printing })),
  ).filter(({ printing }) => printing && printing.id && printing.meta);

  if (wantSet) {
    candidates = candidates.filter(({ printing }) =>
      normalizeName(printing.set && printing.set.name) === wantSet,
    );
  }
  candidates = candidates.filter(({ printing }) => printing.meta.finish === wantFinish);

  if (row.printedAt) {
    candidates = candidates.filter(({ printing }) => printing.printedAt === row.printedAt);
  }

  if (row.product) {
    candidates = candidates.filter(({ printing }) => printing.meta.product === row.product);
  } else if (candidates.length > 1) {
    const boosters = candidates.filter(({ printing }) => printing.meta.product === 'Booster');
    if (boosters.length === 1) candidates = boosters;
  }

  if (!candidates.length) {
    const product = row.product ? ` / ${row.product}` : '';
    const date = row.printedAt ? ` printed ${row.printedAt}` : '';
    return {
      error: `no ${wantFinish}${product} printing in set "${row.set || ''}"${date}`,
    };
  }
  if (candidates.length > 1) {
    const choices = candidates.map(({ printing }) => printing.slug).join(', ');
    return { error: `ambiguous printing: ${choices}` };
  }

  const { card, printing } = candidates[0];
  return {
    cardId: card.id,
    printingId: printing.id,
    slug: printing.slug || '',
    finish: printing.meta.finish,
    product: printing.meta.product,
    setName: (printing.set && printing.set.name) || '',
  };
}

// ===========================================================================
// Replayer
// ===========================================================================

const replayer = {
  async addRow(row) {
    let cards;
    try {
      cards = await getCatalogue();
    } catch (err) {
      return { ok: false, reason: `catalogue failed: ${err.message}` };
    }

    const match = pickPrinting(cards, row);
    if (match.error) return { ok: false, reason: match.error };

    try {
      await trpcUpdateCard({
        printingId: match.printingId,
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
      matchedProduct: match.product,
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

console.log('[sorcerytcg-ext] content script loaded.');
