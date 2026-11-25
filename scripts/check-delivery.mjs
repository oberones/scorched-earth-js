// Verify a running Scorched Earth server end to end:
//   node scripts/check-delivery.mjs [baseUrl ...]     (default http://127.0.0.1:8080/)
// For each base URL: the HTTP response contract (built bytes, security headers, CSP
// hashes, caching, gzip, ETag, 404s, methods, /healthz), WebSocket origin policy, and
// a real lobby -> room -> vote -> shop -> battle session over /ws.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import { gunzipSync } from 'node:zlib';
import engine from '../server/lib/engine.js';

const { CFG } = engine;
const bases = process.argv.slice(2).length ? process.argv.slice(2) : ['http://127.0.0.1:8080/'];
const local = existsSync('dist/index.html') ? readFileSync('dist/index.html') : null;
const sha256 = (b) => createHash('sha256').update(b).digest('base64');

function request(url, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error(`timeout ${url}`)));
    req.end();
  });
}

function checkHeaders(r, what) {
  assert.equal(r.headers['x-content-type-options'], 'nosniff', what);
  assert.equal(r.headers['x-frame-options'], 'SAMEORIGIN', what);
  assert.equal(r.headers['referrer-policy'], 'strict-origin-when-cross-origin', what);
  assert.equal(r.headers['permissions-policy'], 'camera=(), microphone=(), geolocation=()', what);
  const csp = r.headers['content-security-policy'] || '';
  for (const part of ["default-src 'self'", "object-src 'none'", "base-uri 'none'", "frame-ancestors 'self'", "connect-src 'self'"]) {
    assert(csp.includes(part), `${what}: CSP missing ${part}`);
  }
  assert(!/script-src[^;]*'unsafe-inline'/.test(csp), `${what}: CSP must not allow inline scripts wholesale`);
  return csp;
}

// Raw upgrade so we control the Origin header (browsers always send one).
function upgrade(base, origin) {
  return new Promise((resolve, reject) => {
    const u = new URL('ws', base);
    const headers = { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==' };
    if (origin) headers.Origin = origin;
    const req = http.request(u, { headers });
    req.on('upgrade', (res, socket) => { socket.destroy(); resolve(res.statusCode); });
    req.on('response', (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.end();
  });
}

function readLeaderboard(base) {
  const url = new URL('ws', base).href.replace(/^http/, 'ws');
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error('No leaderboard response'));
    }, 5000);
    ws.onopen = () => ws.send(JSON.stringify({ t: 'leaderboard' }));
    ws.onmessage = ({ data }) => {
      clearTimeout(timeout);
      ws.close();
      resolve(JSON.parse(data));
    };
  });
}

function play(base) {
  const url = new URL('ws', base).href.replace(/^http/, 'ws');
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const seen = [];
    let setup = false, voted = false;
    const fail = setTimeout(() => { ws.close(); reject(new Error(`WebSocket session stalled after: ${seen.join(' > ')}`)); }, 30000);
    const send = (m) => ws.send(JSON.stringify(m));
    ws.onerror = (e) => { clearTimeout(fail); reject(new Error(`WebSocket error at ${url}: ${e.message || e.type}`)); };
    ws.onopen = () => send({ t: 'hello', name: 'Delivery check' });
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (seen[seen.length - 1] !== m.t) seen.push(m.t);
      if (m.t === 'welcome') send({ t: 'createRoom', name: 'delivery-check' });
      else if (m.t === 'room' && !setup) { setup = true; send({ t: 'settings', settings: { rounds: 1 } }); send({ t: 'addBot', difficulty: 'easy' }); }
      else if (m.t === 'room' && m.bots.length && !voted) { voted = true; send({ t: 'vote', on: true }); }
      else if (m.t === 'shop') send({ t: 'shopDone' });
      else if (m.t === 'snap' && m.stage === 'play' && m.terrain) {
        assert.equal(m.tanks.length, 2);
        assert.equal(Buffer.from(m.terrain, 'base64').length, CFG.W * 2, 'terrain payload bytes');
        clearTimeout(fail);
        send({ t: 'leaveRoom' });
        ws.close();
        resolve(seen);
      }
    };
  });
}

for (const raw of bases) {
  const base = raw.endsWith('/') ? raw : raw + '/';
  const page = await request(base);
  assert.equal(page.status, 200, 'GET /');
  assert(page.body.includes('Scorched Earth'), 'page title');
  assert.match(page.headers['content-type'], /^text\/html/);
  assert.equal(page.headers['cache-control'], 'no-cache');
  if (local) assert.equal(sha256(page.body), sha256(local), 'served page differs from local dist/index.html');
  const csp = checkHeaders(page, 'GET /');
  const html = page.body.toString('utf8');
  for (const tag of ['script', 'style']) {
    for (const m of html.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'gi'))) {
      assert(csp.includes(`'sha256-${sha256(m[1])}'`), `CSP does not allow the page's inline ${tag}`);
    }
  }

  const gz = await request(base, { headers: { 'Accept-Encoding': 'gzip' } });
  assert.equal(gz.headers['content-encoding'], 'gzip');
  assert(gunzipSync(gz.body).equals(page.body), 'gzip body');
  assert.equal((await request(base, { headers: { 'If-None-Match': page.headers.etag } })).status, 304, 'ETag revalidation');
  const head = await request(base, { method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal(head.body.length, 0);

  for (const missing of ['missing.js', '.env', 'package.json', 'Dockerfile', 'server/server.js', 'src/game.js',
    'deploy/.env', 'deploy/compose.production.yml', '.github/workflows/publish.yml']) {
    const r = await request(base + missing);
    assert.equal(r.status, 404, missing);
    assert.equal(r.headers['cache-control'], 'no-cache', missing);
    checkHeaders(r, missing);
  }
  // A reverse proxy may reject traversal before the request reaches the app, so
  // only the rejection status is shared across direct and path-prefix delivery.
  for (const traversal of ['../server/server.js', '%2e%2e/server/server.js',
    '..%2fserver%2fserver.js', '%2e%2e%2fserver%2fserver.js']) {
    assert.equal((await request(base + traversal)).status, 404, traversal);
  }
  for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) assert.equal((await request(base, { method })).status, 405, method);

  const health = await request(new URL('healthz', base));
  assert.equal(health.status, 200);
  assert.equal(JSON.parse(health.body).ok, true);

  assert.equal(await upgrade(base, 'https://evil.example'), 403, 'cross-site WebSocket must be refused');
  assert.equal(await upgrade(base, new URL(base).origin), 101, 'same-origin WebSocket must be accepted');
  const leaderboard = await readLeaderboard(base);
  assert.equal(leaderboard.t, 'leaderboard');
  assert(Array.isArray(leaderboard.entries));
  if (process.env.SCORCHED_EXPECT_VOLUME_PILOT) {
    assert.deepEqual(leaderboard.entries, [{ name: 'Volume pilot', score: 250, kills: 1, rounds: 1 }]);
  }
  const flow = await play(base);

  console.log(JSON.stringify({ base, checks: ['bytes', 'security-headers', 'csp-hashes', 'cache', 'gzip', 'etag', 'head', '404', 'methods', 'healthz', 'ws-origin', 'leaderboard', 'ws-session'], session: flow.join(' > '), result: 'PASS' }));
}
