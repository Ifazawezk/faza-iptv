// Re-render the Faza IPTV social kit from studio.html: node brand/source/render.mjs [all|static|video|name]
// Needs Google Chrome and FFmpeg (set CHROME / FFMPEG env vars if they are not in the default place / on PATH).
import { spawn, execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
const HERE = path.dirname(fileURLToPath(import.meta.url)).split(path.sep).join('/');
const OUT = path.resolve(HERE, '..');
const ONLY = process.argv[2] || 'all'; // all | static | video | <name substring>
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const STATIC = [
  ['logo/faza-icon-square-1024.png', 1024, 1024, 'mode=profile'],
  ['logo/profile-picture-1080.png', 1080, 1080, 'mode=profile'],
  ['logo/faza-logo-horizontal-for-dark-bg.png', 1800, 500, 'mode=wordmark', true],
  ['logo/faza-logo-horizontal-for-light-bg.png', 1800, 500, 'mode=wordmark&light=1', true],
  ['social/youtube-banner-2560x1440.png', 2560, 1440, 'mode=banner&safe=1'],
  ['social/x-twitter-header-1500x500.png', 1500, 500, 'mode=banner&left=6%'],
  ['social/facebook-cover-1640x624.png', 1640, 624, 'mode=banner'],
  ['social/linkedin-banner-1584x396.png', 1584, 396, 'mode=banner&left=22%'],
  ['social/github-social-preview-1280x640.png', 1280, 640, 'mode=banner&cta=1'],
  ['social/instagram-post-1080x1080.png', 1080, 1080, 'mode=post'],
  ...[1, 2, 3, 4, 5].map(n => [`social/carousel-${n}-1080x1350.png`, 1080, 1350, `mode=slide&n=${n}`]),
  ['social/story-1-1080x1920.png', 1080, 1920, 'mode=slide&n=1'],
  ['social/story-2-1080x1920.png', 1080, 1920, 'mode=slide&n=5'],
];
const VIDEOS = [
  ['video/faza-promo-vertical-1080x1920.mp4', 1080, 1920, 'mode=video'],
  ['video/faza-promo-landscape-1920x1080.mp4', 1920, 1080, 'mode=video'],
  ['video/faza-logo-intro-1080x1080.mp4', 1080, 1080, 'mode=intro'],
];
const FPS = 30;

const chrome = spawn(process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', '--remote-debugging-port=9337',
  `--user-data-dir=${mkdtempSync(path.join(os.tmpdir(), 'faza-render-'))}`, '--hide-scrollbars', '--allow-file-access-from-files', '--force-color-profile=srgb', 'about:blank']);
const sleep = ms => new Promise(r => setTimeout(r, ms));
let targets; for (let i = 0; i < 40; i++) { try { targets = await (await fetch('http://127.0.0.1:9337/json')).json(); if (targets.length) break; } catch {} await sleep(250); }
const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
ws.binaryType = 'arraybuffer';
await new Promise(r => ws.addEventListener('open', r, { once: true }));
let id = 0; const pending = new Map();
ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } else if (m.method === 'Runtime.exceptionThrown') console.log('PAGE EXCEPTION', m.params.exceptionDetails.exception?.description); });
const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async expr => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result.result?.value;
await send('Runtime.enable'); await send('Page.enable');

async function open(w, h, q, transparent) {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  await send('Emulation.setDefaultBackgroundColorOverride', transparent ? { color: { r: 0, g: 0, b: 0, a: 0 } } : {});
  await send('Page.navigate', { url: `file:///${HERE}/studio.html?${q}` });
  await sleep(700);
  return ev('window.ready');
}
const want = name => ONLY === 'all' || (ONLY === 'static' && name.endsWith('.png')) || (ONLY === 'video' && name.endsWith('.mp4')) || name.includes(ONLY);

for (const [name, w, h, q, transparent] of STATIC) {
  if (!want(name)) continue;
  await open(w, h, q, transparent);
  await ev('window.seek(999)');
  await sleep(150);
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  mkdirSync(path.dirname(path.join(OUT, name)), { recursive: true });
  writeFileSync(path.join(OUT, name), Buffer.from(r.result.data, 'base64'));
  console.log('saved', name);
}

for (const [name, w, h, q] of VIDEOS) {
  if (!want(name)) continue;
  const dur = await open(w, h, q);
  const frames = path.join(os.tmpdir(), 'faza-frames'); rmSync(frames, { recursive: true, force: true }); mkdirSync(frames, { recursive: true });
  const n = Math.round(dur * FPS);
  for (let f = 0; f < n; f++) {
    await ev(`window.seek(${(f / FPS).toFixed(4)})`);
    const r = await send('Page.captureScreenshot', { format: 'jpeg', quality: 94, captureBeyondViewport: false, optimizeForSpeed: true });
    writeFileSync(path.join(frames, `f${String(f).padStart(4, '0')}.jpg`), Buffer.from(r.result.data, 'base64'));
  }
  const out = path.join(OUT, name); mkdirSync(path.dirname(out), { recursive: true });
  execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', path.join(frames, 'f%04d.jpg'),
    '-vf', 'scale=in_range=pc:out_range=tv:out_color_matrix=bt709,format=yuv420p',
    '-color_range', 'tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '17', '-profile:v', 'high', '-movflags', '+faststart', out]);
  console.log('saved', name, `(${n} frames)`);
}
chrome.kill(); process.exit(0);
