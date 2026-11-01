# Roadmap

Source brief: `Task Management 2/.claude/think-it-through/prop-trade-copier.md` (2026-11-01).

## Phase 0: Access & due diligence (business, runs in parallel) ⏳ needs the founder
- [ ] Apply for Tradovate / NinjaTrader partner API access → [`phase0/tradovate-partner-application.md`](phase0/tradovate-partner-application.md)
- [ ] Confirm all costs → [`phase0/cost-checklist.md`](phase0/cost-checklist.md)
- [ ] Confirm firm rules (Apex, Tradeify, Topstep…) → [`phase0/prop-firm-rules-checklist.md`](phase0/prop-firm-rules-checklist.md)
- [ ] Get a ProjectX API subscription on one TopstepX account for live testing

## Phase 1: Personal prototype on ProjectX ✅ built, ⏳ live validation
- [x] Platform-agnostic copy engine (market, limit, stop, trailing, SL/TP, modify, cancel)
- [x] Per-follower size ratio + max contracts
- [x] Auto re-sync with guardrails, pause after repeated failures
- [x] Orphan SL/TP protection
- [x] Kill switch
- [x] Latency / slippage / desync metrics
- [x] ProjectX connector (REST + SignalR, token renewal, rate limiting, reconnect + resync)
- [x] Sim Lab + 21 automated tests + benchmark
- [x] Dashboard (matte black / green)
- [ ] **Live test on TopstepX practice accounts:** verify event order, quote fields, `searchById`, cancel behaviour
- [ ] Success criteria over several weeks of real trading: p95 < 100 ms, zero desyncs, setup < 5 min

## Phase 2: Tradovate connector (after access approved)
- [ ] `src/connectors/tradovate.js` against the same contract (OAuth, REST + WebSocket user sync)
- [ ] Cross-firm groups across Tradovate-based firms (Apex, Tradeify, MFFU…)
- [ ] Cross-connector tests (leader on one platform, followers on another)

## Phase 3: SaaS
- [ ] User accounts + auth (email login, 2FA), per-user isolation
- [ ] Database (Postgres) instead of JSON. Secrets in a KMS / vault
- [ ] One copier worker per user. Hosted near the platform's servers (Chicago region)
- [ ] Billing (~$20–30/mo, Stripe), onboarding under 5 minutes
- [ ] Terms of service, risk disclaimer, privacy policy (needs a lawyer)
- [ ] Monitoring + on-call alerts (desync, disconnect) via email / Telegram / push

## Phase 4: v2
- [ ] Prop-rule protection: per-account daily loss / trailing drawdown / consistency guards that skip or shrink a copy before it would break a rule
- [ ] Rithmic connector (conformance review)
- [ ] Forex: MT5 / cTrader
