'use strict';
/* Faza IPTV - front end. Talks to the local server (server.js) for playlists and streams. */

const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const TAB_LABEL = { live: 'Live TV', movie: 'Movies', series: 'Series' };
const CACHE_MS = 6 * 60 * 60 * 1000; // playlists are cached for 6 hours (use the reload button to refresh)
const CHUNK = 150;
const DEMOS = {
  ara: { name: 'Free Arabic channels', url: 'https://iptv-org.github.io/iptv/languages/ara.m3u' },
  news: { name: 'Free world news', url: 'https://iptv-org.github.io/iptv/categories/news.m3u' },
};

/* ---------- storage ---------- */
const LS = {
  get(k, d) { try { const v = localStorage.getItem('iptv.' + k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('iptv.' + k, JSON.stringify(v)); } catch { /* storage full or blocked */ } },
};

const DB = (() => {
  let p;
  const open = () => p ||= new Promise((res, rej) => {
    const r = indexedDB.open('iptv-player', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  const run = async (mode, fn) => {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction('kv', mode);
      const req = fn(t.objectStore('kv'));
      t.oncomplete = () => res(req && req.result);
      t.onerror = () => rej(t.error);
    });
  };
  return {
    get: k => run('readonly', s => s.get(k)).catch(() => undefined),
    put: (k, v) => run('readwrite', s => s.put(v, k)).catch(() => {}),
    delPrefix: prefix => run('readwrite', s => s.delete(IDBKeyRange.bound(prefix, prefix + '￿'))).catch(() => {}),
  };
})();

async function cached(key, fn, force) {
  if (!force) {
    const c = await DB.get(key);
    if (c && Date.now() - c.t < CACHE_MS) return c.v;
  }
  const v = await fn();
  DB.put(key, { t: Date.now(), v });
  return v;
}

/* ---------- state ---------- */
const state = {
  sources: LS.get('sources', []),
  favs: LS.get('favs', {}),
  recent: LS.get('recent', {}),
  sourceId: LS.get('lastSource', null),
  tab: 'live',
  tabs: [],
  group: '__all',
  groupQuery: '',
  query: '',
  data: { live: null, movie: null, series: null },
  seriesView: null,
  list: [],
  rendered: 0,
  current: null,
  loadToken: 0,
  playToken: 0,
};
const currentSource = () => state.sources.find(s => s.id === state.sourceId) || null;
const saveSources = () => LS.set('sources', state.sources);

/* ---------- network helpers ----------
   Server mode (browser / phone via PC): everything goes through server.js to avoid CORS.
   Direct mode (desktop app / Android app, loaded from file://): the app shell has web security
   relaxed, so playlists and streams are requested directly. */
const DIRECT = location.protocol === 'file:';
const HAS_MSE = !!(window.MediaSource || window.ManagedMediaSource);
const HOSTED = !DIRECT && location.protocol === 'https:'; // the online (Cloudflare) version
const uaParam = ua => (ua ? '&ua=' + encodeURIComponent(ua) : '');
const streamSrc = (url, ua) => (DIRECT ? url : '/proxy?url=' + encodeURIComponent(url) + uaParam(ua));
async function getText(url, ua) {
  if (DIRECT) {
    let r;
    try { r = await fetch(url); } catch { throw new Error('Could not reach the server. Check the address and your internet connection.'); }
    if (!r.ok) throw new Error(`The provider returned an error (HTTP ${r.status}).`);
    return r.text();
  }
  const r = await fetch('/api/fetch?url=' + encodeURIComponent(url) + uaParam(ua));
  if (r.status === 401) { location.href = '/'; throw new Error('Please sign in again.'); } // hosted version: session ended
  const body = await r.text();
  if (!r.ok) throw new Error(r.status === 502 ? body : `The provider returned an error (HTTP ${r.status}).`);
  return body;
}
async function getJson(url) {
  const t = await getText(url);
  try { return JSON.parse(t); } catch { throw new Error('Unexpected reply from the server (not JSON). Check the server URL.'); }
}

/* ---------- M3U ---------- */
function parseM3U(text) {
  const items = [];
  let meta = null, ua = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF')) {
      const attrs = {};
      line.replace(/([\w-]+)="([^"]*)"/g, (_, k, v) => { attrs[k.toLowerCase()] = v; });
      let inQ = false, idx = -1;
      for (let i = 8; i < line.length; i++) {
        const c = line[i];
        if (c === '"') inQ = !inQ;
        else if (c === ',' && !inQ) { idx = i; break; }
      }
      meta = {
        name: idx >= 0 ? line.slice(idx + 1).trim() : '',
        logo: attrs['tvg-logo'] || '',
        group: (attrs['group-title'] || '').trim(),
      };
    } else if (line.startsWith('#EXTGRP:')) {
      if (meta && !meta.group) meta.group = line.slice(8).trim();
    } else if (/^#EXTVLCOPT:http-user-agent=/i.test(line)) {
      ua = line.slice(line.indexOf('=') + 1).trim();
    } else if (!line.startsWith('#')) {
      const m = meta || { name: '', logo: '', group: '' };
      const name = m.name || line.split('/').pop();
      const group = m.group || 'Other';
      const gs = group.includes(';') ? group.split(';').map(g => g.trim()).filter(Boolean) : undefined;
      items.push({ key: name + '|' + line, name, logo: m.logo, group, gs, url: line, ua: ua || undefined, kind: guessKind(line) });
      meta = null; ua = '';
    }
  }
  return items;
}
// A channel tagged "News;Sports" shows up in both groups.
const groupsOf = i => i.gs || [i.group];
function guessKind(url) {
  if (/\/movie\//i.test(url) || /\.(mp4|mkv|avi|mov|m4v|webm)(\?|$)/i.test(url)) return 'movie';
  if (/\/series\//i.test(url)) return 'series';
  return 'live';
}
function splitKinds(items) {
  const out = {};
  for (const kind of ['live', 'movie', 'series']) {
    const its = items.filter(i => i.kind === kind).map(i => (i.kind === 'series' ? { ...i, kind: 'movie' } : i));
    out[kind] = { groups: [...new Set(its.flatMap(groupsOf))], items: its };
  }
  return out;
}

/* ---------- Xtream Codes ---------- */
function xtBase(src) {
  let s = src.server.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
  return s;
}
const xtApi = (src, params = '') =>
  `${xtBase(src)}/player_api.php?username=${encodeURIComponent(src.user)}&password=${encodeURIComponent(src.pass)}${params}`;
const xtPath = src => `${xtBase(src)}/%K%/${encodeURIComponent(src.user)}/${encodeURIComponent(src.pass)}/`;

async function xtLogin(src) {
  const info = await getJson(xtApi(src));
  if (!info || !info.user_info || Number(info.user_info.auth) !== 1) {
    throw new Error('Login failed - check the server URL, username and password.');
  }
  const fmts = info.user_info.allowed_output_formats || [];
  src.format = fmts.includes('ts') || !fmts.length ? 'ts' : 'm3u8';
  return info;
}

async function loadXtream(src, kind) {
  const actions = {
    live: ['get_live_categories', 'get_live_streams'],
    movie: ['get_vod_categories', 'get_vod_streams'],
    series: ['get_series_categories', 'get_series'],
  }[kind];
  const [cats, streams] = await Promise.all(actions.map(a => getJson(xtApi(src, '&action=' + a))));
  const catList = Array.isArray(cats) ? cats : [];
  const catName = {};
  catList.forEach(c => { catName[c.category_id] = c.category_name; });
  const groups = catList.map(c => c.category_name);
  const base = xtPath(src);
  const items = (Array.isArray(streams) ? streams : []).map(s => {
    const group = catName[s.category_id] || 'Other';
    if (kind === 'live') {
      return { key: 'l' + s.stream_id, id: s.stream_id, name: s.name, logo: s.stream_icon, group, kind, xt: true, epg: true,
        url: base.replace('%K%', 'live') + `${s.stream_id}.${src.format || 'ts'}` };
    }
    if (kind === 'movie') {
      return { key: 'm' + s.stream_id, id: s.stream_id, name: s.name, logo: s.stream_icon, group, kind, xt: true,
        url: base.replace('%K%', 'movie') + `${s.stream_id}.${s.container_extension || 'mp4'}` };
    }
    return { key: 's' + s.series_id, id: s.series_id, name: s.name, logo: s.cover, group, kind, isSeries: true };
  });
  if (items.some(i => i.group === 'Other') && !groups.includes('Other')) groups.push('Other');
  return { groups, items };
}

async function openSeries(s) {
  const src = currentSource();
  setOverlayLoading('Loading episodes…');
  try {
    const info = await cached(`${src.id}:ep:${s.id}`, () => getJson(xtApi(src, `&action=get_series_info&series_id=${s.id}`)), false);
    const base = xtPath(src).replace('%K%', 'series');
    const items = [];
    const eps = (info && info.episodes) || {};
    Object.keys(eps).sort((a, b) => Number(a) - Number(b)).forEach(k => {
      (eps[k] || []).forEach(ep => {
        const season = ep.season ?? k;
        items.push({
          key: 'e' + ep.id, name: `S${season} E${ep.episode_num} · ${ep.title || ''}`.replace(/ · $/, ''),
          logo: (ep.info && ep.info.movie_image) || s.logo, group: `${s.name} - Season ${season}`, kind: 'movie',
          xt: true, seriesName: s.name, url: base + `${ep.id}.${ep.container_extension || 'mp4'}`,
        });
      });
    });
    if (!items.length) throw new Error('No episodes found for this series.');
    state.seriesView = { series: s, items };
    renderList();
  } catch (e) {
    toast(e.message);
  } finally {
    hideOverlayIfIdle();
  }
}

async function showAccount(src) {
  const el = $('#acct');
  el.innerHTML = '';
  if (src.type !== 'xtream') return;
  try {
    const info = await getJson(xtApi(src));
    if (currentSource() !== src) return;
    const u = info.user_info || {};
    const exp = u.exp_date && Number(u.exp_date) ? new Date(Number(u.exp_date) * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : 'never';
    const ok = String(u.status).toLowerCase() === 'active';
    el.innerHTML = `<span class="${ok ? 'ok' : 'bad'}">● ${esc(u.status || 'Unknown')}</span> · expires ${esc(exp)}<span class="ac2">connections ${esc(u.active_cons ?? '?')}/${esc(u.max_connections ?? '?')}</span>`;
  } catch {
    el.innerHTML = '<span class="bad">● Can\'t reach provider</span>';
  }
}

/* ---------- loading a source ---------- */
async function loadSource(force = false) {
  const token = ++state.loadToken;
  state.data = { live: null, movie: null, series: null };
  state.seriesView = null;
  state.group = '__all';
  renderSources();
  const src = currentSource();
  $('#acct').innerHTML = '';
  if (!src) {
    state.tabs = [];
    renderTabs(); renderGroups(); renderList();
    showWelcome();
    return;
  }
  LS.set('lastSource', src.id);
  showAccount(src);
  $('#channels').innerHTML = `<div class="empty"><div class="spinner"></div>Loading ${esc(src.name)}…</div>`;
  $('#groups').innerHTML = '';
  try {
    if (src.type === 'xtream') {
      state.tabs = ['live', 'movie', 'series'];
      if (!state.tabs.includes(state.tab)) state.tab = 'live';
      const d = await cached(`${src.id}:${state.tab}`, () => loadXtream(src, state.tab), force);
      if (token !== state.loadToken) return;
      state.data[state.tab] = d;
    } else {
      let text;
      if (src.type === 'file') text = await DB.get(`${src.id}:file`);
      else text = await cached(`${src.id}:m3u`, () => getText(src.url), force);
      if (token !== state.loadToken) return;
      if (!text) throw new Error('The playlist file is missing - please add it again.');
      state.data = splitKinds(parseM3U(text));
      state.tabs = ['live', 'movie', 'series'].filter(k => state.data[k].items.length);
      if (!state.tabs.length) throw new Error('No channels were found in this playlist.');
      if (!state.tabs.includes(state.tab)) state.tab = state.tabs[0];
    }
    renderTabs(); renderGroups(); renderList();
    if (!state.current) showIdle();
    if (document.body.classList.contains('tv') && (!document.activeElement || document.activeElement === document.body)) focusList();
  } catch (e) {
    if (token !== state.loadToken) return;
    $('#channels').innerHTML = `<div class="empty">Couldn't load this playlist.<br><br>${esc(e.message)}<br><br><button id="retryLoad">Try again</button></div>`;
    $('#retryLoad').onclick = () => loadSource(true);
  }
}

async function switchTab(kind) {
  const src = currentSource();
  if (!src) return;
  state.tab = kind;
  state.group = '__all';
  state.seriesView = null;
  renderTabs();
  if (!state.data[kind] && src.type === 'xtream') {
    const token = ++state.loadToken;
    $('#channels').innerHTML = `<div class="empty"><div class="spinner"></div>Loading ${TAB_LABEL[kind]}…</div>`;
    $('#groups').innerHTML = '';
    try {
      const d = await cached(`${src.id}:${kind}`, () => loadXtream(src, kind), false);
      if (token !== state.loadToken) return;
      state.data[kind] = d;
    } catch (e) {
      if (token !== state.loadToken) return;
      $('#channels').innerHTML = `<div class="empty">${esc(e.message)}</div>`;
      return;
    }
  }
  renderGroups(); renderList();
}

/* ---------- favorites & recent ---------- */
const favSet = () => new Set(state.favs[state.sourceId] || []);
const isFav = key => favSet().has(key);
function toggleFav(key) {
  const s = favSet();
  s.has(key) ? s.delete(key) : s.add(key);
  state.favs[state.sourceId] = [...s];
  LS.set('favs', state.favs);
}
function addRecent(key) {
  const r = (state.recent[state.sourceId] || []).filter(k => k !== key);
  r.unshift(key);
  state.recent[state.sourceId] = r.slice(0, 40);
  LS.set('recent', state.recent);
}

/* ---------- rendering ---------- */
function renderSources() {
  const sel = $('#sourceSel');
  sel.innerHTML = state.sources.length
    ? state.sources.map(s => `<option value="${esc(s.id)}"${s.id === state.sourceId ? ' selected' : ''}>${esc(s.name)}</option>`).join('')
    : '<option value="">No playlists yet</option>';
  $('#delBtn').disabled = $('#refreshBtn').disabled = !state.sources.length;
}

function renderTabs() {
  $('#tabs').innerHTML = state.tabs.length > 1 || currentSource()?.type === 'xtream'
    ? state.tabs.map(t => `<button data-tab="${t}" class="${t === state.tab ? 'on' : ''}">${TAB_LABEL[t]}</button>`).join('')
    : '';
}

function renderGroups() {
  const d = state.data[state.tab];
  const box = $('#groups');
  if (!d) { box.innerHTML = ''; return; }
  const counts = new Map();
  d.items.forEach(i => groupsOf(i).forEach(g => counts.set(g, (counts.get(g) || 0) + 1)));
  const favs = favSet();
  const favCount = d.items.filter(i => favs.has(i.key)).length;
  const q = state.groupQuery.trim().toLowerCase();
  const row = (id, label, n, cls = '') =>
    `<div class="g ${cls} ${state.group === id ? 'on' : ''}" data-g="${esc(id)}" tabindex="0"><span>${esc(label)}</span><span class="n">${n ?? ''}</span></div>`;
  let html = '';
  if (!q) {
    html += row('__all', 'All', d.items.length, 'special');
    html += row('__fav', '★ Favorites', favCount, 'special');
    if (state.tab !== 'series') html += row('__recent', 'Recently watched', '', 'special');
    html += '<div class="gsep"></div>';
  }
  html += d.groups.filter(g => counts.get(g) && (!q || g.toLowerCase().includes(q))).map(g => row(g, g, counts.get(g))).join('');
  box.innerHTML = html;
}

function filtered() {
  const q = state.query.trim().toLowerCase();
  const match = i => !q || i.name.toLowerCase().includes(q);
  if (state.seriesView) return state.seriesView.items.filter(match);
  const d = state.data[state.tab];
  if (!d) return [];
  let items = d.items;
  // Searching looks across every group of the current tab.
  if (q) return items.filter(match);
  if (state.group === '__fav') { const f = favSet(); items = items.filter(i => f.has(i.key)); }
  else if (state.group === '__recent') {
    const map = new Map(items.map(i => [i.key, i]));
    items = (state.recent[state.sourceId] || []).map(k => map.get(k)).filter(Boolean);
  } else if (state.group !== '__all') items = items.filter(i => groupsOf(i).includes(state.group));
  return items;
}

function logoHtml(item, cls = 'logo') {
  const initials = esc((item.name || '?').replace(/[^\p{L}\p{N} ]/gu, '').trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '?');
  const img = item.logo ? `<img src="${esc(item.logo)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.replaceWith(document.createTextNode('${initials}'))">` : initials;
  return `<div class="${cls}">${img}</div>`;
}

function renderList() {
  state.list = filtered();
  state.rendered = 0;
  const box = $('#channels');
  box.scrollTop = 0;
  box.innerHTML = '';
  const head = $('#chhead');
  if (state.seriesView) {
    head.innerHTML = `<button id="backBtn">← Back</button><span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(state.seriesView.series.name)}</span><span class="muted">${state.list.length}</span>`;
  } else {
    const label = state.query ? `Search: “${state.query}”` :
      state.group === '__all' ? TAB_LABEL[state.tab] || 'Channels' :
      state.group === '__fav' ? 'Favorites' : state.group === '__recent' ? 'Recently watched' : state.group;
    head.innerHTML = `<span id="listTitle" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(label)}</span><span class="muted">${state.list.length.toLocaleString()}</span>`;
  }
  if (!currentSource()) {
    box.innerHTML = '<div class="empty">Add a playlist to see channels here.</div>';
    return;
  }
  if (!state.list.length) {
    box.innerHTML = `<div class="empty">${state.group === '__fav' ? 'No favorites yet - click the ★ next to a channel.' : 'Nothing here.'}</div>`;
    return;
  }
  renderMore();
}

function renderMore() {
  const box = $('#channels');
  const favs = favSet();
  const end = Math.min(state.rendered + CHUNK, state.list.length);
  let html = '';
  for (let i = state.rendered; i < end; i++) {
    const it = state.list[i];
    const playing = state.current && state.current.key === it.key ? ' playing' : '';
    const sub = state.query || state.group === '__fav' || state.group === '__recent' ? `<span class="sub">${esc(it.group)}</span>` : '';
    html += `<div class="ch${playing}" data-i="${i}" tabindex="0">
      ${state.tab === 'live' && !state.seriesView ? `<span class="num">${i + 1}</span>` : ''}
      ${logoHtml(it)}
      <div class="name" title="${esc(it.name)}">${esc(it.name)}${sub}</div>
      ${it.isSeries ? '<span class="muted">›</span>' : `<button class="star${favs.has(it.key) ? ' on' : ''}" data-fav="${i}" title="Favorite">★</button>`}
    </div>`;
  }
  state.rendered = end;
  box.insertAdjacentHTML('beforeend', html);
}

function markPlaying() {
  document.querySelectorAll('.ch.playing').forEach(el => el.classList.remove('playing'));
  if (!state.current) return;
  const i = state.list.findIndex(x => x.key === state.current.key);
  if (i >= 0) {
    const el = document.querySelector(`.ch[data-i="${i}"]`);
    if (el) { el.classList.add('playing'); el.scrollIntoView({ block: 'nearest' }); }
  }
}

/* ---------- overlay ---------- */
const overlay = $('#overlay');
function setOverlay(html, small = false) {
  overlay.innerHTML = html;
  overlay.classList.toggle('small', small);
  overlay.hidden = false;
}
const hideOverlay = () => { overlay.hidden = true; overlay.innerHTML = ''; };
function hideOverlayIfIdle() { if (overlay.dataset.mode === 'busy') { hideOverlay(); delete overlay.dataset.mode; } }
function setOverlayLoading(msg) {
  overlay.dataset.mode = 'busy';
  setOverlay(`<div class="box"><div class="spinner"></div><p>${esc(msg)}</p></div>`);
}
function showWelcome() {
  overlay.dataset.mode = 'welcome';
  setOverlay(`<div class="box"><h3>Welcome to Faza IPTV</h3>
    <p>Add your IPTV subscription (Xtream Codes login or an M3U link/file) to start watching.</p>
    <button class="primary" id="welcomeAdd">+ Add playlist</button></div>`);
  $('#welcomeAdd').onclick = openAdd;
}
function showIdle() {
  overlay.dataset.mode = 'idle';
  setOverlay('<div class="box"><p>Pick a channel from the list to start watching.</p></div>');
}

/* ---------- player ---------- */
const video = $('#video');
let hls = null, ts = null, watchdog = null, epgTimer = null;

function destroyPlayer() {
  clearTimeout(watchdog);
  if (hls) { try { hls.destroy(); } catch { /* ignore */ } hls = null; }
  if (ts) {
    try { ts.pause(); ts.unload(); ts.detachMediaElement(); ts.destroy(); } catch { /* ignore */ }
    ts = null;
  }
  video.onerror = null;
  video.removeAttribute('src');
  video.load();
}

const extOf = url => { try { return (new URL(url).pathname.match(/\.(\w+)$/) || [])[1]?.toLowerCase() || ''; } catch { return ''; } };
const NATIVE_EXT = ['mp4', 'm4v', 'webm', 'mov', 'mkv', 'ogv', 'mp3', 'aac'];

async function playPlan(ch) {
  const ext = extOf(ch.url);
  const swap = (u, e) => u.replace(/\.(ts|m3u8)$/i, '.' + e);
  if (ext === 'm3u8' || ext === 'm3u') return [['hls', ch.url], ...(ch.xt && HAS_MSE ? [['mpegts', swap(ch.url, 'ts')]] : [])];
  if (ext === 'ts') {
    if (ch.xt && !HAS_MSE) return [['hls', swap(ch.url, 'm3u8')]]; // iPhone: only HLS works
    return [['mpegts', ch.url], ...(ch.xt ? [['hls', swap(ch.url, 'm3u8')]] : [])];
  }
  if (NATIVE_EXT.includes(ext)) return [['native', ch.url]];
  if (DIRECT) return [['hls', ch.url], ['mpegts', ch.url], ['native', ch.url]];
  // Unknown type: ask the server to peek at the stream.
  const r = await fetch('/api/probe?url=' + encodeURIComponent(ch.url) + uaParam(ch.ua)).then(x => x.json()).catch(() => ({ ok: false, status: 0 }));
  // Hosted version: the provider may block cloud servers but still allow this device directly.
  if (!r.ok && HOSTED && /^https:/i.test(ch.url)) return [['hls', ch.url], ['mpegts', ch.url], ['native', ch.url]];
  if (!r.ok) {
    const e = new Error(r.status ? `HTTP ${r.status}` : (r.error || 'unreachable'));
    e.status = r.status;
    throw e;
  }
  if (r.kind === 'hls') return [['hls', ch.url]];
  if (r.kind === 'ts') return [['mpegts', ch.url]];
  if (r.kind === 'mp4' || r.kind === 'mkv') return [['native', ch.url]];
  return [['hls', ch.url], ['mpegts', ch.url], ['native', ch.url]];
}

function explain(err) {
  const s = err && err.status;
  if (s === 401 || s === 403) return 'The stream refused the connection (HTTP ' + s + '). It may be blocked in your country, your subscription may have expired, or another device may be using your connection limit.';
  if (s === 404) return 'This stream was not found (HTTP 404). The channel may be offline.';
  if (s === 458 || s === 456 || s === 429) return 'Too many connections. Close the stream on other devices and try again.';
  if (s >= 500) return 'The stream server had an error (HTTP ' + s + '). Try again in a moment.';
  if (err && err.codec) return 'This stream uses a video/audio format the browser cannot decode. Copy the link and open it in VLC.';
  return 'Could not play this stream (' + ((err && err.message) || 'unknown error') + '). The channel may be offline.';
}

async function play(ch) {
  const token = ++state.playToken;
  state.current = ch;
  addRecent(ch.key);
  markPlaying();
  renderInfo();
  loadEpg(ch);
  destroyPlayer();
  overlay.dataset.mode = 'busy';
  setOverlay(`<div class="box"><div class="spinner"></div><p>Connecting to ${esc(ch.name)}…</p></div>`);
  let plan;
  try {
    plan = await playPlan(ch);
  } catch (e) {
    if (token === state.playToken) showPlayError(ch, e);
    return;
  }
  if (token !== state.playToken) return;
  // Hosted version: secure (https) streams are tried straight from this device first
  // (faster, uses your own connection); the Cloudflare relay is the fallback.
  plan = plan.flatMap(([engine, url]) => (HOSTED && /^https:/i.test(url) ? [[engine, url, true], [engine, url, false]] : [[engine, url, false]]));
  let lastErr = null;
  const attempt = i => {
    if (token !== state.playToken) return;
    if (i >= plan.length) return showPlayError(ch, lastErr);
    const [engine, url, direct] = plan[i];
    const src = direct ? url : streamSrc(url, ch.ua);
    let started = false;
    const next = err => {
      if (token !== state.playToken || started) return;
      lastErr = err;
      destroyPlayer();
      attempt(i + 1);
    };
    clearTimeout(watchdog);
    watchdog = setTimeout(() => next(new Error('timed out')), 25000);
    const onPlaying = () => { started = true; clearTimeout(watchdog); };
    video.addEventListener('playing', onPlaying, { once: true });

    if (engine === 'hls' && !(window.Hls && Hls.isSupported())) {
      // Safari / iPhone: play HLS natively.
      if (!video.canPlayType('application/vnd.apple.mpegurl')) return next(new Error('HLS not supported'));
      video.onerror = () => next(new Error('media error ' + (video.error && video.error.code)));
      video.src = src;
      video.play().catch(() => {});
    } else if (engine === 'hls') {
      hls = new Hls({ maxBufferLength: 30, manifestLoadingMaxRetry: 2, levelLoadingMaxRetry: 3 });
      let netRetries = 0, mediaRetries = 0;
      hls.on(Hls.Events.MANIFEST_PARSED, () => video.play().catch(() => {}));
      hls.on(Hls.Events.ERROR, (_, d) => {
        if (!d.fatal) return;
        if (!started) {
          const err = new Error(d.details);
          err.status = d.response && d.response.code;
          err.codec = /codec|incompatible/i.test(d.details);
          return next(err);
        }
        if (d.type === Hls.ErrorTypes.NETWORK_ERROR && netRetries++ < 5) return hls.startLoad();
        if (d.type === Hls.ErrorTypes.MEDIA_ERROR && mediaRetries++ < 2) return hls.recoverMediaError();
        showPlayError(ch, new Error(d.details));
      });
      hls.loadSource(src);
      hls.attachMedia(video);
    } else if (engine === 'mpegts') {
      if (!window.mpegts || !mpegts.getFeatureList().mseLivePlayback) return next(new Error('MPEG-TS not supported'));
      ts = mpegts.createPlayer(
        { type: 'mpegts', isLive: ch.kind === 'live', url: new URL(src, location.href).href },
        { enableWorker: true, lazyLoad: false, liveBufferLatencyChasing: true, liveBufferLatencyMaxLatency: 8, liveBufferLatencyMinRemain: 2, autoCleanupSourceBuffer: true }
      );
      let reloads = 0;
      ts.on(mpegts.Events.ERROR, (type, detail, info) => {
        if (!started) {
          const err = new Error(detail || type);
          err.status = info && info.code > 0 ? info.code : undefined;
          err.codec = type === mpegts.ErrorTypes.MEDIA_ERROR;
          return next(err);
        }
        if (reloads++ < 3) { try { ts.unload(); ts.load(); ts.play(); } catch { /* ignore */ } return; }
        showPlayError(ch, new Error(detail || type));
      });
      ts.attachMediaElement(video);
      ts.load();
      Promise.resolve(ts.play()).catch(() => {});
    } else {
      video.onerror = () => {
        const err = new Error('media error ' + (video.error && video.error.code));
        err.codec = video.error && video.error.code === 4;
        next(err);
      };
      video.src = src;
      video.play().catch(() => {});
    }
  };
  attempt(0);
}

function showPlayError(ch, err) {
  destroyPlayer();
  overlay.dataset.mode = 'error';
  setOverlay(`<div class="box"><h3>Can't play “${esc(ch.name)}”</h3><p>${esc(explain(err))}</p>
    <button class="primary" id="retryPlay">Try again</button> <button id="copyPlay">Copy link</button></div>`);
  $('#retryPlay').onclick = () => play(ch);
  $('#copyPlay').onclick = () => copyLink(ch);
}

video.addEventListener('playing', () => { if (overlay.dataset.mode === 'busy' || overlay.dataset.mode === 'buffer') { hideOverlay(); delete overlay.dataset.mode; } });
video.addEventListener('waiting', () => {
  if (overlay.hidden && state.current) {
    overlay.dataset.mode = 'buffer';
    setOverlay('<div class="box"><div class="spinner"></div></div>', true);
  }
});

function zap(dir) {
  const playable = state.list.filter(i => !i.isSeries);
  if (!playable.length) return;
  let i = state.current ? playable.findIndex(x => x.key === state.current.key) : -1;
  i = i < 0 ? 0 : (i + dir + playable.length) % playable.length;
  play(playable[i]);
}

async function copyLink(ch) {
  try { await navigator.clipboard.writeText(ch.url); toast('Stream link copied - paste it in VLC (Media › Open Network Stream).'); }
  catch { toast(ch.url); }
}

/* ---------- now playing + TV guide ---------- */
function renderInfo() {
  const ch = state.current;
  const box = $('#info');
  if (!ch) { box.innerHTML = ''; return; }
  box.innerHTML = `<div class="np">
      ${logoHtml(ch)}
      <div class="np-text"><div class="np-name" title="${esc(ch.name)}">${esc(ch.seriesName ? ch.seriesName + ' - ' : '')}${esc(ch.name)}</div><div class="np-group">${esc(ch.group)}</div></div>
      <div class="np-actions">
        <button data-act="prev" title="Previous (↑)">‹ Prev</button>
        <button data-act="next" title="Next (↓)">Next ›</button>
        <button data-act="fav" class="${isFav(ch.key) ? 'on' : ''}" title="Favorite">★</button>
        <button data-act="copy" title="Copy the stream link (to open in VLC)">Copy link</button>
        <button data-act="fs" title="Fullscreen (F)">⛶</button>
      </div>
    </div>
    <div class="epg" id="epg"></div>`;
}

function b64(s) {
  try { return new TextDecoder().decode(Uint8Array.from(atob(s), c => c.charCodeAt(0))); } catch { return s || ''; }
}
const hm = d => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

async function loadEpg(ch) {
  clearInterval(epgTimer);
  const src = currentSource();
  if (!ch.epg || !src || src.type !== 'xtream') return;
  const draw = async () => {
    try {
      const data = await getJson(xtApi(src, `&action=get_short_epg&stream_id=${ch.id}&limit=3`));
      if (state.current !== ch) return;
      const now = Date.now() / 1000;
      const list = (data.epg_listings || [])
        .map(p => ({ title: b64(p.title), start: Number(p.start_timestamp), end: Number(p.stop_timestamp) }))
        .filter(p => p.end > now).slice(0, 2);
      const box = $('#epg');
      if (!box) return;
      box.innerHTML = list.map((p, i) => {
        const pct = i === 0 ? Math.max(0, Math.min(100, ((now - p.start) / (p.end - p.start)) * 100)) : 0;
        return `<div><div class="prog"><span class="lbl">${i === 0 ? 'Now' : 'Next'}</span><span class="t">${hm(new Date(p.start * 1000))} - ${hm(new Date(p.end * 1000))}</span><span class="title">${esc(p.title)}</span></div>${i === 0 ? `<div class="bar"><i style="width:${pct}%"></i></div>` : ''}</div>`;
      }).join('');
    } catch { /* no guide for this channel */ }
  };
  draw();
  epgTimer = setInterval(draw, 60000);
}

/* ---------- add / remove playlists ---------- */
const dlg = $('#addDlg');
const form = $('#addForm');
let addMode = 'xtream';
function setMode(m) {
  addMode = m;
  document.querySelectorAll('#modeSeg button').forEach(b => b.classList.toggle('on', b.dataset.mode === m));
  document.querySelectorAll('#addForm .mode').forEach(d => { d.hidden = d.dataset.mode !== m; });
  $('#addErr').textContent = '';
}
function openAdd() {
  form.reset();
  setMode('xtream');
  dlg.showModal();
}
const newId = () => 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

function xtreamFromUrl(u) {
  try {
    const p = new URL(u);
    if (/\/get\.php$/i.test(p.pathname) && p.searchParams.get('username') && p.searchParams.get('password')) {
      return { server: p.origin, user: p.searchParams.get('username'), pass: p.searchParams.get('password') };
    }
  } catch { /* not a url */ }
  return null;
}

async function addSource(src, fileText) {
  state.sources.push(src);
  saveSources();
  if (fileText != null) await DB.put(`${src.id}:file`, fileText);
  state.sourceId = src.id;
  state.current = null;
  destroyPlayer();
  renderInfo();
  await loadSource(true);
}

form.addEventListener('submit', async e => {
  e.preventDefault();
  const f = new FormData(form);
  const err = $('#addErr');
  const btn = $('#saveBtn');
  err.textContent = '';
  btn.disabled = true;
  btn.textContent = 'Checking…';
  try {
    let name = String(f.get('name') || '').trim();
    if (addMode === 'xtream') {
      const src = { id: newId(), type: 'xtream', server: String(f.get('server')).trim(), user: String(f.get('user')).trim(), pass: String(f.get('pass')) };
      if (!src.server || !src.user || !src.pass) throw new Error('Please fill in server URL, username and password.');
      await xtLogin(src);
      src.name = name || new URL(xtBase(src)).hostname;
      dlg.close();
      await addSource(src);
    } else if (addMode === 'url') {
      const url = String(f.get('url')).trim();
      if (!/^https?:\/\//i.test(url)) throw new Error('Please paste a link starting with http:// or https://');
      const xt = xtreamFromUrl(url);
      if (xt) {
        const src = { id: newId(), type: 'xtream', ...xt };
        try {
          await xtLogin(src);
          src.name = name || new URL(xt.server).hostname;
          dlg.close();
          return await addSource(src);
        } catch { /* not a real Xtream panel - fall back to a plain playlist */ }
      }
      const text = await getText(url);
      const count = parseM3U(text).length;
      if (!count) throw new Error('That link did not return an M3U playlist.');
      const src = { id: newId(), type: 'url', url, name: name || new URL(url).hostname };
      await DB.put(`${src.id}:m3u`, { t: Date.now(), v: text });
      dlg.close();
      state.sources.push(src); saveSources();
      state.sourceId = src.id; state.current = null; destroyPlayer(); renderInfo();
      await loadSource(false);
      toast(`Added ${count.toLocaleString()} channels.`);
    } else {
      const file = f.get('file');
      if (!file || !file.size) throw new Error('Choose a .m3u file first.');
      const text = await file.text();
      const count = parseM3U(text).length;
      if (!count) throw new Error('No channels found in that file.');
      dlg.close();
      await addSource({ id: newId(), type: 'file', name: name || file.name.replace(/\.\w+$/, '') }, text);
      toast(`Added ${count.toLocaleString()} channels.`);
    }
  } catch (ex) {
    err.textContent = ex.message;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Add';
  }
});

document.querySelectorAll('[data-demo]').forEach(b => b.addEventListener('click', () => {
  const d = DEMOS[b.dataset.demo];
  setMode('url');
  form.elements.url.value = d.url;
  form.elements.name.value = d.name;
  form.requestSubmit();
}));
$('#modeSeg').addEventListener('click', e => { const b = e.target.closest('button'); if (b) setMode(b.dataset.mode); });
$('#cancelBtn').onclick = () => dlg.close();
$('#addBtn').onclick = openAdd;

$('#sourceSel').onchange = e => {
  state.sourceId = e.target.value;
  state.current = null;
  destroyPlayer();
  renderInfo();
  loadSource(false);
};
$('#refreshBtn').onclick = () => loadSource(true);
$('#delBtn').onclick = async () => {
  const src = currentSource();
  if (!src || !confirm(`Remove "${src.name}" from this app?`)) return;
  state.sources = state.sources.filter(s => s !== src);
  saveSources();
  delete state.favs[src.id]; delete state.recent[src.id];
  LS.set('favs', state.favs); LS.set('recent', state.recent);
  await DB.delPrefix(src.id + ':');
  state.sourceId = state.sources[0] ? state.sources[0].id : null;
  state.current = null;
  destroyPlayer();
  renderInfo();
  loadSource(false);
};

/* ---------- events ---------- */
$('#tabs').addEventListener('click', e => { const b = e.target.closest('[data-tab]'); if (b) switchTab(b.dataset.tab); });
$('#groups').addEventListener('click', e => {
  const g = e.target.closest('[data-g]');
  if (!g) return;
  state.group = g.dataset.g;
  state.seriesView = null;
  if (state.query) { state.query = ''; $('#search').value = ''; }
  const hadFocus = document.activeElement === g;
  renderGroups(); renderList();
  if (hadFocus) { const again = document.querySelector(`.g[data-g="${CSS.escape(state.group)}"]`); if (again) again.focus({ preventScroll: true }); }
});
$('#groupSearch').addEventListener('input', e => { state.groupQuery = e.target.value; renderGroups(); });
let searchTimer;
$('#search').addEventListener('input', e => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { state.query = e.target.value; renderList(); }, 150);
});
$('#chhead').addEventListener('click', e => { if (e.target.id === 'backBtn') { state.seriesView = null; renderList(); } });
$('#channels').addEventListener('scroll', e => {
  const el = e.target;
  if (state.rendered < state.list.length && el.scrollTop + el.clientHeight > el.scrollHeight - 600) renderMore();
});
$('#channels').addEventListener('click', e => {
  const star = e.target.closest('[data-fav]');
  if (star) {
    const it = state.list[Number(star.dataset.fav)];
    toggleFav(it.key);
    star.classList.toggle('on', isFav(it.key));
    renderGroups();
    if (state.current && state.current.key === it.key) renderInfo(), loadEpg(state.current);
    return;
  }
  const row = e.target.closest('.ch');
  if (!row) return;
  const it = state.list[Number(row.dataset.i)];
  if (it.isSeries) openSeries(it);
  else if (state.current && state.current.key === it.key && overlay.hidden) toggleFullscreen(); // OK twice = fullscreen
  else play(it);
});
$('#info').addEventListener('click', e => {
  const b = e.target.closest('[data-act]');
  if (!b || !state.current) return;
  const act = b.dataset.act;
  if (act === 'prev') zap(-1);
  else if (act === 'next') zap(1);
  else if (act === 'copy') copyLink(state.current);
  else if (act === 'fs') toggleFullscreen();
  else if (act === 'fav') { toggleFav(state.current.key); b.classList.toggle('on', isFav(state.current.key)); renderGroups(); markStars(); }
});
function markStars() {
  const favs = favSet();
  document.querySelectorAll('[data-fav]').forEach(s => s.classList.toggle('on', favs.has(state.list[Number(s.dataset.fav)].key)));
}
function toggleFullscreen() {
  const box = $('#playerBox');
  if (document.fullscreenElement) document.exitFullscreen(); else box.requestFullscreen().catch(() => {});
}
video.addEventListener('dblclick', e => { e.preventDefault(); toggleFullscreen(); });

/* ---------- TV & remote control ----------
   Arrow keys move a highlight between buttons, groups and channels (spatial navigation);
   OK/Enter activates. With nothing highlighted (or in fullscreen) Up/Down change channel. */
const NAV_SEL = '.top button, .top select, #search, #tabs button, #groupSearch, .g, #chhead button, .ch, .np-actions button, .overlay button';
const ARROWS = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };

function moveFocus(from, key) {
  const [dx, dy] = ARROWS[key];
  const r = from.getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  let best = null, bestScore = Infinity;
  for (const el of document.querySelectorAll(NAV_SEL)) {
    if (el === from || el.disabled || !el.offsetParent) continue;
    const c = el.getBoundingClientRect();
    if (!c.width || !c.height) continue;
    // must lie in the pressed direction
    if (dx > 0 && c.left < r.right - 2) continue;
    if (dx < 0 && c.right > r.left + 2) continue;
    if (dy > 0 && c.top < r.bottom - 2) continue;
    if (dy < 0 && c.bottom > r.top + 2) continue;
    const ex = c.left + c.width / 2, ey = c.top + c.height / 2;
    const primary = dx ? Math.abs(ex - cx) : Math.abs(ey - cy);
    const secondary = dx ? Math.max(0, Math.abs(ey - cy) - c.height / 2) : Math.max(0, Math.abs(ex - cx) - c.width / 2);
    const score = primary + secondary * 3;
    if (score < bestScore) { bestScore = score; best = el; }
  }
  if (best) {
    best.focus({ preventScroll: true });
    best.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  return !!best;
}

function focusList() {
  const el = document.querySelector('.ch.playing') || document.querySelector('.ch') || document.querySelector('.g.on');
  if (el) { el.focus({ preventScroll: true }); el.scrollIntoView({ block: 'nearest' }); }
}

// Back / Escape / remote "Return": close things one level at a time. Returns true if handled.
function goBack() {
  if (dlg.open) { dlg.close(); return true; }
  if (document.fullscreenElement) { document.exitFullscreen(); return true; }
  if (state.seriesView) { state.seriesView = null; renderList(); focusList(); return true; }
  if (state.query) { state.query = ''; $('#search').value = ''; renderList(); focusList(); return true; }
  return false;
}

const BACK_CODES = new Set([10009 /* Samsung */, 461 /* LG */, 8 /* Backspace */, 27 /* Esc */]);
document.addEventListener('keydown', e => {
  const a = document.activeElement || document.body;
  const typing = /^(INPUT|TEXTAREA)$/.test(a.tagName);
  if (e.key === 'Escape' && typing) { a.blur(); return; }
  if (e.ctrlKey || e.altKey || e.metaKey) return;
  if (!typing && (e.key === 'GoBack' || e.key === 'BrowserBack' || BACK_CODES.has(e.keyCode))) {
    if (goBack()) e.preventDefault();
    return;
  }
  if (dlg.open || typing) return;
  if (e.key === 'ChannelUp' || e.key === 'MediaTrackNext') { e.preventDefault(); return zap(1); }
  if (e.key === 'ChannelDown' || e.key === 'MediaTrackPrevious') { e.preventDefault(); return zap(-1); }
  if (e.key === 'MediaPlayPause' || e.key === 'MediaPlay' || e.key === 'MediaPause') { e.preventDefault(); video.paused ? video.play().catch(() => {}) : video.pause(); return; }
  if ((e.key === 'Enter' || e.key === ' ') && a.matches && a.matches('.ch, .g')) { e.preventDefault(); a.click(); return; }
  const onNav = a !== document.body && a.matches && a.matches(NAV_SEL) && !document.fullscreenElement;
  if (ARROWS[e.key] && onNav) {
    if (a.tagName === 'SELECT' && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) return; // let the dropdown work
    e.preventDefault();
    moveFocus(a, e.key);
    return;
  }
  if (e.key === '/') { e.preventDefault(); $('#search').focus(); }
  else if (e.key === 'ArrowDown' || e.key === 'PageDown') { e.preventDefault(); zap(1); }
  else if (e.key === 'ArrowUp' || e.key === 'PageUp') { e.preventDefault(); zap(-1); }
  else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !document.fullscreenElement) { e.preventDefault(); focusList(); }
  else if (e.key === 'f' || e.key === 'F') toggleFullscreen();
  else if (e.key === 'm' || e.key === 'M') video.muted = !video.muted;
});

// TV mode: big text + remote-friendly. On automatically on TVs; the "TV" button toggles it.
const TV_UA = /Android TV|GoogleTV|BRAVIA|AFT[A-Z]|SmartTV|SMART-TV|Tizen|Web0S|webOS|NetCast|HbbTV|CrKey|Large Screen/i;
function setTvMode(on) {
  document.body.classList.toggle('tv', on);
  $('#tvBtn').classList.toggle('on', on);
}
setTvMode(LS.get('tvMode', null) ?? (TV_UA.test(navigator.userAgent) || new URLSearchParams(location.search).has('tv')));
$('#tvBtn').onclick = () => { const on = !document.body.classList.contains('tv'); LS.set('tvMode', on); setTvMode(on); };

// Android app: the hardware Back button goes through Cordova.
if (DIRECT && /Android/i.test(navigator.userAgent)) {
  const s = document.createElement('script');
  s.src = 'cordova.js';
  s.onload = () => document.addEventListener('deviceready', () => {
    document.addEventListener('backbutton', () => {
      if (!goBack() && navigator.app) navigator.app.exitApp();
    }, false);
  });
  document.head.appendChild(s);
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 4500);
}

/* ---------- start ---------- */
if (!currentSource() && state.sources.length) state.sourceId = state.sources[0].id;
loadSource(false);
