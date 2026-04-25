// Content script: injects filter dropdown on /recents, applies filter via MutationObserver.

const CHAT_HREF_RE = /\/chat\/([0-9a-f-]{36})/i;
const ORG_UUID_RE_SRC = '\\/api\\/organizations\\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\\/';
const ORG_POLL_MS = 300;
const ORG_TIMEOUT_MS = 5000;
const ANCHOR_TIMEOUT_MS = 8000;

const ANCHOR_SELECTORS = [
  '[data-testid="new-chat-button"]',
  'a[href="/new"]',
  'a[href="/new-chat"]',
  'button[aria-label*="New chat" i]',
  '[aria-label*="new chat" i]',
];

let chatMap = null;
let activeFilter = VALUE_ALL;
let domObserver = null;
let selectEl = null;
let teardownFns = [];
let initSession = 0;

// ─── Fetch interceptor ────────────────────────────────────────────────────────
// Injected as a <script> tag so it runs in the page's JS world and can wrap
// window.fetch before the page makes any API calls.

function injectFetchInterceptor() {
  const script = document.createElement('script');
  script.textContent = `(function(){
    var re = new RegExp(${JSON.stringify(ORG_UUID_RE_SRC)}, 'i');
    var orig = window.fetch;
    window.fetch = function(input, init) {
      try {
        var url = typeof input === 'string' ? input : (input && input.url) || '';
        var m = re.exec(url);
        if (m) document.dispatchEvent(new CustomEvent('__cf_org__', {detail: m[1]}));
      } catch(e) {}
      return orig.apply(this, arguments);
    };
  })();`;
  (document.head || document.documentElement).appendChild(script);
  script.remove();
}

// ─── Org UUID from __NEXT_DATA__ ──────────────────────────────────────────────

function getOrgUuidFromNextData() {
  try {
    const el = document.getElementById('__NEXT_DATA__');
    if (!el) return null;
    const pp = JSON.parse(el.textContent)?.props?.pageProps;
    return (
      pp?.account?.membership?.organization?.uuid ||
      pp?.organization?.uuid ||
      pp?.org?.uuid ||
      null
    );
  } catch (e) {
    return null;
  }
}

// ─── Wait for anchor ──────────────────────────────────────────────────────────
// Claude is a React SPA; elements don't exist at document_idle. We observe the
// DOM until the "New chat" button appears, then resolve with it (or null).

function pickAnchor() {
  for (const sel of ANCHOR_SELECTORS) {
    const el = document.querySelector(sel);
    if (el) return el;
  }
  return null;
}

function waitForAnchor() {
  return new Promise((resolve) => {
    const existing = pickAnchor();
    if (existing) { resolve(existing); return; }

    const obs = new MutationObserver(() => {
      const el = pickAnchor();
      if (el) { obs.disconnect(); clearTimeout(t); resolve(el); }
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });

    const t = setTimeout(() => {
      obs.disconnect();
      console.warn('[claude-filter] No anchor found after', ANCHOR_TIMEOUT_MS, 'ms; using fixed fallback');
      resolve(null);
    }, ANCHOR_TIMEOUT_MS);
  });
}

// ─── Org UUID resolution ──────────────────────────────────────────────────────

function resolveOrgUuid() {
  return new Promise((resolve) => {
    // 1. Instant: try __NEXT_DATA__ (present on SSR'd Next.js pages).
    const fromPage = getOrgUuidFromNextData();
    if (fromPage) {
      console.log('[claude-filter] orgUuid from __NEXT_DATA__:', fromPage);
      resolve(fromPage);
      return;
    }

    let done = false;
    const deadline = Date.now() + ORG_TIMEOUT_MS;

    function finish(uuid) {
      if (done) return;
      done = true;
      document.removeEventListener('__cf_org__', onIntercept);
      try { chrome.runtime.onMessage.removeListener(onMsg); } catch (_) {}
      clearInterval(pollId);
      resolve(uuid);
    }

    // 2. Fetch interceptor event (fires as soon as the page calls any org API).
    function onIntercept(e) {
      console.log('[claude-filter] orgUuid from fetch interceptor:', e.detail);
      finish(e.detail);
    }
    document.addEventListener('__cf_org__', onIntercept);
    teardownFns.push(() => document.removeEventListener('__cf_org__', onIntercept));

    // 3. Push from service worker via webRequest (reliable if SW is already running).
    function onMsg(msg) {
      if (msg.type === 'ORG_UUID') {
        console.log('[claude-filter] orgUuid from webRequest:', msg.orgUuid);
        finish(msg.orgUuid);
      }
    }
    try { chrome.runtime.onMessage.addListener(onMsg); } catch (_) {}
    teardownFns.push(() => { try { chrome.runtime.onMessage.removeListener(onMsg); } catch (_) {} });

    // 4. Poll the service worker's stash (handles the race where webRequest fired
    //    before the content script registered its listener).
    const pollId = setInterval(async () => {
      if (done) { clearInterval(pollId); return; }
      if (Date.now() > deadline) {
        console.error('[claude-filter] orgUuid timed out after', ORG_TIMEOUT_MS, 'ms');
        clearInterval(pollId);
        finish(null);
        return;
      }
      try {
        const resp = await chrome.runtime.sendMessage({ type: 'POLL_ORG_UUID' });
        if (resp?.orgUuid) {
          console.log('[claude-filter] orgUuid from poll:', resp.orgUuid);
          finish(resp.orgUuid);
        }
      } catch (_) {}
    }, ORG_POLL_MS);
    teardownFns.push(() => clearInterval(pollId));
  });
}

// ─── DOM insertion ────────────────────────────────────────────────────────────
// When no anchor is found (null), we fall back to a fixed-position element so
// the dropdown is always visible regardless of page layout.

function insertEl(el, anchor) {
  if (anchor) {
    anchor.insertAdjacentElement('beforebegin', el);
  } else {
    el.style.cssText += '; position:fixed !important; top:8px; right:8px; z-index:2147483647;';
    document.body.prepend(el);
  }
}

// ─── Select lifecycle ─────────────────────────────────────────────────────────

function injectLoadingSelect(anchor) {
  document.getElementById(SELECT_ID)?.remove();
  const sel = document.createElement('select');
  sel.id = SELECT_ID;
  sel.disabled = true;
  sel.style.cssText = 'margin:0 8px;font-size:inherit;';
  const opt = document.createElement('option');
  opt.textContent = 'Loading filter…';
  sel.appendChild(opt);
  insertEl(sel, anchor);
  selectEl = sel;
}

function injectFinalSelect(anchor, projects) {
  document.getElementById(SELECT_ID)?.remove();
  selectEl = buildSelect(projects);
  selectEl.value = VALUE_ALL;
  selectEl.addEventListener('change', () => {
    activeFilter = selectEl.value;
    applyFilter();
  });
  insertEl(selectEl, anchor);
}

function markError(msg) {
  if (selectEl) setSelectError(selectEl, msg);
}

// ─── Filtering ────────────────────────────────────────────────────────────────

function getChatRows() {
  return Array.from(document.querySelectorAll('a[href*="/chat/"]')).flatMap((a) => {
    const m = CHAT_HREF_RE.exec(a.getAttribute('href') ?? '');
    if (!m) return [];
    const row = a.closest('li') ?? a.closest('[role="listitem"]') ?? a.parentElement;
    return [{ row, uuid: m[1] }];
  });
}

function applyFilter() {
  if (!chatMap) return;
  for (const { row, uuid } of getChatRows()) {
    const proj = chatMap.has(uuid) ? chatMap.get(uuid) : undefined;
    let visible;
    if (activeFilter === VALUE_ALL) {
      visible = true;
    } else if (activeFilter === VALUE_NO_PROJECT) {
      visible = proj === null || proj === undefined;
    } else {
      visible = proj === undefined || proj === activeFilter;
    }
    row.style.display = visible ? '' : 'none';
  }
}

// ─── MutationObserver ─────────────────────────────────────────────────────────

function attachObserver() {
  const target = document.querySelector('main') ?? document.body;
  domObserver = new MutationObserver(applyFilter);
  domObserver.observe(target, { childList: true, subtree: true });
  teardownFns.push(() => { domObserver?.disconnect(); domObserver = null; });
}

// ─── Teardown ─────────────────────────────────────────────────────────────────

function teardown() {
  initSession++;
  for (const fn of teardownFns) { try { fn(); } catch (_) {} }
  teardownFns = [];
  document.getElementById(SELECT_ID)?.remove();
  selectEl = null;
  chatMap = null;
  activeFilter = VALUE_ALL;
  domObserver = null;
}

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  teardown();
  const session = initSession;
  console.log('[claude-filter] init() session', session);

  injectFetchInterceptor();

  const [anchor, orgUuid] = await Promise.all([waitForAnchor(), resolveOrgUuid()]);
  if (initSession !== session) return;

  console.log(
    '[claude-filter] anchor:', anchor ? anchor.tagName : 'null(fixed)',
    '| orgUuid:', orgUuid
  );

  if (!orgUuid) {
    const errSel = buildSelect([]);
    setSelectError(errSel, 'Could not determine organisation UUID. Open DevTools > Console for details.');
    insertEl(errSel, anchor);
    selectEl = errSel;
    return;
  }

  injectLoadingSelect(anchor);

  let projects;
  try {
    [chatMap, projects] = await Promise.all([fetchAllChats(orgUuid), fetchAllProjects(orgUuid)]);
  } catch (err) {
    console.error('[claude-filter] API error:', err);
    if (initSession === session) markError('Data load failed: ' + err.message);
    return;
  }

  if (initSession !== session) return;

  console.log('[claude-filter] loaded', chatMap.size, 'chats,', projects.length, 'projects');
  injectFinalSelect(anchor, projects);
  attachObserver();
  applyFilter();
}

// ─── SPA navigation ───────────────────────────────────────────────────────────

function isRecentsPage() {
  return location.pathname.startsWith('/recents');
}

function handleNavigation() {
  if (isRecentsPage()) {
    if (!document.getElementById(SELECT_ID)) init();
  } else {
    teardown();
  }
}

(function patchHistory() {
  const origPush = history.pushState.bind(history);
  const origReplace = history.replaceState.bind(history);
  history.pushState = function (...args) { origPush(...args); handleNavigation(); };
  history.replaceState = function (...args) { origReplace(...args); handleNavigation(); };
  window.addEventListener('popstate', handleNavigation);
})();

// ─── Bootstrap ────────────────────────────────────────────────────────────────

if (isRecentsPage()) init();
