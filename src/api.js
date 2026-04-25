// Fetch helpers with rate-limit throttling and exponential back-off.

const PAGE_LIMIT = 30;
const PAGE_DELAY_MS = 200;
const BACKOFF_DELAYS_MS = [1000, 2000, 4000];

async function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(url) {
  let lastError;
  for (let attempt = 0; attempt <= BACKOFF_DELAYS_MS.length; attempt++) {
    if (attempt > 0) {
      await delay(BACKOFF_DELAYS_MS[attempt - 1]);
    }
    let res;
    try {
      res = await fetch(url, { credentials: 'include' });
    } catch (err) {
      lastError = err;
      continue;
    }
    if (res.status === 429 && attempt < BACKOFF_DELAYS_MS.length) {
      lastError = new Error(`HTTP 429 from ${url}`);
      continue;
    }
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} from ${url}`);
    }
    return res.json();
  }
  throw lastError ?? new Error(`Failed to fetch ${url}`);
}

// Fetches all chats and returns Map<chatUuid, projectUuid|null>.
async function fetchAllChats(orgUuid) {
  const map = new Map();
  let offset = 0;
  while (true) {
    const url =
      `https://claude.ai/api/organizations/${orgUuid}/chat_conversations_v2` +
      `?limit=${PAGE_LIMIT}&offset=${offset}&consistency=eventual`;
    const json = await fetchWithRetry(url);
    for (const chat of json.data ?? []) {
      map.set(chat.uuid, chat.project_uuid ?? null);
    }
    if (!json.has_more) break;
    offset += PAGE_LIMIT;
    await delay(PAGE_DELAY_MS);
  }
  return map;
}

// Fetches all non-archived projects and returns Array<{uuid, name}>.
async function fetchAllProjects(orgUuid) {
  const projects = [];
  let offset = 0;
  while (true) {
    const url =
      `https://claude.ai/api/organizations/${orgUuid}/projects` +
      `?include_harmony_projects=true&limit=${PAGE_LIMIT}&order_by=latest_chat&offset=${offset}`;
    const page = await fetchWithRetry(url);
    for (const proj of page) {
      if (!proj.archived_at) {
        projects.push({ uuid: proj.uuid, name: proj.name });
      }
    }
    if (page.length < PAGE_LIMIT) break;
    offset += PAGE_LIMIT;
    await delay(PAGE_DELAY_MS);
  }
  return projects;
}
