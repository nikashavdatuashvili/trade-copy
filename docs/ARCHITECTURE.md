# Architecture

```
 Browser dashboard ──HTTP/SSE──▶ server.js ──▶ CopyEngine ◀──events── Connector (ProjectX | Sim | Tradovate…)
                                                │  ▲                       │
                                                │  └── order/position ─────┘   live (SignalR / WebSocket)
                                                └────── place/modify/cancel ──▶ REST
```

## Key idea: platform-agnostic engine
`src/engine/copier.js` only knows the normalized **connector contract**
([`src/connectors/README.md`](../src/connectors/README.md)). Moving from ProjectX → Tradovate →
Rithmic means writing a new connector. The copy logic, safety and UI stay the same. Leader and
followers can be on **different connectors**, which is how cross-firm copying works.

## Copy algorithm
1. **Market orders → position targeting.** On the first event of a leader market order, the engine computes
   `leaderAfter = leaderBefore ± size`, then for each follower `target = round(leaderAfter × ratio)` (capped
   by max contracts), and sends `target − plannedFollowerPosition`. It copies on the first event and does
   not wait for the fill, so it is as fast as possible. Ratios stay exact through partial exits.
2. **Pending orders → mirrored.** Limit/stop/trailing orders (incl. SL/TP) are placed on followers with
   size `|scale(L + order) − scale(L)|`. Modifies and cancels are mirrored. Copies are tagged
   `customTag = ct-…`, so they are never copied again (no loops).
3. **Reconciler (every 500 ms).** After a 1.5 s quiet period it compares real positions with targets and
   applies the guarded re-sync policy (flatten / reduce / re-enter within tolerance / pause after 3 failures).
4. **Orphan protection.** When a follower goes flat, its remaining reducing copies (SL/TP) are cancelled.

## Latency budget (goal: follower order sent < 100 ms after leader event)
- Engine overhead measured on the simulator: about 2 ms (see `npm run bench`).
- The rest is network: (a) leader event delivery from the platform, (b) REST order call to the platform.
  Production: host the server in the **same region as the platform's servers** (US-Central/Chicago for
  CME futures platforms). Check each firm's VPS rules first.
- Followers are sent **in parallel**, never one after another.

## State & persistence
- `data/store.json`: connections (secrets encrypted) and groups. `data/master.key`: encryption key.
- `logs/YYYY-MM-DD.jsonl`: full activity log (audit trail for disputes with a firm).
- Runtime state (links between leader and follower orders) is in memory. After a restart, groups stay
  stopped until started again, and the reconciler handles any existing positions.

## Known limitations (prototype)
- One process, one user. Multi-user SaaS needs auth, per-user isolation, a database and a job runner (Phase 3).
- Stop-limit orders and pre-existing pending orders are not copied.
- ProjectX `Contract/searchById` is used for tick size. If it fails, re-sync won't re-enter (safe: alert only).
- ProjectX quote field `lastPrice` is assumed for the market hub. If absent, bid/ask mid is used.
