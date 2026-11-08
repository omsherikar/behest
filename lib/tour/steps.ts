import type { Persona } from '@/lib/session';
import type { PinKey } from './pins';

// The guided demo on the home page, as data: each step names the demo role it needs, the page it
// opens, the element it rings (by its data-tour anchor) and what it says. It follows the demo
// video's story: the buyer's mandate and purchases, the seller's checks, the operator's dispute and
// dashboard, then the security replay. Steps that show one particular record name the pin it comes
// from (lib/tour/pins.ts), so later purchases on the shared demo never move them. The copy stays
// general, with no figure that belongs to one run, so it stays true if the run is ever made again.

export type TourStep = {
  /** Unique, in kebab-case. */
  id: string;
  /** The demo role the step switches to, or null for a public page. */
  role: Persona | null;
  /** The page to open; `{dispute}` is filled in from the dispute pin. */
  path: string;
  /** The `data-tour` value of the element to ring, or null for a card with nothing to point at. */
  anchor: string | null;
  /** A grid row to scroll into view first: the row whose id is this pin. */
  row?: PinKey;
  /** A grid record whose side panel the step opens, through `?open=`. */
  open?: PinKey;
  /** The pin the step cannot point at anything without. */
  needs?: PinKey;
  title: string;
  body: string;
};

export const TOUR_STEPS: readonly TourStep[] = [
  {
    id: 'welcome',
    role: null,
    path: '/',
    anchor: 'hero',
    title: 'What Behest is',
    body: 'AI agents can now shop and pay for people. Behest records what the person allowed, checks every purchase against it, and signs a receipt the seller can verify. This tour shows each part on a real run in the PayPal sandbox.',
  },
  {
    id: 'mandate',
    role: 'buyer',
    path: '/buyer',
    anchor: 'mandate-readback',
    title: 'Her mandate, in her own words',
    body: 'Priya wrote her spending limits in plain words, and Claude turned them into a strict policy. The sentences she confirmed were rendered by code from that policy, not written by the model, so what she read is exactly what is enforced.',
  },
  {
    id: 'signature',
    role: 'buyer',
    path: '/buyer',
    anchor: 'mandate-signature',
    title: 'Signed, and checkable by anyone',
    body: 'Behest signs the mandate with its Ed25519 key, and a passkey signature, when the buyer adds one, covers the same policy and readback. Anyone can check them with public keys, without asking Behest. Her PayPal wallet was linked once, with no purchase.',
  },
  {
    id: 'ledger',
    role: 'buyer',
    path: '/buyer/ledger',
    anchor: 'ledger-grid',
    row: 'allowed',
    needs: 'allowed',
    title: 'Every purchase, and what decided it',
    body: "The agent proposes; twelve fixed rules in code decide, with no model in them. Each purchase is allowed, held for Priya, or blocked, and Claude's intent check can only make a decision stricter.",
  },
  {
    id: 'held',
    role: 'buyer',
    path: '/buyer/ledger',
    anchor: 'purchase-reasons',
    open: 'held',
    needs: 'held',
    title: 'Held for Priya',
    body: 'This one was over the approval limit she set, so the rules held it instead of paying. She approved it herself at PayPal, and its receipt records that a person made the call.',
  },
  {
    id: 'blocked',
    role: 'buyer',
    path: '/buyer/ledger',
    anchor: 'what-would-change',
    open: 'blocked',
    needs: 'blocked',
    title: 'Blocked, and what would change',
    body: 'Nothing was paid. Behest runs the same rules again on adjusted copies of the mandate it was decided under, and shows the smallest change that would have let it through, or why no change would.',
  },
  {
    id: 'hidden',
    role: 'seller',
    path: '/seller',
    anchor: 'hidden-from-agents',
    title: 'A listing hidden from agents',
    body: "When Ravi's catalog was built, one listing's text was written to instruct AI agents. Behest flagged it, hides it from every agent, and the rules block it if it is ever proposed.",
  },
  {
    id: 'orders',
    role: 'seller',
    path: '/seller/orders',
    anchor: 'orders-grid',
    row: 'order',
    needs: 'order',
    title: "Ravi's shop checks every receipt",
    body: "Each order arrives with Behest's signed receipt, and the shop checks it before accepting. A receipt sent back with a changed cart, or sent a second time, was rejected. Accepted orders are paid out to Ravi with PayPal Payouts.",
  },
  {
    id: 'receipt',
    role: 'seller',
    path: '/seller/orders',
    anchor: 'receipt-check',
    open: 'order',
    needs: 'order',
    title: 'Checked with the public key',
    body: "When the order arrived, the shop checked the receipt with only Behest's public key: the signature, that it was under 15 minutes old, that the seller, cart and amount matched, and that it had not been used before.",
  },
  {
    id: 'dispute',
    role: 'operator',
    path: '/ops/disputes',
    anchor: 'disputes-grid',
    row: 'dispute',
    needs: 'dispute',
    title: 'A dispute, already matched',
    body: "Behest is the merchant of record, so a buyer's dispute at PayPal arrives on Behest's account. It is pulled in and matched to the purchase it is about, with the buyer's own note.",
  },
  {
    id: 'answer',
    role: 'operator',
    path: '/ops/disputes/{dispute}',
    anchor: 'dispute-answer',
    needs: 'dispute',
    title: 'Every claim cites a signed record',
    body: 'Claude drafted the answer and the operator reviewed it. Each claim names the evidence it rests on, and a claim citing nothing is dropped before anyone sees it. Behest checked what PayPal takes at this stage before sending it.',
  },
  {
    id: 'evidence',
    role: 'operator',
    path: '/ops/disputes/{dispute}',
    anchor: 'dispute-evidence',
    needs: 'dispute',
    title: 'The evidence behind it',
    body: "The pack is built from Behest's own records: the signed mandate with its passkey check, the receipt, the cart, the purchase log and the agent's decision record. Text from the seller or the agent is quoted and labelled with where it came from.",
  },
  {
    id: 'dashboard',
    role: 'operator',
    path: '/dashboard',
    anchor: 'ledger-widget',
    title: "The operator's dashboard",
    body: "The dashboard runs on AG Studio with Behest's own widgets: the decision ledger, budgets, receipts and payouts, and reconciliation against PayPal's transaction records. A Claude analyst answers questions about the data.",
  },
  {
    id: 'security',
    role: null,
    path: '/security',
    anchor: 'security-figures',
    title: 'Tested against a published attack',
    body: 'We replayed a published prompt-injection attack on agent payments through every layer. The page shows what each layer did, including where an attack got through, and lists what Behest does not cover yet.',
  },
];

/** The last card, which hands over to the judge. */
export const TOUR_END: TourStep = {
  id: 'try',
  role: null,
  path: '/security',
  anchor: null,
  title: 'Try it yourself',
  body: "Pick Buyer on the home page, write your own mandate and sign it, then ask the shopping agent for something. The PayPal sandbox buyer login for approving a held purchase is in the Devpost submission's testing instructions. Everyone shares the demo buyer, and the agent makes real model calls within a daily cap.",
};

/** Each demo role as the top bar names it. */
export const ROLE_LABEL: Record<Persona, string> = { buyer: 'Buyer', seller: 'Seller', operator: 'Operator' };

/** What a step says when the record it points at is not on this site. */
export const NOT_LOADED = 'The demo data for this step is not loaded on this site yet.';
