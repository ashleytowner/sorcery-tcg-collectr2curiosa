// Page-world shim. Monkey-patches fetch + XHR and posts request/response
// metadata to the content script via window.postMessage tagged __sorcerytcg_ext__.

(function () {
  if (window.__sorcerytcg_ext_injected__) return;
  window.__sorcerytcg_ext_injected__ = true;

  const MAX_BODY = 4096;

  function truncate(s) {
    if (typeof s !== 'string') {
      try { s = String(s); } catch (_) { return null; }
    }
    return s.length > MAX_BODY ? s.slice(0, MAX_BODY) + '…[truncated]' : s;
  }

  function post(payload) {
    try {
      window.postMessage({ source: '__sorcerytcg_ext__', payload }, '*');
    } catch (_) { /* ignore */ }
  }

  // ── fetch ────────────────────────────────────────────────────────────────
  const origFetch = window.fetch;
  window.fetch = async function (input, init) {
    const url = (typeof input === 'string') ? input : (input && input.url) || '';
    const method = (init && init.method) || (input && input.method) || 'GET';
    let reqBody = null;
    if (init && init.body) {
      try { reqBody = truncate(typeof init.body === 'string' ? init.body : JSON.stringify(init.body)); } catch (_) {}
    }
    const t0 = performance.now();
    try {
      const resp = await origFetch.apply(this, arguments);
      const clone = resp.clone();
      let respBody = null;
      try { respBody = truncate(await clone.text()); } catch (_) {}
      post({
        kind: 'network',
        api: 'fetch',
        method,
        url,
        status: resp.status,
        duration: Math.round(performance.now() - t0),
        requestBody: reqBody,
        responseBody: respBody,
        timestamp: Date.now(),
      });
      return resp;
    } catch (err) {
      post({
        kind: 'network',
        api: 'fetch',
        method,
        url,
        status: -1,
        error: String(err && err.message || err),
        requestBody: reqBody,
        timestamp: Date.now(),
      });
      throw err;
    }
  };

  // ── XHR ──────────────────────────────────────────────────────────────────
  const XHR = window.XMLHttpRequest;
  const origOpen = XHR.prototype.open;
  const origSend = XHR.prototype.send;

  XHR.prototype.open = function (method, url) {
    this.__sorcerytcg_method__ = method;
    this.__sorcerytcg_url__ = url;
    return origOpen.apply(this, arguments);
  };

  XHR.prototype.send = function (body) {
    const xhr = this;
    const reqBody = body == null ? null : truncate(typeof body === 'string' ? body : JSON.stringify(body));
    const t0 = performance.now();
    xhr.addEventListener('loadend', function () {
      let respBody = null;
      try {
        if (xhr.responseType === '' || xhr.responseType === 'text') {
          respBody = truncate(xhr.responseText);
        }
      } catch (_) {}
      post({
        kind: 'network',
        api: 'xhr',
        method: xhr.__sorcerytcg_method__,
        url: xhr.__sorcerytcg_url__,
        status: xhr.status,
        duration: Math.round(performance.now() - t0),
        requestBody: reqBody,
        responseBody: respBody,
        timestamp: Date.now(),
      });
    });
    return origSend.apply(this, arguments);
  };
})();
