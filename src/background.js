// Service worker: captures the org UUID from the first API request and relays
// it to whichever tab is on /recents.

const ORG_UUID_RE = /\/api\/organizations\/([0-9a-f-]{36})\//i;

// Map of tabId → orgUuid for tabs that haven't been notified yet.
const pending = new Map();

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    const match = ORG_UUID_RE.exec(details.url);
    if (!match) return;
    const orgUuid = match[1];
    const tabId = details.tabId;
    if (tabId < 0) return;

    // Try to push it to the content script immediately.
    chrome.tabs.sendMessage(tabId, { type: 'ORG_UUID', orgUuid }, () => {
      // If the content script isn't ready yet, stash it so it can poll.
      if (chrome.runtime.lastError) {
        pending.set(tabId, orgUuid);
      }
    });
  },
  { urls: ['https://claude.ai/api/organizations/*/*'] }
);

// Content script polls via runtime.sendMessage when the webRequest fired
// before the content script was ready.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'POLL_ORG_UUID') {
    const tabId = sender.tab?.id;
    if (tabId !== undefined && pending.has(tabId)) {
      sendResponse({ orgUuid: pending.get(tabId) });
      pending.delete(tabId);
    } else {
      sendResponse({ orgUuid: null });
    }
  }
});

// Clean up stale entries when a tab closes.
chrome.tabs.onRemoved.addListener((tabId) => {
  pending.delete(tabId);
});
