# Cost checklist: can we sell at ~$20–30/month?

Fill in **verified** numbers (date + source) before setting the price.

| Cost | Who pays | Reported figure (unverified) | Verified figure | Source / date |
|---|---|---|---|---|
| ProjectX API Access subscription | the trader (per ProjectX account) | not found. Check TopstepX → Settings → API | | |
| Tradovate API Access add-on | n/a for OAuth partners? (personal keys: $25/mo + $1,000 live account) | $25/mo | | |
| NinjaTrader Ecosystem / partner fees | us | unknown | | |
| CME market data (non-display / API use) | us or trader? | ~$390/mo (2023 forum report) | | |
| Rithmic conformance / API fees | us | unknown | | |
| Cloud server near Chicago (per worker) | us | ~$5–40/mo per VM | | |
| Database, logs, monitoring | us | ~$20–100/mo at start | | |
| Payment processing (Stripe) | us | ~3% + fee | | |
| Business entity, lawyer (ToS, disclaimer) | us | one-off | | |

## Break-even sketch (fill in when verified)
- Fixed monthly costs: `F = …`
- Variable cost per user: `v = …`
- Price `p = $25` → break-even users = `F / (p − v)`

## Questions to answer
- Does **our** use of quote/fill prices count as "non-display use" that needs a CME license? (Ask the platform. Often the platform's license covers its own API users.)
- Do traders already pay the platform API fee themselves (like ProjectX)? Then it isn't our cost, but it is friction at signup.
