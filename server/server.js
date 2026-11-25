#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Scorched Earth multiplayer server. Zero dependencies - Node >= 18.
//   node server/server.js
// Serves the built browser game (dist/) and the WebSocket endpoint /ws.
//
// Environment:
//   PORT=8080  HOST=0.0.0.0  STATIC_DIR=<repo>/dist  LOG_LEVEL=info|quiet
//   ALLOWED_ORIGINS   comma list of extra browser origins allowed to open /ws
//                     (same-host pages are always allowed; "*" allows any)
//   MAX_CLIENTS=1000  MAX_ROOMS=200  SHUTDOWN_GRACE_MS=2000
//   LEADERBOARD_FILE=<repo>/.data/leaderboard.json
// ---------------------------------------------------------------------------
'use strict';
const http = require('http');
const path = require('path');
const { attachWebSocketServer } = require('./lib/websocket');
const { loadDirectory } = require('./lib/static');
const { Lobby } = require('./lib/lobby');
const { openLeaderboard } = require('./lib/leaderboard');
const { APP_VERSION } = require('./lib/engine');

const PORT = Number.isInteger(+process.env.PORT) && process.env.PORT !== '' ? +process.env.PORT : 8080;
const HOST = process.env.HOST || '0.0.0.0';
const STATIC_DIR = path.resolve(process.env.STATIC_DIR || path.join(__dirname, '..', 'dist'));
const MAX_CLIENTS = +process.env.MAX_CLIENTS || 1000;
const GRACE = +process.env.SHUTDOWN_GRACE_MS || 2000;
const ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const quiet = process.env.LOG_LEVEL === 'quiet';
const log = (...a) => { if (!quiet) console.log(new Date().toISOString(), ...a); };

const site = loadDirectory(STATIC_DIR, { extraConnect: ORIGINS.filter(o => o !== '*' && o !== 'null') });
const leaderboardFile = path.resolve(process.env.LEADERBOARD_FILE || path.join(__dirname, '..', '.data', 'leaderboard.json'));
let leaderboard;
try {
  leaderboard = openLeaderboard(leaderboardFile);
} catch (error) {
  console.error('Could not load leaderboard:', error.message);
}
const lobby = new Lobby({ log, leaderboard });
const started = Date.now();
let stopping = false;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/healthz') {
    const status = stopping ? 503 : 200;
    res.writeHead(status, Object.assign({ 'content-type': 'application/json', 'cache-control': 'no-store' }, site.headers));
    res.end(JSON.stringify(Object.assign({ ok: !stopping, version: process.env.APP_VERSION || APP_VERSION, uptime: Math.round((Date.now() - started) / 1000) }, lobby.stats())));
    return;
  }
  site.handle(req, res);
});
server.keepAliveTimeout = 65000;  // longer than typical reverse-proxy idle timeouts
server.headersTimeout = 66000;
server.requestTimeout = 30000;

// Browsers always send Origin on WebSocket upgrades: refuse pages from other sites
// (cross-site WebSocket hijacking). Non-browser clients send none and are allowed.
function verifyOrigin(req) {
  const origin = req.headers.origin;
  if (!origin || ORIGINS.includes('*') || ORIGINS.includes(origin)) return null;
  let host;
  try { host = new URL(origin).host; } catch { return { status: 403, reason: 'Forbidden' }; }
  const fwd = req.headers['x-forwarded-host'];
  const allowed = [req.headers.host, ...(fwd ? String(fwd).split(',').map(s => s.trim()) : [])];
  return allowed.includes(host) ? null : { status: 403, reason: 'Forbidden' };
}

const wss = attachWebSocketServer(server, {
  path: '/ws',
  maxClients: MAX_CLIENTS,
  verify: (req) => {
    if (stopping) return { status: 503, reason: 'Service Unavailable' };
    const denied = verifyOrigin(req);
    if (denied) log('ws refused origin', req.headers.origin);
    return denied;
  },
  onConnection: (ws) => {
    log('ws connect', ws.remoteAddress);
    ws.on('close', () => log('ws close', ws.remoteAddress));
    lobby.onConnection(ws);
  },
});

server.listen(PORT, HOST, () => log(`Scorched Earth server listening on http://${HOST}:${server.address().port} (static ${STATIC_DIR}, ${site.files.size} files)`));

function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log(`${signal} received - draining`);
  lobby.shutdown();
  server.close();
  setTimeout(() => {
    wss.closeAll(1001, 'server restarting');
    setTimeout(() => process.exit(0), 300).unref();
  }, Math.min(GRACE, 25000)).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = { server, lobby };
