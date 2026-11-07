# Behest interface design

Behest is a protocol for proving an AI agent's purchasing authority: a signed mandate, a deterministic gate, a model check that can only tighten, a PayPal charge or approval, and an Ed25519-signed receipt. The interface is an inspector for that protocol. Everything it shows is a real artifact you could verify yourself.

Every screen answers one question for the person looking at it: why was this purchase allowed, held or blocked, and what proves it.

The look follows the best product sites, with the author's own [argus.omstudio.tech](https://argus.omstudio.tech) as the reference: pure black, a tight grotesk, a floating glass pill nav, two-tone statements, the real product shown in a frame, and generous space. Components come from [VengeanceUI](https://www.vengenceui.com/docs), adapted to these tokens, in `components/vui/`.

## Audience and jobs

- **Buyer (Priya).** Writes a mandate, links a wallet, asks the agent to shop, approves held purchases, reads the ledger.
- **Seller (Ravi's Spice Co.).** Onboards a catalog, sees which listings agents may buy, sees orders and whether each receipt verified.
- **Operator.** Answers disputes with evidence drawn from signed records.
- **Judges.** Technical reviewers who see all three in a few minutes. Every page explains itself in one line, then lets them inspect the proof.

## The one bold element: the authority trace

Every purchase shows the chain that authorized it, in order, as a trace:

1. **Mandate**: the signed policy. Proof: policy hash, mandate id, signed at, and how it was confirmed (session or passkey).
2. **Gate**: deterministic rules. Proof: each rule with pass, ask, block or skip, and its detail.
3. **Intent check**: Claude's check that the cart matches the request; it can only tighten. Proof: verdict and reasons.
4. **PayPal**: the charge or the buyer's approval. Proof: order id, capture id, captured at.
5. **Receipt**: signed by Behest, verified by the seller. Proof: receipt id, key id, and the compact JWS shown as three coloured segments (header, payload, signature) with the decoded header and payload beside it, plus a "Verify" action that calls the public verify route.

Collapsed, the trace is one line of five nodes joined by a neutral rail: only the nodes carry state colour, and a segment is solid into a step the purchase reached and dashed into one it never reached. Expanded, each node opens to its proof. The landing page shows it in a product frame right under the hero. When the agent streams a proposal, the trace fills node by node as events arrive: the single orchestrated motion, disabled under reduced motion.

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

One theme, pure black. Grey carries the structure; colour appears only for state and for the receipt's three segments. The tokens live in `app/globals.css` as CSS variables and Tailwind colours (`bg-bg`, `bg-surface`, `text-muted`, `border-line` and so on).

### Colour

| Token | Value | Use |
| --- | --- | --- |
| `bg` | #000000 | Page background |
| `surface` | #0A0A0B | Panels, cards, the console (`panel` is the old name, kept until every page uses `surface`) |
| `raised` | #111113 | Hover, selected rows, an open trace step, inputs |
| `overlay` | rgba(10,10,11,0.9) | Floating glass: the top bar, menus, popovers. Always with a 20 px backdrop blur, and close to opaque so content never reads through the bar. A 96 px fade from black sits behind the top bar |
| `line` | rgba(255,255,255,0.08) | Hairlines, dividers, panel borders |
| `line-strong` | rgba(255,255,255,0.14) | Stronger dividers, the borders of glass pills and secondary buttons (their label identifies them) |
| `control` | #5C5C66 | The border of a form control: input, select, textarea, checkbox. About 3:1 on black, so the control's edge passes WCAG 1.4.11 |
| `text` | #EDEDEF | Primary text, the primary button's fill |
| `muted` | #8B8B93 | Secondary text: 5.9:1 on `surface`, 5.6:1 on `raised` |
| `faint` | #5C5C66 | Decoration only: rails, separators, counters beside a label. About 3:1, so never words a person must read |
| `seal` | #3FD0A1 | Allowed, paid, verified, done |
| `hold` | #F4B95A | Needs the buyer's approval, waiting |
| `stop` | #FF7A7A | Blocked, failed, refused |
| `jws-header` | #9DB4FF | Receipt header segment |
| `jws-payload` | #C9A7FF | Receipt payload segment |
| `jws-signature` | #6FD6D0 | Receipt signature segment |

State colours also have a 12 percent tint for backgrounds (`bg-seal/12`). Colour is never the only signal: every state also has a word and a shape (filled, half, outlined, crossed). The old `action` token now names the text colour, so a page not yet restyled has no blue in it.

AG Grid and AG Studio follow through the `--pp-*` variables, which point at these tokens.

### Buttons and links

- **Primary**: a white pill with black text, for the action the page is for. One per view.
- **Secondary**: a dark glass pill (`overlay` fill, blur, `line-strong` border), beside the primary.
- **Quiet**: text on no fill, for small actions in a row or a panel.
- **Links** are text. A link inside a sentence keeps a faint underline that brightens on hover (`textLink` in `components/ui/link.ts`), so it never rests on colour alone; a standalone link may show its underline on hover only. No blue fills anywhere.
- **Fields** (input, textarea, search) use `fieldClass` in `components/ui/field.ts`: the surface fill, the `control` border, 12 px corners.
- The focus ring is 2 px of `text`, offset 2 px, on everything focusable.

### Type

- **Geist Sans** for the interface and **Geist Mono** for machine values, both through `next/font/google`.
- Mono only for machine values: ids, hashes, SKUs, amounts in tables, JWS, console lines, and the wordmark.
- Scale:

| Token | Size | Use |
| --- | --- | --- |
| `text-display` | 48 to 88 px, weight 500, tracking -0.04em, line height 1.02 | The landing headline |
| `text-section` | 40 to 56 px, weight 500, tracking -0.035em | Landing section statements |
| `text-title` | 34 px, tracking -0.03em | An app page's title |
| `text-heading` | 22 px, tracking -0.02em | A card's or a panel's title |
| `text-lead` | 17 px | An intro paragraph |
| `text-body` | 15 px | Body |
| `text-meta` | 13 px | Labels, captions, table meta |

- Two-tone headlines, a white line then a `muted` line, only on the landing hero and section statements.
- Sentence case everywhere; no all-caps labels. Prose under 75 characters per line.

### Shape and depth

- Radius: pills fully rounded; inputs and small blocks 12 px (`rounded-control`); panels 16 px (`rounded-panel`); landing cards and frames 20 px (`rounded-frame`).
- No drop shadows except on overlays (the top bar, menus). A panel may carry a 1 px inner top highlight, `inset 0 1px 0 rgba(255,255,255,0.04)`: the `panel` utility gives the surface, the hairline and the highlight together.
- A glowing border (`glow-border-card`) on at most one or two primary panels per page. On the landing page, only the receipt.

## Layout

### The grid

- One container, `container-page`: 1200 px of content, centred, with a 24 px gutter outside it (16 px under 640 px). Twelve columns inside it.
- Nothing hugs the left edge with dead space on the right: a page's content fills the container, in one or two columns.
- Spacing on an 8 px rhythm. Landing sections sit 128 to 160 px apart; app sections 32 to 48 px.
- Every page works at 390 px with no horizontal scroll.

### App shell

```
  +--------------------------------------------------------------+
  | behest      Mandate  Shop  Approvals  Ledger    Buyer|Seller|Operator |   floating glass bar
  +--------------------------------------------------------------+

  Page title                                        [Primary action]
  One line: what this page is for.

  [ main column, 7 or 8 of 12 ]          [ side column, 5 or 4 of 12 ]
```

- **Top bar**: a floating glass bar in the container, sticky at the top. The wordmark on the left, the persona's sections in a spotlight nav (a light follows the pointer, a glow sits under the current page), and the persona switcher on the right as a segmented pill. Under 1024 px the section nav moves to a second row and scrolls sideways.
- **Page header**: the title, one line on what the page is for, and the primary action right-aligned on the same row from 1024 px.
- **Two columns where a page has a task and context**, from 1024 px, stacked below it:

| Page | Main column | Side column |
| --- | --- | --- |
| Mandate | Form and readback, 7 columns | What your agent can do now, budget left this month, wallet status, 5 columns |
| Shop | Console, 8 columns | Budget, approval limit and recent purchases, 4 columns |
| Approvals | List | Detail of the selected item |
| Ledger | Full-width table with a stats row on top | None |
| Seller catalog | Table | Onboarding panel |
| Seller orders | Table | Receipt check side panel |
| Dispute | Evidence | Timeline |

- **Empty states** sit centred in the content area: one line on why, and the next action. Never a blank half screen.
- **Tables and grids**: no truncated headers or clipped columns at 1280 px. Every column is sized to its header and cells first; spare width then goes to the column marked to fill (`context: { fill: true }`, such as the ledger's reasons), or to all columns in proportion. A grid narrower than its content scrolls sideways rather than cut a header. Long text wraps in its cell. Numbers right-aligned in mono.
- The AG Studio dashboard keeps its "best on a wider screen" notice under 1024 px.

## Landing page (`/`)

A product page built from the same components, with no invented metrics, testimonials or logos. Every claim matches the code. Top to bottom:

1. **Glass navbar**: the `behest` wordmark in mono; in the centre How it works, Security, Receipts and FAQ, with the spotlight following the section in view; on the right a quiet "PayPal sandbox" pill and a white "Try the demo" pill.
2. **Hero**, centred over light lines: a "Built on PayPal" pill badge, the two-tone headline "Your AI agent pays. / You keep signed proof.", one paragraph of at most two lines, a white "Try the live demo" pill and a glass "See the attack replay" pill (to `/security`), and the check line "PayPal sandbox only. No real money moves."
3. **Product in frame**: a large window frame holding the real AuthorityTrace of the sample purchase, with its receipt in JwsView, interactive, and one caption line.
4. **How it works**: a statement, then five numbered cards (Mandate, Gate, Intent check, PayPal, Receipt), three then two, each with a live mini UI from the real components and code (the readback, the gate's own rule results, the intent check's tightening, the approval button, the three JWS segments) and one sentence.
5. **Security**: a statement; the replay's numbers from `lib/security/results.json` when that file exists (attacks replayed, stopped in the live run, model calls, cost), never hardcoded; one line on the published attack and a link to `/security`; the four rules the code holds to.
6. **Built on PayPal**: a bento grid of Vault v3, Orders v2, Payouts, Refunds, Disputes, Webhooks and the Agent Toolkit (read only), each with a small Phosphor icon, its API and one line on what Behest uses it for. No PayPal logo artwork.
7. **Inspect a receipt**: the decoded receipt in a glowing frame, beside how a seller verifies it against `/.well-known/jwks.json` and `/api/receipts/verify`.
8. **FAQ**: six questions whose answers match the code and the README's known limitations.
9. **Try it**: the three personas, each a card that starts its session.
10. **Footer**: the wordmark, docs and source, and "PayPal sandbox only; no real money moves."

Each section opens with a small mono index pill (its number and name) above a statement in `text-section`.

## Principles

- **Show the proof.** Any signed thing (mandate, receipt) can be inspected and copied; the receipt can be verified from the page.
- **Explain, then show.** Each page opens with one sentence on what it is for. Each held or blocked purchase says why in plain words from the gate's reasons, with the raw rule result one click away.
- **States are words first.** "Paid", "Waiting for your approval", "Blocked by your mandate", never a bare code.
- **Empty is an invitation.** An empty ledger says how to make the first purchase and links there.
- **Errors say what happened and what to do.** No apologies, no vague failures.
- **One shell.** One top bar, one persona switcher, one nav pattern for all three personas.
- **Motion answers people.** The trace's fill, the nav's spotlight and the hero's light lines are the only motion that plays on its own; all of it stops under reduced motion.
- **Quality floor.** Usable at 390 px, visible keyboard focus, reduced motion respected, AA contrast, keyboard operable trace and console.

## Copy rules

Sentence case. Active verbs on buttons that say what happens ("Sign mandate", "Link PayPal", "Approve at PayPal", "Verify receipt"). The same action keeps the same name through the flow. No em dashes, no arrows in button text, no strings of metadata joined with dots.
