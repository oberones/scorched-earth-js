// ---------------------------------------------------------------------------
// In-memory static file delivery with the same response contract as the
// hyperprism nginx config: security headers, strict CSP, no-cache revalidation,
// ETag/304, gzip, 404 for anything that isn't a built file, GET/HEAD only.
// Files are read once at startup, so the container filesystem can be read-only.
// ---------------------------------------------------------------------------
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.gltf': 'model/gltf+json', '.glb': 'model/gltf-binary', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.webp': 'image/webp',
};
const COMPRESSIBLE = /^(text\/|application\/json|image\/svg|model\/gltf\+json)/;
const sha256b64 = (s) => crypto.createHash('sha256').update(s).digest('base64');

// CSP: the bundled page is one HTML file with an inline <script> and <style>;
// allow exactly those blocks by hash instead of 'unsafe-inline'.
function contentSecurityPolicy(html, extraConnect = []) {
  const hashes = (tag) => [...html.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'gi'))]
    .map(m => `'sha256-${sha256b64(m[1])}'`).join(' ');
  return [
    "default-src 'self'",
    `script-src 'self' ${hashes('script')}`.trim(),
    `style-src 'self' ${hashes('style')}`.trim(),
    "style-src-attr 'unsafe-inline'",           // per-player colours are set in style attributes
    "img-src 'self' data: blob:",
    ['connect-src', "'self'", ...extraConnect].join(' '), // WebSocket to the same origin
    "object-src 'none'", "base-uri 'none'", "frame-ancestors 'self'", "form-action 'none'",
  ].join('; ');
}

function securityHeaders(csp) {
  return {
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'SAMEORIGIN',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'permissions-policy': 'camera=(), microphone=(), geolocation=()',
    'content-security-policy': csp,
  };
}

function loadDirectory(root, { extraConnect = [] } = {}) {
  root = path.resolve(root);
  const files = new Map();
  let csp = contentSecurityPolicy('', extraConnect);
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.name.startsWith('.')) continue;          // never serve dotfiles
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) { walk(full); continue; }
      if (!ent.isFile()) continue;
      const body = fs.readFileSync(full);
      const rel = '/' + path.relative(root, full).split(path.sep).join('/');
      const type = TYPES[path.extname(full).toLowerCase()] || 'application/octet-stream';
      const gz = COMPRESSIBLE.test(type) && body.length >= 1024 ? zlib.gzipSync(body, { level: 9 }) : null;
      files.set(rel, { body, gz, type, etag: `"${crypto.createHash('sha256').update(body).digest('base64url').slice(0, 27)}"` });
      if (rel === '/index.html') csp = contentSecurityPolicy(body.toString('utf8'), extraConnect);
    }
  };
  if (!fs.existsSync(path.join(root, 'index.html'))) throw new Error(`No index.html in ${root} - run "node tools/build.js" first`);
  walk(root);
  const headers = securityHeaders(csp);

  function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, Object.assign({ allow: 'GET, HEAD', 'cache-control': 'no-cache' }, headers));
      return res.end();
    }
    let rel;
    try { rel = decodeURIComponent(url.pathname); } catch { rel = '/'; }
    if (rel.endsWith('/')) rel += 'index.html';
    const f = files.get(rel);
    if (!f) {
      res.writeHead(404, Object.assign({ 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-cache' }, headers));
      return res.end(req.method === 'HEAD' ? undefined : 'Not found');
    }
    const base = Object.assign({ 'content-type': f.type, etag: f.etag, 'cache-control': 'no-cache', vary: 'Accept-Encoding' }, headers);
    if (req.headers['if-none-match'] === f.etag) { res.writeHead(304, base); return res.end(); }
    const useGz = f.gz && /\bgzip\b/.test(req.headers['accept-encoding'] || '');
    const body = useGz ? f.gz : f.body;
    if (useGz) base['content-encoding'] = 'gzip';
    base['content-length'] = body.length;
    res.writeHead(200, base);
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  return { handle, files, headers };
}

module.exports = { loadDirectory, contentSecurityPolicy };
