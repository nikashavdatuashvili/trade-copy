# CopyTrader

Leader → follower trade copier for futures prop firm accounts. Trade on one account and every
follower account gets the same trade within milliseconds, with size ratios, SL/TP copying and
automatic re-sync if an account ever gets out of step.

**Status:** Phase 1 prototype. Engine + simulator + ProjectX (TopstepX) connector + dashboard.
Tradovate connector waits on partner API access (see [`docs/phase0`](docs/phase0)).

## Quick start

```bash
npm install
npm start            # dashboard on http://127.0.0.1:8787
```

1. Click **+ Add Sim Lab** to get 4 fake accounts (no real money, no keys).
2. **+ New copy group**: pick `SIM Leader` as the leader and add followers with ratios (e.g. 1, 2, 0.5).
3. **Start** the group, then trade the leader from the **Sim Lab** panel. Watch the **Sync board**.
4. Try **Reject next order** or **Force desync** on a follower to see auto re-sync and alerts.

### Real ProjectX / TopstepX accounts
1. In TopstepX: *Settings → API*, subscribe to ProjectX API access and create an API key.
2. In TopstepX: **turn off Topstep's built-in trade copier**, or its API blocks incoming orders.
3. In each follower's *Risk Settings*, don't use auto brackets: the copier copies the leader's
   SL/TP orders itself, and platform brackets would double them.
4. Dashboard: **+ Add ProjectX account** (username, not email, + API key).
5. Test on **evaluation / practice accounts first**.

## Live P/L
Every account card shows **open P/L** (live, recalculated on every price tick from position × price move × tick value)
and **closed P/L** (booked when a position is reduced or closed). The header shows the total across all accounts in
your groups. For ProjectX accounts, closed P/L comes from the platform's own trade events (`profitAndLoss` minus fees)
and counts from when the dashboard connected.

## What gets copied
| Leader action | Followers |
|---|---|
| Market buy/sell (entry, scale in/out, reverse, flatten) | Market order sized so follower position = leader position × ratio |
| Limit / stop / trailing stop (incl. SL & TP) | Same order, scaled size |
| Move / resize a pending order | Same modification |
| Cancel a pending order | Cancelled |
| Follower ends up flat | Its remaining SL/TP copies are cancelled, so a stray stop can't open a new trade |

Not copied yet: stop-limit orders, orders that existed before the group was started.

## Safety
- **Auto re-sync** (per group, on by default). About 1.5 s after the last activity, each follower is checked against the target:
  - should be flat → flatten
  - too big → reduce
  - missing contracts → re-enter **only if price is within N ticks** of the leader's entry; otherwise alert and don't chase
  - 3 failed attempts in 60 s → follower **paused** + alert
- **Kill switch:** stops all groups, cancels all follower orders and flattens followers (optionally leaders too).
- Positions are re-read over REST every 15 s in case a live event was missed. After a reconnect they are re-read immediately.
- Groups are **not** auto-started after a restart unless `AUTO_START_GROUPS=true`.
- API keys are encrypted at rest (AES-256-GCM). The key is in `data/master.key` or `COPYTRADER_MASTER_KEY`.
- The dashboard listens on 127.0.0.1 only. To expose it, set `HOST`, `DASHBOARD_PASSWORD` and put HTTPS in front.
- Manual trades on a follower are seen as a desync and corrected. Trade followers only through the leader.

## Config (`.env`)
See [`.env.example`](.env.example).

## Commands
```bash
npm test             # 23 automated tests (engine, ProjectX mapping, encryption)
npm run bench        # latency/correctness benchmark on the simulator: [followers] [trades] [latencyMs]
```

## Project layout
```
src/engine/copier.js        platform-agnostic copy engine + reconciler + kill switch
src/connectors/projectx.js  ProjectX Gateway API (REST + SignalR)
src/connectors/sim.js       simulated broker (Sim Lab, tests, benchmark)
src/connectors/README.md    the contract every platform connector implements
src/store.js                settings + encrypted secrets
src/server.js, src/app.js   HTTP API, live events, wiring
web/                        dashboard
docs/                       roadmap, architecture, Phase 0 business tasks
```

## Prop firm rules
You are responsible for following each firm's rules. Most allow copying only between accounts
**you own**, cap the number of accounts, and some restrict VPS/cloud use. See
[`docs/phase0/prop-firm-rules-checklist.md`](docs/phase0/prop-firm-rules-checklist.md).
