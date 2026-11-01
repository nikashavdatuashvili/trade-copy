// Minimal HTTP + Server-Sent-Events API for the dashboard (no framework).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', (c) => {
      s += c;
      if (s.length > 1e6) reject(new Error('Body too large'));
    });
    req.on('end', () => {
      try {
        resolve(s ? JSON.parse(s) : {});
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
  });
}

function checkAuth(req) {
  const pw = process.env.DASHBOARD_PASSWORD;
  if (!pw) return true;
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return false;
  const [, given] = Buffer.from(h.slice(6), 'base64').toString().split(':');
  const a = Buffer.from(given || '');
  const b = Buffer.from(pw);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function createServer(app) {
  const { engine } = app;
  const clients = new Set();
  const broadcast = (event, data) => {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) res.write(msg);
  };
  let pending = false;
  const pushState = () => {
    if (pending) return;
    pending = true;
    setTimeout(() => {
      pending = false;
      broadcast('state', snapshot());
    }, 100);
  };
  engine.on('log', (l) => broadcast('log', l));
  engine.on('alert', (a) => broadcast('alert', a));
  engine.on('change', pushState);
  engine.on('positions', pushState);
  app.simMarket.on('quote', pushState);
  setInterval(pushState, 2000);

  function connectionsView() {
    return [...engine.connectors.values()].map((c) => ({ id: c.id, type: c.type, label: c.label, status: c.status }));
  }

  async function fullState() {
    const connections = await Promise.all(
      [...engine.connectors.values()].map(async (c) => ({
        id: c.id, type: c.type, label: c.label, status: c.status,
        accounts: c.status === 'connected' ? await c.listAccounts().catch(() => []) : [],
      }))
    );
    return {
      connections,
      ...engine.getState(),
      sim: { walking: app.simMarket.walking, contracts: app.simMarket.contracts },
      history: Object.fromEntries(engine.priceHistory),
      logs: app.logs.toArray().slice(-200),
    };
  }

  // SSE sends the cheap synchronous view; clients fetch /api/state for accounts when needed.
  const snapshot = () => ({ connections: connectionsView(), ...engine.getState(), sim: { walking: app.simMarket.walking, contracts: app.simMarket.contracts } });

  const simConn = (id) => {
    const c = engine.connectors.get(id);
    if (!c || c.type !== 'sim') throw new Error('Not a sim connection');
    return c;
  };

  const routes = {
    'GET /api/state': async () => fullState(),
    'POST /api/connections': async (b) => ({ id: await app.addConnection(b) }),
    'DELETE /api/connections/:id': async (_, p) => (await app.removeConnection(p.id), { ok: true }),
    'POST /api/connections/:id/reconnect': async (_, p) => (await app.reconnect(p.id), { ok: true }),
    'POST /api/groups': async (b) => app.saveGroup(b),
    'PUT /api/groups/:id': async (b, p) => app.saveGroup({ ...b, id: p.id }),
    'DELETE /api/groups/:id': async (_, p) => (engine.removeGroup(p.id), app.store.remove('groups', p.id), { ok: true }),
    'POST /api/groups/:id/start': async (_, p) => (await engine.startGroup(p.id), app.persistGroups(), { ok: true }),
    'POST /api/groups/:id/stop': async (_, p) => (engine.stopGroup(p.id), app.persistGroups(), { ok: true }),
    'POST /api/groups/:id/resume': async (b, p) => (engine.resumeFollower(p.id, b.followerKey), { ok: true }),
    'POST /api/kill': async (b) => {
      const r = await engine.killSwitch({ includeLeader: !!b.includeLeader });
      app.persistGroups();
      return { results: r };
    },
    // ---- Sim Lab: lets you "trade" the simulated leader from the dashboard
    'POST /api/sim/order': async (b) => simConn(b.connectionId).placeOrder({
      accountId: b.accountId, contractId: b.contractId, type: b.type, side: b.side, size: Number(b.size),
      limitPrice: b.limitPrice != null && b.limitPrice !== '' ? Number(b.limitPrice) : null,
      stopPrice: b.stopPrice != null && b.stopPrice !== '' ? Number(b.stopPrice) : null,
    }),
    'POST /api/sim/flatten': async (b) => (await simConn(b.connectionId).closePosition(b), { ok: true }),
    'POST /api/sim/orders': async (b) => simConn(b.connectionId).getOpenOrders(b.accountId),
    'POST /api/sim/cancel': async (b) => (await simConn(b.connectionId).cancelOrder(b), { ok: true }),
    'POST /api/sim/modify': async (b) => (await simConn(b.connectionId).modifyOrder(b), { ok: true }),
    'POST /api/sim/reject-next': async (b) => (simConn(b.connectionId).failNext(b.accountId), { ok: true }),
    'POST /api/sim/force-position': async (b) => (simConn(b.connectionId).forcePosition(b.accountId, b.contractId, Number(b.net)), { ok: true }),
    'POST /api/sim/price': async (b) => {
      if (b.ticks != null) app.simMarket.moveTicks(b.contractId, Number(b.ticks));
      else app.simMarket.setPrice(b.contractId, Number(b.price));
      return { ok: true };
    },
    'POST /api/sim/walk': async (b) => (b.on ? app.simMarket.startWalk() : app.simMarket.stopWalk(), { ok: true }),
  };

  function match(method, pathname) {
    for (const [k, fn] of Object.entries(routes)) {
      const [m, pattern] = k.split(' ');
      if (m !== method) continue;
      const a = pattern.split('/');
      const b = pathname.split('/');
      if (a.length !== b.length) continue;
      const params = {};
      if (a.every((seg, i) => (seg.startsWith(':') ? ((params[seg.slice(1)] = decodeURIComponent(b[i])), true) : seg === b[i]))) return { fn, params };
    }
    return null;
  }

  return http.createServer(async (req, res) => {
    if (!checkAuth(req)) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="CopyTrader"' });
      return res.end('Authentication required');
    }
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(`event: state\ndata: ${JSON.stringify(snapshot())}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      const m = match(req.method, url.pathname);
      if (!m) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Not found' }));
      }
      try {
        const body = req.method === 'GET' ? {} : await readBody(req);
        const out = await m.fn(body, m.params);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(out ?? { ok: true }));
        pushState();
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }
    // static files
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const file = path.join(WEB, path.normalize(rel));
    if (!file.startsWith(WEB) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404);
      return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
}
