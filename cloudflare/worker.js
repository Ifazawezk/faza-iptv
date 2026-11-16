// Faza IPTV - Cloudflare Worker (free plan, always on, runs close to every viewer).
// Serves the web app from ../public and relays playlists/streams (same endpoints as server.js).
// Everything is behind a password (secret ACCESS_KEY); after logging in, a signed HttpOnly cookie
// keeps the device signed in for a year. Changing ACCESS_KEY signs every device out.

const UA = 'VLC/3.0.20 LibVLC/3.0.20';
const COOKIE = 'faza_auth';
const YEAR = 60 * 60 * 24 * 365;
// Files a signed-out browser may load (login page look + "install app" icons).
const PUBLIC_FILES = new Set(['/icon.svg', '/icon-192.png', '/icon-512.png', '/manifest.webmanifest', '/style.css']);
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Strict-Transport-Security': 'max-age=31536000',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const p = url.pathname;
    if (!env.ACCESS_KEY) return text('Set the ACCESS_KEY secret first: npx wrangler secret put ACCESS_KEY', 500);

    if (p === '/login' && req.method === 'POST') return login(req, env);
    if (p === '/logout') return redirect('/', `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`);

    if (!(await isSignedIn(req, env))) {
      if (PUBLIC_FILES.has(p)) return withHeaders(await env.ASSETS.fetch(req));
      if (p === '/proxy' || p.startsWith('/api/')) return text('Sign in required', 401);
      return loginPage();
    }

    if (p === '/proxy') return proxy(req, url);
    if (p === '/api/fetch') return apiFetch(req, url);
    if (p === '/api/probe') return probe(req, url);
    return withHeaders(await env.ASSETS.fetch(req));
  },
};

/* ---------- auth ---------- */
async function hmac(key, msg) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}
function same(a, b) { // constant-time compare
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
const sessionToken = env => hmac(env.ACCESS_KEY, 'faza-iptv-session-v1');
async function isSignedIn(req, env) {
  const m = (req.headers.get('Cookie') || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([a-f0-9]{64})`));
  return !!m && same(m[1], await sessionToken(env));
}
async function login(req, env) {
  const form = await req.formData().catch(() => null);
  const pass = String((form && form.get('password')) || '');
  // Compare HMACs so the check takes the same time whatever was typed.
  const ok = same(await hmac('cmp', pass), await hmac('cmp', env.ACCESS_KEY));
  if (!ok) {
    await new Promise(r => setTimeout(r, 1500)); // slow down guessing
    return loginPage('Wrong password.', 401);
  }
  return redirect('/', `${COOKIE}=${await sessionToken(env)}; Path=/; Max-Age=${YEAR}; HttpOnly; Secure; SameSite=Lax`);
}
function loginPage(error = '', status = 200) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Faza IPTV</title><link rel="icon" href="/icon.svg"><link rel="manifest" href="/manifest.webmanifest"><link rel="apple-touch-icon" href="/icon-192.png">
<meta name="theme-color" content="#0b0f17"><link rel="stylesheet" href="/style.css">
<style>body{display:grid;place-items:center;min-height:100vh;padding:16px}form{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:28px;width:min(380px,100%);display:grid;gap:14px}
h1{margin:0;font-size:22px;display:flex;gap:10px;align-items:center}h1 img{width:32px}input{width:100%;padding:12px;font-size:16px}button{padding:12px;font-size:16px}.err{color:var(--danger);margin:0}</style></head>
<body><form method="post" action="/login"><h1><img src="/icon.svg" alt=""><span class="wm">Faza <b>IPTV</b></span></h1>
<label class="muted" for="pw">Password</label><input id="pw" name="password" type="password" autocomplete="current-password" autofocus required>
${error ? `<p class="err">${error}</p>` : ''}<button class="primary" type="submit">Sign in</button></form></body></html>`;
  return new Response(html, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS } });
}

/* ---------- helpers ---------- */
function text(body, status = 200) {
  return new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS } });
}
function redirect(to, cookie) {
  return new Response(null, { status: 303, headers: { Location: to, 'Set-Cookie': cookie, 'Cache-Control': 'no-store' } });
}
function withHeaders(res) {
  const r = new Response(res.body, res);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) r.headers.set(k, v);
  return r;
}
function target(url) {
  const t = url.searchParams.get('url');
  try {
    const u = new URL(t);
    if ((u.protocol === 'http:' || u.protocol === 'https:') && u.host !== url.host) return u.href;
  } catch { /* invalid */ }
  return null;
}
function upstreamHeaders(req, url) {
  const h = { 'User-Agent': url.searchParams.get('ua') || UA, Accept: '*/*' };
  const range = req.headers.get('Range');
  if (range) h.Range = range;
  return h;
}
const proxyUrl = (u, ua) => '/proxy?url=' + encodeURIComponent(u) + (ua ? '&ua=' + encodeURIComponent(ua) : '');
function rewriteM3U8(body, base, ua) {
  return body.split(/\r?\n/).map(line => {
    const t = line.trim();
    if (!t) return line;
    if (t.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (_, u) => `URI="${proxyUrl(new URL(u, base).href, ua)}"`);
    return proxyUrl(new URL(t, base).href, ua);
  }).join('\n');
}
const errMsg = e => (e && (e.message || String(e))) || 'unknown error';

/* ---------- endpoints (same as server.js) ---------- */
async function apiFetch(req, url) {
  const t = target(url);
  if (!t) return text('Invalid url', 400);
  try {
    const r = await fetch(t, { headers: upstreamHeaders(req, url), redirect: 'follow' });
    let buf = new Uint8Array(await r.arrayBuffer());
    if (buf[0] === 0x1f && buf[1] === 0x8b) {
      buf = new Uint8Array(await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
    }
    return new Response(buf, { status: r.status, headers: { 'Content-Type': (r.headers.get('content-type') || 'text/plain').replace(/gzip/i, 'plain'), 'Cache-Control': 'no-store' } });
  } catch (e) {
    return text('Fetch failed: ' + errMsg(e), 502);
  }
}

async function proxy(req, url) {
  const t = target(url);
  if (!t) return text('Invalid url', 400);
  const ua = url.searchParams.get('ua') || '';
  try {
    const r = await fetch(t, { headers: upstreamHeaders(req, url), redirect: 'follow' });
    const type = r.headers.get('content-type') || '';
    const finalUrl = r.url || t;
    const fu = new URL(finalUrl);
    if (r.ok && (/mpegurl/i.test(type) || /\.m3u8?$/i.test(fu.pathname))) {
      const body = await r.text();
      if (body.trimStart().startsWith('#EXTM3U')) {
        return new Response(rewriteM3U8(body, finalUrl, ua), { headers: { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-cache' } });
      }
      return new Response(body, { status: r.status, headers: { 'Content-Type': type } });
    }
    const headers = new Headers({ 'Cache-Control': 'no-cache' });
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
      const v = r.headers.get(h);
      if (v) headers.set(h, v);
    }
    return new Response(r.body, { status: r.status, headers });
  } catch (e) {
    return text('Stream failed: ' + errMsg(e), 502);
  }
}

async function probe(req, url) {
  const json = o => new Response(JSON.stringify(o), { headers: { 'Content-Type': 'application/json' } });
  const t = target(url);
  if (!t) return json({ ok: false, status: 0, error: 'Invalid url' });
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 15000);
    const r = await fetch(t, { headers: upstreamHeaders(req, url), redirect: 'follow', signal: ac.signal });
    const type = r.headers.get('content-type') || '';
    let head = new Uint8Array(0);
    if (r.body) {
      const reader = r.body.getReader();
      while (head.length < 1024) {
        const { done, value } = await reader.read();
        if (done) break;
        const n = new Uint8Array(head.length + value.length);
        n.set(head); n.set(value, head.length); head = n;
      }
      reader.cancel().catch(() => {});
    }
    clearTimeout(timer);
    const at = (i, n) => String.fromCharCode(...head.slice(i, i + n));
    const start = at(0, 64).replace(/^﻿|^\xEF\xBB\xBF/, '').trimStart();
    let kind = 'unknown';
    if (start.startsWith('#EXTM3U') || /mpegurl/i.test(type)) kind = 'hls';
    else if (head[0] === 0x47 && (head.length < 189 || head[188] === 0x47)) kind = 'ts';
    else if (at(4, 4) === 'ftyp') kind = 'mp4';
    else if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) kind = 'mkv';
    else if (/mp2t/i.test(type)) kind = 'ts';
    else if (/video\/(mp4|webm)/i.test(type)) kind = 'mp4';
    return json({ ok: r.ok, status: r.status, kind, type });
  } catch (e) {
    return json({ ok: false, status: 0, error: e && e.name === 'AbortError' ? 'Timed out' : errMsg(e) });
  }
}
