// In-memory simulated broker. Used for:
//  - the "Sim Lab" in the dashboard (try the copier without any real account)
//  - automated tests and the latency benchmark
// It follows the same connector contract as the real ProjectX connector.

import { EventEmitter } from 'node:events';
import { sideSign } from '../util/common.js';

export const DEFAULT_SIM_CONTRACTS = {
  'SIM.MNQ': { id: 'SIM.MNQ', name: 'MNQ (sim)', tickSize: 0.25, tickValue: 0.5, price: 21000 },
  'SIM.MES': { id: 'SIM.MES', name: 'MES (sim)', tickSize: 0.25, tickValue: 1.25, price: 6000 },
  'SIM.NQ': { id: 'SIM.NQ', name: 'NQ (sim)', tickSize: 0.25, tickValue: 5, price: 21000 },
};

/** Shared fake market: holds prices and broadcasts quotes. */
export class SimMarket extends EventEmitter {
  constructor(contracts = DEFAULT_SIM_CONTRACTS) {
    super();
    this.setMaxListeners(100);
    this.contracts = structuredClone(contracts);
    this.walkTimer = null;
  }

  price(contractId) {
    return this.contracts[contractId]?.price;
  }

  setPrice(contractId, price) {
    const c = this.contracts[contractId];
    if (!c) throw new Error(`Unknown sim contract ${contractId}`);
    c.price = Math.round(price / c.tickSize) * c.tickSize;
    this.emit('quote', { contractId, price: c.price });
  }

  moveTicks(contractId, ticks) {
    const c = this.contracts[contractId];
    this.setPrice(contractId, c.price + ticks * c.tickSize);
  }

  startWalk(intervalMs = 300) {
    if (this.walkTimer) return;
    this.drift = this.drift || {};
    this.walkTimer = setInterval(() => {
      for (const id of Object.keys(this.contracts)) {
        // random walk with a little momentum so it looks like a real tape
        const d = (this.drift[id] = (this.drift[id] || 0) * 0.85 + (Math.random() - 0.5) * 1.6);
        const step = Math.round(d + (Math.random() - 0.5) * 2);
        if (step) this.moveTicks(id, step);
      }
    }, intervalMs);
  }

  stopWalk() {
    clearInterval(this.walkTimer);
    this.walkTimer = null;
  }

  get walking() {
    return !!this.walkTimer;
  }
}

let simOrderSeq = 1000;

export class SimConnector extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.id
   * @param {SimMarket} o.market
   * @param {{id:string,name:string,balance?:number}[]} o.accounts
   * @param {number} [o.latencyMs]  simulated network latency for each request
   * @param {number} [o.slippageTicks]  ticks of adverse slippage on market fills
   */
  constructor({ id, label = 'Sim', market, accounts, latencyMs = 0, slippageTicks = 0 }) {
    super();
    this.setMaxListeners(100);
    this.id = id;
    this.type = 'sim';
    this.label = label;
    this.market = market;
    this.latencyMs = latencyMs;
    this.slippageTicks = slippageTicks;
    this.status = 'disconnected';
    this.accounts = new Map(
      accounts.map((a) => [String(a.id), { ...a, id: String(a.id), balance: a.balance ?? 50000, canTrade: true }])
    );
    this.orders = new Map(); // orderId -> order
    this.positions = new Map(); // accountId -> Map(contractId -> {net, avgPrice})
    this.failNextFor = new Map(); // accountId -> reason
    this._onQuote = (q) => {
      this.emit('quote', q);
      this._checkTriggers(q.contractId, q.price);
    };
  }

  async _net() {
    if (this.latencyMs > 0) await new Promise((r) => setTimeout(r, this.latencyMs));
    else await Promise.resolve();
  }

  _emitLater(event, payload) {
    const snapshot = structuredClone(payload); // freeze state now, deliver "over the network" later
    queueMicrotask(() => this.emit(event, snapshot));
  }

  _account(accountId) {
    const a = this.accounts.get(String(accountId));
    if (!a) throw new Error(`Sim account ${accountId} not found`);
    return a;
  }

  async connect() {
    this.market.on('quote', this._onQuote);
    this.status = 'connected';
    this.emit('status', { status: this.status });
  }

  async disconnect() {
    this.market.off('quote', this._onQuote);
    this.status = 'disconnected';
    this.emit('status', { status: this.status });
  }

  async listAccounts() {
    return [...this.accounts.values()].map(({ id, name, balance, canTrade }) => ({ id, name, balance, canTrade }));
  }

  async getContract(contractId) {
    const c = this.market.contracts[contractId];
    return c ? { id: c.id, name: c.name, tickSize: c.tickSize, tickValue: c.tickValue } : null;
  }

  async getPositions(accountId) {
    await this._net();
    const m = this.positions.get(String(accountId)) || new Map();
    return [...m.entries()].filter(([, p]) => p.net !== 0).map(([contractId, p]) => ({ contractId, ...p }));
  }

  async getOpenOrders(accountId) {
    await this._net();
    return [...this.orders.values()]
      .filter((o) => o.accountId === String(accountId) && (o.status === 'open' || o.status === 'pending'))
      .map((o) => structuredClone(o));
  }

  async watchContract() {}

  /** Test helper: the next order on this account is rejected. */
  failNext(accountId, reason = 'Simulated rejection') {
    this.failNextFor.set(String(accountId), reason);
  }

  /** Test helper: set a position directly (e.g. to simulate a manual trade or a desync). */
  forcePosition(accountId, contractId, net, avgPrice = this.market.price(contractId)) {
    const m = this._posMap(accountId);
    m.set(contractId, { net, avgPrice: net === 0 ? 0 : avgPrice });
    this._emitLater('position', { accountId: String(accountId), contractId, net, avgPrice: net === 0 ? 0 : avgPrice });
  }

  _posMap(accountId) {
    const k = String(accountId);
    if (!this.positions.has(k)) this.positions.set(k, new Map());
    return this.positions.get(k);
  }

  async placeOrder(req) {
    await this._net();
    const accountId = String(req.accountId);
    this._account(accountId);
    const c = this.market.contracts[req.contractId];
    if (!c) throw new Error(`Contract not found: ${req.contractId}`);
    if (!Number.isInteger(req.size) || req.size <= 0) throw new Error(`Invalid size ${req.size}`);
    const orderId = String(++simOrderSeq);
    const order = {
      accountId,
      orderId,
      contractId: req.contractId,
      status: 'open',
      type: req.type,
      side: req.side,
      size: req.size,
      limitPrice: req.limitPrice ?? null,
      stopPrice: req.stopPrice ?? null,
      trailPrice: req.trailPrice ?? null,
      filledPrice: null,
      fillVolume: 0,
      customTag: req.customTag ?? null,
    };
    const failReason = this.failNextFor.get(accountId);
    if (failReason) {
      this.failNextFor.delete(accountId);
      order.status = 'rejected';
      this.orders.set(orderId, order);
      this._emitLater('order', order);
      const err = new Error(failReason);
      err.code = 'REJECTED';
      throw err;
    }
    this.orders.set(orderId, order);
    this._emitLater('order', order);
    if (order.type === 'market') {
      this._fill(order, c.price + sideSign(order.side) * this.slippageTicks * c.tickSize);
    } else {
      this._checkTriggers(order.contractId, c.price);
    }
    return { orderId };
  }

  async modifyOrder({ accountId, orderId, size, limitPrice, stopPrice, trailPrice }) {
    await this._net();
    const o = this.orders.get(String(orderId));
    if (!o || o.accountId !== String(accountId)) throw new Error(`Order ${orderId} not found`);
    if (o.status !== 'open') throw new Error(`Order ${orderId} is ${o.status}`);
    if (size != null) o.size = size;
    if (limitPrice != null) o.limitPrice = limitPrice;
    if (stopPrice != null) o.stopPrice = stopPrice;
    if (trailPrice != null) o.trailPrice = trailPrice;
    this._emitLater('order', o);
    this._checkTriggers(o.contractId, this.market.price(o.contractId));
  }

  async cancelOrder({ accountId, orderId }) {
    await this._net();
    const o = this.orders.get(String(orderId));
    if (!o || o.accountId !== String(accountId)) throw new Error(`Order ${orderId} not found`);
    if (o.status !== 'open') throw new Error(`Order ${orderId} is ${o.status}`);
    o.status = 'cancelled';
    this._emitLater('order', o);
  }

  async closePosition({ accountId, contractId }) {
    const p = this._posMap(accountId).get(contractId);
    if (!p || p.net === 0) return;
    await this.placeOrder({ accountId, contractId, type: 'market', side: p.net > 0 ? 'sell' : 'buy', size: Math.abs(p.net) });
  }

  async partialClose({ accountId, contractId, size }) {
    const p = this._posMap(accountId).get(contractId);
    if (!p || p.net === 0) throw new Error('Position not found');
    if (size <= 0 || size > Math.abs(p.net)) throw new Error('Invalid close size');
    await this.placeOrder({ accountId, contractId, type: 'market', side: p.net > 0 ? 'sell' : 'buy', size });
  }

  _checkTriggers(contractId, price) {
    for (const o of this.orders.values()) {
      if (o.status !== 'open' || o.contractId !== contractId || o.type === 'market') continue;
      let hit = false;
      if (o.type === 'limit') hit = o.side === 'buy' ? price <= o.limitPrice : price >= o.limitPrice;
      else if (o.type === 'stop') hit = o.side === 'buy' ? price >= o.stopPrice : price <= o.stopPrice;
      else if (o.type === 'joinBid' || o.type === 'joinAsk') hit = true;
      if (hit) this._fill(o, o.type === 'limit' ? o.limitPrice : price);
    }
  }

  _fill(order, price) {
    order.status = 'filled';
    order.filledPrice = price;
    order.fillVolume = order.size;
    const m = this._posMap(order.accountId);
    const p = m.get(order.contractId) || { net: 0, avgPrice: 0 };
    const signed = sideSign(order.side) * order.size;
    const net = p.net + signed;
    // Realized P/L on the part of the position that was closed
    if (p.net !== 0 && Math.sign(signed) !== Math.sign(p.net)) {
      const closed = Math.min(Math.abs(signed), Math.abs(p.net));
      const c = this.market.contracts[order.contractId];
      const pnl = ((price - p.avgPrice) * Math.sign(p.net) * closed * c.tickValue) / c.tickSize;
      this._emitLater('trade', { accountId: order.accountId, contractId: order.contractId, pnl: Math.round(pnl * 100) / 100, fees: 0, size: order.size, price });
    } else {
      this._emitLater('trade', { accountId: order.accountId, contractId: order.contractId, pnl: null, fees: 0, size: order.size, price });
    }
    let avgPrice;
    if (net === 0) avgPrice = 0;
    else if (p.net === 0 || Math.sign(p.net) !== Math.sign(net)) avgPrice = price; // opened or flipped
    else if (Math.sign(signed) === Math.sign(p.net)) avgPrice = (p.avgPrice * Math.abs(p.net) + price * Math.abs(signed)) / Math.abs(net);
    else avgPrice = p.avgPrice; // reduced
    m.set(order.contractId, { net, avgPrice });
    this._emitLater('order', order);
    this._emitLater('position', { accountId: order.accountId, contractId: order.contractId, net, avgPrice });
  }
}
