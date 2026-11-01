// Latency + correctness benchmark on the simulator.
// Usage: node scripts/bench-sim.js [followers=5] [trades=200] [latencyMs=20]
import { CopyEngine } from '../src/engine/copier.js';
import { SimMarket, SimConnector } from '../src/connectors/sim.js';
import { sleep } from '../src/util/common.js';

const [nF = 5, nT = 200, lat = 20] = process.argv.slice(2).map(Number);
const C = 'SIM.MNQ';
const market = new SimMarket();
const conn = new SimConnector({ id: 'b', market, latencyMs: lat, accounts: [{ id: 'L', name: 'L' }, ...Array.from({ length: nF }, (_, i) => ({ id: `F${i}`, name: `F${i}` }))] });
await conn.connect();
const engine = new CopyEngine({ options: { graceMs: 400, reconcileIntervalMs: 100 } });
engine.registerConnector(conn);
const ratios = [1, 2, 0.5, 1, 3, 1.5, 1, 1, 1, 1];
engine.setGroup({ id: 'g', leader: { connectionId: 'b', accountId: 'L' }, followers: Array.from({ length: nF }, (_, i) => ({ connectionId: 'b', accountId: `F${i}`, ratio: ratios[i % ratios.length] })) });
await engine.startGroup('g');
engine.start();

console.log(`Benchmark: ${nF} followers, ${nT} leader market orders, ${lat}ms simulated network latency`);
for (let i = 0; i < nT; i++) {
  const net = engine._actual('b:L', C).net;
  const side = net >= 3 ? 'sell' : net <= -3 ? 'buy' : Math.random() < 0.5 ? 'buy' : 'sell';
  await conn.placeOrder({ accountId: 'L', contractId: C, type: 'market', side, size: 1 + Math.floor(Math.random() * 2) });
  market.moveTicks(C, Math.round((Math.random() - 0.5) * 2));
  await sleep(5 + Math.random() * 30);
}
await conn.closePosition({ accountId: 'L', contractId: C });
await sleep(1500);
engine.stop();

const m = engine.getMetrics();
const L = engine._actual('b:L', C).net;
const wrong = Array.from({ length: nF }, (_, i) => engine._actual(`b:F${i}`, C).net).filter((n) => n !== 0).length;
console.log(`copies sent:        ${m.copies}`);
console.log(`copy latency:       p50 ${m.latency.p50.toFixed(1)}ms · p95 ${m.latency.p95.toFixed(1)}ms · max ${m.latency.max.toFixed(1)}ms`);
console.log(`  (engine overhead = latency minus the ${lat}ms simulated network)`);
console.log(`failures/desyncs:   ${m.failures} / ${m.desyncs}`);
console.log(`final leader net:   ${L}; followers not flat: ${wrong}`);
console.log(m.latency.p95 - lat < 100 && wrong === 0 && m.desyncs === 0 ? 'PASS ✅' : 'FAIL ❌');
process.exit(0);
