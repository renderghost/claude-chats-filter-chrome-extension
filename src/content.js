// Content script: injects the filter dropdown and applies it via MutationObserver.

const CHAT_HREF_RE = /\/chat\/([0-9a-f-]{36})/i;
const ORG_POLL_INTERVAL_MS = 300;
const ORG_POLL_TIMEOUT_MS = 5000;

// State scoped to a single /recents session.
let chatMap = null;        // Map<chatUuid, projectUuid|null>
let activeFilter = '__all__';
let observer = null;
let selectEl = null;
let teardownFns = [];

// ─── Entry point ────────────────────────────────────────────────────────────

async function init() {
  teardown();

  const orgUuid = await resolveOrgUuid();
  if (!orgUuid) {
    console.error('[claude-filter] Could not determine org UUID within timeout.');
    injectErrorSelect('Could not determine organisation UUID.');
    return;
  }

  injectLoadingSelect();

  let projects;
  try {
    [chatMap, projects] = await Promise.all([
      fetchAllChats(orgUuid),
      fetchAllProjects(orgUuid),
    ]);
  } catch (err) {
    console.error('[claude-filter] API fetch failed:', err);
    markSelectError('Failed to load data: ' + err.message);
    return;
  }

  injectSelect(projects);
  attachObserver();
  applyFilter();
}

// ─── Org UUID resolution ─────────────────────────────────────────────────────

function resolveOrgUuid() {
  return new Promise((resolve) => {
    const deadline = Date.now() + ORG_POLL_TIMEOUT_MS;

    // The background script may push the UUID to us directly.
    const messageHandler = (msg) => {
      if (msg.type === 'ORG_UUID') {
        chrome.runtime.onMessage.removeListener(messageHandler);
        clearInterval(pollId);
        resolve(msg.orgUuid);
      }
    };
    chrome.runtime.onMessage.addListener(messageHandler);
    teardownFns.push(() => chrome.runtime.onMessage.removeListener(messageHandler));

    // Also poll in case the webRequest fired before the content script loaded.
    const pollId = setInterval(async () => {
      if (Date.now() > deadline) {
        clearInterval(pollId);
        chrome.runtime.onMessage.removeListener(messageHandler);
        resolve(null);
        return;
      }
      try {
        const resp = await chrome.runtime.sendMessage({ type: 'POLL_ORG_UUID' });
        if (resp?.orgUuid) {
          clearInterval(pollId);
          chrome.runtime.onMessage.removeListener(messageHandler);
          resolve(resp.orgUuid);
        }
      } catch (_) {
        // Service worker not yet ready; keep polling.
      }
    }, ORG_POLL_INTERVAL_MS);

    teardownFns.push(() => clearInterval(pollId));
  });
}

// ─── Select injection ────────────────────────────────────────────────────────

function findAnchorPoint() {
  // Look for the "New chat" button container — a stable landmark at the top of
  // the recents list. We'll insert the select immediately before it.
  // Claude's DOM varies, so we try several selectors in order of preference.
  const candidates = [
    '[data-testid="new-chat-button"]',
    'a[href="/new"]',
    'button[aria-label*="New chat" i]',
    'nav a[href="/new"]',
  ];
  for (const sel of candidates) {
    const el = document.querySelector(sel);
    if (el) return el;
  }
  // Fallback: insert at the top of <main>.
  return document.querySelector('main') ?? document.body;
}

function injectLoadingSelect() {
  const anchor = findAnchorPoint();
  const placeholder = document.createElement('select');
  placeholder.id = SELECT_ID;
  placeholder.disabled = true;
  placeholder.style.cssText = 'margin: 0 8px; font-size: inherit;';
  const opt = document.createElement('option');
  opt.textContent = 'Loading filter…';
  placeholder.appendChild(opt);
  anchor.insertAdjacentElement('beforebegin', placeholder);
  selectEl = placeholder;
}

function injectErrorSelect(message) {
  const anchor = findAnchorPoint();
  const sel = buildSelect([]);
  setSelectError(sel, message);
  anchor.insertAdjacentElement('beforebegin', sel);
  selectEl = sel;
}

function markSelectError(message) {
  if (selectEl) {
    setSelectError(selectEl, message);
  } else {
    injectErrorSelect(message);
  }
}

function injectSelect(projects) {
  const anchor = findAnchorPoint();
  // Remove placeholder if present.
  document.getElementById(SELECT_ID)?.remove();

  selectEl = buildSelect(projects);
  selectEl.value = VALUE_ALL;
  selectEl.addEventListener('change', () => {
    activeFilter = selectEl.value;
    applyFilter();
  });
  anchor.insertAdjacentElement('beforebegin', selectEl);
}

// ─── Filtering ───────────────────────────────────────────────────────────────

function getChatRows() {
  // Each chat row contains an anchor whose href is /chat/{uuid}.
  return Array.from(document.querySelectorAll('a[href*="/chat/"]'))
    .map((a) => {
      const m = CHAT_HREF_RE.exec(a.getAttribute('href') ?? '');
      if (!m) return null;
      // Walk up to find the list-item / row wrapper.
      const row = a.closest('li') ?? a.closest('[role="listitem"]') ?? a.parentElement;
      return { row, uuid: m[1] };
    })
    .filter(Boolean);
}

function applyFilter() {
  if (!chatMap) return;
  for (const { row, uuid } of getChatRows()) {
    let visible;
    if (activeFilter === VALUE_ALL) {
      visible = true;
    } else if (activeFilter === VALUE_NO_PROJECT) {
      const projectUuid = chatMap.has(uuid) ? chatMap.get(uuid) : undefined;
      // Unknown chats (created after load) stay visible.
      visible = projectUuid === null || projectUuid === undefined;
    } else {
      const projectUuid = chatMap.has(uuid) ? chatMap.get(uuid) : undefined;
      visible = projectUuid === undefined || projectUuid === activeFilter;
    }
    row.style.display = visible ? '' : 'none';
  }
}

// ─── MutationObserver ────────────────────────────────────────────────────────

function attachObserver() {
  const target = document.querySelector('main') ?? document.body;
  observer = new MutationObserver(() => applyFilter());
  observer.observe(target, { childList: true, subtree: true });
  teardownFns.push(() => {
    observer?.disconnect();
    observer = null;
  });
}

// ─── Teardown ────────────────────────────────────────────────────────────────

function teardown() {
  for (const fn of teardownFns) fn();
  teardownFns = [];
  document.getElementById(SELECT_ID)?.remove();
  selectEl = null;
  chatMap = null;
  activeFilter = '__all__';
  observer = null;
}

// ─── SPA navigation handling ─────────────────────────────────────────────────

function isRecentsPage() {
  return location.pathname.startsWith('/recents');
}

function handleNavigation() {
  if (isRecentsPage()) {
    if (!document.getElementById(SELECT_ID)) {
      init();
    }
  } else {
    teardown();
  }
}

// Patch history methods to detect SPA navigation.
(function patchHistory() {
  const origPushState = history.pushState.bind(history);
  const origReplaceState = history.replaceState.bind(history);

  history.pushState = function (...args) {
    origPushState(...args);
    handleNavigation();
  };
  history.replaceState = function (...args) {
    origReplaceState(...args);
    handleNavigation();
  };

  window.addEventListener('popstate', handleNavigation);
})();

// ─── Bootstrap ───────────────────────────────────────────────────────────────

if (isRecentsPage()) {
  init();
}
