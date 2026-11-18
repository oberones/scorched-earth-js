// ---------------------------------------------------------------------------
// Minimal RFC 6455 WebSocket server (text frames, ping/pong, close, fragmentation).
// No dependencies, so the game server deploys with nothing but Node >= 18.
// ---------------------------------------------------------------------------
'use strict';
const crypto = require('crypto');
const { EventEmitter } = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_PAYLOAD = 64 * 1024;

class WebSocketConnection extends EventEmitter {
  constructor(socket, req) {
    super();
    this.socket = socket;
    this.req = req;
    this.buf = Buffer.alloc(0);
    this.fragments = [];
    this.fragOpcode = 0;
    this.open = true;
    this.lastSeen = Date.now();
    socket.setNoDelay(true);
    socket.on('data', (d) => this._onData(d));
    socket.on('close', () => this._closed());
    socket.on('error', () => this._closed());
  }

  get remoteAddress() {
    const fwd = this.req.headers['x-forwarded-for'];
    return (fwd ? String(fwd).split(',')[0].trim() : this.socket.remoteAddress) || '?';
  }

  _onData(chunk) {
    this.lastSeen = Date.now();
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      const frame = this._parseFrame();
      if (!frame) break;
      this._onFrame(frame);
      if (!this.open) break;
    }
  }

  _parseFrame() {
    const b = this.buf;
    if (b.length < 2) return null;
    const fin = (b[0] & 0x80) !== 0;
    const opcode = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f;
    let off = 2;
    if (len === 126) { if (b.length < 4) return null; len = b.readUInt16BE(2); off = 4; }
    else if (len === 127) {
      if (b.length < 10) return null;
      const hi = b.readUInt32BE(2), lo = b.readUInt32BE(6);
      if (hi !== 0) { this.close(1009, 'too big'); return null; }
      len = lo; off = 10;
    }
    if (len > MAX_PAYLOAD) { this.close(1009, 'too big'); return null; }
    if (!masked) { this.close(1002, 'client frames must be masked'); return null; }
    if (b.length < off + 4 + len) return null;
    const mask = b.subarray(off, off + 4);
    off += 4;
    const payload = Buffer.from(b.subarray(off, off + len));
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    this.buf = b.subarray(off + len);
    return { fin, opcode, payload };
  }

  _onFrame({ fin, opcode, payload }) {
    switch (opcode) {
      case 0x0: // continuation
        if (!this.fragOpcode) return this.close(1002, 'unexpected continuation');
        this.fragments.push(payload);
        if (this.fragments.reduce((n, p) => n + p.length, 0) > MAX_PAYLOAD) return this.close(1009, 'too big');
        if (fin) {
          const all = Buffer.concat(this.fragments);
          const op = this.fragOpcode;
          this.fragments = []; this.fragOpcode = 0;
          if (op === 0x1) this.emit('message', all.toString('utf8'));
        }
        return;
      case 0x1: // text
      case 0x2: // binary (accepted, but the game protocol is JSON text)
        if (!fin) { this.fragOpcode = opcode; this.fragments = [payload]; return; }
        if (opcode === 0x1) this.emit('message', payload.toString('utf8'));
        return;
      case 0x8: { // close
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1000;
        this.close(code === 1005 ? 1000 : code);
        return;
      }
      case 0x9: this._send(0xA, payload); return; // ping -> pong
      case 0xA: return;                            // pong
      default: this.close(1002, 'bad opcode');
    }
  }

  _send(opcode, payload) {
    if (!this.open || this.socket.destroyed) return;
    const len = payload.length;
    let header;
    if (len < 126) { header = Buffer.alloc(2); header[1] = len; }
    else if (len < 65536) { header = Buffer.alloc(4); header[1] = 126; header.writeUInt16BE(len, 2); }
    else { header = Buffer.alloc(10); header[1] = 127; header.writeUInt32BE(0, 2); header.writeUInt32BE(len, 6); }
    header[0] = 0x80 | opcode;
    this.socket.write(Buffer.concat([header, payload]));
  }

  send(text) { this._send(0x1, Buffer.from(text, 'utf8')); }
  ping() { this._send(0x9, Buffer.alloc(0)); }

  close(code = 1000, reason = '') {
    if (!this.open) return;
    const r = Buffer.from(String(reason).slice(0, 100));
    const p = Buffer.alloc(2 + r.length);
    p.writeUInt16BE(code, 0); r.copy(p, 2);
    this._send(0x8, p);
    this.open = false;
    this.socket.end();
    setTimeout(() => this.socket.destroy(), 1000).unref();
    this._closed();
  }

  _closed() {
    if (this._didClose) return;
    this._didClose = true;
    this.open = false;
    this.emit('close');
  }
}

// Attach to an http.Server. onConnection(ws) is called for each accepted socket.
// verify(req) may return a falsy value to accept or { status, reason } to refuse.
function attachWebSocketServer(server, { path = '/ws', onConnection, heartbeatMs = 25000, verify = null, maxClients = Infinity }) {
  const clients = new Set();
  const refuse = (socket, status, reason) => {
    socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  };
  server.on('upgrade', (req, socket) => {
    socket.on('error', () => socket.destroy());
    const url = new URL(req.url, 'http://x');
    const key = req.headers['sec-websocket-key'];
    if (url.pathname !== path || !key || String(req.headers.upgrade).toLowerCase() !== 'websocket') {
      return refuse(socket, 400, 'Bad Request');
    }
    if (clients.size >= maxClients) return refuse(socket, 503, 'Service Unavailable');
    const denied = verify && verify(req);
    if (denied) return refuse(socket, denied.status || 403, denied.reason || 'Forbidden');
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '', '',
    ].join('\r\n'));
    const ws = new WebSocketConnection(socket, req);
    clients.add(ws);
    ws.on('close', () => clients.delete(ws));
    onConnection(ws);
  });
  // keepalive: ping idle sockets, drop dead ones (also keeps proxies from timing out)
  const timer = setInterval(() => {
    const now = Date.now();
    for (const ws of clients) {
      if (now - ws.lastSeen > heartbeatMs * 2.5) { ws.socket.destroy(); ws._closed(); }
      else ws.ping();
    }
  }, heartbeatMs);
  timer.unref();
  return {
    clients,
    closeAll(code = 1001, reason = 'server shutting down') { for (const ws of clients) ws.close(code, reason); },
  };
}

module.exports = { attachWebSocketServer };
