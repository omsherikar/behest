# Behest

**Signed proof of what a human authorized, on every AI-agent purchase made with PayPal.**

Sellers hesitate to take orders from AI shopping agents because nobody can prove what the human behind the agent actually agreed to, and when an agent order goes wrong, the dispute has no evidence. Behest closes that gap. A buyer writes a spending mandate in plain words, Claude compiles it into a strict policy, and Behest reads the policy back to the buyer in sentences rendered by code, not by a model. The buyer signs it and links a PayPal wallet once. From then on a Claude shopping agent buys inside the mandate: a deterministic gate decides every purchase, Claude's intent check can only make that decision stricter, and every paid purchase carries an Ed25519-signed receipt that the seller verifies with a public key before accepting the order. When a buyer disputes a purchase, Behest answers PayPal with evidence drawn from those signed records.

Built for the [PayPal AI Hackathon](https://paypalaihackathon.devpost.com). Everything runs on the PayPal sandbox.

- **Demo video (2:58):** [youtu.be/-qJ0i8Bb1_I](https://youtu.be/-qJ0i8Bb1_I)
- **Live demo, with a three-minute guided tour:** [behest.omstudio.tech](https://behest.omstudio.tech)

## How it works

1. **Mandate.** The buyer types something like "$60 a month on groceries and spices, ask me above $25, never electronics". Claude compiles it into a policy JSON (budget and period, per-purchase maximum, approval threshold, allowed and denied categories and sellers, purchase rate, expiry) and lists its assumptions and open questions.
2. **Readback and signature.** Code, not a model, renders the policy back as plain sentences. The buyer confirms exactly what will be enforced, and Behest signs the mandate as an EdDSA JWS. A limit Behest cannot enforce, such as "only on weekends", comes back as a question; it is never dropped. With a passkey, the buyer also signs the hashes of the policy and the readback, and the mandate names the passkey's public key, so anyone can check the buyer's signature without Behest.
3. **Wallet link.** The buyer approves a PayPal Vault v3 setup token once, with no purchase. Behest keeps the resulting payment token, so later purchases inside the mandate need no click.
4. **Shopping.** The buyer asks the Claude shopping agent for something. The agent searches Behest sellers, compares open-web prices through Channel3, and proposes a seller, SKUs and quantities. It never sees a payment tool and never sets a price. Its searches, lookups and choice form a decision record, whose hash goes into the receipt.
5. **Decision.** The policy gate, plain TypeScript with no model in it, re-prices the cart from Behest's database and evaluates twelve rules to ALLOW, ASK or BLOCK. An item priced over 1.5 times its Channel3 market median is held for the buyer. Claude's intent check then compares the cart with the buyer's own request and can only move the verdict toward the human. A held or blocked purchase shows the smallest change to the mandate that would have let it through, or why no change would.
6. **Payment.** ALLOW charges the saved wallet with PayPal Orders v2, buyer not present. ASK creates a PayPal order the buyer approves themselves, from a link or a QR code on their phone. BLOCK moves no money. Every PayPal call that moves money carries an idempotency key.
7. **Receipt and settlement.** A captured purchase gets a signed receipt. The seller verifies it against Behest's public JWKS (signature, under 15 minutes old, seller, cart, amount, never used before) and accepts or rejects the order. Behest, the merchant of record, pays an accepted order out to the seller with PayPal Payouts, or refunds a rejected one.
8. **Disputes.** A dispute opened at PayPal is matched to its purchase. Claude drafts a narrative in which every claim cites an evidence item (signed mandate, readback, receipt, cart, the agent's decision record, purchase log, approval); a claim that cites nothing is dropped. The operator reviews and edits it. Before answering, Behest reads the dispute at PayPal and answers the way PayPal allows at that stage: the narrative as evidence through provide-evidence, or a message to the buyer while PayPal takes no evidence yet.

The full design, with its invariants, state machine, receipt format and decision record, is in [docs/architecture.md](docs/architecture.md).

## What the demo shows

### Guided demo

**Take the guided demo** on the home page is a three-minute, fourteen-step tour. It switches persona for you, opens each page and highlights real records from one run on the live site: an allowed, a held and a blocked purchase, a seller order whose receipt was checked, and a dispute. It resumes after a reload, Esc closes it, and its last card hands over with **Try it yourself**. The records it points at are named in `TOUR_PINS` ([docs/deploy.md](docs/deploy.md)); a step whose record is missing still shows its card, without the highlight.

### Personas

Open the app and pick a persona on the home page. There is no sign-up: the persona is held in a signed, HTTP-only cookie, and every page and route that needs a persona checks it on the server. The seller catalog and order intake, receipt verification, PayPal webhooks, the public key set, the health check and the session route itself are public by design. The demo buyer is Priya; the demo seller is Ravi's Spice Co.

### Buyer

| Page | What it does |
|---|---|
| `/buyer` (Mandate) | Write a mandate, read the readback, answer any open questions, sign it and link PayPal. Shows the active mandate and the wallet status. |
| `/buyer/shop` (Shop) | Send the shopping agent out with a request and follow its run live: each search, each proposal with Behest's verdict and reasons, and its closing summary. |
| `/buyer/approvals` (Approvals) | Purchases waiting for the buyer, with the items, the reasons and the PayPal approval link, also drawn as a QR code to scan with a phone. |
| `/buyer/ledger` (Ledger) | Every purchase the agent proposed, in an AG Grid: verdict, status, reasons and the signed receipt id of each paid one. |

### Seller

| Page | What it does |
|---|---|
| `/seller` (Onboarding) | Until the shop exists, onboard it from a catalog CSV, product photos with a price each, or both: Claude drafts the listings, every listing is screened for text aimed at AI agents, and each is benchmarked against Channel3 market prices. Afterwards, the shop's summary, including the listings hidden from agents. `npm run seed` creates Ravi's shop from its CSV without calling a model, so a seeded demo opens on the summary. |
| `/seller/catalog` (Catalog) | The listings, their market medians, and which ones are hidden from agents and why. |
| `/seller/orders` (Orders) | Every agent order with the result of verifying its receipt, why a rejected one failed, the cart total and the payout. |

### Operator

| Page | What it does |
|---|---|
| `/ops/disputes` | Every dispute buyers opened at PayPal, matched to its purchase. |
| `/ops/disputes/[id]` | The dispute, the buyer's notes, the evidence items, a Claude-drafted narrative with a citation on every claim, and the edit and submit controls. |

The operator also sees the starter's PayPal data pages (`/products`, `/plans`, `/invoices`, `/transactions`, `/balances`).

### Dashboard

`/dashboard` is an AG Studio report scoped to whoever is viewing: the buyer sees their purchases and mandate, the seller the orders placed with it, and the operator everything plus PayPal Transaction Search for reconciliation. It has three custom Studio widgets: the **decision ledger** (verdict chips and every rule's outcome), the **budget burn-down** (spend against the mandate, with reservations shown apart), and the **receipt card** (a receipt's claims and its live verification result). The **AG Studio analyst** is driven by Claude through a custom adapter ([app/dashboard/studio/anthropic-adapter.ts](app/dashboard/studio/anthropic-adapter.ts)): ask "Which purchases needed approval this week and why?" and it answers or adds widgets. Its tools run in the browser over the rows already loaded for the persona, and the Anthropic key stays on the server behind [`/api/ai/studio`](app/api/ai/studio/route.ts).

### Public pages and endpoints

| Path | What it is |
|---|---|
| `/security` | A published prompt-injection attack on agent payments, ["Whispers of Wealth"](https://arxiv.org/abs/2601.22569) (arXiv 2601.22569), replayed against every Behest layer. In the live run against the model, 7 of 8 attacks were stopped and 1 was held for the buyer, over 38 model calls costing about $0.31. The page also lists what Behest does not stop yet. |
| `/.well-known/jwks.json` | The Ed25519 public keys that verify every mandate and receipt Behest signs. |
| `POST /api/receipts/verify` | Runs the seller's receipt checks for a seller without a JOSE library. Body: `{ "jws", "cart", "sellerSlug" }`. |
| `/api/sellers/<slug>/catalog` | A seller's catalog as JSON, the way outside shopping agents read it. A listing flagged for text aimed at AI agents is never in it. |
| `/llms.txt` | A plain-text summary of Behest for AI agents and other readers, with links to check each claim. `/robots.txt` keeps crawlers off the persona pages and private APIs. |

## Built With

**PayPal (sandbox)**

| Product | How Behest uses it | Code |
|---|---|---|
| Vault v3 saved wallet | Setup token and payment token: the buyer saves their PayPal wallet once, with no purchase, while signing the mandate | [lib/paypal/vault.ts](lib/paypal/vault.ts) |
| Orders v2 capture | ALLOW: charge the saved wallet with no buyer present. ASK: a buyer-approved order, captured on return or by webhook | [lib/paypal/orders.ts](lib/paypal/orders.ts) |
| Payouts | Pay the seller once it has verified the receipt and accepted the order | [lib/paypal/payouts.ts](lib/paypal/payouts.ts) |
| Refunds (Payments v2) | Refund the buyer from Behest's capture when a seller rejects an order | [lib/paypal/refunds.ts](lib/paypal/refunds.ts) |
| Disputes with provide-evidence and send-message | Read disputes, match them to purchases, and answer the way PayPal allows at that stage: the operator's reviewed narrative as evidence, or a message to the buyer | [lib/paypal/disputes.ts](lib/paypal/disputes.ts) |
| Webhooks | Order approval, capture, refund, payout and dispute events, each accepted only after PayPal's verify-webhook-signature call | [lib/paypal/webhooks.ts](lib/paypal/webhooks.ts) |
| PayPal Agent Toolkit (read-only) | `list_disputes`, `get_dispute`, `get_order` and `get_shipment_tracking`, bridged into Claude tools for the dispute evidence agent. No other toolkit tool is ever exposed | [lib/paypal/toolkit-bridge.ts](lib/paypal/toolkit-bridge.ts) |
| Transaction Search | Reconciliation rows on the operator's dashboard | [lib/paypal/reporting.ts](lib/paypal/reporting.ts) |

**AI and data**

- **Claude (Opus 5.5) through the Anthropic API**, with the official TypeScript SDK. Six uses, all routed through [lib/llm](lib/llm), which logs every call's tokens and cost and enforces daily spend caps:
  - mandate compiler (structured output);
  - shopping agent (tool loop, at most 12 turns);
  - intent check (structured output, can only tighten);
  - catalog builder (structured output, with vision for photos);
  - dispute evidence agent (read-only tool loop, then a cited narrative);
  - AG Studio analyst (streamed through the dashboard's adapter).
- **AG Grid and AG Studio** for every table (ledger, catalog, orders, disputes, the starter's data pages) and the dashboard with its custom widgets and Claude analyst.
- **Channel3** product search for open-web market prices: the shopping agent's `search_market` tool and the market benchmark stored on each listing at onboarding, which the gate compares prices against.

**Platform**: Next.js 16 (App Router), React 19, TypeScript, Postgres with Drizzle ORM (PGlite for local runs and tests), `jose` for Ed25519 JWS, zod, Tailwind CSS, Vitest.

## Run locally

You need Node.js 22 and a PayPal sandbox REST app (see [PayPal sandbox setup](#paypal-sandbox-setup)). No database server is needed: without `DATABASE_URL`, the app uses PGlite on disk in `.data/pglite`.

```bash
npm install
cp .env.example .env   # then fill it in
npm run keys           # prints RECEIPT_SIGNING_KEY and RECEIPT_KEY_ID; paste both lines into .env
npm run db:migrate
npm run seed
npm run dev
```

Open http://localhost:3000 and pick a persona. `npm run db:migrate` and `npm run seed` read `.env`; `npm run dev` loads it through Next.js.

What to put in `.env` (each variable is described in [.env.example](.env.example)):

| Variable | Needed for |
|---|---|
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | Every PayPal call |
| `PAYEE_EMAIL` | The sandbox business account that receives seller payouts. `npm run seed` needs it |
| `SESSION_SECRET` | Signing persona cookies (`openssl rand -base64 32`) |
| `RECEIPT_SIGNING_KEY`, `RECEIPT_KEY_ID` | Signing mandates and receipts. From `npm run keys` |
| `APP_URL` | PayPal return links. `http://localhost:3000` locally |
| `ANTHROPIC_API_KEY` or `LLM_STUB=1` | Every Claude call (see below) |
| `CHANNEL3_API_KEY` | Market prices. Without it the agent is told prices are unavailable |
| `PAYPAL_WEBHOOK_ID` | Webhooks. Needs a public HTTPS URL, so it is usually set only on a deployment |
| `WORKER=1` | Runs the background job worker in the app process: payment follow-ups, approval expiry, payout polling and dispute sync |
| `AG_STUDIO` | Optional AG Studio licence key |
| `DATABASE_URL` | Optional locally; required in production |
| `LLM_DAILY_CAP_USD` | Optional daily model budget, default `5` |
| `LLM_ANALYST_DAILY_CAP_USD`, `LLM_CATALOG_DAILY_CAP_USD` | Optional daily budgets of their own for the dashboard analyst and the catalog builder, default `1` each; their spend also counts toward `LLM_DAILY_CAP_USD` |
| `DEMO_RESET_KEY` | Optional; turns on the operator's demo reset |

**Free runs with `LLM_STUB=1`.** With `LLM_STUB=1`, no request reaches Claude: each model route replays a recorded Claude answer from [tests/fixtures/llm](tests/fixtures/llm), at no cost. Every route gives its recorded answer whatever you type: the mandate compiles to $60 a month on groceries and spices, approval above $25, never electronics; the shopping agent proposes one bag of turmeric from Ravi's Spice Co.; the intent check finds the cart consistent. PayPal sandbox calls are still real. The stub is refused when `NODE_ENV` is `production`.

**Resetting the demo.** `npm run seed` can be run again safely. To clear purchases, mandates and jobs on a running app, the operator persona can POST to `/api/demo/reset` with the `x-demo-reset-key` header set to `DEMO_RESET_KEY` (at least 16 characters) and the body `{"confirm":"reset"}`. A linked wallet is kept unless the body also has `"full": true`. The reset refuses to run while a purchase that changed in the last 30 minutes is being charged, or while a job is running.

Other scripts: `npm test`, `npm run lint`, `npm run typecheck`, `npm run build`, `npm run start`.

## PayPal sandbox setup

The full runbook, with the sandbox results that shaped the design, is [docs/vault-proof.md](docs/vault-proof.md). In short:

1. Use **US** sandbox accounts, because saving a PayPal wallet is supported only for merchants in certain countries. Create a US Business account (Behest, the merchant of record), a US Personal account (the buyer) and a second US Business account (the seller who receives payouts, `PAYEE_EMAIL`).
2. Create a sandbox REST app linked to the Behest business account and copy its client ID and secret.
3. On the app, switch on **Save payment methods**, **PayPal and Venmo** under payment methods, and **Transaction search**.
4. On a deployment, add a webhook for `https://<your host>/api/paypal/webhooks` and put its id in `PAYPAL_WEBHOOK_ID`. Locally, the PayPal return pages cover the same transitions for the buyer's own browser.

When a page sends you to PayPal (linking the wallet, approving an ASK purchase), log in as the sandbox **Personal** account and pay with its card.

## Deploy

Behest runs as one service with Docker Compose on a small VM on Google Cloud or AWS: the app with its job worker (`WORKER=1`), Postgres, and Caddy in front for HTTPS. The deployment guide is [docs/deploy.md](docs/deploy.md).

Rate limits key on the client address. Behind Caddy, `TRUSTED_PROXY_HOPS=1` picks the right `X-Forwarded-For` entry. Set `TRUST_CLOUDFLARE_HEADERS=1` only when Cloudflare is in front, because a client could forge its headers otherwise.

## Test credentials for judges

- **Hosted demo:** [behest.omstudio.tech](https://behest.omstudio.tech). Start with **Take the guided demo** on the home page: a three-minute tour of real records from one run on that site (an allowed, a held and a blocked purchase, a seller order whose receipt was checked, and a dispute), after which you can try it yourself.
- **Behest login:** none. Pick the buyer, seller or operator persona on the home page.
- **PayPal sandbox buyer login** (for linking the wallet and approving ASK purchases at PayPal): in the testing instructions of the Devpost submission, not in this public repository.

## Security and trust model

- **The gate decides.** Every purchase is decided by plain TypeScript ([lib/gate](lib/gate)) with no model in it. Prices, categories and sellers are re-loaded from Behest's database; the agent contributes only SKUs and quantities. Any exception in the gate blocks.
- **Models only tighten.** Claude's intent check can move ALLOW to ASK and ASK to BLOCK, never the other way. A failed, refused or capped model call sends the purchase to the buyer. The readback the buyer confirms is rendered by code from the policy.
- **Untrusted text is quoted.** Seller listings, Channel3 results, PayPal dispute text and the agent's own rationale reach Claude only inside delimited tags it is told to treat as data. One gate input does come from seller text: each listing's category, which the catalog builder assigns from what the seller wrote (see [Known limitations](#known-limitations)). Listings whose text speaks to AI agents are flagged at onboarding and hidden from agents; the gate also blocks any cart that contains one.
- **Signed receipts with a public JWKS.** Mandates and receipts are Ed25519 JWS, and the policy and cart hashes inside them are SHA-256 over RFC 8785 canonical JSON. Anyone can verify them against [`/.well-known/jwks.json`](app/.well-known/jwks.json/route.ts); sellers check signature, freshness (15 minutes), seller, cart hash, amount and replay, and seller intake never reads Behest's purchase tables.
- **Idempotent PayPal calls.** Every money-moving request carries a `PayPal-Request-Id` derived from the purchase and the step (`charge`, `capture`, `refund`), and payouts a matching `sender_batch_id`, so a retry can never charge, pay or refund twice.
- **Tested against a published attack.** The [`/security`](app/security/page.tsx) page replays the attack from "Whispers of Wealth" (arXiv 2601.22569) against every layer and lists, with the results, what Behest does not stop yet.
- **Sandbox only.** Behest uses PayPal sandbox accounts and moves no real money. Secrets live in environment variables and are never committed.

## Sandbox honesty

Discovery through Channel3 is real: the shopping agent and seller onboarding query Channel3's live product search for open-web prices. Checkout happens only at sellers registered on Behest, because sandbox money moves only between sandbox accounts. Open-web products are shown to the agent for price comparison and are never bought.

## Known limitations

- **Spend caps are checked, not reserved.** Each model call checks the daily caps before it starts, so calls already running, or several started at once, can spend past a cap.
- **A lost charge can be replayed after its mandate is revoked.** When PayPal's answer to a charge is lost, Behest sends the same request again, under the same request id, for up to 5 hours. It does so even if the buyer revoked the mandate after the first attempt was sent: PayPal may already have taken the money, and refusing the replay would leave that payment unrecorded.
- **A refund event can run out of retries first.** A refund or reversal PayPal reports while Behest's own refund of the same purchase still awaits PayPal's answer is retried for about 26 minutes, but a refund whose answer was lost is retried for about an hour. If the lost answer takes longer, the event's job ends dead before it records what the event reports.
- **What needs an operator has no page.** Events that ask for an operator, such as a purchase left charging for half an hour (`charge_stale`), a seller that never answers or a refund that is stuck, and jobs that ran out of retries are kept only in the database; [docs/deploy.md](docs/deploy.md#checks-for-the-operator) has the two queries that list them. A purchase can wait there for good: an order whose delivery kept failing for more than 15 minutes comes back `expired` when it is delivered again, and the purchase stays `captured`, with the buyer charged and the seller unpaid, until an operator acts.
- **The demo reset is broad.** It does not refuse while a captured purchase awaits delivery or a payout is unfinished, and it removes their records with the rest even though sandbox money may still be moving. It keeps every seller, including ones visitors onboarded.
- **Cancelling at PayPal does not cancel the purchase.** A buyer who cancels on PayPal's approval page sees a notice, but the purchase stays awaiting approval, holding its budget, until its 3-hour approval window expires.
- **A listing's category is written by a model from seller text.** The catalog builder assigns each listing's category from what the seller wrote, and the gate's category rules read it, so a dishonest seller can list earbuds as spices. The intent check and the mandate's seller lists are the backstop.
- **One signing key, no rotation yet.** Behest signs every mandate and receipt with one Ed25519 key. If that key were rotated, the published key set would have to keep the old public key, or older mandates and receipts, and the evidence built from them, would honestly report that they no longer verify.
- **Someone else can present a receipt first.** Every persona's dashboard data carries receipt signatures, and the seller order route is public. After a failed first delivery, a third party could present the still-fresh receipt before Behest delivers again; Behest's redelivery then comes back `replayed`, and the purchase stays `captured` for an operator.

## Credits

Behest started from PayPal's [AG Grid hackathon starter](https://github.com/paypaldev/hackathon-paypal-ag-grid-boilerplate). The starter's PayPal REST client, its AG Grid data pages and its AG Studio dashboard shell are the base this app grew from; Behest replaced the starter's Studio adapter with a Claude one and added the custom widgets.

## License

[MIT](LICENSE), copyright 2026 Om Sherikar.
