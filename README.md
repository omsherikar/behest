> [!TIP]
> **PayPal AI Hackathon**
> 
> Win part of $69,750 in total prizes
> 
> Build What's Next with PayPal and AI is a global online hackathon inviting developers, designers, founders, students, and builders to create something new using PayPal and AI.
> 
> There are no prescribed problem statements and no set of tracks. Build an agent, an app, an automation, a new payment experience, a business tool, a social product, or something we haven't thought of yet.
> 
> https://paypalaihackathon.devpost.com

# PayPal SDK data pages

A Next.js app that reads PayPal sandbox data over the [PayPal REST API](https://developer.paypal.com/api/rest/) and shows it two ways:

- **Endpoint pages**: one [AG Grid](https://www.ag-grid.com/react-data-grid/) per PayPal endpoint the demo calls, showing what each returns.
- **Dashboard** (`/dashboard`): an [AG Studio](https://www.ag-grid.com/studio/) report over all of that data, joined together, which you can edit and save in the browser.

## Run locally

Requires Node.js 20.9 or later and a PayPal sandbox REST app ([developer.paypal.com](https://developer.paypal.com/dashboard/applications/sandbox)). The transactions and balances pages also need the app's **Transaction search** feature enabled.

```bash
npm install
cp env.example .env.local   # then fill in the values
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Next.js only loads the dotted `.env.local`; it is git-ignored, so credentials stay out of the repo.

Other scripts: `npm run build` (production build), `npm run start` (serve the build), `npm run lint`.

### AG Studio licence (optional)

Set `AG_STUDIO` in `.env.local` to your AG Studio licence key. The dashboard passes it to `AgStudioProvider`.

### AI analyst (optional)

The AG Studio dashboard at `/dashboard` has an AI analyst, run by Claude. Ask it about the data in front of you ("Which purchases needed approval this week and why?") and it answers, or adds widgets to the report. It is shown when `ANTHROPIC_API_KEY` is set. In development, `LLM_STUB=1` shows it with a recorded reply instead, so no model is called.

The key never reaches the browser. Studio's adapter ([`anthropic-adapter.ts`](app/dashboard/studio/anthropic-adapter.ts)) runs client-side: it turns Studio's conversation and tool schemas into a Messages API request and posts it to [`/api/ai/studio`](app/api/ai/studio/route.ts). That route needs a persona, rate limits each client address and persona, accepts only text, calls of the dashboard's own tools and their results, and calls Claude through `lib/llm` on the `studio_analyst` route: its model and effort (`CLAUDE_MODEL_STUDIO_ANALYST`, `CLAUDE_EFFORT_STUDIO_ANALYST`), the daily spend cap (`LLM_DAILY_CAP_USD`) and the `llm_calls` log. It streams Claude's own stream events back, and the adapter turns them into Studio's text, reasoning and tool call events.

Studio runs the tools in the browser, against the rows already loaded for the persona, so the analyst sees nothing the dashboard does not show.

## How it works

```
lib/paypal/              Every PayPal call: OAuth token, paging, retries, response types
lib/dashboard/           The dashboard's rows, scoped to the persona viewing them
app/(endpoints)/         One page per endpoint, each rendering an AG Grid
app/dashboard/           The AG Studio dashboard
app/api/ai/studio/       The dashboard analyst: each Studio turn sent to Claude, the reply streamed back
```

[`lib/paypal`](lib/paypal) calls the REST API with plain `fetch`, no SDK. It gets an OAuth access token with the client-credentials grant and caches it until just before it expires. It follows `page`/`total_pages` paging, and retries on 401, 429 and 5xx responses. Its types are hand-written for the fields this demo reads, in the API's own snake_case.

Every page is a server component that calls `await connection()`, so it renders per request with live data instead of being prerendered at build time. PayPal credentials never leave the server.

## Endpoint pages

Each page in [`app/(endpoints)`](app/(endpoints)) calls one function in `lib/paypal`, maps the response to flat rows, and passes them with plain column definitions to the shared [`DataGrid`](app/(endpoints)/data-grid.tsx). The page header shows the REST calls behind it.

| Page | `lib/paypal` function | REST calls |
|---|---|---|
| [`/products`](app/(endpoints)/products/page.tsx) | `listProducts()` | `GET /v1/catalogs/products`, then `GET /v1/catalogs/products/{id}` per product |
| [`/plans`](app/(endpoints)/plans/page.tsx) | `listPlans()` | `GET /v1/billing/plans`, then `GET /v1/billing/plans/{id}` per plan |
| [`/invoices`](app/(endpoints)/invoices/page.tsx) | `listInvoices()` | `GET /v2/invoicing/invoices`, then `GET /v2/invoicing/invoices/{id}` per invoice |
| [`/transactions`](app/(endpoints)/transactions/page.tsx) | `searchTransactions(start, end)` | `GET /v1/reporting/transactions` |
| [`/balances`](app/(endpoints)/balances/page.tsx) | `getBalances()` | `GET /v1/reporting/balances` |

Things worth knowing about these endpoints:

- **List endpoints return summaries.** Products have no type or category, plans no billing cycles, and invoices no line items, payments or refunds. So each record is fetched again in full, which is why these pages take a second or two.
- **Billing plans keep their price in `billing_cycles`.** There is an optional `TRIAL` cycle, then the `REGULAR` cycle; `total_cycles: 0` means it bills until cancelled.
- **Transaction Search covers at most 31 days per request** and rejects fractional seconds in dates. New activity can take up to three hours to appear. `fields=all` adds `payer_info` to each `transaction_info`. Event codes are [PayPal T-codes](https://developer.paypal.com/docs/transaction-search/transaction-event-codes/) (`T0001` = payout); status is `S` success, `P` pending, `D` denied, `V` reversed or `F` partially refunded.
- **Amounts are decimal strings with a currency**, e.g. `{ "value": "2.99", "currency_code": "USD" }`. `amountOf()` turns them into numbers, and the grid formats money columns in each row's currency.

### The grid

Pages are server components, so the column definitions they pass to the grid must be plain data, with no functions. Money columns use the `type: 'money'` column type, defined in `data-grid.tsx`, which formats the value in the row's `currency`. Date columns use AG Grid's built-in `cellDataType: 'dateString'` or `'dateTimeString'`. Every column can be sorted and filtered, and the search box filters across all columns.

## Dashboard

[`/dashboard`](app/dashboard/page.tsx) loads its rows from [`/api/dashboard/data`](app/api/dashboard/data/route.ts), which scopes them to the signed-in persona ([`lib/dashboard/scope.ts`](lib/dashboard/scope.ts)): the buyer sees its own purchases and mandate, the seller the orders placed with it, and the operator everything plus PayPal Transaction Search for reconciliation. AG Studio's data sources, relationships, custom widgets (decision ledger, budget burn-down, receipt card), theme, built-in reports and AI assistant are configured in [`app/dashboard/studio`](app/dashboard/studio). Reports you create or edit are saved per persona in the browser's localStorage.
