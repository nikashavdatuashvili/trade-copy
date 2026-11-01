# Tradovate / NinjaTrader partner API access

## Why
Prop/evaluation accounts on Tradovate can't create personal API keys. A third-party app that connects
*other traders'* accounts needs OAuth client credentials (`client_id`, `client_secret`, approved
`redirect_uri`). Per a Tradovate email quoted on their forum, these are issued **only to approved members
of the NinjaTrader Ecosystem after a review**. Without them, there's no Tradovate connector.

## Where to apply (verify, these change)
1. **NinjaTrader Ecosystem vendor program:** NinjaTrader's site, "Ecosystem" / "Become a vendor".
2. **Tradovate partner portal:** `partner.tradovate.com` documents API-key auth for *evaluation partners*
   (prop firms). It's useful for seeing what partners get. You may be routed there.
3. **Tradovate API forum:** https://community.tradovate.com/c/api-developers/ (threads: "Third-Party OAuth
   Integration", "API access for 3rd-party app development").
4. Ask in the forum which contact handles third-party OAuth approvals, rather than guessing an email.

## What they'll likely ask for (prepare first)
- [ ] Registered business entity (name, country, registration number)
- [ ] Website with product description, privacy policy, terms of service
- [ ] Description of how credentials/tokens are stored (we encrypt at rest with AES-256-GCM. Plan a KMS for SaaS)
- [ ] Order-flow description: follower orders are placed only on the *trader's own* accounts, triggered by the trader's own leader trades
- [ ] Expected users and order volume
- [ ] Market data: whether you display CME data (we don't need to display it. We only use fill/quote prices internally)
- [ ] Redirect URI(s) for OAuth (e.g. `https://app.<yourdomain>/oauth/tradovate/callback`)

## Draft message (fill in the brackets)

> **Subject:** Third-party OAuth application: trade copier for traders' own accounts
>
> Hello,
>
> I'm building **[Product name]**, a trade-copying tool for futures traders who manage several of their
> own accounts (including prop-firm evaluation and funded accounts on Tradovate). The trader places
> trades on one "leader" account, and the app replicates them to the trader's other accounts within
> milliseconds, with risk controls (size ratios, desync detection, a kill switch).
>
> We'd like to apply for OAuth client credentials so traders can authorize the app to their own
> Tradovate accounts. Key points:
> - Orders are only placed on accounts owned by the authorizing user. No signal selling, no copying between different people.
> - Access tokens are encrypted at rest. Each user can revoke access at any time.
> - We don't redistribute or display market data.
> - Planned redirect URI: [https://…/oauth/tradovate/callback]
> - Company: [legal name, country]. Contact: [name, email, phone]. Website: [url]
>
> Could you tell us the application process for the NinjaTrader Ecosystem / Tradovate partner
> program, the requirements and any fees, and whether a sandbox/demo environment is available for
> conformance testing?
>
> Thank you,
> [Name]

## Track it
| Date | Action | Response |
|---|---|---|
| | | |
