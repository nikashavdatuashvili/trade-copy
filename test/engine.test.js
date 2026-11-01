import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CopyEngine, scaleNet } from '../src/engine/copier.js';
import { SimMarket, SimConnector } from '../src/connectors/sim.js';
import { sleep } from '../src/util/common.js';

const C = 'SIM.MNQ';

async function setup({ followers = [{ ratio: 1 }], resync = { enabled: true, toleranceTicks: 4 }, options = {} } = {}) {
  const market = new SimMarket();
  const conn = new SimConnector({
    id: 'sim1',
    market,
    accounts: [{ id: 'L', name: 'Leader' }, ...followers.map((_, i) => ({ id: `F${i + 1}`, name: `Follower ${i + 1}` }))],
  });
  await conn.connect();
  const engine = new CopyEngine({ options: { graceMs: 50, reconcileIntervalMs: 20, positionRefreshMs: 60000, ...options } });
  const logs = [];
  engine.on('log', (l) => logs.push(l));
  engine.registerConnector(conn);
  engine.setGroup({
    id: 'g1',
    name: 'Test',
    leader: { connectionId: 'sim1', accountId: 'L' },
    followers: followers.map((f, i) => ({ connectionId: 'sim1', accountId: `F${i + 1}`, ...f })),
    resync,
  });
  await engine.startGroup('g1');
  const net = (acc) => engine._actual(`sim1:${acc}`, C).net;
  const leader = (req) => conn.placeOrder({ accountId: 'L', contractId: C, ...req });
  return { market, conn, engine, net, leader, logs };
}

const settle = (ms = 30) => sleep(ms);

test('scaleNet rounds half up and respects max', () => {
  assert.equal(scaleNet(3, { ratio: 0.5 }), 2);
  assert.equal(scaleNet(-3, { ratio: 0.5 }), -2);
  assert.equal(scaleNet(1, { ratio: 0.3 }), 0);
  assert.equal(scaleNet(10, { ratio: 1, maxContracts: 4 }), 4);
  assert.equal(scaleNet(0, { ratio: 2 }), 0);
});

test('market entry and exit are copied 1:1 to every follower', async () => {
  const { net, leader, engine } = await setup({ followers: [{ ratio: 1 }, { ratio: 1 }, { ratio: 1 }] });
  await leader({ type: 'market', side: 'buy', size: 2 });
  await settle();
  assert.deepEqual([net('L'), net('F1'), net('F2'), net('F3')], [2, 2, 2, 2]);
  await leader({ type: 'market', side: 'sell', size: 2 });
  await settle();
  assert.deepEqual([net('L'), net('F1'), net('F2'), net('F3')], [0, 0, 0, 0]);
  assert.equal(engine.getMetrics().copies, 6);
});

test('size ratios stay consistent through scale-in and partial exits', async () => {
  const { net, leader } = await setup({ followers: [{ ratio: 2 }, { ratio: 0.5 }, { ratio: 1, maxContracts: 2 }] });
  await leader({ type: 'market', side: 'buy', size: 1 });
  await settle();
  assert.deepEqual([net('F1'), net('F2'), net('F3')], [2, 1, 1]);
  await leader({ type: 'market', side: 'buy', size: 2 }); // leader 3
  await settle();
  assert.deepEqual([net('F1'), net('F2'), net('F3')], [6, 2, 2]);
  await leader({ type: 'market', side: 'sell', size: 1 }); // leader 2
  await settle();
  assert.deepEqual([net('F1'), net('F2'), net('F3')], [4, 1, 2]);
  await leader({ type: 'market', side: 'sell', size: 2 }); // flat
  await settle();
  assert.deepEqual([net('F1'), net('F2'), net('F3')], [0, 0, 0]);
});

test('short positions and reversals are copied', async () => {
  const { net, leader } = await setup();
  await leader({ type: 'market', side: 'sell', size: 1 });
  await settle();
  assert.equal(net('F1'), -1);
  await leader({ type: 'market', side: 'buy', size: 3 }); // reverse to +2
  await settle();
  assert.equal(net('F1'), 2);
});

test('pending limit order is copied, modified and cancelled with the leader', async () => {
  const { conn, leader, market } = await setup({ followers: [{ ratio: 1 }, { ratio: 2 }] });
  const { orderId } = await leader({ type: 'limit', side: 'buy', size: 1, limitPrice: market.price(C) - 10 });
  await settle();
  let f1 = await conn.getOpenOrders('F1');
  let f2 = await conn.getOpenOrders('F2');
  assert.equal(f1.length, 1);
  assert.equal(f1[0].limitPrice, market.price(C) - 10);
  assert.equal(f2[0].size, 2);

  await conn.modifyOrder({ accountId: 'L', orderId, limitPrice: market.price(C) - 20, size: 2 });
  await settle();
  f1 = await conn.getOpenOrders('F1');
  f2 = await conn.getOpenOrders('F2');
  assert.equal(f1[0].limitPrice, market.price(C) - 20);
  assert.equal(f1[0].size, 2);
  assert.equal(f2[0].size, 4);

  await conn.cancelOrder({ accountId: 'L', orderId });
  await settle();
  assert.equal((await conn.getOpenOrders('F1')).length, 0);
  assert.equal((await conn.getOpenOrders('F2')).length, 0);
});

test('stop-loss / take-profit copies: TP fills, SL is cancelled everywhere', async () => {
  const { conn, leader, market, net } = await setup();
  const entry = market.price(C);
  await leader({ type: 'market', side: 'buy', size: 1 });
  await settle();
  const sl = await leader({ type: 'stop', side: 'sell', size: 1, stopPrice: entry - 5 });
  await leader({ type: 'limit', side: 'sell', size: 1, limitPrice: entry + 5 });
  await settle();
  assert.equal((await conn.getOpenOrders('F1')).length, 2);

  market.setPrice(C, entry + 5); // TP hits on leader and follower
  await settle();
  assert.equal(net('L'), 0);
  assert.equal(net('F1'), 0);
  // Leader cancels its SL (like an OCO would); follower SL must disappear too.
  await conn.cancelOrder({ accountId: 'L', orderId: sl.orderId });
  await settle();
  assert.equal((await conn.getOpenOrders('F1')).length, 0);
});

test('follower SL copy is auto-cancelled when follower goes flat on its own', async () => {
  const { conn, leader, market, net } = await setup();
  const entry = market.price(C);
  await leader({ type: 'market', side: 'buy', size: 1 });
  await settle();
  await leader({ type: 'stop', side: 'sell', size: 1, stopPrice: entry - 5 });
  await settle();
  conn.forcePosition('F1', C, 0); // e.g. follower got stopped/closed by the prop firm
  await settle();
  assert.equal((await conn.getOpenOrders('F1')).length, 0, 'stray stop must not stay resting on a flat account');
  assert.equal(net('L'), 1);
});

test('rejected follower entry is re-synced when price is within tolerance', async () => {
  const { conn, leader, net, engine } = await setup({ followers: [{ ratio: 1 }, { ratio: 1 }] });
  conn.failNext('F2');
  await leader({ type: 'market', side: 'buy', size: 2 });
  await settle();
  assert.equal(net('F1'), 2);
  assert.equal(net('F2'), 0);
  engine.start();
  await settle(250);
  engine.stop();
  assert.equal(net('F2'), 2, 'reconciler should have re-entered F2');
  assert.ok(engine.getMetrics().resyncs >= 1);
});

test('re-sync does NOT chase when price moved beyond tolerance', async () => {
  const { conn, leader, net, engine, market, logs } = await setup({ resync: { enabled: true, toleranceTicks: 4 } });
  conn.failNext('F1');
  await leader({ type: 'market', side: 'buy', size: 1 });
  market.moveTicks(C, 20);
  engine.start();
  await settle(250);
  engine.stop();
  assert.equal(net('F1'), 0);
  assert.ok(logs.some((l) => l.msg.includes('NOT done')));
});

test('follower holding a position while leader is flat gets flattened', async () => {
  const { conn, net, engine } = await setup();
  conn.forcePosition('F1', C, 3); // manual / stray trade
  engine.start();
  await settle(250);
  engine.stop();
  assert.equal(net('F1'), 0);
});

test('follower is paused after repeated failed re-syncs', async () => {
  const { conn, net, engine } = await setup({ options: { maxResyncAttempts: 2, graceMs: 10 } });
  conn.forcePosition('F1', C, 2);
  conn.closePosition = async () => {
    throw new Error('broker down');
  };
  engine.start();
  await settle(400);
  engine.stop();
  assert.equal(net('F1'), 2);
  assert.equal(engine.getState().groups[0].followers[0].paused, true);
});

test('re-sync disabled: only alerts', async () => {
  const { conn, net, engine } = await setup({ resync: { enabled: false } });
  const alerts = [];
  engine.on('alert', (a) => alerts.push(a));
  conn.forcePosition('F1', C, 1);
  engine.start();
  await settle(200);
  engine.stop();
  assert.equal(net('F1'), 1);
  assert.equal(alerts.length, 1);
});

test('kill switch cancels follower orders and flattens followers, leaves leader', async () => {
  const { conn, leader, net, engine, market } = await setup({ followers: [{ ratio: 1 }, { ratio: 1 }] });
  await leader({ type: 'market', side: 'buy', size: 1 });
  await leader({ type: 'stop', side: 'sell', size: 1, stopPrice: market.price(C) - 10 });
  await settle();
  const res = await engine.killSwitch();
  await settle();
  assert.ok(res.every((r) => r.ok));
  assert.deepEqual([net('L'), net('F1'), net('F2')], [1, 0, 0]);
  assert.equal((await conn.getOpenOrders('F1')).length, 0);
  assert.equal(engine.getState().groups[0].running, false);
});

test('copied orders are never re-copied (no loops) and leader tags are ignored', async () => {
  const { conn, leader, engine } = await setup();
  await leader({ type: 'market', side: 'buy', size: 1 });
  await settle();
  // Only the follower order should exist besides the leader's.
  const all = [...conn.orders.values()];
  assert.equal(all.length, 2);
  assert.equal(engine.getMetrics().copies, 1);
});

test('group validation rejects bad configs', async () => {
  const engine = new CopyEngine();
  assert.throws(() => engine.setGroup({ id: 'x', leader: { connectionId: 'a', accountId: '1' }, followers: [] }));
  assert.throws(() => engine.setGroup({ id: 'x', leader: { connectionId: 'a', accountId: '1' }, followers: [{ connectionId: 'a', accountId: '1', ratio: 1 }] }));
  engine.setGroup({ id: 'x', leader: { connectionId: 'a', accountId: '1' }, followers: [{ connectionId: 'a', accountId: '2', ratio: 1 }] });
  assert.throws(() => engine.setGroup({ id: 'y', leader: { connectionId: 'a', accountId: '3' }, followers: [{ connectionId: 'a', accountId: '2', ratio: 1 }] }), /another copy group/);
});

test('latency is measured for every copy', async () => {
  const { leader, engine } = await setup({ followers: [{ ratio: 1 }, { ratio: 1 }] });
  await leader({ type: 'market', side: 'buy', size: 1 });
  await settle();
  const m = engine.getMetrics();
  assert.equal(m.latency.samples, 2);
  assert.ok(m.latency.p95 < 50);
  assert.equal(m.slippage.samples, 2);
  assert.equal(m.slippage.avgTicks, 0);
});

test('stop-loss is held back on a follower whose entry failed, then restored after re-sync', async () => {
  const { conn, leader, market, net, engine } = await setup({ followers: [{ ratio: 1 }, { ratio: 1 }] });
  const entry = market.price(C);
  conn.failNext('F2');
  await leader({ type: 'market', side: 'buy', size: 1 });
  await leader({ type: 'stop', side: 'sell', size: 1, stopPrice: entry - 5 }); // immediate SL, like a bracket
  await settle();
  assert.equal((await conn.getOpenOrders('F1')).length, 1);
  assert.equal((await conn.getOpenOrders('F2')).length, 0, 'flat follower must not hold a stop that could open a short');
  engine.start();
  await settle(250);
  engine.stop();
  await settle();
  assert.equal(net('F2'), 1, 're-synced');
  const f2 = await conn.getOpenOrders('F2');
  assert.equal(f2.length, 1, 'stop-loss restored after re-entry');
  assert.equal(f2[0].stopPrice, entry - 5);
  // and it behaves: stop hits on both
  market.setPrice(C, entry - 6);
  await settle();
  assert.deepEqual([net('L'), net('F1'), net('F2')], [0, 0, 0]);
});

test('live P/L: unrealized moves with price, realized books on exit', async () => {
  const { leader, market, engine } = await setup({ followers: [{ ratio: 2 }] });
  await leader({ type: 'market', side: 'buy', size: 1 });
  await settle();
  market.moveTicks(C, 8); // MNQ: 8 ticks * $0.50 = $4 per contract
  await settle();
  assert.equal(engine.accountPnl('sim1:L').unrealized, 4);
  assert.equal(engine.accountPnl('sim1:F1').unrealized, 8);
  await leader({ type: 'market', side: 'sell', size: 1 });
  await settle();
  assert.deepEqual([engine.accountPnl('sim1:L').unrealized, engine.accountPnl('sim1:L').realized], [0, 4]);
  assert.equal(engine.accountPnl('sim1:F1').realized, 8);
  assert.ok(engine.priceHistory.get(C).length >= 1);
});
