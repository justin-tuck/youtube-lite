'use strict';

/* ================= Storage ================= */

const DATA_KEY = 'ytlite.data.v1';   // creators, categories, seen, settings
const CACHE_KEY = 'ytlite.cache.v1'; // last fetched videos (rebuildable)
const VIEW_KEY = 'ytlite.view.v1';   // current filter / toggle
const STALE_MS = 15 * 60 * 1000;     // auto-refresh on open if older than this
const SEEN_TTL_MS = 365 * 24 * 3600 * 1000;

const uid = () => Math.random().toString(36).slice(2, 10);

function defaultData() {
  return {
    version: 1,
    categories: ['AI', 'Coding', 'Fitness', 'Finance'].map(name => ({ id: uid(), name })),
    creators: [],
    seen: {},
    settings: { apiKey: '', customProxy: '' },
  };
}

function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function save() {
  // Drop seen markers older than a year; feeds only show recent uploads anyway.
  const cutoff = Date.now() - SEEN_TTL_MS;
  for (const [id, t] of Object.entries(data.seen)) if (t < cutoff) delete data.seen[id];
  try {
    localStorage.setItem(DATA_KEY, JSON.stringify(data));
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
    localStorage.setItem(VIEW_KEY, JSON.stringify(view));
  } catch (err) {
    setStatus(`Could not save: ${err.message}`);
  }
}

let data = normalizeData(load(DATA_KEY, null)) || defaultData();
let cache = load(CACHE_KEY, { lastRefreshed: 0, feeds: {} });
let view = load(VIEW_KEY, { filter: 'all', onlyNew: false });
let refreshing = false;

/** Validates and cleans up stored or imported data. Returns null if unusable. */
function normalizeData(d) {
  if (!d || !Array.isArray(d.categories) || !Array.isArray(d.creators)) return null;
  const categories = d.categories
    .filter(c => c && c.name)
    .map(c => ({ id: String(c.id || uid()), name: String(c.name) }));
  const catIds = new Set(categories.map(c => c.id));
  const creators = d.creators
    .filter(c => c && /^UC[\w-]{22}$/.test(c.channelId))
    .map(c => ({
      id: String(c.id || uid()),
      name: String(c.name || c.channelId),
      channelId: c.channelId,
      // Only trust youtube.com links, since backups may come from someone else.
      url: /^https:\/\/www\.youtube\.com\/[\w@.\/-]+$/.test(c.url) ? c.url : `https://www.youtube.com/channel/${c.channelId}`,
      // Older data stored a single categoryId; convert it to the list form.
      categoryIds: [...new Set(Array.isArray(c.categoryIds) ? c.categoryIds : [c.categoryId])].filter(id => catIds.has(id)),
    }));
  const seen = {};
  if (d.seen && typeof d.seen === 'object') {
    for (const [id, t] of Object.entries(d.seen)) seen[id] = typeof t === 'number' ? t : Date.now();
  }
  const s = d.settings || {};
  return {
    version: 1, categories, creators, seen,
    settings: { apiKey: String(s.apiKey || ''), customProxy: String(s.customProxy || '') },
  };
}

/* ================= Fetching ================= */

/*
 * Pages opened from file:// have origin "null", and YouTube's RSS feeds send no
 * CORS headers, so the browser blocks reading them directly. Without an API key
 * we go through public CORS proxies, trying each until one answers. With an API
 * key we call the YouTube Data API, which allows cross-origin requests.
 */
const enc = encodeURIComponent;
const PROXIES = [
  { name: 'allorigins', url: u => `https://api.allorigins.win/get?url=${enc(u)}`, json: true },
  { name: 'allorigins-raw', url: u => `https://api.allorigins.win/raw?url=${enc(u)}` },
  { name: 'everyorigin', url: u => `https://everyorigin.jwvbremen.nl/api/get?url=${enc(u)}`, json: true },
  { name: 'cors.lol', url: u => `https://api.cors.lol/?url=${enc(u)}` },
  { name: 'codetabs', url: u => `https://api.codetabs.com/v1/proxy/?quest=${enc(u)}` },
];
let preferredProxy = null; // name of the last proxy that worked
let proxyStrikes = {};     // failures per proxy during the current refresh

/** Error meaning YouTube itself answered with an error (e.g. 404), so other proxies won't help. */
class UpstreamError extends Error {}

function proxyList() {
  const list = [...PROXIES];
  const custom = data.settings.customProxy.trim();
  if (custom) {
    list.unshift({
      name: 'custom',
      url: u => (custom.includes('{url}') ? custom.replace('{url}', enc(u)) : custom + enc(u)),
    });
  } else if (preferredProxy) {
    list.sort((a, b) => (b.name === preferredProxy) - (a.name === preferredProxy));
  }
  return list;
}

async function fetchViaProxy(target, timeoutMs = 12000) {
  const failures = [];
  const list = proxyList();
  // Skip proxies that keep failing during this refresh, unless that would skip them all.
  const usable = list.filter(p => (proxyStrikes[p.name] || 0) < 3);
  for (const proxy of usable.length ? usable : list) {
    try {
      const res = await fetch(proxy.url(target), { signal: AbortSignal.timeout(timeoutMs) });
      let body, status = res.status;
      if (proxy.json && res.ok) {
        const j = await res.json();
        body = j.contents;
        status = j.status?.http_code ?? status;
      } else {
        body = await res.text();
      }
      if (status === 404) throw new UpstreamError('Not found on YouTube (404)');
      if (status >= 400 || !body) throw new Error(`HTTP ${status}`);
      preferredProxy = proxy.name;
      proxyStrikes[proxy.name] = 0;
      return body;
    } catch (err) {
      if (err instanceof UpstreamError) throw err;
      proxyStrikes[proxy.name] = (proxyStrikes[proxy.name] || 0) + 1;
      failures.push(`${proxy.name}: ${err.name === 'TimeoutError' ? 'timed out' : err.message}`);
    }
  }
  throw new Error(`All proxies failed (${failures.join('; ')})`);
}

function parseFeed(xml) {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.querySelector('parsererror') || !doc.querySelector('feed')) throw new Error('Response was not a YouTube feed');
  const videos = [...doc.getElementsByTagName('entry')].map(e => ({
    id: e.getElementsByTagName('yt:videoId')[0]?.textContent || '',
    title: e.querySelector(':scope > title')?.textContent || '(untitled)',
    published: e.querySelector(':scope > published')?.textContent || '',
    url: e.querySelector(':scope > link')?.getAttribute('href') || '',
  })).filter(v => v.id);
  return {
    channelName: doc.querySelector('feed > author > name')?.textContent || '',
    channelId: doc.getElementsByTagName('yt:channelId')[0]?.textContent || '',
    videos,
  };
}

async function fetchFeedRss(channelId) {
  const base = 'https://www.youtube.com/feeds/videos.xml?';
  try {
    // "UULF" + id is the channel's uploads playlist without Shorts and live streams.
    return parseFeed(await fetchViaProxy(`${base}playlist_id=UULF${channelId.slice(2)}`));
  } catch (err) {
    if (!(err instanceof UpstreamError)) throw err;
    // Some channels lack that playlist; fall back to the full feed and drop Shorts.
    const feed = parseFeed(await fetchViaProxy(`${base}channel_id=${channelId}`));
    feed.videos = feed.videos.filter(v => !v.url.includes('/shorts/'));
    return feed;
  }
}

async function youtubeApi(path, params) {
  const qs = new URLSearchParams({ ...params, key: data.settings.apiKey.trim() });
  const res = await fetch(`https://www.googleapis.com/youtube/v3/${path}?${qs}`, { signal: AbortSignal.timeout(15000) });
  const j = await res.json().catch(() => ({}));
  if (res.status === 404) throw new UpstreamError(j.error?.message || 'Not found');
  if (!res.ok) throw new Error(`YouTube API: ${j.error?.message || `HTTP ${res.status}`}`);
  return j;
}

async function fetchFeedApi(channelId) {
  const get = playlistId => youtubeApi('playlistItems', { part: 'snippet', maxResults: 15, playlistId });
  let j;
  try {
    j = await get(`UULF${channelId.slice(2)}`);
  } catch (err) {
    if (!(err instanceof UpstreamError)) throw err;
    j = await get(`UU${channelId.slice(2)}`); // may include Shorts
  }
  const items = (j.items || []).map(i => i.snippet)
    .filter(s => s?.resourceId?.videoId && !/^(Private|Deleted) video$/.test(s.title));
  return {
    channelName: items[0]?.channelTitle || '',
    channelId,
    videos: items.map(s => ({
      id: s.resourceId.videoId,
      title: s.title,
      published: s.publishedAt,
      url: `https://www.youtube.com/watch?v=${s.resourceId.videoId}`,
    })),
  };
}

const fetchFeed = id => (data.settings.apiKey.trim() ? fetchFeedApi(id) : fetchFeedRss(id));

/**
 * Turns user input (channel ID, channel URL, @handle, /user/ or /c/ URL) into a
 * channel ID. Handles need a lookup: via the API if a key is set, otherwise by
 * scraping the channel page through a proxy, which is best-effort.
 */
async function resolveChannelId(input) {
  const s = input.trim();
  const direct = s.match(/\b(UC[\w-]{22})\b/);
  if (direct) return direct[1];

  const bare = s.match(/^@?([\w.-]{3,})$/)?.[1]; // "@name" or just "name"
  const handle = s.match(/youtube\.com\/(@[^/?#\s]+)/i)?.[1] || (bare && `@${bare}`);
  const user = s.match(/youtube\.com\/user\/([^/?#\s]+)/i)?.[1];
  const custom = s.match(/youtube\.com\/c\/([^/?#\s]+)/i)?.[1];
  if (!handle && !user && !custom) throw new Error('That doesn\'t look like a YouTube channel URL, @handle, or channel ID.');

  if (data.settings.apiKey.trim() && (handle || user)) {
    const j = await youtubeApi('channels', handle ? { part: 'id', forHandle: handle } : { part: 'id', forUsername: user });
    if (j.items?.[0]?.id) return j.items[0].id;
    throw new Error('No channel found for that handle.');
  }

  if (user) {
    // Legacy usernames still have an RSS feed that includes the channel ID.
    try {
      const feed = parseFeed(await fetchViaProxy(`https://www.youtube.com/feeds/videos.xml?user=${enc(user)}`));
      if (feed.channelId) return feed.channelId;
    } catch { /* fall through to page scrape */ }
  }

  const pageUrl = `https://www.youtube.com/${handle ? `@${enc(handle.slice(1))}` : user ? `user/${enc(user)}` : `c/${enc(custom)}`}`;
  let html;
  try {
    html = await fetchViaProxy(pageUrl, 30000);
  } catch (err) {
    throw new Error(`Couldn't look up that channel (${err.message}). Paste the channel ID instead.`);
  }
  const id = html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[\w-]{22})"/)?.[1]
    || html.match(/"externalId":"(UC[\w-]{22})"/)?.[1];
  if (!id) throw new Error('Couldn\'t find the channel ID on that page (the proxy may have gotten a consent or error page). Paste the channel ID instead.');
  return id;
}

/** Fetches one creator's feed and stores the result (or the error) in the cache. */
async function refreshCreator(creator) {
  const entry = cache.feeds[creator.id] || { videos: [] };
  try {
    const feed = await fetchFeed(creator.channelId);
    entry.videos = feed.videos;
    entry.error = null;
    entry.fetchedAt = Date.now();
    if (feed.channelName) entry.channelName = feed.channelName;
  } catch (err) {
    entry.error = err.message; // keep previously cached videos
  }
  cache.feeds[creator.id] = entry;
  return entry;
}

async function refreshAll() {
  if (refreshing || !data.creators.length) return;
  refreshing = true;
  proxyStrikes = {};
  $('#refreshBtn').disabled = true;
  const queue = [...data.creators];
  let done = 0;
  setStatus(`Refreshing 0/${queue.length}…`);
  // A few requests at a time to stay polite to the free proxies.
  const worker = async () => {
    while (queue.length) {
      await refreshCreator(queue.shift());
      setStatus(`Refreshing ${++done}/${data.creators.length}…`);
      renderFeed();
      renderSidebar();
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  cache.lastRefreshed = Date.now();
  refreshing = false;
  $('#refreshBtn').disabled = false;
  save();
  render();
}

/* ================= Derived data ================= */

const $ = sel => document.querySelector(sel);
const creatorById = id => data.creators.find(c => c.id === id);
const categoryName = id => data.categories.find(c => c.id === id)?.name || 'Uncategorized';
const NEW_WINDOW_MS = 7 * 24 * 3600 * 1000; // only recent uploads count as "New"
const isRecent = v => Date.now() - new Date(v.published).getTime() < NEW_WINDOW_MS;
const isNew = v => isRecent(v) && !data.seen[v.id];

/** Creators matching the current filter. */
function creatorsInView(filter = view.filter) {
  if (filter === 'all') return data.creators;
  const [kind, id] = filter.split(':');
  if (kind === 'creator') return data.creators.filter(c => c.id === id);
  if (id === 'none') return data.creators.filter(c => !c.categoryIds.length);
  return data.creators.filter(c => c.categoryIds.includes(id));
}

function videosFor(creators) {
  const out = [];
  for (const c of creators) {
    for (const v of cache.feeds[c.id]?.videos || []) out.push({ ...v, creator: c });
  }
  return out.sort((a, b) => (b.published || '').localeCompare(a.published || ''));
}

const newCount = creators => videosFor(creators).filter(isNew).length;

function filterExists(filter) {
  if (filter === 'all') return true;
  const [kind, id] = filter.split(':');
  if (kind === 'creator') return !!creatorById(id);
  if (id === 'none') return data.creators.some(c => !c.categoryIds.length);
  return data.categories.some(c => c.id === id);
}

/* ================= Rendering ================= */

function esc(s) {
  return String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

function timeAgo(iso) {
  const t = new Date(iso).getTime();
  if (!t) return '';
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.round(s / 86400)}d ago`;
  return new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function setStatus(text) {
  $('#status').textContent = text;
}

function renderStatus() {
  if (refreshing) return;
  const t = cache.lastRefreshed;
  setStatus(t ? `Last refreshed ${timeAgo(new Date(t).toISOString())} (${new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})` : 'Not refreshed yet');
}

function filterButton(filter, label, count, extra = '') {
  return `<li><button type="button" data-filter="${esc(filter)}" class="${view.filter === filter ? 'active' : ''}">
    <span class="label">${esc(label)}</span>${extra}${count ? `<span class="count">${count}</span>` : ''}</button></li>`;
}

/** Sidebar sections can be collapsed; the choice is saved with the view state. */
function renderCollapsed() {
  for (const [key, list] of [['categories', '#categoryList'], ['creators', '#creatorList']]) {
    const closed = !!view.collapsed?.[key];
    $(list).hidden = closed;
    document.querySelector(`[data-collapse="${key}"]`).setAttribute('aria-expanded', String(!closed));
  }
}

function renderSidebar() {
  renderCollapsed();
  const cats = [['all', 'All', data.creators]];
  for (const c of data.categories) cats.push([`cat:${c.id}`, c.name, creatorsInView(`cat:${c.id}`)]);
  if (data.creators.some(c => !c.categoryIds.length)) cats.push(['cat:none', 'Uncategorized', creatorsInView('cat:none')]);
  $('#categoryList').innerHTML = cats.map(([f, label, cs]) => filterButton(f, label, newCount(cs))).join('');

  // Creator list follows the last chosen category, even while one creator is selected.
  const scope = creatorsInView(view.filter.startsWith('creator:') ? view.scope : view.filter);
  $('#creatorList').innerHTML = [...scope].sort((a, b) => a.name.localeCompare(b.name)).map(c => {
    const err = cache.feeds[c.id]?.error;
    const warn = err ? `<span class="warn" title="${esc(err)}">⚠</span>` : '';
    return filterButton(`creator:${c.id}`, c.name, newCount([c]), warn);
  }).join('') || '<li class="muted" style="padding:6px 8px">None yet</li>';
}

function renderFeed() {
  const creators = creatorsInView();
  const all = videosFor(creators);
  const shown = view.onlyNew ? all.filter(isNew) : all;
  const unseen = all.filter(isNew).length;

  let title = 'All';
  if (view.filter.startsWith('creator:')) title = creatorById(view.filter.slice(8))?.name;
  else if (view.filter.startsWith('cat:')) title = categoryName(view.filter.slice(4));
  $('#viewTitle').textContent = title;
  $('#onlyNew').checked = view.onlyNew;
  $('#markAllBtn').disabled = unseen === 0;
  $('#markAllBtn').textContent = unseen ? `Mark ${unseen} as seen` : 'All seen';

  $('#errors').innerHTML = creators
    .filter(c => cache.feeds[c.id]?.error)
    .map(c => `<p>Couldn't refresh <strong>${esc(c.name)}</strong>: ${esc(cache.feeds[c.id].error)}</p>`)
    .join('');

  if (!data.creators.length) {
    $('#feed').innerHTML = '<p class="empty">No creators yet. Use <strong>+ Add creator</strong> to follow your first channel.</p>';
    return;
  }
  if (!shown.length) {
    const msg = !creators.length ? 'No creators in this category.'
      : view.onlyNew && all.length ? 'You\'re all caught up.'
      : refreshing ? 'Loading…' : 'No videos loaded yet. Press Refresh.';
    $('#feed').innerHTML = `<p class="empty">${msg}</p>`;
    return;
  }

  $('#feed').innerHTML = shown.slice(0, 300).map(v => {
    const fresh = isNew(v);
    const href = `https://www.youtube.com/watch?v=${enc(v.id)}`;
    return `<article class="card ${fresh ? 'new' : ''} ${data.seen[v.id] ? 'seen' : ''}">
      <a href="${href}" target="_blank" rel="noopener noreferrer" data-video="${esc(v.id)}">
        <img class="thumb" loading="lazy" alt="" src="https://i.ytimg.com/vi/${enc(v.id)}/mqdefault.jpg">
        <h3 class="title">${esc(v.title)}</h3>
      </a>
      <div class="meta">
        ${fresh ? '<span class="badge">NEW</span>' : ''}
        <span>${esc(v.creator.name)}</span>·<time datetime="${esc(v.published)}" title="${esc(new Date(v.published).toLocaleString())}">${esc(timeAgo(v.published))}</time>
        ${isRecent(v) ? `<button type="button" class="link" data-toggle-seen="${esc(v.id)}">${fresh ? 'Mark seen' : 'Mark unseen'}</button>` : ''}
      </div>
    </article>`;
  }).join('');
}

/** A checkbox per category; a creator can be in any number of them (or none). */
function categoryChecks(selectedIds, attrs) {
  return data.categories.map(c => `<label class="chip"><input type="checkbox" ${attrs} value="${esc(c.id)}"
    ${selectedIds.includes(c.id) ? 'checked' : ''}> ${esc(c.name)}</label>`).join('')
    || '<span class="muted">No categories yet</span>';
}

function renderManage() {
  $('#creatorTable').innerHTML = data.creators.length ? data.creators.map(c => `
    <div class="row" data-creator="${esc(c.id)}">
      <input value="${esc(c.name)}" data-field="name" aria-label="Name">
      <a class="channel" href="${esc(c.url)}" target="_blank" rel="noopener noreferrer" title="${esc(c.channelId)}">${esc(c.channelId)}</a>
      <button type="button" class="danger" data-remove-creator="${esc(c.id)}">Remove</button>
      <div class="cat-checks">${categoryChecks(c.categoryIds, 'data-field="category"')}</div>
    </div>`).join('') : '<p class="muted">No creators yet.</p>';

  $('#categoryTable').innerHTML = data.categories.map(c => {
    const n = data.creators.filter(cr => cr.categoryIds.includes(c.id)).length;
    return `<div class="row" data-category="${esc(c.id)}">
      <input value="${esc(c.name)}" data-field="catName" aria-label="Category name">
      <span class="muted">${n} creator${n === 1 ? '' : 's'}</span>
      <button type="button" class="danger" data-remove-category="${esc(c.id)}">Delete</button>
    </div>`;
  }).join('');

  $('#apiKeyInput').value = data.settings.apiKey;
  $('#proxyInput').value = data.settings.customProxy;
}

function render() {
  if (!filterExists(view.filter)) view.filter = 'all';
  if (!view.scope || view.scope.startsWith('creator:') || !filterExists(view.scope)) view.scope = 'all';
  renderSidebar();
  renderFeed();
  renderStatus();
}

/* ================= Actions ================= */

function markSeen(ids, seen = true) {
  const now = Date.now();
  for (const id of ids) {
    if (seen) data.seen[id] = now;
    else delete data.seen[id];
  }
  save();
  render();
}

async function addCreator(form) {
  const status = $('#addStatus');
  const submit = $('#addSubmit');
  const input = form.channel.value;
  status.className = 'form-status';
  submit.disabled = true;
  proxyStrikes = {};
  try {
    status.textContent = 'Looking up channel…';
    const channelId = await resolveChannelId(input);
    if (data.creators.some(c => c.channelId === channelId)) throw new Error('You already follow this channel.');

    const handle = input.match(/@[\w.-]+/)?.[0];
    const creator = {
      id: uid(),
      name: form.name.value.trim(),
      channelId,
      url: handle ? `https://www.youtube.com/${handle}` : `https://www.youtube.com/channel/${channelId}`,
      categoryIds: [...form.querySelectorAll('input[name=category]:checked')].map(i => i.value),
    };
    status.textContent = 'Loading videos…';
    const entry = await refreshCreator(creator);
    creator.name ||= entry.channelName || handle || channelId;
    data.creators.push(creator);
    save();
    render();
    if (entry.error) {
      status.textContent = `Added, but videos couldn't load yet: ${entry.error}`;
    } else {
      form.reset();
      status.textContent = '';
      $('#addDialog').close();
    }
  } catch (err) {
    status.className = 'form-status error';
    status.textContent = err.message;
  } finally {
    submit.disabled = false;
  }
}

function exportData() {
  const payload = {
    app: 'youtube-lite',
    exportedAt: new Date().toISOString(),
    version: data.version,
    categories: data.categories,
    creators: data.creators,
    seen: data.seen,
    // Settings (API key, proxy) are left out: they belong to this browser, not the creator list.
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `youtube-lite-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function importData(file) {
  let parsed;
  try {
    parsed = normalizeData(JSON.parse(await file.text()));
  } catch {
    parsed = null;
  }
  if (!parsed) {
    alert('That file isn\'t a valid YouTube Lite backup.');
    return;
  }
  const msg = `Import ${parsed.creators.length} creators and ${parsed.categories.length} categories? This replaces your current data.`;
  if (!confirm(msg)) return;
  // Keep this browser's settings; an imported file must not swap in its own proxy.
  parsed.settings = data.settings;
  data = parsed;
  cache = { lastRefreshed: 0, feeds: {} };
  view.filter = 'all';
  save();
  renderManage();
  render();
  refreshAll();
}

/* ================= Events ================= */

document.addEventListener('click', e => {
  const t = e.target.closest('[data-filter],[data-collapse],[data-toggle-seen],[data-remove-creator],[data-remove-category],[data-close]');
  if (!t) return;
  if (t.dataset.collapse) {
    view.collapsed = { ...view.collapsed, [t.dataset.collapse]: !view.collapsed?.[t.dataset.collapse] };
    save();
    renderCollapsed();
  } else if (t.dataset.filter) {
    view.filter = t.dataset.filter;
    if (!view.filter.startsWith('creator:')) view.scope = view.filter;
    save();
    render();
  } else if (t.dataset.toggleSeen) {
    markSeen([t.dataset.toggleSeen], !data.seen[t.dataset.toggleSeen]);
  } else if (t.dataset.removeCreator) {
    const c = creatorById(t.dataset.removeCreator);
    if (!c || !confirm(`Remove ${c.name}?`)) return;
    data.creators = data.creators.filter(x => x !== c);
    delete cache.feeds[c.id];
    save();
    renderManage();
    render();
  } else if (t.dataset.removeCategory) {
    const id = t.dataset.removeCategory;
    const n = data.creators.filter(c => c.categoryIds.includes(id)).length;
    if (!confirm(`Delete category "${categoryName(id)}"?${n ? ` ${n} creator(s) will be removed from it (creators are kept).` : ''}`)) return;
    data.categories = data.categories.filter(c => c.id !== id);
    for (const c of data.creators) c.categoryIds = c.categoryIds.filter(x => x !== id);
    save();
    renderManage();
    render();
  } else if (t.hasAttribute('data-close')) {
    t.closest('dialog').close();
  }
});

// Opening a video (left or middle click) marks it as seen.
const onVideoOpen = e => {
  const a = e.target.closest('a[data-video]');
  // Deferred so the link isn't re-rendered away while the browser follows it.
  if (a && (e.type === 'click' || e.button === 1)) setTimeout(() => markSeen([a.dataset.video]));
};
$('#feed').addEventListener('click', onVideoOpen);
$('#feed').addEventListener('auxclick', onVideoOpen);

$('#refreshBtn').addEventListener('click', refreshAll);
$('#onlyNew').addEventListener('change', e => { view.onlyNew = e.target.checked; save(); renderFeed(); });
$('#markAllBtn').addEventListener('click', () => markSeen(videosFor(creatorsInView()).filter(isNew).map(v => v.id)));

$('#addBtn').addEventListener('click', () => {
  // Preselect the category currently being viewed.
  const cur = view.filter.startsWith('cat:') ? view.filter.slice(4) : '';
  $('#addCategories').innerHTML = categoryChecks([cur], 'name="category"');
  $('#addStatus').textContent = '';
  $('#addDialog').showModal();
});
$('#addForm').addEventListener('submit', e => { e.preventDefault(); addCreator(e.target); });

$('#manageBtn').addEventListener('click', () => { renderManage(); $('#manageDialog').showModal(); });

// Inline edits in the Manage dialog (creator name/category, category name).
$('#manageDialog').addEventListener('change', e => {
  const field = e.target.dataset.field;
  if (!field) return;
  if (field === 'catName') {
    const cat = data.categories.find(c => c.id === e.target.closest('[data-category]').dataset.category);
    const name = e.target.value.trim();
    if (cat && name) cat.name = name;
    else if (cat) e.target.value = cat.name;
  } else {
    const c = creatorById(e.target.closest('[data-creator]').dataset.creator);
    if (!c) return;
    if (field === 'name') c.name = e.target.value.trim() || c.name;
    if (field === 'category') {
      const id = e.target.value;
      c.categoryIds = e.target.checked ? [...c.categoryIds, id] : c.categoryIds.filter(x => x !== id);
    }
  }
  save();
  renderManage();
  render();
});

$('#newCategoryForm').addEventListener('submit', e => {
  e.preventDefault();
  const name = e.target.name.value.trim();
  if (!name) return;
  data.categories.push({ id: uid(), name });
  e.target.reset();
  save();
  renderManage();
  render();
});

$('#apiKeyInput').addEventListener('change', e => { data.settings.apiKey = e.target.value.trim(); save(); });
$('#proxyInput').addEventListener('change', e => { data.settings.customProxy = e.target.value.trim(); save(); });
$('#exportBtn').addEventListener('click', exportData);
$('#importInput').addEventListener('change', e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (file) importData(file);
});

/* ================= Start ================= */

render();
setInterval(renderStatus, 60 * 1000);
if (Date.now() - (cache.lastRefreshed || 0) > STALE_MS) refreshAll();
