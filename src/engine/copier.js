// The copy engine: platform-agnostic leader -> followers replication.
//
// How it works (plain language):
//  1. Every order event from a LEADER account is copied to its followers immediately.
//     - Market orders: we compute what each follower's position SHOULD be after this order
//       (leader position x follower ratio) and send the difference. This keeps ratios exact
//       even for partial exits (leader 3 -> 2 with ratio 0.5 stays consistent).
//     - Pending orders (limit / stop / trailing, incl. stop-loss & take-profit): copied as
//       pending orders; later edits and cancels on the leader are mirrored.
//  2. A RECONCILER runs every ~0.5s. Once things are quiet, it compares each follower's real
//     position with the target. If they differ (rejected order, disconnect, manual trade…)
//     it auto re-syncs with guardrails:
//       - target flat           -> flatten follower (always safe)
//       - follower too big      -> partially close the excess (safe)
//       - follower missing size -> enter ONLY if price is within N ticks of the leader's entry,
//                                  otherwise alert and do not chase
//       - too many attempts     -> pause that follower and alert
//  3. Protective orders copied to a follower are cancelled when that follower goes flat, so a
//     stray stop can never open a new position.
//  4. KILL SWITCH: stop everything, cancel orders and flatten followers (optionally the leader).

import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import { roundHalfUp, sideSign, TERMINAL_STATUSES, Ring, percentile, makeCopyTag, isCopyTag } from '../util/common.js';

export const DEFAULT_OPTIONS = {
  graceMs: 1500, // wait this long after activity before judging a follower out of sync
  reconcileIntervalMs: 500,
  positionRefreshMs: 15000, // safety net: re-read positions over REST in case an event was missed
  maxResyncAttempts: 3,
  attemptWindowMs: 60000,
};

export const accKey = (connectionId, accountId) => `${connectionId}:${accountId}`;

/** Leader net position -> follower target net position. */
export function scaleNet(net, follower) {
  if (!net) return 0;
  const ratio = follower.ratio ?? 1;
  let qty = roundHalfUp(Math.abs(net) * ratio);
  if (follower.maxContracts) qty = Math.min(qty, follower.maxContracts);
  return Math.sign(net) * qty;
}

const snapOrder = (o) => ({ size: o.size, limitPrice: o.limitPrice ?? null, stopPrice: o.stopPrice ?? null, trailPrice: o.trailPrice ?? null });
const sameSnap = (a, b) => a.size === b.size && a.limitPrice === b.limitPrice && a.stopPrice === b.stopPrice && a.trailPrice === b.trailPrice;

export class CopyEngine extends EventEmitter {
  constructor({ options = {} } = {}) {
    super();
    this.setMaxListeners(100);
    this.opt = { ...DEFAULT_OPTIONS, ...options };
    this.connectors = new Map();
    this.listeners = new Map();
    this.groups = new Map(); // id -> { cfg, rt }
    this.positions = new Map(); // accKey -> Map(contractId -> {net, avgPrice})
    this.lastPrice = new Map(); // contractId -> price
    this.contractInfo = new Map(); // contractId -> {tickSize,...}
    this.tagIndex = new Map(); // customTag -> { groupId, link, copy }
    this.realized = new Map(); // accKey -> { pnl, fees, trades }
    this.priceHistory = new Map(); // contractId -> [{t, p}]
    this.metrics = { latencyMs: new Ring(1000), slippageTicks: new Ring(1000), copies: 0, failures: 0, desyncs: 0, resyncs: 0 };
    this.timers = [];
  }

  // ---------------------------------------------------------------- lifecycle

  start() {
    if (this.timers.length) return;
    this.timers.push(setInterval(() => this.reconcileNow().catch((e) => this._log('error', `Reconcile crashed: ${e.message}`)), this.opt.reconcileIntervalMs));
    this.timers.push(setInterval(() => this.refreshPositions().catch(() => {}), this.opt.positionRefreshMs));
  }

  stop() {
    this.timers.forEach(clearInterval);
    this.timers = [];
  }

  registerConnector(conn) {
    this.unregisterConnector(conn.id);
    const l = {
      order: (o) => this._onOrder(conn, o),
      position: (p) => this._onPosition(conn, p),
      quote: (q) => this._onQuote(conn, q),
      trade: (t) => this._onTrade(conn, t),
      status: (s) => {
        this._log(s.status === 'error' ? 'error' : 'info', `Connection "${conn.label}" ${s.status}${s.error ? `: ${s.error}` : ''}`);
        this.emit('change');
      },
      resynced: () => this.refreshPositions(conn.id).catch(() => {}),
    };
    for (const [ev, fn] of Object.entries(l)) conn.on(ev, fn);
    this.connectors.set(conn.id, conn);
    this.listeners.set(conn.id, l);
  }

  unregisterConnector(id) {
    const conn = this.connectors.get(id);
    const l = this.listeners.get(id);
    if (conn && l) for (const [ev, fn] of Object.entries(l)) conn.off(ev, fn);
    this.connectors.delete(id);
    this.listeners.delete(id);
  }

  // ---------------------------------------------------------------- groups

  validateGroup(cfg, ignoreId = null) {
    if (!cfg.leader?.connectionId || cfg.leader?.accountId == null) throw new Error('Leader account is required');
    if (!Array.isArray(cfg.followers) || cfg.followers.length === 0) throw new Error('At least one follower is required');
    const lk = accKey(cfg.leader.connectionId, cfg.leader.accountId);
    const keys = new Set([lk]);
    for (const f of cfg.followers) {
      const k = accKey(f.connectionId, f.accountId);
      if (keys.has(k)) throw new Error('An account can appear only once in a group (leader cannot follow itself)');
      keys.add(k);
      if (!(f.ratio > 0) || f.ratio > 100) throw new Error('Follower ratio must be between 0 and 100');
      if (f.maxContracts != null && !(Number.isInteger(f.maxContracts) && f.maxContracts > 0)) throw new Error('Max contracts must be a positive whole number');
    }
    for (const [id, g] of this.groups) {
      if (id === ignoreId) continue;
      for (const k of this._groupKeys(g.cfg)) {
        if (keys.has(k)) throw new Error('One of these accounts is already used in another copy group');
      }
    }
  }

  _groupKeys(cfg) {
    return [accKey(cfg.leader.connectionId, cfg.leader.accountId), ...cfg.followers.map((f) => accKey(f.connectionId, f.accountId))];
  }

  setGroup(cfg) {
    const normalized = {
      id: cfg.id,
      name: cfg.name || 'Copy group',
      leader: { connectionId: cfg.leader.connectionId, accountId: String(cfg.leader.accountId) },
      followers: cfg.followers.map((f) => ({
        connectionId: f.connectionId,
        accountId: String(f.accountId),
        ratio: Number(f.ratio ?? 1),
        maxContracts: f.maxContracts ? Number(f.maxContracts) : null,
        enabled: f.enabled !== false,
      })),
      resync: { enabled: cfg.resync?.enabled !== false, toleranceTicks: Number(cfg.resync?.toleranceTicks ?? 4) },
      running: !!cfg.running,
    };
    this.validateGroup(normalized, normalized.id);
    const existing = this.groups.get(normalized.id);
    if (existing?.rt) throw new Error('Stop the group before editing it');
    this.groups.set(normalized.id, { cfg: normalized, rt: null });
    this.emit('change');
    return normalized;
  }

  removeGroup(id) {
    const g = this.groups.get(id);
    if (g?.rt) throw new Error('Stop the group before deleting it');
    this.groups.delete(id);
    this.emit('change');
  }

  async startGroup(id) {
    const g = this.groups.get(id);
    if (!g) throw new Error('Group not found');
    if (g.rt) return;
    const all = [g.cfg.leader, ...g.cfg.followers];
    for (const a of all) {
      const c = this.connectors.get(a.connectionId);
      if (!c || c.status !== 'connected') throw new Error(`Connection for account ${a.accountId} is not connected`);
    }
    await Promise.all(all.map((a) => this._loadPositions(a.connectionId, a.accountId)));
    const lk = accKey(g.cfg.leader.connectionId, g.cfg.leader.accountId);
    const rt = {
      leaderKey: lk,
      leaderTracked: new Map(),
      lastLeaderActivity: new Map(),
      links: new Map(), // leader orderId -> link
      followers: new Map(),
    };
    for (const [c, p] of this.positions.get(lk) || []) {
      rt.leaderTracked.set(c, p.net);
      this._watch(g.cfg.leader.connectionId, c);
    }
    for (const f of g.cfg.followers) {
      const fk = accKey(f.connectionId, f.accountId);
      const planned = new Map();
      for (const [c, p] of this.positions.get(fk) || []) planned.set(c, p.net);
      rt.followers.set(fk, { cfg: f, key: fk, planned, inflightUntil: new Map(), busy: new Set(), attempts: [], paused: false, mismatch: new Map() });
    }
    g.rt = rt;
    g.cfg.running = true;
    this._log('info', `Group "${g.cfg.name}" started: 1 leader, ${g.cfg.followers.length} follower(s)`, { groupId: id });
    this.emit('change');
  }

  stopGroup(id) {
    const g = this.groups.get(id);
    if (!g) throw new Error('Group not found');
    if (!g.rt) return;
    g.rt = null;
    g.cfg.running = false;
    this._log('warn', `Group "${g.cfg.name}" stopped. Orders already copied to followers stay in place.`, { groupId: id });
    this.emit('change');
  }

  resumeFollower(groupId, followerKey) {
    const fr = this.groups.get(groupId)?.rt?.followers.get(followerKey);
    if (!fr) throw new Error('Follower not found or group not running');
    fr.paused = false;
    fr.attempts = [];
    fr.mismatch.clear();
    this._log('info', `Follower ${followerKey} resumed`, { groupId });
    this.emit('change');
  }

  // ---------------------------------------------------------------- event routing

  _runningGroups() {
    return [...this.groups.values()].filter((g) => g.rt);
  }

  _onOrder(conn, o) {
    const key = accKey(conn.id, o.accountId);
    if (o.status === 'filled' && o.filledPrice != null) this.lastPrice.set(o.contractId, o.filledPrice);
    for (const g of this._runningGroups()) {
      if (g.rt.leaderKey === key) this._onLeaderOrder(g, o, performance.now());
    }
    if (isCopyTag(o.customTag)) this._onCopyOrderUpdate(o);
  }

  _onQuote(conn, q) {
    this.lastPrice.set(q.contractId, q.price);
    let h = this.priceHistory.get(q.contractId);
    if (!h) this.priceHistory.set(q.contractId, (h = []));
    const now = Date.now();
    const last = h[h.length - 1];
    if (last && now - last.t < 250) last.p = q.price; // keep ~4 points/sec
    else h.push({ t: now, p: q.price });
    while (h.length && now - h[0].t > 15 * 60 * 1000) h.shift(); // 15 minutes
    if (!this.contractInfo.has(q.contractId)) this._contract(conn.id, q.contractId);
  }

  _onTrade(conn, t) {
    const key = accKey(conn.id, t.accountId);
    const r = this.realized.get(key) || { pnl: 0, fees: 0, trades: 0 };
    if (t.pnl != null) r.pnl += t.pnl;
    r.fees += t.fees || 0;
    r.trades += 1;
    this.realized.set(key, r);
    if (t.price != null) this.lastPrice.set(t.contractId, t.price);
    this.emit('positions');
  }

  /** Live P/L for one account: open (unrealized, at last price) + closed (realized this session). */
  accountPnl(key) {
    let unrealized = 0;
    let priced = true;
    for (const [c, p] of this.positions.get(key) || []) {
      const info = this.contractInfo.get(c);
      const last = this.lastPrice.get(c);
      if (!info?.tickSize || last == null) {
        priced = false;
        continue;
      }
      unrealized += ((last - p.avgPrice) * p.net * info.tickValue) / info.tickSize;
    }
    const r = this.realized.get(key) || { pnl: 0, fees: 0, trades: 0 };
    return { unrealized: Math.round(unrealized * 100) / 100, realized: Math.round((r.pnl - r.fees) * 100) / 100, trades: r.trades, priced };
  }

  _onPosition(conn, p) {
    const key = accKey(conn.id, p.accountId);
    if (p.net && !this.contractInfo.has(p.contractId)) this._contract(conn.id, p.contractId);
    this._setPosition(key, p.contractId, p.net, p.avgPrice);
    if (p.net === 0) {
      // Follower went flat: cancel any protective copies (stop-loss / take-profit) still resting,
      // so they can never open a fresh position on their own.
      for (const g of this._runningGroups()) {
        if (g.rt.followers.has(key)) this._deferProtective(g, key, p.contractId, 'follower is flat');
      }
    }
    this.emit('positions');
  }

  _setPosition(key, contractId, net, avgPrice) {
    if (!this.positions.has(key)) this.positions.set(key, new Map());
    const m = this.positions.get(key);
    if (!net) m.delete(contractId);
    else m.set(contractId, { net, avgPrice });
  }

  _actual(key, contractId) {
    return this.positions.get(key)?.get(contractId) || { net: 0, avgPrice: 0 };
  }

  // ---------------------------------------------------------------- leader handling

  _onLeaderOrder(g, o, t0) {
    const rt = g.rt;
    if (isCopyTag(o.customTag)) return; // never re-copy our own orders
    const c = o.contractId;
    rt.lastLeaderActivity.set(c, Date.now());
    this._watch(g.cfg.leader.connectionId, c);
    let link = rt.links.get(o.orderId);

    if (!link) {
      if (['rejected', 'cancelled', 'expired'].includes(o.status)) return;
      if (o.type === 'market') {
        link = { kind: 'market', contractId: c, side: o.side, copies: [], leaderFillPrice: o.filledPrice ?? null };
        rt.links.set(o.orderId, link);
        this._copyMarket(g, o, link, t0);
        return;
      }
      if (o.status === 'filled') {
        // A pending order we never saw open (e.g. created before the group started).
        rt.links.set(o.orderId, { kind: 'untracked', contractId: c, copies: [] });
        this._applyLeaderFill(rt, c, o.side, o.fillVolume || o.size);
        return;
      }
      if (o.type === 'stopLimit') {
        rt.links.set(o.orderId, { kind: 'ignored', contractId: c, copies: [] });
        this._log('warn', `Stop-limit orders are not copied yet (order ${o.orderId})`, { groupId: g.cfg.id });
        return;
      }
      link = { kind: 'pending', contractId: c, side: o.side, type: o.type, snapshot: snapOrder(o), baseLeader: rt.leaderTracked.get(c) || 0, filledApplied: 0, copies: [] };
      rt.links.set(o.orderId, link);
      this._copyPending(g, o, link, t0);
      return;
    }

    if (link.kind === 'market') {
      if (o.filledPrice != null && link.leaderFillPrice == null) {
        link.leaderFillPrice = o.filledPrice;
        for (const copy of link.copies) this._recordSlippage(link, copy);
      }
      return;
    }
    if (link.kind !== 'pending') return;

    const vol = o.status === 'filled' ? o.fillVolume || o.size : o.fillVolume || 0;
    if (vol > link.filledApplied) {
      this._applyLeaderFill(rt, c, o.side, vol - link.filledApplied);
      link.filledApplied = vol;
      if (o.filledPrice != null) link.leaderFillPrice = o.filledPrice;
      for (const copy of link.copies) this._recordSlippage(link, copy);
    }
    if (['cancelled', 'expired', 'rejected'].includes(o.status)) {
      link.closed = true;
      for (const copy of link.copies) this._cancelCopy(g, copy, `leader order ${o.status}`);
      return;
    }
    if (o.status === 'open' && !sameSnap(link.snapshot, snapOrder(o))) {
      link.snapshot = snapOrder(o);
      this._modifyCopies(g, link, o);
    }
  }

  _applyLeaderFill(rt, contractId, side, qty) {
    const after = (rt.leaderTracked.get(contractId) || 0) + sideSign(side) * qty;
    rt.leaderTracked.set(contractId, after);
    for (const fr of rt.followers.values()) fr.planned.set(contractId, scaleNet(after, fr.cfg));
  }

  _activeFollowers(g) {
    return [...g.rt.followers.values()].filter((fr) => fr.cfg.enabled && !fr.paused);
  }

  _copyMarket(g, o, link, t0) {
    const rt = g.rt;
    const c = o.contractId;
    const after = (rt.leaderTracked.get(c) || 0) + sideSign(o.side) * o.size;
    rt.leaderTracked.set(c, after);
    for (const fr of this._activeFollowers(g)) {
      const planned = fr.planned.has(c) ? fr.planned.get(c) : this._actual(fr.key, c).net;
      const target = scaleNet(after, fr.cfg);
      const delta = target - planned;
      fr.planned.set(c, target);
      if (delta === 0) continue;
      fr.inflightUntil.set(c, Date.now() + this.opt.graceMs);
      this._sendCopy(g, fr, link, { contractId: c, type: 'market', side: delta > 0 ? 'buy' : 'sell', size: Math.abs(delta) }, t0, false);
    }
  }

  _pendingSize(link, fr, size) {
    const L = link.baseLeader;
    const signed = sideSign(link.side) * size;
    return Math.abs(scaleNet(L + signed, fr.cfg) - scaleNet(L, fr.cfg));
  }

  _copyPending(g, o, link, t0) {
    const L = link.baseLeader;
    const signed = sideSign(o.side) * o.size;
    const reducing = L !== 0 && Math.sign(signed) !== Math.sign(L);
    link.reducing = reducing;
    link.deferred = new Set();
    for (const fr of this._activeFollowers(g)) {
      if (reducing && !this._followerOnSide(fr, o.contractId, L)) {
        // Follower has no position to protect (e.g. its entry was rejected). Placing this stop/limit
        // could OPEN a position, so hold it back; it is restored after a successful re-sync.
        link.deferred.add(fr.key);
        this._log('warn', `Protective order ${o.orderId} held back on ${fr.key}: follower has no matching position`, { groupId: g.cfg.id });
        continue;
      }
      const size = this._pendingSize(link, fr, o.size);
      if (size === 0) {
        this._log('info', `Order ${o.orderId} not copied to ${fr.key}: ratio rounds it to 0 contracts`, { groupId: g.cfg.id });
        continue;
      }
      this._sendCopy(g, fr, link, {
        contractId: o.contractId, type: o.type, side: o.side, size,
        limitPrice: o.limitPrice ?? null, stopPrice: o.stopPrice ?? null, trailPrice: o.trailPrice ?? null,
      }, t0, reducing);
    }
  }

  _followerOnSide(fr, contractId, leaderNet) {
    const net = fr.planned.has(contractId) ? fr.planned.get(contractId) : this._actual(fr.key, contractId).net;
    return net !== 0 && Math.sign(net) === Math.sign(leaderNet);
  }

  /** Cancel a follower's resting protective copies on a contract and remember them for restore. */
  _deferProtective(g, key, contractId, why) {
    for (const link of g.rt.links.values()) {
      if (link.kind !== 'pending' || link.closed || link.contractId !== contractId) continue;
      for (const copy of link.copies) {
        if (copy.key === key && copy.reducing && !TERMINAL_STATUSES.has(copy.status)) {
          link.deferred.add(key);
          this._cancelCopy(g, copy, why);
        }
      }
    }
  }

  /** After a follower is re-entered, re-place the leader's still-open protective orders on it. */
  _restoreProtective(g, fr, contractId) {
    for (const [leaderOrderId, link] of g.rt.links) {
      if (link.kind !== 'pending' || link.closed || link.contractId !== contractId || !link.deferred?.has(fr.key)) continue;
      link.deferred.delete(fr.key);
      const size = this._pendingSize(link, fr, link.snapshot.size);
      if (size === 0) continue;
      this._log('info', `Restoring protective order ${leaderOrderId} on ${fr.key}`, { groupId: g.cfg.id });
      this._sendCopy(g, fr, link, { contractId, type: link.type, side: link.side, limitPrice: link.snapshot.limitPrice, stopPrice: link.snapshot.stopPrice, trailPrice: link.snapshot.trailPrice, size }, performance.now(), true);
    }
  }

  _sendCopy(g, fr, link, req, t0, reducing) {
    const conn = this.connectors.get(fr.cfg.connectionId);
    const tag = makeCopyTag();
    const copy = { key: fr.key, accountId: fr.cfg.accountId, connectionId: fr.cfg.connectionId, tag, orderId: null, status: 'sending', side: req.side, size: req.size, reducing, fillPrice: null, slippageRecorded: false };
    link.copies.push(copy);
    this.tagIndex.set(tag, { groupId: g.cfg.id, link, copy });
    copy.promise = conn
      .placeOrder({ ...req, accountId: fr.cfg.accountId, customTag: tag })
      .then(({ orderId }) => {
        copy.orderId = String(orderId);
        if (copy.status === 'sending') copy.status = 'open';
        this.metrics.copies++;
        this.metrics.latencyMs.push(performance.now() - t0);
        this._log('info', `Copied ${req.type} ${req.side} ${req.size} ${req.contractId} -> ${fr.key}`, { groupId: g.cfg.id, ms: Math.round(performance.now() - t0) });
        if (link.closed) this._cancelCopy(g, copy, 'leader order already closed');
        return copy.orderId;
      })
      .catch((e) => {
        copy.status = 'rejected';
        this.metrics.failures++;
        if (req.type === 'market') {
          fr.planned.delete(req.contractId); // unknown now: reconciler will compare real positions
          fr.inflightUntil.set(req.contractId, 0);
          if (g.rt && this._actual(fr.key, req.contractId).net === 0) this._deferProtective(g, fr.key, req.contractId, 'entry failed');
        }
        this._log('error', `Copy to ${fr.key} FAILED (${req.type} ${req.side} ${req.size} ${req.contractId}): ${e.message}`, { groupId: g.cfg.id });
        this.emit('alert', { level: 'error', message: `Copy to ${fr.key} failed: ${e.message}` });
        return null;
      });
  }

  _onCopyOrderUpdate(o) {
    const entry = this.tagIndex.get(o.customTag);
    if (!entry) return;
    const { copy, link } = entry;
    if (!copy.orderId) copy.orderId = String(o.orderId);
    copy.status = o.status;
    if (o.status === 'filled' && o.filledPrice != null) {
      copy.fillPrice = o.filledPrice;
      this._recordSlippage(link, copy);
    }
    if (TERMINAL_STATUSES.has(o.status) && link.kind === 'market') this.tagIndex.delete(o.customTag);
  }

  async _recordSlippage(link, copy) {
    if (copy.slippageRecorded || copy.fillPrice == null || link.leaderFillPrice == null) return;
    copy.slippageRecorded = true;
    const info = await this._contract(copy.connectionId, link.contractId);
    if (!info?.tickSize) return;
    // Positive = follower got a worse price than the leader.
    const ticks = ((copy.fillPrice - link.leaderFillPrice) * sideSign(copy.side)) / info.tickSize;
    this.metrics.slippageTicks.push(Math.round(ticks * 100) / 100);
  }

  async _modifyCopies(g, link, o) {
    for (const copy of link.copies) {
      const orderId = await copy.promise;
      if (!orderId || TERMINAL_STATUSES.has(copy.status)) continue;
      const fr = g.rt?.followers.get(copy.key);
      if (!fr) continue;
      const size = this._pendingSize(link, fr, o.size);
      const conn = this.connectors.get(copy.connectionId);
      try {
        if (size === 0) {
          await this._cancelCopy(g, copy, 'resized to 0');
          continue;
        }
        await conn.modifyOrder({ accountId: copy.accountId, orderId, size: size !== copy.size ? size : null, limitPrice: o.limitPrice ?? null, stopPrice: o.stopPrice ?? null, trailPrice: o.trailPrice ?? null });
        copy.size = size;
        this._log('info', `Modified copy on ${copy.key} (order ${orderId})`, { groupId: g.cfg.id });
      } catch (e) {
        this._log('error', `Modify on ${copy.key} failed: ${e.message}`, { groupId: g.cfg.id });
      }
    }
  }

  async _cancelCopy(g, copy, why) {
    if (copy.cancelRequested) return;
    copy.cancelRequested = true;
    const orderId = await copy.promise;
    if (!orderId || TERMINAL_STATUSES.has(copy.status)) return;
    try {
      await this.connectors.get(copy.connectionId).cancelOrder({ accountId: copy.accountId, orderId });
      copy.status = 'cancelled';
      this._log('info', `Cancelled copy on ${copy.key} (${why})`, { groupId: g?.cfg.id });
    } catch (e) {
      // Usually means it just filled or was already cancelled; the reconciler covers the rest.
      this._log('warn', `Cancel on ${copy.key} failed (${why}): ${e.message}`, { groupId: g?.cfg.id });
    }
  }

  // ---------------------------------------------------------------- reconciler

  async reconcileNow() {
    const jobs = [];
    for (const g of this._runningGroups()) {
      const rt = g.rt;
      const contracts = new Set([...rt.leaderTracked.keys(), ...(this.positions.get(rt.leaderKey)?.keys() || [])]);
      for (const fr of rt.followers.values()) for (const c of this.positions.get(fr.key)?.keys() || []) contracts.add(c);
      for (const c of contracts) {
        if (Date.now() - (rt.lastLeaderActivity.get(c) || 0) < this.opt.graceMs) continue;
        const leader = this._actual(rt.leaderKey, c);
        rt.leaderTracked.set(c, leader.net);
        for (const fr of rt.followers.values()) {
          if (!fr.cfg.enabled || fr.paused || fr.busy.has(c)) continue;
          if ((fr.inflightUntil.get(c) || 0) > Date.now()) continue;
          const target = scaleNet(leader.net, fr.cfg);
          const actual = this._actual(fr.key, c).net;
          if (target === actual) {
            fr.planned.set(c, actual);
            if (fr.mismatch.has(c)) {
              fr.mismatch.delete(c);
              this._log('info', `${fr.key} back in sync on ${c}`, { groupId: g.cfg.id });
              this.emit('change');
            }
            continue;
          }
          jobs.push(this._resolveMismatch(g, fr, c, leader, target, actual));
        }
      }
    }
    await Promise.all(jobs);
  }

  async _resolveMismatch(g, fr, c, leader, target, actual) {
    const now = Date.now();
    let m = fr.mismatch.get(c);
    if (!m) {
      m = { since: now, target, actual, notified: false, chaseBlocked: false };
      fr.mismatch.set(c, m);
      this.metrics.desyncs++;
      this.emit('change');
    }
    m.target = target;
    m.actual = actual;
    if (!m.notified) {
      m.notified = true;
      this._log('warn', `OUT OF SYNC: ${fr.key} has ${actual} on ${c}, should have ${target}`, { groupId: g.cfg.id });
      this.emit('alert', { level: 'warn', message: `${fr.key} out of sync on ${c}: has ${actual}, should have ${target}` });
    }
    if (!g.cfg.resync.enabled) return;

    fr.attempts = fr.attempts.filter((t) => now - t < this.opt.attemptWindowMs);
    if (fr.attempts.length >= this.opt.maxResyncAttempts) {
      fr.paused = true;
      this._log('error', `Paused ${fr.key}: ${this.opt.maxResyncAttempts} re-sync attempts failed. Check the account, then resume it.`, { groupId: g.cfg.id });
      this.emit('alert', { level: 'error', message: `Follower ${fr.key} paused after repeated re-sync failures` });
      this.emit('change');
      return;
    }

    const conn = this.connectors.get(fr.cfg.connectionId);
    const base = { accountId: fr.cfg.accountId, contractId: c };
    fr.busy.add(c);
    try {
      if (target === 0) {
        fr.attempts.push(now);
        await conn.closePosition(base);
        this._log('warn', `Re-sync: flattened ${fr.key} on ${c}`, { groupId: g.cfg.id });
      } else if (Math.sign(target) === Math.sign(actual) && Math.abs(actual) > Math.abs(target)) {
        fr.attempts.push(now);
        await conn.partialClose({ ...base, size: Math.abs(actual) - Math.abs(target) });
        this._log('warn', `Re-sync: reduced ${fr.key} on ${c} from ${actual} to ${target}`, { groupId: g.cfg.id });
      } else {
        const check = await this._priceCheck(g, c, leader.avgPrice);
        if (!check.ok) {
          if (!m.chaseBlocked) {
            m.chaseBlocked = true;
            this._log('warn', `Re-sync NOT done for ${fr.key} on ${c}: ${check.reason}. Fix manually or wait for the next leader trade.`, { groupId: g.cfg.id });
            this.emit('alert', { level: 'warn', message: `${fr.key}: not chasing price on ${c} (${check.reason})` });
          }
          return;
        }
        fr.attempts.push(now);
        if (actual !== 0 && Math.sign(actual) !== Math.sign(target)) {
          await conn.closePosition(base);
          await conn.placeOrder({ ...base, type: 'market', side: target > 0 ? 'buy' : 'sell', size: Math.abs(target), customTag: makeCopyTag() });
        } else {
          const delta = target - actual;
          await conn.placeOrder({ ...base, type: 'market', side: delta > 0 ? 'buy' : 'sell', size: Math.abs(delta), customTag: makeCopyTag() });
        }
        this._log('warn', `Re-sync: moved ${fr.key} on ${c} from ${actual} to ${target} (${check.reason})`, { groupId: g.cfg.id });
      }
      this.metrics.resyncs++;
      fr.planned.set(c, target);
      if (target !== 0) this._restoreProtective(g, fr, c);
      fr.inflightUntil.set(c, Date.now() + this.opt.graceMs);
      m.notified = false; // if it still differs after this, say so again
    } catch (e) {
      this._log('error', `Re-sync of ${fr.key} on ${c} failed: ${e.message}`, { groupId: g.cfg.id });
      fr.inflightUntil.set(c, Date.now() + this.opt.graceMs);
    } finally {
      fr.busy.delete(c);
    }
  }

  async _priceCheck(g, contractId, leaderAvg) {
    const tol = g.cfg.resync.toleranceTicks;
    const info = await this._contract(g.cfg.leader.connectionId, contractId);
    const last = this.lastPrice.get(contractId);
    if (!info?.tickSize || last == null || !leaderAvg) return { ok: false, reason: 'no reliable current price' };
    const ticks = Math.abs(last - leaderAvg) / info.tickSize;
    if (ticks > tol) return { ok: false, reason: `price moved ${ticks.toFixed(1)} ticks from leader entry (limit ${tol})` };
    return { ok: true, reason: `${ticks.toFixed(1)} ticks from leader entry` };
  }

  // ---------------------------------------------------------------- kill switch

  async killSwitch({ includeLeader = false } = {}) {
    const targets = new Map();
    for (const g of this.groups.values()) {
      if (g.rt) this.stopGroup(g.cfg.id);
      for (const f of g.cfg.followers) targets.set(accKey(f.connectionId, f.accountId), f);
      if (includeLeader) targets.set(accKey(g.cfg.leader.connectionId, g.cfg.leader.accountId), g.cfg.leader);
    }
    const results = await Promise.all(
      [...targets.entries()].map(async ([key, a]) => {
        const conn = this.connectors.get(a.connectionId);
        if (!conn || conn.status !== 'connected') return { key, ok: false, error: 'not connected' };
        try {
          const orders = await conn.getOpenOrders(a.accountId);
          await Promise.allSettled(orders.map((o) => conn.cancelOrder({ accountId: a.accountId, orderId: o.orderId })));
          const positions = await conn.getPositions(a.accountId);
          await Promise.all(positions.filter((p) => p.net).map((p) => conn.closePosition({ accountId: a.accountId, contractId: p.contractId })));
          return { key, ok: true, cancelled: orders.length, flattened: positions.filter((p) => p.net).length };
        } catch (e) {
          return { key, ok: false, error: e.message };
        }
      })
    );
    this._log('error', `KILL SWITCH used${includeLeader ? ' (including leaders)' : ''}: ${results.map((r) => `${r.key} ${r.ok ? 'OK' : 'FAILED ' + r.error}`).join(', ')}`);
    this.emit('alert', { level: 'error', message: 'Kill switch executed' });
    return results;
  }

  // ---------------------------------------------------------------- helpers

  async _loadPositions(connectionId, accountId) {
    const conn = this.connectors.get(connectionId);
    const key = accKey(connectionId, accountId);
    const list = await conn.getPositions(accountId);
    const m = new Map();
    for (const p of list) if (p.net) m.set(p.contractId, { net: p.net, avgPrice: p.avgPrice });
    this.positions.set(key, m);
  }

  /** Safety net: re-read positions over REST for all accounts in running groups. */
  async refreshPositions(onlyConnectionId = null) {
    const seen = new Set();
    const jobs = [];
    for (const g of this._runningGroups()) {
      for (const a of [g.cfg.leader, ...g.cfg.followers]) {
        if (onlyConnectionId && a.connectionId !== onlyConnectionId) continue;
        const k = accKey(a.connectionId, a.accountId);
        if (seen.has(k)) continue;
        seen.add(k);
        // Skip accounts with something in flight: the REST snapshot could be older than our events.
        const busy = g.rt.followers.get(k);
        if (busy && [...busy.inflightUntil.values()].some((t) => t > Date.now())) continue;
        jobs.push(this._loadPositions(a.connectionId, a.accountId).catch((e) => this._log('warn', `Position refresh failed for ${k}: ${e.message}`)));
      }
    }
    await Promise.all(jobs);
    if (jobs.length) this.emit('positions');
  }

  async _contract(connectionId, contractId) {
    if (this.contractInfo.has(contractId)) return this.contractInfo.get(contractId);
    const conn = this.connectors.get(connectionId);
    try {
      const info = await conn?.getContract(contractId);
      if (info) this.contractInfo.set(contractId, info);
      return info;
    } catch {
      return null;
    }
  }

  _watch(connectionId, contractId) {
    const conn = this.connectors.get(connectionId);
    if (conn?.watchContract) Promise.resolve(conn.watchContract(contractId)).catch(() => {});
  }

  _log(level, msg, data = {}) {
    this.emit('log', { ts: new Date().toISOString(), level, msg, ...data });
  }

  // ---------------------------------------------------------------- state for the UI

  getMetrics() {
    const lat = this.metrics.latencyMs.toArray();
    const slip = this.metrics.slippageTicks.toArray();
    const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
    return {
      copies: this.metrics.copies,
      failures: this.metrics.failures,
      desyncs: this.metrics.desyncs,
      resyncs: this.metrics.resyncs,
      latency: { samples: lat.length, avg: avg(lat), p50: percentile(lat, 50), p95: percentile(lat, 95), max: lat.length ? Math.max(...lat) : null },
      slippage: { samples: slip.length, avgTicks: avg(slip), worstTicks: slip.length ? Math.max(...slip) : null },
    };
  }

  getState() {
    const groups = [...this.groups.values()].map(({ cfg, rt }) => ({
      ...cfg,
      followers: cfg.followers.map((f) => {
        const k = accKey(f.connectionId, f.accountId);
        const fr = rt?.followers.get(k);
        return {
          ...f,
          key: k,
          paused: fr?.paused || false,
          mismatches: fr ? [...fr.mismatch.entries()].map(([contractId, m]) => ({ contractId, target: m.target, actual: m.actual, since: m.since })) : [],
        };
      }),
    }));
    const positions = {};
    for (const [k, m] of this.positions) positions[k] = Object.fromEntries(m);
    const pnl = {};
    const keys = new Set([...this.positions.keys(), ...this.realized.keys()]);
    for (const g of this.groups.values()) for (const k of this._groupKeys(g.cfg)) keys.add(k);
    for (const k of keys) pnl[k] = this.accountPnl(k);
    return {
      groups, positions, pnl,
      lastPrice: Object.fromEntries(this.lastPrice),
      contracts: Object.fromEntries(this.contractInfo),
      metrics: this.getMetrics(),
    };
  }
}
