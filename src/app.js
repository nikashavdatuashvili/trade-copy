// Entry point: wires store + connectors + copy engine + web server.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Store } from './store.js';
import { CopyEngine } from './engine/copier.js';
import { SimMarket, SimConnector } from './connectors/sim.js';
import { ProjectXConnector } from './connectors/projectx.js';
import { createServer } from './server.js';
import { Ring } from './util/common.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadDotEnv() {
  const f = path.join(ROOT, '.env');
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

export class App {
  constructor({ dataDir = path.join(ROOT, 'data'), logDir = path.join(ROOT, 'logs') } = {}) {
    this.store = new Store(dataDir);
    this.logDir = logDir;
    fs.mkdirSync(logDir, { recursive: true });
    this.engine = new CopyEngine();
    this.simMarket = new SimMarket();
    this.logs = new Ring(500);
    this.engine.on('log', (l) => this._writeLog(l));
  }

  _writeLog(l) {
    this.logs.push(l);
    const day = l.ts.slice(0, 10);
    fs.appendFile(path.join(this.logDir, `${day}.jsonl`), JSON.stringify(l) + '\n', () => {});
    const color = { error: '\x1b[31m', warn: '\x1b[33m', info: '\x1b[32m' }[l.level] || '';
    console.log(`${color}[${l.ts.slice(11, 23)}] ${l.level.toUpperCase()}\x1b[0m ${l.msg}`);
  }

  buildConnector(rec) {
    if (rec.type === 'sim') {
      return new SimConnector({
        id: rec.id,
        label: rec.label,
        market: this.simMarket,
        latencyMs: rec.options?.latencyMs ?? 15,
        accounts: rec.options?.accounts ?? [
          { id: `${rec.id}-L`, name: 'SIM Leader 50K' },
          { id: `${rec.id}-F1`, name: 'SIM Follower 1' },
          { id: `${rec.id}-F2`, name: 'SIM Follower 2' },
          { id: `${rec.id}-F3`, name: 'SIM Follower 3' },
        ],
      });
    }
    if (rec.type === 'projectx') {
      const secret = this.store.decrypt(rec.secret);
      return new ProjectXConnector({ id: rec.id, label: rec.label, userName: secret.userName, apiKey: secret.apiKey, restUrl: rec.options?.restUrl, rtcUrl: rec.options?.rtcUrl });
    }
    throw new Error(`Unknown connection type ${rec.type}`);
  }

  async addConnection({ type, label, userName, apiKey, restUrl, rtcUrl }) {
    const id = `${type}-${crypto.randomBytes(3).toString('hex')}`;
    const rec = { id, type, label: label || (type === 'sim' ? 'Sim Lab' : 'ProjectX'), options: {} };
    if (type === 'projectx') {
      if (!userName || !apiKey) throw new Error('ProjectX username and API key are required');
      rec.secret = this.store.encrypt({ userName, apiKey });
      if (restUrl) rec.options.restUrl = restUrl;
      if (rtcUrl) rec.options.rtcUrl = rtcUrl;
    }
    const conn = this.buildConnector(rec);
    this.engine.registerConnector(conn);
    await conn.connect(); // fail fast on bad credentials: nothing is saved
    this.store.upsert('connections', rec);
    if (type === 'sim') this.simMarket.startWalk(); // make the fake market move right away
    return id;
  }

  async removeConnection(id) {
    for (const g of this.engine.groups.values()) {
      if ([g.cfg.leader, ...g.cfg.followers].some((a) => a.connectionId === id)) throw new Error(`Connection is used by group "${g.cfg.name}"`);
    }
    const conn = this.engine.connectors.get(id);
    await conn?.disconnect().catch(() => {});
    this.engine.unregisterConnector(id);
    this.store.remove('connections', id);
  }

  async reconnect(id) {
    const conn = this.engine.connectors.get(id);
    if (!conn) throw new Error('Connection not found');
    await conn.disconnect().catch(() => {});
    await conn.connect();
  }

  saveGroup(cfg) {
    const g = this.engine.setGroup({ ...cfg, id: cfg.id || `grp-${crypto.randomBytes(3).toString('hex')}`, running: false });
    this.store.upsert('groups', g);
    return g;
  }

  persistGroups() {
    for (const g of this.engine.groups.values()) this.store.upsert('groups', g.cfg);
  }

  async boot() {
    for (const rec of this.store.connections) {
      try {
        const conn = this.buildConnector(rec);
        this.engine.registerConnector(conn);
        await conn.connect();
        if (rec.type === 'sim') this.simMarket.startWalk();
      } catch (e) {
        this.engine._log('error', `Could not connect "${rec.label}": ${e.message}`);
      }
    }
    for (const cfg of this.store.groups) {
      try {
        const wasRunning = cfg.running;
        this.engine.setGroup({ ...cfg, running: false });
        if (wasRunning && process.env.AUTO_START_GROUPS === 'true') await this.engine.startGroup(cfg.id);
        else if (wasRunning) this.engine._log('warn', `Group "${cfg.name}" was running before restart. It stays STOPPED until you start it (set AUTO_START_GROUPS=true to change this).`);
      } catch (e) {
        this.engine._log('error', `Could not restore group "${cfg.name}": ${e.message}`);
      }
    }
    this.persistGroups();
    this.engine.start();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  loadDotEnv();
  const app = new App({
    ...(process.env.DATA_DIR ? { dataDir: path.resolve(process.env.DATA_DIR) } : {}),
    ...(process.env.LOG_DIR ? { logDir: path.resolve(process.env.LOG_DIR) } : {}),
  });
  await app.boot();
  const port = Number(process.env.PORT || 8787);
  const host = process.env.HOST || '127.0.0.1';
  if (host !== '127.0.0.1' && host !== 'localhost' && !process.env.DASHBOARD_PASSWORD) {
    console.error('Refusing to listen on a public address without DASHBOARD_PASSWORD set.');
    process.exit(1);
  }
  createServer(app).listen(port, host, () => console.log(`\x1b[32mCopyTrader dashboard: http://${host}:${port}\x1b[0m`));
  const shutdown = async () => {
    app.persistGroups();
    for (const c of app.engine.connectors.values()) await c.disconnect().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
