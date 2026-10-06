/*
 * Weft: on-page panel, product discovery, badges and filtering.
 * Runs when the toolbar button is clicked (clicking again closes it), or by itself
 * on stores where "Run automatically" is turned on.
 */
(() => {
  'use strict';

  // Set by auto-flag.js when the browser runs this automatically on a chosen store.
  const AUTO = window.__weftAuto === true;

  if (window.__weft) {
    if (!AUTO) window.__weft.close();
    return;
  }

  const P = window.WeftParser;
  const store = typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local ? chrome.storage.local : null;

  const CACHE_PREFIX = 'weft1:';
  const CACHE_TTL = 7 * 24 * 3600 * 1000;
  const CONCURRENCY = 2;
  // Pages a store shows instead of the product when it suspects a bot.
  const CHALLENGE_RE =
    /px-captcha|captcha-delivery|validatecaptcha|are you a (?:human|robot)|verify (?:that )?(?:you are|you're) (?:a )?human|press (?:&amp;|&|and) hold|robot check|unusual traffic from your|request unsuccessful\. incapsula|<title>just a moment/i;
  const PRODUCT_MARK_RE = /"@type"\s*:\s*"Product|og:type"\s+content="product/i;
  const SETTINGS_KEY = 'weft-settings';
  const DEFAULTS = {
    fibers: ['cotton'], // materials to look for
    threshold: 100, // minimum % of those materials
    avoid: [], // fibers that rule an item out
    stretch: 0, // % of spandex/elastane that still counts as OK
    usaOnly: false,
    hideUnknown: false,
    mode: 'dim', // fade or hide items that don't match
    moreOpen: false,
    collapsed: false,
  };

  const settings = { ...DEFAULTS };
  const products = new Map(); // key -> { key, url, cards:Set, result, state, retries }
  const memCache = new Map();
  const restorePosition = new Map(); // card -> original inline position
  let active = 0;
  let pausedUntil = 0;
  let challenged = false; // the store asked for a human check, so checking is paused
  let gentle = false; // after a pause, go one page at a time
  let running = true;
  let lastHref = location.href;
  let pageVerdict = null;
  let pageChecks = 0;
  let pageFetched = false;

  // ---------- storage ----------

  function storageGet(keys) {
    if (!store) return Promise.resolve({});
    return new Promise((resolve) => {
      try {
        store.get(keys, (v) => resolve(v || {}));
      } catch (e) {
        resolve({});
      }
    });
  }

  function storageSet(obj) {
    if (!store) return;
    try {
      store.set(obj);
    } catch (e) {
      /* extension reloaded or storage full; memory cache still works */
    }
  }

  // ---------- page styles (light DOM) ----------

  const PAGE_CSS = `
    [data-weft-state="dim"] { opacity: .2 !important; filter: grayscale(1) !important; transition: opacity .2s ease, filter .2s ease !important; }
    [data-weft-state="dim"]:hover { opacity: .9 !important; filter: none !important; }
    [data-weft-state="hide"] { display: none !important; }
    [data-weft-state="match"] { outline: 2px solid #2f6b45 !important; outline-offset: -2px !important; }
    [data-weft-flash] { animation: weft-flash 1.2s ease 2 !important; }
    @keyframes weft-flash { 50% { outline-color: #a9d3b5; } }
  `;
  const styleEls = [];
  function addStyles(root) {
    const el = document.createElement('style');
    el.setAttribute('data-weft-ui', '');
    el.textContent = PAGE_CSS;
    (root === document ? document.head || document.documentElement : root).appendChild(el);
    styleEls.push(el);
  }
  addStyles(document);

  // Some stores draw their product grid inside a shadow root (e.g. the Fast Simon
  // search/filter app on Shopify stores), which normal page queries can't see into.
  const knownRoots = new Set();
  const styledRoots = new Set();

  function shadowRoots() {
    const roots = [];
    const walk = (root) => {
      const w = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      let el;
      while ((el = w.nextNode())) {
        if (el.shadowRoot && !isOurs(el)) {
          roots.push(el.shadowRoot);
          walk(el.shadowRoot);
        }
      }
    };
    if (document.body) walk(document.body);
    return roots;
  }

  function queryAll(selector) {
    const out = [...document.querySelectorAll(selector)];
    for (const root of knownRoots) if (root.host.isConnected) out.push(...root.querySelectorAll(selector));
    return out;
  }

  function trackRoots() {
    for (const root of shadowRoots()) {
      if (knownRoots.has(root)) continue;
      knownRoots.add(root);
      observer.observe(root, { childList: true, subtree: true });
    }
  }

  function ensureStyles(card) {
    const root = card.getRootNode();
    if (root instanceof ShadowRoot && !styledRoots.has(root)) {
      styledRoots.add(root);
      addStyles(root);
    }
  }

  // ---------- product discovery ----------

  const EXCLUDE_PATH =
    /\/(?:cart|bag|basket|checkout|account|my-account|login|log-in|signin|sign-in|register|wishlist|favou?rites|help|faq|customer-service|stores?|store-locator|search|blog|journal|stories|policies|gift-?cards?|careers|about|privacy|terms)(?:\/|$|\.)/i;
  // Category / listing pages, not products (e.g. Shopify "/collections/tees", Target "/c/...").
  const CATEGORY_PATH = /\/(?:collections?|categories|category|plp|departments?|c)\/[^/]+\/?$|\/browse\/category|\/(?:c|plp|category)\//i;
  const ID_PARAMS = /^(?:pid|productid|product_id|id|itemid|item_id|sku|styleid|style|variant)$/i;

  // Sponsored/tracking links often wrap the real product address: "/sspa/click?...&url=/Shirt/dp/B0...".
  const WRAP_PARAMS = ['url', 'u', 'rd', 'redirect', 'redirect_url', 'redirectUrl', 'dest', 'destination', 'target'];
  function unwrap(url) {
    for (const k of WRAP_PARAMS) {
      const v = url.searchParams.get(k);
      if (!v || !/^(?:\/|https?:)/.test(v)) continue;
      try {
        const inner = new URL(v, location.href);
        if (inner.origin === location.origin) return inner;
      } catch (e) {
        /* not a URL */
      }
    }
    return url;
  }

  // Amazon and Walmart products have many URLs each, so key them by their product ID.
  const ASIN_RE = /\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})(?=[/?]|$)/i;
  const WALMART_RE = /^\/ip\/(?:[^/]+\/)?(\d{5,})\/?$/;

  function productKey(url) {
    const asin = url.pathname.match(ASIN_RE);
    if (asin) return '/dp/' + asin[1].toUpperCase();
    const wm = url.pathname.match(WALMART_RE);
    if (wm) return '/ip/' + wm[1];
    const keep = [];
    for (const [k, v] of url.searchParams) if (ID_PARAMS.test(k)) keep.push(k + '=' + v);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    return path + (keep.length ? '?' + keep.sort().join('&') : '');
  }

  function rectOf(el) {
    const r = el.getBoundingClientRect();
    return { w: r.width, h: r.height, top: r.top, bottom: r.bottom };
  }

  /** Size of the product image a link shows (links are often inline, so check images too). */
  function linkArea(a) {
    let best = rectOf(a);
    let area = best.w >= 80 && best.h >= 80 ? best.w * best.h : 0;
    const imgs = a.querySelectorAll('img, picture, video');
    for (let i = 0; i < imgs.length && i < 6; i++) {
      const r = rectOf(imgs[i]);
      if (r.w >= 80 && r.h >= 80 && r.w * r.h > area) area = r.w * r.h;
    }
    return area;
  }

  function isOurs(node) {
    return node.nodeType === 1 && (node.tagName === 'WEFT-BADGE' || node.hasAttribute('data-weft-ui'));
  }

  function discover() {
    if (!running || !document.body) return;
    const found = [];
    trackRoots();
    const anchors = queryAll('a[href]');
    const here = productKey(new URL(location.href));

    for (const a of anchors) {
      if (a.closest('[data-weft-card]')) continue;
      if (a.closest('header, nav, footer, [role="navigation"], [role="banner"], [role="contentinfo"], [data-weft-ui]')) continue;
      let url;
      try {
        url = unwrap(new URL(a.getAttribute('href'), location.href));
      } catch (e) {
        continue;
      }
      if (url.origin !== location.origin || !/^https?:$/.test(url.protocol)) continue;
      if (url.pathname === '/' || EXCLUDE_PATH.test(url.pathname)) continue;
      if (CATEGORY_PATH.test(url.pathname) && !/\/products?\//i.test(url.pathname)) continue;
      const key = productKey(url);
      if (key === here) continue;
      const area = linkArea(a);
      if (!area) continue;
      a.setAttribute('data-weft-key', key);
      found.push({ a, key, url, area });
    }

    // Grow each image link up to its whole product tile: the largest ancestor
    // that doesn't contain another product and isn't much bigger than the image.
    const cards = [];
    for (const f of found) {
      if (f.a.closest('[data-weft-card]')) continue;
      let card = f.a;
      while (card.parentElement && card.parentElement !== document.body) {
        const parent = card.parentElement;
        const pr = rectOf(parent);
        if (pr.w * pr.h > f.area * 3.2) break;
        let other = false;
        for (const x of parent.querySelectorAll('a[data-weft-key]')) {
          if (x.getAttribute('data-weft-key') !== f.key) {
            other = true;
            break;
          }
        }
        if (other) break;
        card = parent;
      }
      if (getComputedStyle(card).display === 'contents' && card.firstElementChild) card = card.firstElementChild;
      cards.push({ ...f, card });
    }

    // Keep things that look like products: a product-style URL, or one of a repeated grid of tiles.
    const siblingCount = new Map();
    for (const c of cards) {
      for (const anc of [c.card.parentElement, c.card.parentElement && c.card.parentElement.parentElement]) {
        if (anc) siblingCount.set(anc, (siblingCount.get(anc) || 0) + 1);
      }
    }
    const fresh = [];
    for (const c of cards) {
      const parent = c.card.parentElement;
      const grid = Math.max(siblingCount.get(parent) || 0, (parent && siblingCount.get(parent.parentElement)) || 0);
      if (!P.looksLikeProductUrl(c.url) && grid < 3) continue;
      if (c.card.hasAttribute('data-weft-card')) continue;
      c.card.setAttribute('data-weft-card', c.key);
      ensureStyles(c.card);
      let p = products.get(c.key);
      if (!p) {
        const href = /^\/(?:dp|ip)\//.test(c.key) ? location.origin + c.key : c.url.href;
        p = { key: c.key, url: href, cards: new Set(), result: null, state: 'new', retries: 0 };
        products.set(c.key, p);
        fresh.push(p);
      }
      p.cards.add(c.card);
      if (p.result) decorate(p);
    }

    for (const x of queryAll('a[data-weft-key]')) {
      if (!x.closest('[data-weft-card]')) x.removeAttribute('data-weft-key');
    }

    // Forget tiles the site removed (e.g. after re-rendering the grid).
    for (const p of products.values()) {
      for (const card of p.cards) if (!card.isConnected) p.cards.delete(card);
    }

    if (fresh.length) loadCached(fresh);
    checkThisPage();
    render();
  }

  async function loadCached(list) {
    const need = [];
    for (const p of list) {
      if (memCache.has(p.key)) applyResult(p, memCache.get(p.key));
      else need.push(p);
    }
    if (need.length) {
      const got = await storageGet(need.map((p) => CACHE_PREFIX + location.host + p.key));
      const now = Date.now();
      for (const p of need) {
        const hit = got[CACHE_PREFIX + location.host + p.key];
        if (hit && now - hit.t < CACHE_TTL) {
          memCache.set(p.key, hit.r);
          applyResult(p, hit.r);
        } else if (p.state === 'new') {
          p.state = 'queued';
        }
      }
    }
    render();
    pump();
  }

  // ---------- fetching ----------

  function distanceToView(p) {
    let best = Infinity;
    const vh = window.innerHeight;
    for (const card of p.cards) {
      const r = card.getBoundingClientRect();
      if (!r.width && !r.height) continue;
      const d = r.bottom < 0 ? -r.bottom + vh : r.top > vh ? r.top - vh : 0;
      if (d < best) best = d;
    }
    return best;
  }

  function nextQueued() {
    let pick = null;
    let pickD = Infinity;
    for (const p of products.values()) {
      if (p.state !== 'queued') continue;
      const d = distanceToView(p);
      if (d < pickD || !pick) {
        pick = p;
        pickD = d;
      }
    }
    return pick;
  }

  function pump() {
    if (!running || challenged) return;
    const wait = pausedUntil - Date.now();
    if (wait > 0) {
      setTimeout(pump, wait + 50);
      return;
    }
    while (active < (gentle ? 1 : CONCURRENCY)) {
      const p = nextQueued();
      if (!p) break;
      p.state = 'loading';
      active++;
      decorate(p);
      check(p).finally(() => {
        active--;
        render();
        setTimeout(pump, (gentle ? 1500 : 300) + Math.random() * 400);
      });
    }
    render();
  }

  async function fetchHtml(url) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    try {
      const res = await fetch(url, { credentials: 'same-origin', signal: ctrl.signal });
      if (res.status === 429 || res.status === 503) {
        const err = new Error('rate limited');
        err.retry = true;
        throw err;
      }
      const html = await res.text();
      const blockPage = html.length < 150000 && CHALLENGE_RE.test(html) && !PRODUCT_MARK_RE.test(html);
      if (res.status === 403 || blockPage) {
        const err = new Error('store asked for a human check');
        err.challenge = true;
        throw err;
      }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return html;
    } finally {
      clearTimeout(timer);
    }
  }

  async function check(p) {
    try {
      const html = await fetchHtml(p.url);
      if (!running) return;
      const r = P.analyzeHtml(html, p.url);
      memCache.set(p.key, r);
      storageSet({ [CACHE_PREFIX + location.host + p.key]: { r, t: Date.now() } });
      applyResult(p, r);
      return;
    } catch (e) {
      if (e.challenge) {
        // Stop and let the shopper carry on; they can resume from the panel.
        p.state = 'queued';
        challenged = true;
        decorate(p);
        render();
        return;
      }
      if (e.retry && p.retries < 2) {
        p.retries++;
        p.state = 'queued';
        pausedUntil = Date.now() + 4000 * p.retries;
        return;
      }
      p.result = { kind: 'error', message: String(e.message || e) };
      p.state = 'done';
    }
    decorate(p);
  }

  function applyResult(p, r) {
    p.result = r;
    // The link led to a category or other non-product page: drop its label.
    p.state = r.isProduct === false ? 'skip' : 'done';
    decorate(p);
  }

  // ---------- this page (product detail pages) ----------

  async function checkThisPage() {
    if (location.href !== lastHref) {
      lastHref = location.href;
      pageVerdict = null;
      pageChecks = 0;
      pageFetched = false;
    }
    if (pageVerdict) return;
    if (pageChecks++ > 12) return;

    const strongSignal = P.isProductDocument(document, null);
    const urlSignal = P.looksLikeProductUrl(location.href) && products.size < 6;
    if (!strongSignal && !urlSignal) {
      pageVerdict = null;
      return;
    }
    let v = P.analyzeDocument(document);
    if (v.kind === 'unknown' && !pageFetched) {
      // Details are sometimes only in the server HTML (or only after clicking a tab).
      pageFetched = true;
      try {
        const fromServer = P.analyzeHtml(await fetchHtml(location.href));
        if (fromServer.kind !== 'unknown') v = fromServer;
      } catch (e) {
        /* keep live result */
      }
    }
    if (!strongSignal && v.confidence !== 'high') v = { kind: 'unknown' };
    pageVerdict = v.kind === 'unknown' ? null : v;
    render();
  }

  // ---------- preferences & scoring ----------

  const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

  function prefs() {
    return { fibers: settings.fibers, avoid: settings.avoid, stretch: settings.stretch };
  }

  /** How a product's fabric compares with what's chosen in the panel. */
  function scored(p) {
    return P.score(p.result, prefs());
  }

  // Bar colors per fiber: greens/earth tones for natural, blues for wood-based, warm brights for synthetics.
  const FIBER_COLORS = {
    cotton: '#6fae7c', linen: '#c9ae72', wool: '#a97e57', cashmere: '#d2a27a', silk: '#d99bb8', hemp: '#8faa55',
    alpaca: '#bf9f78', mohair: '#cbb08c', angora: '#dccab0', ramie: '#a8b765', camel: '#b98f5c', yak: '#9e8569',
    lyocell: '#6e9fd1', modal: '#86b2dc', viscose: '#5b8fc4', cupro: '#9cbfe3', bamboo: '#7fb39a', acetate: '#a5b9d6',
    polyester: '#e05a47', nylon: '#e8913a', acrylic: '#a86cc9', elastane: '#e3bf3a', polyurethane: '#9aa0a6',
    polypropylene: '#8d949b', metallic: '#bfc4c9', rubber: '#7c8187', leather: '#8f5f3c', other: '#c3bcb0',
  };
  const colorOf = (f) => FIBER_COLORS[f] || '#ced4da';

  function barHtml(fibers) {
    if (!fibers) return '';
    return Object.entries(fibers)
      .sort((a, b) => b[1] - a[1])
      .map(([f, pct]) => `<span style="flex:${pct} 0 0;background:${colorOf(f)}" title="${esc(pct + '% ' + (P.FIBER_LABELS[f] || f))}"></span>`)
      .join('');
  }

  /** Short verdict text, e.g. "100% cotton", "98% cotton + stretch", "Has polyester". */
  function verdictText(v, long) {
    const L = v.label;
    const stretch = v.stretch ? ' + stretch' : '';
    const own = v.pct == null ? null : v.pct - (v.stretch || 0);
    switch (v.status) {
      case 'pure':
        return v.stretch ? `${own}% ${L}${stretch}` : `100% ${L}`;
      case 'pure-main':
        return (v.stretch ? `${own}% ${L}${stretch}` : `100% ${L}`) + (long ? ' (main fabric)' : '*');
      case 'varies':
        return `100% ${L} ${long ? 'in some colors' : '(some colors)'}`;
      case 'likely':
        return `${cap(L)} ${long ? '(no % listed)' : '· no % listed'}`;
      case 'blend':
        return v.pct == null ? `${cap(L)} blend` : `${own}% ${L}${stretch}`;
      case 'none':
        return `No ${L}`;
      case 'blocked':
        return `Has ${L}`;
      case 'error':
        return long ? "Couldn't open this page" : "Can't open";
      default:
        return long ? 'Fabric not listed' : 'Not listed';
    }
  }

  function verdictFor(p) {
    if (p.state === 'skip') return 'skip';
    if (p.state !== 'done' || !p.result) return 'pending';
    const v = scored(p);
    if (v.status === 'blocked') return 'below';
    if (settings.usaOnly && v.origin !== 'USA') return 'below';
    if (v.status === 'unknown' || v.status === 'error') return settings.hideUnknown ? 'below' : 'unknown';
    if (settings.threshold === 0) return 'match';
    if (v.pct == null) return 'below';
    return v.pct >= settings.threshold ? 'match' : 'below';
  }

  // ---------- badges ----------

  // Product badges look like little paper hang tags, so they read well on any photo.
  const BADGE_CSS = `
    :host { all: initial; position: absolute !important; top: 8px !important; left: 8px !important; z-index: 2147483000 !important;
            max-width: calc(100% - 16px) !important; pointer-events: auto; }
    .b { position: relative; display: inline-flex; align-items: center; gap: 6px; padding: 5px 8px 5px 7px; max-width: 100%;
         font: 600 10.5px/1.2 ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace; letter-spacing: .03em; text-transform: uppercase;
         color: #1f1c18; background: #fbf8f1; border-radius: 3px; white-space: normal;
         box-shadow: 0 0 0 1px rgba(31,28,24,.16), 0 1px 3px rgba(31,28,24,.2); }
    .b::before { content: ""; width: 6px; height: 6px; border-radius: 50%; flex: none; box-shadow: inset 0 0 0 1.5px currentColor; }
    .b.has-bar { padding-bottom: 9px; }
    .pure, .pure-main, .varies, .likely { color: #2f6b45; }
    .pure::before, .pure-main::before, .varies::before { background: currentColor; }
    .blend { color: #8a5d10; }
    .none, .blocked { color: #a23e2c; }
    .unknown, .error, .loading { color: #7a7266; }
    .loading::before { animation: blink 1s ease-in-out infinite; }
    @keyframes blink { 50% { opacity: .2; } }
    .cbar { position: absolute; left: 7px; right: 7px; bottom: 3px; height: 3px; display: flex; gap: 1px; }
    .cbar span { display: block; height: 100%; min-width: 2px; }
    .usa { padding: 1px 4px; border-radius: 2px; box-shadow: inset 0 0 0 1px currentColor; font-size: 9.5px; }
  `;

  function badgeContent(p) {
    if (p.state === 'queued' && challenged) return { cls: 'unknown', html: 'Paused', tip: 'Checking is paused. Resume from the Weft panel.' };
    if (p.state === 'loading' || p.state === 'queued') return { cls: 'loading', html: 'Checking', tip: 'Checking fabric…' };
    const v = scored(p);
    const lines = [v.summary].concat(v.details.slice(1));
    if (v.status === 'pure-main') lines.push('* main fabric; other parts differ');
    if (v.status === 'likely') lines.push(v.details[0], 'No percentages given');
    if (v.status === 'unknown') lines.splice(0, lines.length, "Couldn't find the fabric on this product's page");
    if (v.status === 'error') lines.splice(0, lines.length, "Couldn't open this product page");
    if (v.origin) lines.push('Made in: ' + v.origin);
    const bar = v.composition ? `<span class="cbar">${barHtml(v.composition)}</span>` : '';
    const usa = v.origin === 'USA' ? '<span class="usa">USA</span>' : '';
    return {
      cls: v.status + (bar ? ' has-bar' : ''),
      html: esc(verdictText(v, false)) + usa + bar,
      tip: lines.filter(Boolean).join('\n'),
    };
  }

  function badgeFor(card) {
    let host = null;
    for (const ch of card.children) if (ch.tagName === 'WEFT-BADGE') host = ch;
    if (!host) {
      host = document.createElement('weft-badge');
      const root = host.attachShadow({ mode: 'open' });
      root.innerHTML = `<style>${BADGE_CSS}</style><span class="b"></span>`;
      if (getComputedStyle(card).position === 'static') {
        restorePosition.set(card, card.style.position);
        card.style.position = 'relative';
      }
      card.appendChild(host);
    }
    return host;
  }

  function decorate(p) {
    if (!running) return;
    if (p.state === 'skip') {
      for (const card of p.cards) {
        for (const ch of [...card.children]) if (ch.tagName === 'WEFT-BADGE') ch.remove();
        card.removeAttribute('data-weft-state');
      }
      return;
    }
    const c = p.state === 'new' ? null : badgeContent(p);
    const v = verdictFor(p);
    for (const card of p.cards) {
      if (!card.isConnected) continue;
      if (c) {
        const host = badgeFor(card);
        const span = host.shadowRoot.querySelector('.b');
        span.className = 'b ' + c.cls;
        span.innerHTML = c.html;
        host.title = c.tip;
      }
      const highlight = settings.threshold > 0 || settings.avoid.length || settings.usaOnly;
      const state = v === 'match' ? (highlight ? 'match' : '') : v === 'below' ? settings.mode : '';
      if (state) card.setAttribute('data-weft-state', state);
      else card.removeAttribute('data-weft-state');
    }
  }

  function applyAll() {
    for (const p of products.values()) decorate(p);
    render();
  }

  function nextMatch() {
    const cards = [];
    for (const p of products.values()) {
      if (verdictFor(p) !== 'match') continue;
      for (const card of p.cards) if (card.isConnected) cards.push(card);
    }
    if (!cards.length) return;
    cards.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
    const target = cards.find((c) => c.getBoundingClientRect().top > 140) || cards[0];
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target.setAttribute('data-weft-flash', '');
    setTimeout(() => target.removeAttribute('data-weft-flash'), 2600);
  }

  // ---------- panel ----------

  const host = document.createElement('div');
  host.setAttribute('data-weft-ui', '');
  host.style.cssText = 'all: initial; position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;';
  const ui = host.attachShadow({ mode: 'open' });

  // Weft's mark: a square of plain-woven threads.
  const LOGO = 
    '<svg viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="7" fill="#2d3f6b"/><rect x="6.6" y="5.2" width="5.8" height="21.6" fill="#f6f1e6"/><rect x="13.1" y="5.2" width="5.8" height="21.6" fill="#f6f1e6"/><rect x="19.6" y="5.2" width="5.8" height="21.6" fill="#f6f1e6"/><rect x="5.2" y="6.6" width="21.6" height="5.8" fill="#d6c5a0"/><rect x="5.2" y="13.1" width="21.6" height="5.8" fill="#d6c5a0"/><rect x="5.2" y="19.6" width="21.6" height="5.8" fill="#d6c5a0"/><rect x="6.6" y="6.6" width="5.8" height="5.8" fill="#2d3f6b"/><rect x="6.6" y="7.05" width="5.8" height="4.9" fill="#d6c5a0"/><rect x="6.6" y="13.1" width="5.8" height="5.8" fill="#2d3f6b"/><rect x="7.05" y="13.1" width="4.9" height="5.8" fill="#f6f1e6"/><rect x="6.6" y="19.6" width="5.8" height="5.8" fill="#2d3f6b"/><rect x="6.6" y="20.05" width="5.8" height="4.9" fill="#d6c5a0"/><rect x="13.1" y="6.6" width="5.8" height="5.8" fill="#2d3f6b"/><rect x="13.55" y="6.6" width="4.9" height="5.8" fill="#f6f1e6"/><rect x="13.1" y="13.1" width="5.8" height="5.8" fill="#2d3f6b"/><rect x="13.1" y="13.55" width="5.8" height="4.9" fill="#d6c5a0"/><rect x="13.1" y="19.6" width="5.8" height="5.8" fill="#2d3f6b"/><rect x="13.55" y="19.6" width="4.9" height="5.8" fill="#f6f1e6"/><rect x="19.6" y="6.6" width="5.8" height="5.8" fill="#2d3f6b"/><rect x="19.6" y="7.05" width="5.8" height="4.9" fill="#d6c5a0"/><rect x="19.6" y="13.1" width="5.8" height="5.8" fill="#2d3f6b"/><rect x="20.05" y="13.1" width="4.9" height="5.8" fill="#f6f1e6"/><rect x="19.6" y="19.6" width="5.8" height="5.8" fill="#2d3f6b"/><rect x="19.6" y="20.05" width="5.8" height="4.9" fill="#d6c5a0"/></svg>';

  const chip = (attr, value, text, title) =>
    `<button class="chip" ${attr}="${value}"${title ? ` title="${esc(title)}"` : ''}>${esc(text)}</button>`;
  const NATURAL_TITLE = 'Cotton, linen, wool, cashmere, silk, hemp, alpaca, mohair, angora, ramie, camel, yak';
  const SYNTH_TITLE = 'Polyester, nylon, acrylic, spandex, polyurethane, polypropylene, metallic, rubber';
  const host_ = location.host.replace(/^www\./, '');

  // The panel is styled like a garment's fabric-content label: woven paper, stitched edges, printed type.
  ui.innerHTML = `
  <style>
    :host {
      --paper: #f6f1e6; --paper-2: #ede5d4; --ink: #1f1c18; --muted: #6f675b; --stitch: #c9bda6;
      --brand: #2d3f6b; --brand-ink: #f6f1e6; --yes: #2f6b45; --mid: #8a5d10; --no: #a23e2c; --unk: #7a7266;
      --shadow: 0 1px 0 rgba(31,28,24,.05), 0 14px 30px -10px rgba(31,28,24,.4);
      --mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace;
      --serif: ui-serif, "New York", "Iowan Old Style", Georgia, serif;
      --sans: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    }
    @media (prefers-color-scheme: dark) {
      :host {
        --paper: #1d1b18; --paper-2: #29261f; --ink: #ece5d6; --muted: #a59c8c; --stitch: #4d473c;
        --brand: #aebde6; --brand-ink: #1d1b18; --yes: #8fc9a0; --mid: #e0b660; --no: #ee9c88; --unk: #a39a8d;
        --shadow: 0 14px 30px -10px rgba(0,0,0,.7);
      }
    }
    * { box-sizing: border-box; }
    .panel, .mini { font: 13px/1.45 var(--sans); color: var(--ink); }
    .panel { width: 300px; max-height: calc(100vh - 32px); display: flex; flex-direction: column; background: var(--paper);
             border-radius: 6px; box-shadow: var(--shadow); outline: 1px dashed var(--stitch); outline-offset: -6px; overflow: hidden; }
    .body { overflow-y: auto; overscroll-behavior: contain; }
    header, section, footer { margin: 0 6px; padding: 12px 10px; }
    section, footer { border-top: 1px dashed var(--stitch); }
    header { display: flex; align-items: center; justify-content: space-between; padding: 12px 6px 10px 10px; flex: none; }
    .brand { display: flex; align-items: center; gap: 8px; }
    .brand svg { width: 20px; height: 20px; }
    .word { font: 600 20px/1 var(--serif); letter-spacing: -.01em; }
    .icon { width: 26px; height: 26px; border: 0; background: transparent; color: var(--muted); border-radius: 4px; cursor: pointer; font: 17px/1 var(--sans); }
    .icon:hover { background: var(--paper-2); color: var(--ink); }
    .cap { font: 600 10px/1 var(--mono); letter-spacing: .14em; text-transform: uppercase; color: var(--muted); margin-bottom: 9px; }

    .verdict { font: 700 17px/1.2 var(--mono); text-transform: uppercase; letter-spacing: .01em; }
    .yes { color: var(--yes); } .mid { color: var(--mid); } .no { color: var(--no); } .unk { color: var(--unk); }
    .bigbar { display: flex; gap: 2px; height: 6px; margin: 9px 0 6px; }
    .bigbar span { min-width: 3px; }
    .legend { list-style: none; margin: 0; padding: 0; }
    .fiber { width: 100%; display: flex; align-items: baseline; border: 0; background: transparent; color: var(--ink); padding: 3px 0;
             font: 500 11.5px/1.3 var(--mono); text-transform: uppercase; letter-spacing: .03em; cursor: pointer; text-align: left; }
    .fiber:hover .fname { text-decoration: underline; text-underline-offset: 3px; }
    .dot { width: 8px; height: 8px; border-radius: 1px; flex: none; margin-right: 7px; align-self: center; }
    .lead { flex: 1; border-bottom: 1px dotted var(--stitch); margin: 0 6px; transform: translateY(-3px); }
    .kind { color: var(--muted); font-weight: 400; margin-left: 6px; text-transform: none; letter-spacing: 0; font-family: var(--sans); font-size: 11px; }
    .fact { margin: 2px 0 6px 15px; font-size: 12px; color: var(--muted); }
    .detail { color: var(--muted); font-size: 12px; margin-top: 6px; white-space: pre-line; }
    .origin { font: 600 11px/1 var(--mono); letter-spacing: .08em; text-transform: uppercase; margin-top: 10px; }

    .tally { display: flex; gap: 16px; font: 12px/1.2 var(--sans); color: var(--muted); }
    .tally b { display: block; font: 700 18px/1.1 var(--mono); color: var(--ink); }
    .tally .m b { color: var(--yes); }
    .progress { height: 2px; background: var(--paper-2); margin: 10px 0 6px; }
    .bar { height: 100%; width: 0; background: var(--ink); transition: width .3s ease; }
    .ptext { font-size: 12px; color: var(--muted); }

    .row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    output { font: 700 12px var(--mono); }
    .chips { display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 14px; }
    .chip { font: 12px/1.3 var(--sans); padding: 3px 8px; border-radius: 3px; border: 1px solid var(--stitch); background: transparent; color: var(--ink); cursor: pointer; }
    .chip:hover { border-color: var(--muted); }
    .chip[aria-pressed="true"] { background: var(--ink); border-color: var(--ink); color: var(--paper); }
    .avoid .chip[aria-pressed="true"] { background: var(--no); border-color: var(--no); color: var(--paper); }
    .chip.preset { border-style: dashed; }
    .chip.preset[aria-pressed="true"] { border-style: solid; }
    input[type=range] { -webkit-appearance: none; appearance: none; width: 100%; height: 20px; margin: 4px 0 10px; background: transparent; cursor: pointer; }
    input[type=range]::-webkit-slider-runnable-track { height: 2px; background: var(--ink); }
    input[type=range]::-webkit-slider-thumb { -webkit-appearance: none; width: 11px; height: 17px; margin-top: -7.5px; border-radius: 2px;
                                              background: var(--paper); border: 1.5px solid var(--ink); }
    .seg { display: inline-flex; gap: 2px; }
    .seg button { border: 0; background: transparent; color: var(--muted); font: 12px var(--sans); padding: 2px 5px; cursor: pointer; }
    .seg button[aria-pressed="true"] { color: var(--ink); font-weight: 600; text-decoration: underline; text-decoration-thickness: 1.5px; text-underline-offset: 4px; }
    .more { width: 100%; display: flex; align-items: center; justify-content: space-between; margin-top: 12px; padding: 0; border: 0;
            background: transparent; color: var(--ink); font: 600 12.5px var(--sans); cursor: pointer; }
    .more .pm { font: 600 14px/1 var(--mono); color: var(--muted); }
    .morecount { color: var(--muted); font-weight: 400; }
    .extra { padding-top: 12px; }
    .extra .row { margin-bottom: 12px; }
    .sub { font-size: 12px; color: var(--muted); margin-bottom: 6px; }
    .check, .auto { display: flex; align-items: flex-start; gap: 8px; font-size: 12px; cursor: pointer; }
    .check { margin-top: 8px; color: var(--muted); }
    .check input, .auto input { accent-color: var(--ink); margin: 2px 0 0; }
    .auto small { display: block; color: var(--muted); font-size: 11.5px; }
    .paused { background: color-mix(in srgb, var(--mid) 9%, transparent); font-size: 12.5px; }
    .resume { margin-top: 8px; font: 600 12px var(--sans); padding: 5px 10px; border-radius: 4px; cursor: pointer;
              border: 1px solid var(--ink); background: transparent; color: var(--ink); }

    footer { display: flex; gap: 8px; flex: none; padding: 10px 10px 12px; }
    footer button { flex: 1; font: 600 12.5px var(--sans); padding: 8px 10px; border-radius: 4px; cursor: pointer;
                    border: 1px solid var(--stitch); background: transparent; color: var(--ink); }
    footer button.primary { background: var(--brand); border-color: var(--brand); color: var(--brand-ink); }
    footer button:disabled { opacity: .4; cursor: default; }
    button:focus-visible, input:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }

    .mini { display: flex; align-items: center; gap: 8px; background: var(--paper); border: 0; border-radius: 4px; padding: 7px 12px 7px 8px;
            box-shadow: var(--shadow); outline: 1px dashed var(--stitch); outline-offset: -4px; cursor: pointer;
            font: 600 11px/1 var(--mono); letter-spacing: .05em; text-transform: uppercase; color: var(--ink); }
    .mini svg { width: 18px; height: 18px; }
    [hidden] { display: none !important; }
  </style>
  <div class="panel" role="dialog" aria-label="Weft">
    <header>
      <div class="brand">${LOGO}<span class="word">weft</span></div>
      <div>
        <button class="icon" data-act="collapse" title="Minimize" aria-label="Minimize">&#8211;</button>
        <button class="icon" data-act="close" title="Close and remove labels" aria-label="Close">&times;</button>
      </div>
    </header>
    <div class="body">
      <section class="paused" hidden>
        <b>Paused.</b> ${esc(host_)} asked to confirm you're human, so Weft stopped opening product pages.
        Carry on browsing as normal, then resume (it will go slower).<br>
        <button class="resume" data-act="resume">Resume checking</button>
      </section>
      <section class="item" hidden>
        <div class="cap">Fabric content</div>
        <div class="verdict"></div>
        <div class="bigbar"></div>
        <ul class="legend"></ul>
        <div class="detail"></div>
        <div class="origin"></div>
      </section>
      <section class="scan">
        <div class="cap">On this page</div>
        <div class="tally">
          <span class="m"><b data-n="match">0</b>match</span>
          <span><b data-n="below">0</b>don't</span>
          <span><b data-n="unknown">0</b>not listed</span>
        </div>
        <div class="progress"><div class="bar"></div></div>
        <div class="ptext"></div>
      </section>
      <section class="controls">
        <div class="cap">Looking for</div>
        <div class="chips" role="group" aria-label="Materials to look for">
          ${P.MATERIALS.map((f) => chip('data-fiber', f, cap(f), P.FIBER_INFO[f])).join('')}
          <button class="chip preset" data-preset="natural" title="${NATURAL_TITLE}">All natural</button>
        </div>
        <label class="row" for="th"><span class="thname">Minimum cotton</span><output></output></label>
        <input id="th" type="range" min="0" max="100" step="5">
        <div class="row"><span>Items that don't match</span>
          <div class="seg" role="group" aria-label="Items that don't match">
            <button data-mode="dim">Fade</button><button data-mode="hide">Hide</button>
          </div>
        </div>
        <button class="more" aria-expanded="false"><span>More filters <span class="morecount"></span></span><span class="pm">+</span></button>
        <div class="extra" hidden>
          <div class="row"><span>Allow stretch</span>
            <div class="seg" role="group" aria-label="Allow stretch (spandex)" title="Count a little spandex/elastane as OK">
              <button data-stretch="0">None</button><button data-stretch="2">2%</button><button data-stretch="5">5%</button><button data-stretch="10">10%</button>
            </div>
          </div>
          <div class="sub">Avoid anything with</div>
          <div class="chips avoid" role="group" aria-label="Fibers to avoid">
            ${P.AVOIDABLE.map((f) => chip('data-avoid', f, cap(P.FIBER_LABELS[f] || f), P.FIBER_INFO[f])).join('')}
            <button class="chip preset" data-preset="synthetic" title="${SYNTH_TITLE}">All synthetic</button>
          </div>
          <label class="check"><input type="checkbox" class="usa"> Only items made in USA</label>
          <label class="check"><input type="checkbox" class="hu"> Treat "not listed" as no match</label>
        </div>
      </section>
      <section class="autorow" hidden>
        <label class="auto"><input type="checkbox" class="autobox"><span>Run automatically on ${esc(host_)}<small>Opens by itself whenever you visit this store</small></span></label>
      </section>
    </div>
    <footer>
      <button class="primary" data-act="next">Next match &darr;</button>
      <button data-act="rescan">Rescan</button>
    </footer>
  </div>
  <button class="mini" hidden title="Open Weft">${LOGO}<span class="mtext"></span></button>
  `;

  const $ = (s) => ui.querySelector(s);
  const panel = $('.panel');
  const mini = $('.mini');
  const range = $('#th');
  let openFact = null;

  ui.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const d = btn.dataset;
    if (d.act === 'close') api.close();
    else if (d.act === 'collapse') setCollapsed(true);
    else if (d.act === 'next') nextMatch();
    else if (d.act === 'rescan') rescan();
    else if (d.act === 'resume') {
      challenged = false;
      gentle = true;
      render();
      pump();
    }
    else if (d.fiber) {
      const cur = settings.fibers.filter((x) => P.MATERIALS.includes(x));
      const next = cur.includes(d.fiber) ? cur.filter((x) => x !== d.fiber) : cur.concat(d.fiber);
      if (next.length) update({ fibers: next }); // keep at least one material
    } else if (d.preset === 'natural') {
      update({ fibers: isSet(settings.fibers, P.NATURAL) ? ['cotton'] : P.NATURAL.slice() });
    } else if (d.avoid) {
      const cur = settings.avoid;
      update({ avoid: cur.includes(d.avoid) ? cur.filter((x) => x !== d.avoid) : cur.concat(d.avoid) });
    } else if (d.preset === 'synthetic') {
      update({ avoid: isSet(settings.avoid, P.SYNTHETIC) ? [] : P.SYNTHETIC.slice() });
    } else if (d.stretch) update({ stretch: Number(d.stretch) });
    else if (d.mode) update({ mode: d.mode });
    else if (btn.classList.contains('more')) update({ moreOpen: !settings.moreOpen });
    else if (btn.classList.contains('fiber')) {
      openFact = openFact === btn.dataset.f ? null : btn.dataset.f;
      itemKey = '';
      render();
    } else if (btn === mini) setCollapsed(false);
  });
  range.addEventListener('input', () => {
    settings.threshold = Number(range.value);
    applyAll();
  });
  range.addEventListener('change', saveSettings);
  $('.hu').addEventListener('change', (e) => update({ hideUnknown: e.target.checked }));
  $('.usa').addEventListener('change', (e) => update({ usaOnly: e.target.checked }));
  $('.autobox').addEventListener('change', (e) => setAutoRun(e.target.checked));

  function isSet(list, ref) {
    return list.length === ref.length && ref.every((f) => list.includes(f));
  }

  function update(changes) {
    Object.assign(settings, changes);
    saveSettings();
    applyAll();
  }

  function setCollapsed(v) {
    settings.collapsed = v;
    saveSettings();
    render();
  }

  function saveSettings() {
    storageSet({ [SETTINGS_KEY]: settings });
  }

  function rescan() {
    for (const p of products.values()) {
      if (p.result && (p.result.kind === 'error' || p.result.kind === 'unknown')) {
        p.result = null;
        p.state = 'queued';
        p.retries = 0;
        memCache.delete(p.key);
        decorate(p);
      }
    }
    pageVerdict = null;
    pageChecks = 0;
    pageFetched = false;
    discover();
    pump();
  }

  // ---------- auto-run on this store ----------

  const runtime = typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id ? chrome.runtime : null;
  let autoOn = AUTO;

  function send(msg) {
    return new Promise((resolve) => {
      try {
        runtime.sendMessage(msg, (reply) => {
          void chrome.runtime.lastError;
          resolve(reply || null);
        });
      } catch (e) {
        resolve(null); // extension was reloaded
      }
    });
  }

  async function refreshAuto() {
    if (!runtime || !running) return;
    const r = await send({ type: 'auto-status', origin: location.origin });
    if (r) autoOn = Boolean(r.on);
    render();
  }

  async function setAutoRun(on) {
    // Turning it on opens a small window where the browser asks for permission for this site.
    await send({ type: on ? 'auto-enable' : 'auto-disable', origin: location.origin });
    if (!on) autoOn = false;
    render();
  }

  // ---------- rendering ----------

  let itemKey = '';
  function renderItem() {
    const item = $('.item');
    item.hidden = !pageVerdict;
    if (!pageVerdict) {
      itemKey = '';
      return;
    }
    const v = P.score(pageVerdict, prefs());
    const key = JSON.stringify([v, openFact]);
    if (key === itemKey) return;
    itemKey = key;

    const tone = { pure: 'yes', 'pure-main': 'yes', varies: 'yes', likely: 'yes', blend: 'mid', unknown: 'unk' }[v.status] || 'no';
    const el = $('.verdict');
    el.className = 'verdict ' + tone;
    el.textContent = verdictText(v, true);

    const bigbar = $('.bigbar');
    bigbar.hidden = !v.composition;
    bigbar.innerHTML = barHtml(v.composition);

    // Fiber rows, printed like a care label: "COTTON ........ 100%". Tap one for the fiber guide.
    const legend = $('.legend');
    legend.innerHTML = '';
    const entries = v.composition
      ? Object.entries(v.composition).sort((a, b) => b[1] - a[1])
      : (pageVerdict.fibers || []).map((f) => [f, null]);
    for (const [f, pct] of entries) {
      const li = document.createElement('li');
      const kind = { natural: 'natural', semi: 'wood-based', synthetic: 'synthetic' }[P.fiberKind(f)] || '';
      li.innerHTML =
        `<button class="fiber" data-f="${f}" aria-expanded="${openFact === f}">` +
        `<span class="dot" style="background:${colorOf(f)}"></span><span class="fname">${esc(P.FIBER_LABELS[f] || f)}</span>` +
        `<span class="kind">${kind}</span><span class="lead"></span><span class="fpct">${pct == null ? '' : Math.round(pct * 10) / 10 + '%'}</span></button>` +
        `<p class="fact"${openFact === f ? '' : ' hidden'}>${esc(P.FIBER_INFO[f] || '')}</p>`;
      legend.appendChild(li);
    }

    $('.detail').textContent = (v.composition ? v.details.filter((d) => d !== v.summary) : v.details).join('\n');
    const origin = $('.origin');
    origin.hidden = !v.origin;
    origin.textContent = v.origin ? (v.origin === 'Imported' ? 'Imported' : 'Made in ' + v.origin) : '';
  }

  let renderQueued = false;
  function render() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      if (!running) return;
      const n = { match: 0, below: 0, unknown: 0, pending: 0, skip: 0 };
      for (const p of products.values()) {
        if (![...p.cards].some((c) => c.isConnected)) continue;
        n[verdictFor(p)]++;
      }
      const total = n.match + n.below + n.unknown + n.pending;
      const done = total - n.pending;

      // When it starts by itself, stay out of the way until there's something to show.
      host.style.display = AUTO && !total && !pageVerdict ? 'none' : '';
      panel.hidden = settings.collapsed;
      mini.hidden = !settings.collapsed;
      $('.mtext').textContent = total
        ? `${n.match} ${n.match === 1 ? 'match' : 'matches'}${n.pending ? ` · ${done}/${total}` : ''}`
        : pageVerdict
          ? verdictText(P.score(pageVerdict, prefs()), true)
          : 'weft';

      $('.scan').hidden = !total && Boolean(pageVerdict);
      $('.bar').style.width = total ? (done / total) * 100 + '%' : '0';
      $('.ptext').textContent = !total
        ? 'No products found yet. Open a category or search page, or scroll to load more.'
        : n.pending
          ? `Checked ${done} of ${total}${challenged ? ' (paused)' : '…'}`
          : `Checked all ${total}`;
      for (const k of ['match', 'below', 'unknown']) $(`[data-n="${k}"]`).textContent = n[k];
      $('.tally').hidden = !total;
      $('.progress').hidden = !total;
      $('[data-act="next"]').disabled = !n.match;

      const natural = isSet(settings.fibers, P.NATURAL);
      for (const b of ui.querySelectorAll('[data-fiber]')) b.setAttribute('aria-pressed', String(!natural && settings.fibers.includes(b.dataset.fiber)));
      $('[data-preset="natural"]').setAttribute('aria-pressed', String(natural));
      const synth = isSet(settings.avoid, P.SYNTHETIC);
      for (const b of ui.querySelectorAll('[data-avoid]')) b.setAttribute('aria-pressed', String(!synth && settings.avoid.includes(b.dataset.avoid)));
      $('[data-preset="synthetic"]').setAttribute('aria-pressed', String(synth));
      for (const b of ui.querySelectorAll('[data-stretch]')) b.setAttribute('aria-pressed', String(Number(b.dataset.stretch) === settings.stretch));
      for (const b of ui.querySelectorAll('[data-mode]')) b.setAttribute('aria-pressed', String(b.dataset.mode === settings.mode));

      $('.thname').textContent = 'Minimum ' + P.wantedName(settings.fibers);
      range.value = settings.threshold;
      $('output').textContent = settings.threshold === 0 ? 'Any' : settings.threshold + '%';
      $('.hu').checked = settings.hideUnknown;
      $('.usa').checked = settings.usaOnly;

      $('.more').setAttribute('aria-expanded', String(settings.moreOpen));
      $('.more .pm').textContent = settings.moreOpen ? '−' : '+';
      $('.extra').hidden = !settings.moreOpen;
      const active = (settings.stretch ? 1 : 0) + (settings.avoid.length ? 1 : 0) + (settings.usaOnly ? 1 : 0) + (settings.hideUnknown ? 1 : 0);
      $('.morecount').textContent = active ? `· ${active} on` : '';

      $('.paused').hidden = !challenged;
      $('.autorow').hidden = !runtime;
      $('.autobox').checked = autoOn;

      renderItem();
    });
  }

  // ---------- watching the page ----------

  let discoverTimer = 0;
  function scheduleDiscover(delay = 600) {
    clearTimeout(discoverTimer);
    discoverTimer = setTimeout(discover, delay);
  }

  const observer = new MutationObserver((muts) => {
    for (const m of muts) {
      for (const n of m.addedNodes) {
        if (n.nodeType === 1 && !isOurs(n)) return scheduleDiscover();
      }
    }
  });
  const onScroll = () => scheduleDiscover(400);
  const onFocus = () => refreshAuto();

  const api = {
    close() {
      running = false;
      observer.disconnect();
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('focus', onFocus);
      clearTimeout(discoverTimer);
      host.remove();
      for (const el of styleEls) el.remove();
      for (const b of queryAll('weft-badge')) b.remove();
      for (const el of queryAll('[data-weft-card], [data-weft-key], [data-weft-state]')) {
        el.removeAttribute('data-weft-card');
        el.removeAttribute('data-weft-key');
        el.removeAttribute('data-weft-state');
      }
      for (const [card, pos] of restorePosition) card.style.position = pos;
      delete window.__weft;
    },
  };
  window.__weft = api;

  (async () => {
    const saved = (await storageGet(SETTINGS_KEY))[SETTINGS_KEY] || {};
    Object.assign(settings, saved, { collapsed: AUTO });
    if (!Array.isArray(settings.fibers) || !settings.fibers.length) settings.fibers = ['cotton'];
    if (!Array.isArray(settings.avoid)) settings.avoid = [];
    document.documentElement.appendChild(host);
    observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
    window.addEventListener('scroll', onScroll, { passive: true, capture: true });
    window.addEventListener('focus', onFocus);
    discover();
    refreshAuto();
  })();
})();
