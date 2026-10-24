'use strict';

// Service worker. Holds the recorder buffer in chrome.storage.session so the
// popup or a brief navigation can't drop it. Routes getTrace/getStats/clear.

const KEYS = {
  trace: 'sorcerytcg_trace',
  stats: 'sorcerytcg_stats',
  recording: 'sorcerytcg_recording',
};

const IMPORTER_URL = chrome.runtime.getURL('popup.html');

// A browser-action popup is destroyed when Chrome's file chooser takes focus.
// Open the importer as a persistent extension tab instead.
chrome.action.onClicked.addListener(async () => {
  const tabs = await chrome.tabs.query({});
  const existing = tabs.find(tab => tab.url && tab.url.startsWith(IMPORTER_URL));
  if (existing && existing.id !== undefined) {
    await chrome.tabs.update(existing.id, { active: true });
    if (existing.windowId !== undefined) {
      await chrome.windows.update(existing.windowId, { focused: true });
    }
    return;
  }
  await chrome.tabs.create({ url: IMPORTER_URL });
});

async function readSession(key, fallback) {
  const obj = await chrome.storage.session.get(key);
  return obj[key] === undefined ? fallback : obj[key];
}

async function writeSession(patch) {
  await chrome.storage.session.set(patch);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg.type === 'persistTrace') {
      await writeSession({
        [KEYS.trace]: msg.trace || [],
        [KEYS.stats]: msg.stats || { events: 0, mutations: 0, network: 0 },
        [KEYS.recording]: !!msg.recording,
      });
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === 'recorderStarted') {
      await writeSession({ [KEYS.recording]: true });
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === 'getTrace') {
      const trace = await readSession(KEYS.trace, []);
      sendResponse({ ok: true, trace });
      return;
    }
    if (msg.type === 'getStats') {
      const stats = await readSession(KEYS.stats, { events: 0, mutations: 0, network: 0 });
      const recording = await readSession(KEYS.recording, false);
      sendResponse({ ok: true, stats, recording });
      return;
    }
    if (msg.type === 'clearTrace') {
      await writeSession({
        [KEYS.trace]: [],
        [KEYS.stats]: { events: 0, mutations: 0, network: 0 },
        [KEYS.recording]: false,
      });
      sendResponse({ ok: true });
      return;
    }
  })();
  return true;
});
