# Behest

**Signed proof of what a human authorized, on every AI-agent purchase made with PayPal.**

Sellers hesitate to take orders from AI shopping agents because nobody can prove what the human behind the agent actually agreed to, and when an agent order goes wrong, the dispute has no evidence. Behest closes that gap. A buyer writes a spending mandate in plain words, Claude compiles it into a strict policy, and Behest reads the policy back to the buyer in sentences rendered by code, not by a model. The buyer signs it and links a PayPal wallet once. From then on a Claude shopping agent buys inside the mandate: a deterministic gate decides every purchase, Claude's intent check can only make that decision stricter, and every paid purchase carries an Ed25519-signed receipt that the seller verifies with a public key before accepting the order. When a buyer disputes a purchase, Behest answers PayPal with evidence drawn from those signed records.

Built for the [PayPal AI Hackathon](https://paypalaihackathon.devpost.com). Everything runs on the PayPal sandbox.

## How it works

1. **Mandate.** The buyer types something like "$60 a month on groceries and spices, ask me above $25, never electronics". Claude compiles it into a policy JSON (budget and period, per-purchase maximum, approval threshold, allowed and denied categories and sellers, purchase rate, expiry) and lists its assumptions and open questions.
2. **Readback and signature.** Code, not a model, renders the policy back as plain sentences. The buyer confirms exactly what will be enforced, and Behest signs the mandate as an EdDSA JWS.
3. **Wallet link.** The buyer approves a PayPal Vault v3 setup token once, with no purchase. Behest keeps the resulting payment token, so later purchases inside the mandate need no click.
4. **Shopping.** The buyer asks the Claude shopping agent for something. The agent searches Behest sellers, compares open-web prices through Channel3, and proposes a seller, SKUs and quantities. It never sees a payment tool and never sets a price.
5. **Decision.** The policy gate, plain TypeScript with no model in it, re-prices the cart from Behest's database and evaluates twelve rules to ALLOW, ASK or BLOCK. Claude's intent check then compares the cart with the buyer's own request and can only move the verdict toward the human.
6. **Payment.** ALLOW charges the saved wallet with PayPal Orders v2, buyer not present. ASK creates a PayPal order the buyer approves themselves, from a link or a QR code on their phone. BLOCK moves no money. Every PayPal call that moves money carries an idempotency key.
7. **Receipt and settlement.** A captured purchase gets a signed receipt. The seller verifies it against Behest's public JWKS and accepts or rejects the order. Behest, the merchant of record, pays an accepted order out to the seller with PayPal Payouts, or refunds a rejected one.
8. **Disputes.** A dispute opened at PayPal is matched to its purchase. Claude drafts a narrative in which every claim cites an evidence item (signed mandate, readback, receipt, cart, purchase log, approval), the operator reviews and edits it, and Behest submits it through PayPal's provide-evidence endpoint.

The full design, with its invariants, state machine, receipt format and decision record, is in [docs/architecture.md](docs/architecture.md).

## What the demo shows

Open the app and pick a persona on the home page. There is no sign-up: the persona is held in a signed, HTTP-only cookie, and every route checks it on the server. The demo buyer is Priya; the demo seller is Ravi's Spice Co.

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

## Built With

**PayPal (sandbox)**

| Product | How Behest uses it | Code |
|---|---|---|
| Vault v3 saved wallet | Setup token and payment token: the buyer saves their PayPal wallet once, with no purchase, while signing the mandate | [lib/paypal/vault.ts](lib/paypal/vault.ts) |
| Orders v2 capture | ALLOW: charge the saved wallet with no buyer present. ASK: a buyer-approved order, captured on return or by webhook | [lib/paypal/orders.ts](lib/paypal/orders.ts) |
| Payouts | Pay the seller once it has verified the receipt and accepted the order | [lib/paypal/payouts.ts](lib/paypal/payouts.ts) |
| Refunds (Payments v2) | Refund the buyer from Behest's capture when a seller rejects an order | [lib/paypal/refunds.ts](lib/paypal/refunds.ts) |
| Disputes with provide-evidence | Read disputes, match them to purchases, submit the operator's reviewed narrative | [lib/paypal/disputes.ts](lib/paypal/disputes.ts) |
| Webhooks | Order approval, capture, refund, payout and dispute events, each accepted only after PayPal's verify-webhook-signature call | [lib/paypal/webhooks.ts](lib/paypal/webhooks.ts) |
| PayPal Agent Toolkit (read-only) | `list_disputes`, `get_dispute`, `get_order` and `get_shipment_tracking`, bridged into Claude tools for the dispute evidence agent. No other toolkit tool is ever exposed | [lib/paypal/toolkit-bridge.ts](lib/paypal/toolkit-bridge.ts) |
| Transaction Search | Reconciliation rows on the operator's dashboard | [lib/paypal/reporting.ts](lib/paypal/reporting.ts) |

**AI and data**

- **Claude (Opus 5.5) through the Anthropic API**, with the official TypeScript SDK. Six uses, all routed through [lib/llm](lib/llm), which logs every call's tokens and cost and enforces a daily spend cap:
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
| `DEMO_RESET_KEY` | Optional; turns on the operator's demo reset |

**Free runs with `LLM_STUB=1`.** With `LLM_STUB=1`, no request reaches Claude: each model route replays a recorded Claude answer from [tests/fixtures/llm](tests/fixtures/llm), at no cost. Every route gives its recorded answer whatever you type: the mandate compiles to $60 a month on groceries and spices, approval above $25, never electronics; the shopping agent proposes one bag of turmeric from Ravi's Spice Co.; the intent check finds the cart consistent. PayPal sandbox calls are still real. The stub is refused when `NODE_ENV` is `production`.

**Resetting the demo.** `npm run seed` can be run again safely. To clear purchases, mandates and jobs on a running app, the operator persona can POST to `/api/demo/reset` with the `x-demo-reset-key` header set to `DEMO_RESET_KEY` (at least 16 characters) and the body `{"confirm":"reset"}`. A linked wallet is kept unless the body also has `"full": true`. The reset refuses to run while a payment is in progress.

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

> **To be added at deploy:** the hosted URL and the PayPal sandbox buyer login (email and password of the sandbox Personal account). Nothing below this line is filled in yet.

- **Hosted URL:** to be added at deploy.
- **Behest login:** none. Pick the buyer, seller or operator persona on the home page.
- **PayPal sandbox buyer login** (for linking the wallet and approving ASK purchases at PayPal): to be added at deploy.

## Security and trust model

- **The gate decides.** Every purchase is decided by plain TypeScript ([lib/gate](lib/gate)) with no model in it. Prices, categories and sellers are re-loaded from Behest's database; the agent contributes only SKUs and quantities. Any exception in the gate blocks.
- **Models only tighten.** Claude's intent check can move ALLOW to ASK and ASK to BLOCK, never the other way. A failed, refused or capped model call sends the purchase to the buyer. The readback the buyer confirms is rendered by code from the policy.
- **Untrusted text is quoted.** Seller listings, Channel3 results, PayPal dispute text and the agent's own rationale reach Claude only inside delimited tags it is told to treat as data, and they never reach the gate. Listings whose text speaks to AI agents are flagged at onboarding and hidden from agents; the gate also blocks any cart that contains one.
- **Signed receipts with a public JWKS.** Mandates and receipts are Ed25519 JWS, and the policy and cart hashes inside them are SHA-256 over RFC 8785 canonical JSON. Anyone can verify them against [`/.well-known/jwks.json`](app/.well-known/jwks.json/route.ts); sellers check signature, freshness (15 minutes), seller, cart hash, amount and replay, and seller intake never reads Behest's purchase tables.
- **Idempotent PayPal calls.** Every money-moving request carries a `PayPal-Request-Id` derived from the purchase and the step (`charge`, `capture`, `refund`), and payouts a matching `sender_batch_id`, so a retry can never charge, pay or refund twice.
- **Sandbox only.** Behest uses PayPal sandbox accounts and moves no real money. Secrets live in environment variables and are never committed.

## Sandbox honesty

Discovery through Channel3 is real: the shopping agent and seller onboarding query Channel3's live product search for open-web prices. Checkout happens only at sellers registered on Behest, because sandbox money moves only between sandbox accounts. Open-web products are shown to the agent for price comparison and are never bought.

## Credits

Behest started from PayPal's [AG Grid hackathon starter](https://github.com/paypaldev/hackathon-paypal-ag-grid-boilerplate). The starter's PayPal REST client, its AG Grid data pages and its AG Studio dashboard shell are the base this app grew from; Behest replaced the starter's Studio adapter with a Claude one and added the custom widgets.

## License

[MIT](LICENSE), copyright 2026 Om Sherikar.
