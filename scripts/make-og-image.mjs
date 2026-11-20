// Renders the link-preview images from tools/*.html with headless Chrome:
//   public/og-image.png         1200 × 630, used by LinkedIn, iMessage, Slack, X… (og:image)
//   public/apple-touch-icon.png 180 × 180, iOS icon
// Usage: npm run og   (set CHROME=/path/to/chrome if Chrome is not in the usual place)
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = [
  { page: 'tools/og-image.html', out: 'public/og-image.png', width: 1200, height: 630 },
  { page: 'tools/apple-touch-icon.html', out: 'public/apple-touch-icon.png', width: 180, height: 180 },
];

await import('./copy-vendor.mjs');
const server = await createServer({ root, logLevel: 'warn', server: { port: 5199 } });
await server.listen();
const base = server.resolvedUrls.local[0];

const profile = mkdtempSync(join(tmpdir(), 'og-chrome-'));
const chrome = spawn(findChrome(), [
  '--headless=new',
  '--remote-debugging-port=0',
  `--user-data-dir=${profile}`,
  '--hide-scrollbars',
  '--no-first-run',
  '--no-default-browser-check',
  'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });

try {
  const cdp = await connect(await devtoolsUrl(chrome));
  for (const shot of SHOTS) {
    await capture(cdp, shot);
    console.log(`wrote ${shot.out} (${shot.width}×${shot.height})`);
  }
  cdp.close();
} finally {
  const exited = chrome.exitCode !== null || new Promise((r) => chrome.once('exit', r));
  chrome.kill();
  await exited;
  await server.close();
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

async function capture(cdp, { page, out, width, height }) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const send = (method, params) => cdp.send(method, params, sessionId);
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: new URL(page, base).href });

  const deadline = Date.now() + 90_000;
  for (;;) {
    let state = '';
    try {
      const { result } = await send('Runtime.evaluate', {
        expression: 'window.__ogReady === true ? "ready" : (window.__ogError || "")',
        returnByValue: true,
      });
      state = result.value;
    } catch { /* page still navigating */ }
    if (state === 'ready') break;
    if (state) throw new Error(`${page} failed:\n${state}`);
    if (Date.now() > deadline) throw new Error(`Timed out rendering ${page}`);
    await new Promise((r) => setTimeout(r, 250));
  }

  const { data } = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width, height, scale: 1 } });
  writeFileSync(join(root, out), Buffer.from(data, 'base64'));
  await cdp.send('Target.closeTarget', { targetId });
}

function findChrome() {
  const candidates = [
    process.env.CHROME,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
  const hit = candidates.find((p) => p && existsSync(p));
  if (!hit) throw new Error('Chrome not found. Set CHROME=/path/to/chrome.');
  return hit;
}

function devtoolsUrl(proc) {
  return new Promise((resolve, reject) => {
    let log = '';
    proc.stderr.on('data', (d) => {
      log += d;
      const m = log.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) resolve(m[1]);
    });
    proc.on('exit', (code) => reject(new Error(`Chrome exited (${code}):\n${log}`)));
  });
}

// Minimal Chrome DevTools Protocol client over Node's built-in WebSocket.
async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let nextId = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error.message));
    else p.resolve(msg.result);
  };
  return {
    send(method, params = {}, sessionId) {
      const id = ++nextId;
      ws.send(JSON.stringify({ id, method, params, sessionId }));
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    close: () => ws.close(),
  };
}
