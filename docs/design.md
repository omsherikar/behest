# Behest interface design

Behest is a protocol for proving an AI agent's purchasing authority: a signed mandate, a deterministic gate, a model check that can only tighten, a PayPal charge or approval, and an Ed25519-signed receipt. The interface is an inspector for that protocol. It looks technical because the product is technical: everything it shows is a real artifact you could verify yourself.

Every screen answers one question for the person looking at it: why was this purchase allowed, held or blocked, and what proves it.

## Audience and jobs

- **Buyer (Priya).** Writes a mandate, links a wallet, asks the agent to shop, approves held purchases, reads the ledger.
- **Seller (Ravi's Spice Co.).** Onboards a catalog, sees which listings agents may buy, sees orders and whether each receipt verified.
- **Operator.** Answers disputes with evidence drawn from signed records.
- **Judges.** Technical reviewers who see all three in a few minutes. Every page explains itself in one line, then lets them inspect the proof.

## The one bold element: the authority trace

Every purchase shows the chain that authorized it, in order, as a trace:

1. **Mandate**: the signed policy. Proof: policy hash, mandate id, signed at.
2. **Gate**: deterministic rules. Proof: each rule with pass, ask, block or skip, and its detail.
3. **Intent check**: Claude's check that the cart matches the request; it can only tighten. Proof: verdict and reasons.
4. **PayPal**: the charge or the buyer's approval. Proof: order id, capture id, captured at.
5. **Receipt**: signed by Behest, verified by the seller. Proof: receipt id, key id, and the compact JWS shown as three coloured segments (header, payload, signature) with the decoded header and payload beside it, plus a "Verify" action that calls the public verify route.

Collapsed, the trace is one line of five nodes joined by a rail; the rail segments take each step's state colour. Expanded, each node opens to its proof. This is the only place the interface spends boldness. When the agent streams a proposal, the trace fills node by node as events arrive: the single orchestrated motion, disabled under reduced motion.

## The agent console

The shop page shows a run as a console, not chat bubbles:

```
14:02:07  search_sellers  query: "turmeric", maxPriceCents: 2500
14:02:08  3 results from Ravi's Spice Co.
14:02:09  propose_purchase  TUR-100 x2
14:02:11  Allowed  $18.75  Paid  receipt rct_7f3a...
          [trace: Mandate - Gate - Intent - PayPal - Receipt]
```

Timestamps and tool calls in mono; the agent's plain-language status lines and summaries in sans. Proposals expand to their full trace inline.

## Tokens

Dark, by design: the console and the trace read best on a dark surface, and the demo is recorded on screen. One theme only.

### Colour

| Token | Hex | Use |
| --- | --- | --- |
| `bg` | #0A1220 | Page background (deep navy ink, not neutral black) |
| `panel` | #0F192C | Panels, the console |
| `raised` | #15223A | Hover, selected rows, expanded trace |
| `line` | #22314C | Borders, rails, dividers |
| `text` | #E4EBF5 | Primary text |
| `muted` | #8E9DB8 | Secondary text (at least 4.5:1 on `bg` and `panel`) |
| `action` | #5B9BFF | Links, primary buttons, focus ring. Never means a state. |
| `seal` | #3FD0A1 | Allowed, paid, verified, done |
| `hold` | #F4B95A | Needs the buyer's approval, waiting |
| `stop` | #FF7A7A | Blocked, failed, refused |
| `jws-header` | #9DB4FF | Receipt header segment |
| `jws-payload` | #C9A7FF | Receipt payload segment |
| `jws-signature` | #6FD6D0 | Receipt signature segment |

State colours also have a 12 percent tint for backgrounds. Colour is never the only signal: every state also has a word and a shape (filled, half, outlined, crossed). Check every text pairing for 4.5:1.

AG Grid and AG Studio get a matching dark theme from these tokens (the existing `--pp-*` variables remain for anything that still reads them, remapped to the dark values).

### Type

- **IBM Plex Sans** for the interface: headings, body, buttons. Weights 400, 500, 600. Sentence case everywhere; no all-caps labels.
- **IBM Plex Mono** for machine values and the console: ids, hashes, SKUs, timestamps, tool calls, JWS segments, amounts in tables. Tabular figures.
- Scale (rem): 0.75 meta, 0.875 body, 1 lead, 1.375 page title, 2 home title. Prose under 75 characters per line.

### Space and shape

- 4 px base; panels pad 16 to 20 px; sections 32 px apart. Dense but never cramped.
- Radius: 4 px controls, 8 px panels, none on the trace rail.
- Hairline 1 px borders in `line`; no drop shadows except overlays (menus, drawers).
- A faint 24 px grid on the page background only on the home page, as a quiet nod to schematic paper.

## Layout

```
+----------------------------------------------------------------+
| behest                                 Viewing as  Buyer   v   |  top bar
| Mandate   Shop   Approvals   Ledger                            |  section nav, active underlined
+----------------------------------------------------------------+
| Page title                                                     |
| One sentence: what this page is for.                           |
|                                                                |
| [content, left aligned, max 1200 px]                           |
+----------------------------------------------------------------+
```

The wordmark is lowercase `behest` in Plex Mono, the one typographic signature. Content is left aligned; numbers right aligned in tables and grids.

## Principles

- **Show the proof.** Any signed thing (mandate, receipt) can be inspected and copied; the receipt can be verified from the page.
- **Explain, then show.** Each page opens with one sentence on what it is for. Each held or blocked purchase says why in plain words from the gate's reasons, with the raw rule result one click away.
- **States are words first.** "Paid", "Waiting for your approval", "Blocked by your mandate", never a bare code.
- **Empty is an invitation.** An empty ledger says how to make the first purchase and links there.
- **Errors say what happened and what to do.** No apologies, no vague failures.
- **One shell.** One top bar, one persona switcher, one nav pattern for all three personas.
- **Quality floor.** Usable at 390 px, visible keyboard focus, reduced motion respected, AA contrast, keyboard operable trace and console.

## Copy rules

Sentence case. Active verbs on buttons that say what happens ("Sign mandate", "Link PayPal", "Approve at PayPal", "Verify receipt"). The same action keeps the same name through the flow. No em dashes, no arrows on buttons, no strings of metadata joined with dots.

## Landing page (`/`)

A technical product page, built from the same components, with no invented metrics, testimonials or logos. Every claim matches the code. Sections, top to bottom:

1. **Hero.** One line: "Signed proof of what you authorized, on every purchase your AI agent makes." Actions: "Try the live demo" (scrolls to the persona choice) and "Read the architecture" (docs/architecture.md on GitHub once public, otherwise the in-repo path). Visual: an AuthorityTrace that plays its five nodes once, ending in a receipt shown with JwsView.
2. **The problem.** Three short points: an agent spends your money; a chat log is not proof of what you allowed; the seller cannot tell an authorized order from an injected one.
3. **How it works.** The five steps (mandate, gate, intent check, PayPal, receipt), each with what it proves. Numbered, because it is a sequence.
4. **Inspect a receipt.** A sample receipt token in JwsView, decoded, with how a seller verifies it against `/.well-known/jwks.json` and `/api/receipts/verify`.
5. **Built on PayPal.** Vault v3 saved wallets, Orders v2, Payouts, Refunds, Disputes with evidence, Webhooks, Agent Toolkit (read only): one line each on what Behest uses it for.
6. **Safety model.** The gate decides; models only tighten; seller and market text reach the model only as quoted data; every PayPal call carries a request id, so retries never double charge.
7. **Try it.** The three personas, each with what you can do there.
8. **Footer.** Docs, source, and "PayPal sandbox only; no real money moves."
