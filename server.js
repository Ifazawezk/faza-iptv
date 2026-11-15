// Faza IPTV - local server (no npm dependencies, Node 18+)
// Serves the web UI and proxies playlists/streams so the browser isn't blocked by CORS.
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { Readable } = require('stream');

const PORT = Number(process.env.PORT) || 8686;
const PUBLIC = path.join(__dirname, 'public');
const DEFAULT_UA = 'VLC/3.0.20 LibVLC/3.0.20';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*' });
  res.end(body);
}

function upstreamHeaders(req, ua) {
  const h = { 'User-Agent': ua || DEFAULT_UA, Accept: '*/*' };
  if (req.headers.range) h.Range = req.headers.range;
  return h;
}

function isHttpUrl(u) {
  try { const p = new URL(u); return p.protocol === 'http:' || p.protocol === 'https:'; } catch { return false; }
}

function proxyUrl(u, ua) {
  return '/proxy?url=' + encodeURIComponent(u) + (ua ? '&ua=' + encodeURIComponent(ua) : '');
}

// Rewrite every URI inside an HLS playlist so it also goes through this proxy.
function rewriteM3U8(text, baseUrl, ua) {
  return text.split(/\r?\n/).map(line => {
    const t = line.trim();
    if (!t) return line;
    if (t.startsWith('#')) {
      return line.replace(/URI="([^"]+)"/g, (_, u) => `URI="${proxyUrl(new URL(u, baseUrl).href, ua)}"`);
    }
    return proxyUrl(new URL(t, baseUrl).href, ua);
  }).join('\n');
}

// GET /api/fetch?url=...  -> returns text (M3U playlists, Xtream API JSON, XMLTV EPG; .gz handled)
async function handleFetch(req, res, q) {
  const url = q.get('url');
  if (!isHttpUrl(url)) return send(res, 400, 'Invalid url');
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 60000);
  try {
    const r = await fetch(url, { headers: upstreamHeaders(req, q.get('ua')), redirect: 'follow', signal: ac.signal });
    let buf = Buffer.from(await r.arrayBuffer());
    if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
    res.writeHead(r.status, {
      'Content-Type': (r.headers.get('content-type') || 'text/plain').replace(/gzip/i, 'plain'),
      'Access-Control-Allow-Origin': '*',
      'X-Final-Url': r.url,
    });
    res.end(buf);
  } catch (e) {
    send(res, 502, 'Fetch failed: ' + (e.cause?.message || e.message));
  } finally {
    clearTimeout(timer);
  }
}

// GET /proxy?url=...  -> streams media; HLS playlists get rewritten, everything else is piped.
async function handleProxy(req, res, q) {
  const url = q.get('url');
  const ua = q.get('ua') || '';
  if (!isHttpUrl(url)) return send(res, 400, 'Invalid url');
  const ac = new AbortController();
  res.on('close', () => ac.abort());
  try {
    const r = await fetch(url, { headers: upstreamHeaders(req, ua), redirect: 'follow', signal: ac.signal });
    const type = r.headers.get('content-type') || '';
    const finalUrl = r.url || url;
    const looksHls = /mpegurl/i.test(type) || /\.m3u8?(\?|$)/i.test(new URL(finalUrl).pathname + new URL(finalUrl).search);
    if (looksHls && r.ok) {
      const text = await r.text();
      if (text.trimStart().startsWith('#EXTM3U')) {
        res.writeHead(200, {
          'Content-Type': 'application/vnd.apple.mpegurl',
          'Cache-Control': 'no-cache',
          'Access-Control-Allow-Origin': '*',
        });
        return res.end(rewriteM3U8(text, finalUrl, ua));
      }
      res.writeHead(r.status, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*' });
      return res.end(text);
    }
    const headers = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' };
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
      const v = r.headers.get(h);
      if (v) headers[h] = v;
    }
    res.writeHead(r.status, headers);
    if (!r.body) return res.end();
    Readable.fromWeb(r.body).on('error', () => res.destroy()).pipe(res);
  } catch (e) {
    if (!res.headersSent) send(res, 502, 'Stream failed: ' + (e.cause?.message || e.message));
    else res.destroy();
  }
}

// GET /api/probe?url=...  -> peeks at the first bytes to tell HLS / MPEG-TS / MP4 / MKV apart.
async function handleProbe(req, res, q) {
  const url = q.get('url');
  const json = obj => send(res, 200, JSON.stringify(obj), 'application/json');
  if (!isHttpUrl(url)) return json({ ok: false, status: 0, error: 'Invalid url' });
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 15000);
  try {
    const r = await fetch(url, { headers: upstreamHeaders(req, q.get('ua')), redirect: 'follow', signal: ac.signal });
    const type = r.headers.get('content-type') || '';
    let head = Buffer.alloc(0);
    if (r.body) {
      const reader = r.body.getReader();
      while (head.length < 1024) {
        const { done, value } = await reader.read();
        if (done) break;
        head = Buffer.concat([head, Buffer.from(value)]);
      }
      reader.cancel().catch(() => {});
    }
    ac.abort();
    const start = head.toString('latin1', 0, 64).replace(/^﻿|^\xEF\xBB\xBF/, '').trimStart();
    let kind = 'unknown';
    if (start.startsWith('#EXTM3U') || /mpegurl/i.test(type)) kind = 'hls';
    else if (head[0] === 0x47 && (head.length < 189 || head[188] === 0x47)) kind = 'ts';
    else if (head.toString('latin1', 4, 8) === 'ftyp') kind = 'mp4';
    else if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) kind = 'mkv';
    else if (/mp2t/i.test(type)) kind = 'ts';
    else if (/video\/(mp4|webm)/i.test(type)) kind = 'mp4';
    json({ ok: r.ok, status: r.status, kind, type });
  } catch (e) {
    json({ ok: false, status: 0, error: e.name === 'AbortError' ? 'Timed out' : (e.cause?.message || e.message) });
  } finally {
    clearTimeout(timer);
  }
}

function serveStatic(req, res, pathname) {
  const file = path.normalize(path.join(PUBLIC, pathname === '/' ? 'index.html' : pathname));
  if (!file.startsWith(PUBLIC)) return send(res, 403, 'Forbidden');
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'Not found');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname === '/proxy') return handleProxy(req, res, u.searchParams);
  if (u.pathname === '/api/fetch') return handleFetch(req, res, u.searchParams);
  if (u.pathname === '/api/probe') return handleProbe(req, res, u.searchParams);
  return serveStatic(req, res, decodeURIComponent(u.pathname));
});

// By default only this computer can use the player. With --lan, phones/tablets on the same
// Wi-Fi can open it too (the proxy is then reachable from your local network).
const LAN = process.argv.includes('--lan');
server.listen(PORT, LAN ? '0.0.0.0' : '127.0.0.1', () => {
  const link = `http://localhost:${PORT}`;
  console.log(`\n  Faza IPTV running at ${link}`);
  if (LAN) {
    const ips = Object.values(require('os').networkInterfaces()).flat()
      .filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address);
    console.log('\n  On your phone (same Wi-Fi), open:');
    ips.forEach(ip => console.log(`     http://${ip}:${PORT}`));
    console.log('  Then use "Add to Home screen" to install it like an app.');
  }
  console.log('\n  Keep this window open while watching. Close it to stop.\n');
  if (process.argv.includes('--open')) {
    require('child_process').exec(`start "" "${link}"`);
  }
});
server.on('error', e => {
  if (e.code === 'EADDRINUSE') {
    console.log(`Port ${PORT} is already in use - the player is probably already running. Opening it...`);
    if (process.argv.includes('--open')) require('child_process').exec(`start "" "http://localhost:${PORT}"`);
  } else console.error(e);
});
