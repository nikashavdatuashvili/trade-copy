// ProjectX Gateway API connector (TopstepX and other ProjectX-powered firms).
// Docs: https://gateway.docs.projectx.com/
//
// The trader buys "API Access" in their ProjectX/TopstepX settings, creates an API key and
// enters username + key in the dashboard. REST is used for actions, SignalR for live events.

import { EventEmitter } from 'node:events';
import * as signalR from '@microsoft/signalr';
import { RateLimiter } from '../util/common.js';

export const PX = {
  restUrl: 'https://api.topstepx.com',
  rtcUrl: 'https://rtc.topstepx.com',
};

const ORDER_TYPE = { 0: 'unknown', 1: 'limit', 2: 'market', 3: 'stopLimit', 4: 'stop', 5: 'trailingStop', 6: 'joinBid', 7: 'joinAsk' };
const ORDER_TYPE_NUM = Object.fromEntries(Object.entries(ORDER_TYPE).map(([k, v]) => [v, Number(k)]));
const ORDER_STATUS = { 0: 'pending', 1: 'open', 2: 'filled', 3: 'cancelled', 4: 'expired', 5: 'rejected', 6: 'pending' };
const SIDE = { 0: 'buy', 1: 'sell' };
const LOGIN_ERRORS = {
  3: 'Invalid username or API key',
  7: 'Agreements not signed: log into the ProjectX platform and accept them',
  9: 'No active API subscription on this ProjectX account',
  10: 'API key login is disabled for this account',
};

export class ProjectXError extends Error {
  constructor(path, errorCode, errorMessage, httpStatus) {
    super(`${path}: ${errorMessage || `errorCode ${errorCode}`}${httpStatus ? ` (HTTP ${httpStatus})` : ''}`);
    this.path = path;
    this.errorCode = errorCode;
    this.httpStatus = httpStatus;
  }
}

export function normalizeOrder(o) {
  return {
    accountId: String(o.accountId),
    orderId: String(o.id),
    contractId: o.contractId,
    status: ORDER_STATUS[o.status] ?? 'pending',
    type: ORDER_TYPE[o.type] ?? 'unknown',
    side: SIDE[o.side],
    size: o.size,
    limitPrice: o.limitPrice ?? null,
    stopPrice: o.stopPrice ?? null,
    trailPrice: o.trailPrice ?? null,
    filledPrice: o.filledPrice ?? null,
    fillVolume: o.fillVolume ?? (ORDER_STATUS[o.status] === 'filled' ? o.size : 0),
    customTag: o.customTag ?? null,
  };
}

export function normalizePosition(p) {
  const net = !p.size ? 0 : p.type === 2 ? -p.size : p.size;
  return { accountId: String(p.accountId), contractId: p.contractId, net, avgPrice: p.averagePrice ?? 0 };
}

export function orderRequestBody(req) {
  const type = ORDER_TYPE_NUM[req.type];
  if (!type || type === 3) throw new Error(`Order type "${req.type}" is not supported by ProjectX place`);
  return {
    accountId: Number(req.accountId),
    contractId: req.contractId,
    type,
    side: req.side === 'buy' ? 0 : 1,
    size: req.size,
    limitPrice: req.limitPrice ?? null,
    stopPrice: req.stopPrice ?? null,
    trailPrice: req.trailPrice ?? null,
    customTag: req.customTag ?? null,
    // Brackets are copied as separate stop/limit orders by the engine, so none are sent here.
  };
}

export class ProjectXConnector extends EventEmitter {
  constructor({ id, label = 'ProjectX', userName, apiKey, restUrl = PX.restUrl, rtcUrl = PX.rtcUrl, fetchImpl = globalThis.fetch, hubBuilder = null }) {
    super();
    this.setMaxListeners(100);
    this.id = id;
    this.type = 'projectx';
    this.label = label;
    this.userName = userName;
    this.apiKey = apiKey;
    this.restUrl = restUrl.replace(/\/$/, '');
    this.rtcUrl = rtcUrl.replace(/\/$/, '');
    this.fetch = fetchImpl;
    this.hubBuilder = hubBuilder; // injectable for tests
    this.status = 'disconnected';
    this.token = null;
    this.accounts = [];
    this.limiter = new RateLimiter(190, 60000); // documented: 200 / 60s
    this.userHub = null;
    this.marketHub = null;
    this.watched = new Set();
    this.renewTimer = null;
  }

  _setStatus(status, error) {
    this.status = status;
    this.emit('status', { status, error });
  }

  async _login() {
    const res = await this.fetch(`${this.restUrl}/api/Auth/loginKey`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', accept: 'text/plain' },
      body: JSON.stringify({ userName: this.userName, apiKey: this.apiKey }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.success || !body.token) {
      throw new ProjectXError('/api/Auth/loginKey', body.errorCode, LOGIN_ERRORS[body.errorCode] || body.errorMessage, res.ok ? null : res.status);
    }
    this.token = body.token;
  }

  async _renew() {
    try {
      const r = await this._post('/api/Auth/validate', {}, { retryAuth: false });
      if (r.newToken) this.token = r.newToken;
    } catch {
      await this._login(); // fall back to a fresh login with the stored key
    }
  }

  async _post(path, body, { retryAuth = true } = {}) {
    await this.limiter.acquire();
    const res = await this.fetch(`${this.restUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', accept: 'text/plain', Authorization: `Bearer ${this.token}` },
      body: JSON.stringify(body),
    });
    if (res.status === 401 && retryAuth) {
      await this._login();
      return this._post(path, body, { retryAuth: false });
    }
    if (res.status === 429) {
      await new Promise((r) => setTimeout(r, 1500));
      return this._post(path, body, { retryAuth });
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.success === false) throw new ProjectXError(path, data.errorCode, data.errorMessage, res.ok ? null : res.status);
    return data;
  }

  async connect() {
    this._setStatus('connecting');
    try {
      await this._login();
      const r = await this._post('/api/Account/search', { onlyActiveAccounts: true });
      this.accounts = (r.accounts || []).map((a) => ({ id: String(a.id), name: a.name, balance: a.balance, canTrade: a.canTrade }));
      await this._startHubs();
      clearInterval(this.renewTimer);
      this.renewTimer = setInterval(() => this._renew().catch((e) => this._setStatus('error', e.message)), 20 * 3600 * 1000); // tokens last 24h
      this._setStatus('connected');
    } catch (e) {
      this._setStatus('error', e.message);
      throw e;
    }
  }

  async disconnect() {
    clearInterval(this.renewTimer);
    await Promise.allSettled([this.userHub?.stop(), this.marketHub?.stop()]);
    this.userHub = this.marketHub = null;
    this._setStatus('disconnected');
  }

  _buildHub(url) {
    if (this.hubBuilder) return this.hubBuilder(url, () => this.token);
    return new signalR.HubConnectionBuilder()
      .withUrl(url, {
        skipNegotiation: true,
        transport: signalR.HttpTransportType.WebSockets,
        accessTokenFactory: () => this.token,
        timeout: 10000,
      })
      .withAutomaticReconnect({ nextRetryDelayInMilliseconds: (ctx) => Math.min(30000, 500 * 2 ** ctx.previousRetryCount) })
      .configureLogging(signalR.LogLevel.Warning)
      .build();
  }

  async _subscribeUser() {
    await this.userHub.invoke('SubscribeAccounts');
    for (const a of this.accounts) {
      const id = Number(a.id);
      await this.userHub.invoke('SubscribeOrders', id);
      await this.userHub.invoke('SubscribePositions', id);
      await this.userHub.invoke('SubscribeTrades', id);
    }
  }

  async _startHubs() {
    this.userHub = this._buildHub(`${this.rtcUrl}/hubs/user`);
    this.userHub.on('GatewayUserOrder', (d) => this.emit('order', normalizeOrder(d?.data ?? d)));
    this.userHub.on('GatewayUserPosition', (d) => this.emit('position', normalizePosition(d?.data ?? d)));
    this.userHub.on('GatewayUserTrade', (d) => {
      const t = d?.data ?? d;
      if (t.voided) return;
      this.emit('trade', { accountId: String(t.accountId), contractId: t.contractId, pnl: t.profitAndLoss ?? null, fees: t.fees ?? 0, size: t.size, price: t.price });
    });
    this.userHub.on('GatewayUserAccount', (d) => {
      const a = d?.data ?? d;
      const acc = this.accounts.find((x) => x.id === String(a.id));
      if (acc) Object.assign(acc, { balance: a.balance, canTrade: a.canTrade });
      this.emit('account', { id: String(a.id), balance: a.balance, canTrade: a.canTrade });
    });
    this.userHub.onreconnecting(() => this._setStatus('connecting', 'live connection lost, reconnecting'));
    this.userHub.onreconnected(async () => {
      await this._subscribeUser().catch(() => {});
      this._setStatus('connected');
      this.emit('resynced'); // events may have been missed: engine re-reads positions
    });
    this.userHub.onclose((err) => {
      if (this.status !== 'disconnected') {
        this._setStatus('error', `live connection closed${err ? `: ${err.message}` : ''}`);
        setTimeout(() => this._restartHubs(), 5000);
      }
    });
    await this.userHub.start();
    await this._subscribeUser();

    this.marketHub = this._buildHub(`${this.rtcUrl}/hubs/market`);
    this.marketHub.on('GatewayQuote', (contractId, data) => {
      const price = data?.lastPrice ?? (data?.bestBid != null && data?.bestAsk != null ? (data.bestBid + data.bestAsk) / 2 : null);
      if (price != null) this.emit('quote', { contractId, price });
    });
    this.marketHub.onreconnected(async () => {
      for (const c of this.watched) await this.marketHub.invoke('SubscribeContractQuotes', c).catch(() => {});
    });
    await this.marketHub.start().catch((e) => this.emit('status', { status: this.status, error: `market data unavailable: ${e.message}` }));
  }

  async _restartHubs() {
    if (this.status === 'disconnected') return;
    try {
      await Promise.allSettled([this.userHub?.stop(), this.marketHub?.stop()]);
      await this._renew();
      await this._startHubs();
      for (const c of this.watched) await this.marketHub.invoke('SubscribeContractQuotes', c).catch(() => {});
      this._setStatus('connected');
      this.emit('resynced');
    } catch (e) {
      this._setStatus('error', e.message);
      setTimeout(() => this._restartHubs(), 10000);
    }
  }

  // ------------------------------------------------------------ connector contract

  async listAccounts() {
    return this.accounts;
  }

  async getContract(contractId) {
    try {
      const r = await this._post('/api/Contract/searchById', { contractId });
      const c = r.contract;
      return c ? { id: c.id, name: c.name, tickSize: c.tickSize, tickValue: c.tickValue } : null;
    } catch {
      return null;
    }
  }

  async getPositions(accountId) {
    const r = await this._post('/api/Position/searchOpen', { accountId: Number(accountId) });
    return (r.positions || []).map(normalizePosition).filter((p) => p.net !== 0).map(({ contractId, net, avgPrice }) => ({ contractId, net, avgPrice }));
  }

  async getOpenOrders(accountId) {
    const r = await this._post('/api/Order/searchOpen', { accountId: Number(accountId) });
    return (r.orders || []).map(normalizeOrder);
  }

  async placeOrder(req) {
    const r = await this._post('/api/Order/place', orderRequestBody(req));
    return { orderId: String(r.orderId) };
  }

  async modifyOrder({ accountId, orderId, size = null, limitPrice = null, stopPrice = null, trailPrice = null }) {
    await this._post('/api/Order/modify', { accountId: Number(accountId), orderId: Number(orderId), size, limitPrice, stopPrice, trailPrice });
  }

  async cancelOrder({ accountId, orderId }) {
    await this._post('/api/Order/cancel', { accountId: Number(accountId), orderId: Number(orderId) });
  }

  async closePosition({ accountId, contractId }) {
    await this._post('/api/Position/closeContract', { accountId: Number(accountId), contractId });
  }

  async partialClose({ accountId, contractId, size }) {
    await this._post('/api/Position/partialCloseContract', { accountId: Number(accountId), contractId, size });
  }

  async watchContract(contractId) {
    if (this.watched.has(contractId) || !this.marketHub) return;
    this.watched.add(contractId);
    await this.marketHub.invoke('SubscribeContractQuotes', contractId);
  }
}
