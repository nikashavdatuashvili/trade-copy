import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ProjectXConnector, normalizeOrder, normalizePosition, orderRequestBody } from '../src/connectors/projectx.js';

function fakeHub() {
  const h = new EventEmitter();
  h.invoked = [];
  h.on = h.on.bind(h);
  h.start = async () => {};
  h.stop = async () => {};
  h.invoke = async (...args) => h.invoked.push(args);
  h.onreconnecting = () => {};
  h.onreconnected = (fn) => (h._reconnected = fn);
  h.onclose = () => {};
  // SignalR passes event args positionally
  h.fire = (name, ...args) => EventEmitter.prototype.emit.call(h, name, ...args);
  return h;
}

function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init) => {
    const path = new URL(url).pathname;
    const body = JSON.parse(init.body);
    calls.push({ path, body, auth: init.headers.Authorization });
    const handler = routes[path];
    if (!handler) return { ok: false, status: 404, json: async () => ({}) };
    const out = await handler(body, calls.length);
    return { ok: (out.status ?? 200) < 400, status: out.status ?? 200, json: async () => out.body };
  };
  fn.calls = calls;
  return fn;
}

const okLogin = () => ({ body: { token: 'T1', success: true, errorCode: 0 } });

test('normalizers map ProjectX enums', () => {
  assert.deepEqual(normalizePosition({ accountId: 5, contractId: 'C', type: 2, size: 3, averagePrice: 10 }), { accountId: '5', contractId: 'C', net: -3, avgPrice: 10 });
  const o = normalizeOrder({ id: 9, accountId: 5, contractId: 'C', status: 2, type: 4, side: 1, size: 2, stopPrice: 99, filledPrice: 98.75, fillVolume: 2, customTag: 'ct-x' });
  assert.equal(o.status, 'filled');
  assert.equal(o.type, 'stop');
  assert.equal(o.side, 'sell');
  assert.equal(o.orderId, '9');
  const b = orderRequestBody({ accountId: '5', contractId: 'C', type: 'limit', side: 'buy', size: 1, limitPrice: 100, customTag: 'ct-1' });
  assert.deepEqual(b, { accountId: 5, contractId: 'C', type: 1, side: 0, size: 1, limitPrice: 100, stopPrice: null, trailPrice: null, customTag: 'ct-1' });
  assert.throws(() => orderRequestBody({ type: 'stopLimit' }));
});

test('connect logs in, lists accounts and subscribes each account', async () => {
  const hubs = [];
  const f = fakeFetch({
    '/api/Auth/loginKey': okLogin,
    '/api/Account/search': () => ({ body: { success: true, accounts: [{ id: 1, name: 'A', balance: 50000, canTrade: true }, { id: 2, name: 'B', balance: 50000, canTrade: true }] } }),
  });
  const px = new ProjectXConnector({ id: 'px', userName: 'u', apiKey: 'k', fetchImpl: f, hubBuilder: () => { const h = fakeHub(); hubs.push(h); return h; } });
  await px.connect();
  assert.equal(px.status, 'connected');
  assert.equal(f.calls[0].path, '/api/Auth/loginKey');
  assert.deepEqual(f.calls[0].body, { userName: 'u', apiKey: 'k' });
  assert.equal(f.calls[1].auth, 'Bearer T1');
  const names = hubs[0].invoked.map((x) => x.join(':'));
  assert.deepEqual(names, ['SubscribeAccounts', 'SubscribeOrders:1', 'SubscribePositions:1', 'SubscribeTrades:1', 'SubscribeOrders:2', 'SubscribePositions:2', 'SubscribeTrades:2']);

  const got = [];
  px.on('order', (o) => got.push(o));
  px.on('position', (p) => got.push(p));
  hubs[0].fire('GatewayUserOrder', { id: 7, accountId: 1, contractId: 'C', status: 1, type: 2, side: 0, size: 1 });
  hubs[0].fire('GatewayUserPosition', { action: 1, data: { id: 3, accountId: 1, contractId: 'C', type: 1, size: 1, averagePrice: 5 } });
  assert.equal(got[0].type, 'market');
  assert.equal(got[1].net, 1);

  await px.watchContract('C');
  const quotes = [];
  px.on('quote', (q) => quotes.push(q));
  hubs[1].fire('GatewayQuote', 'C', { lastPrice: 101.25 });
  assert.deepEqual(quotes[0], { contractId: 'C', price: 101.25 });
  await px.disconnect();
});

test('login errors are explained in plain language', async () => {
  const f = fakeFetch({ '/api/Auth/loginKey': () => ({ body: { token: null, success: false, errorCode: 9 } }) });
  const px = new ProjectXConnector({ id: 'px', userName: 'u', apiKey: 'k', fetchImpl: f, hubBuilder: fakeHub });
  await assert.rejects(px.connect(), /No active API subscription/);
  assert.equal(px.status, 'error');
});

test('401 triggers one re-login and retry; API errors surface errorMessage', async () => {
  let n = 0;
  const f = fakeFetch({
    '/api/Auth/loginKey': okLogin,
    '/api/Order/place': () => (++n === 1 ? { status: 401, body: {} } : { body: { success: false, errorCode: 2, errorMessage: 'Outside trading hours' } }),
  });
  const px = new ProjectXConnector({ id: 'px', userName: 'u', apiKey: 'k', fetchImpl: f, hubBuilder: fakeHub });
  px.token = 'old';
  await assert.rejects(px.placeOrder({ accountId: 1, contractId: 'C', type: 'market', side: 'buy', size: 1 }), /Outside trading hours/);
  assert.deepEqual(f.calls.map((c) => c.path), ['/api/Order/place', '/api/Auth/loginKey', '/api/Order/place']);
});
