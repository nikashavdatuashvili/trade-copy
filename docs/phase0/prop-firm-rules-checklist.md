# Prop firm rules checklist

Rules change often, and third-party summaries (mostly copier vendors) contradict each other. **Verify each
row in the firm's own help center** and write the date you checked.

| Question | Apex | Topstep | Tradeify | MyFundedFutures | Take Profit Trader |
|---|---|---|---|---|---|
| Copying between own accounts allowed? | reportedly yes | yes (built-in TopstepX copier) | yes (group trading) | ? | ? |
| Third-party copier allowed (not just native)? | ? | API allowed. Must disable native copier | ? | ? | ? |
| Max accounts copied together | reportedly 20 | reportedly 5 Express Funded, limits on Live | reportedly 5 funded / $750k combined | ? | ? |
| Cross-firm copying allowed? | ? | ? | ? | ? | ? |
| VPS / cloud / server trading allowed? | ? | reportedly **banned** (personal device rule) | ? | ? | ? |
| Hedging between accounts banned? | ? | ? | must keep same direction | ? | ? |
| Consistency rule affected by copying? | ? | applies to every account | ? | ? | ? |
| Live / funded accounts supported by API? | ? | eval + XFA yes, Live no (per vendors) | ? | ? | ? |
| Date verified | | | | | |

## The VPS question is critical
If a firm bans VPS/cloud trading, a **cloud** copier may break its rules even when copying itself is allowed.
Options: (a) ask the firm to whitelist the copier's servers, (b) offer a "local agent" that runs on the
trader's own PC, (c) don't support that firm. Ask each firm in writing and keep the answer.

## Sources to start from
- https://intercom.help/topstep-llc/en/articles/8284151
- https://thortradecopier.com/blog/can-you-copy-trade-multiple-prop-firm-accounts
- https://blog.pickmytrade.io/apex-copy-trading-rules-account-failed/
- https://tradecopia.com/learn/copy-trade-topstep
- https://proptradingvibes.com/blog/topstep-copy-trading-rules
