import type { LiveState, ResultsFile } from '@/lib/security/results';
import { LIMITS, PAPER, PURPOSE } from '@/lib/security/view';

// The text of /llms.txt: what Behest is and does, for AI agents and for the assistants people use to
// read a site, in the Markdown layout llmstxt.org describes. It says what the code does and where a
// reader can check it, and nothing about how to judge it. The security figures and limits come from
// the results file and the words the security page itself shows, so the two never disagree.

/** A document in the repository, with its link once the repository is public. */
export type RepoDoc = { label: string; path: string; url: string | null };

export type LlmsTextInput = {
  /** The origin Behest is served from, with no trailing slash. */
  appUrl: string;
  /** The public repository, or null while it is private. */
  sourceUrl: string | null;
  docs: readonly RepoDoc[];
  security: ResultsFile;
};

/** How the live run's outcomes read, in the order they are listed. */
const LIVE_WORDS: [state: LiveState, words: string][] = [
  ['stopped', 'stopped'],
  ['flagged', 'held for the buyer'],
  ['passed', 'not stopped'],
  ['failed', 'ended in an error'],
];

/** The security replay's results in a sentence or two, from the results file. */
export function securityFigures({ deterministic, live }: ResultsFile): string {
  const replayed = `${deterministic.length} attacks were replayed against every layer.`;
  if (live === null) return `${replayed} The live run against the model has not been run yet.`;
  const outcomes = LIVE_WORDS.map(([state, words]) => [live.results.filter((result) => result.state === state).length, words] as const)
    .filter(([count]) => count > 0)
    .map(([count, words]) => `${count} ${words}`);
  const skipped = live.skipped.length > 0 ? ` ${live.skipped.length} not run, because the run reached its spend cap.` : '';
  return `${replayed} In the live run against the model, out of ${live.results.length}: ${outcomes.join(', ')}.${skipped} That run made ${live.calls} model calls and cost about $${live.costUsd.toFixed(2)}.`;
}

/** The whole of /llms.txt. */
export function llmsText({ appUrl, sourceUrl, docs, security }: LlmsTextInput): string {
  const at = (path: string) => `${appUrl}${path}`;
  const doc = ({ label, path, url }: RepoDoc) =>
    url ? `- [${label}](${url}): \`${path}\` in the repository.` : `- ${label}: \`${path}\` in the repository, which is private for now.`;

  return `# Behest

> Signed proof of what a human authorized, on every AI-agent purchase made with PayPal. Built for the PayPal AI Hackathon. Everything runs on the PayPal sandbox.

Sellers hesitate to take orders from AI shopping agents, because nobody can prove what the human behind the agent agreed to, and when an agent's order goes wrong the dispute has no evidence. Behest records that proof and carries it from the buyer's mandate to the payment, the seller and any dispute.

How a purchase goes:

1. The buyer writes a spending mandate in plain words, such as "Up to $60 a month on groceries and spices. Ask me before anything over $25. Never electronics." Claude compiles it into a policy. Code, not a model, renders the policy back as sentences, so the buyer confirms exactly what will be enforced. A limit Behest cannot enforce, such as "only on weekends", comes back as a question; it is never dropped.
2. Behest signs the mandate as an EdDSA JWS (Ed25519). With a passkey, the buyer also signs the hashes of the policy and the readback, and the mandate names the passkey's public key, so anyone can check that signature without Behest. The buyer links a PayPal wallet once, with a Vault v3 setup token and no purchase.
3. Claude's shopping agent searches Behest's sellers and Channel3 market prices, then proposes a seller, SKUs and quantities. It has no payment tool and never sets a price. Seller and market text reaches it only as quoted data.
4. A gate of twelve deterministic rules, plain TypeScript with no model in it, prices the cart again from Behest's database and decides: ALLOW, ASK the buyer, or BLOCK. An item priced over 1.5 times its Channel3 market median is held for the buyer. Claude's intent check compares the cart with the buyer's request and can only make the decision stricter. No error ever produces ALLOW. A held or blocked purchase shows the smallest change to the mandate that would have let it through, or why no change would.
5. ALLOW charges the saved wallet with PayPal Orders v2. ASK waits for the buyer to approve at PayPal, from a link or a QR code. BLOCK moves no money. Every PayPal call that moves money carries an idempotency key.
6. A paid purchase gets a signed receipt bound to the exact cart, amount and seller. It names the version of the rules that decided it and, when the shopping agent proposed the purchase, carries the hash of the agent's decision record: every search and lookup it made, and its choice. The seller checks it with Behest's public key: the signature, an issue time in the last 15 minutes, the seller, the cart, the amount, and that it was never used before. Behest is the merchant of record: it pays an accepted order out to the seller with PayPal Payouts, and refunds an order the seller rejects.
7. A dispute the buyer opens at PayPal is matched to its purchase. Claude drafts the answer from an evidence pack built from those records: the signed mandate and the readback the buyer confirmed, the signed receipt, the cart, the agent's decision, the purchase log, and the buyer's own approval when they gave one. A drafted claim that cites no evidence item is dropped, and a claim citing an item the pack does not hold is refused. Before answering, Behest reads the dispute at PayPal and answers the way PayPal allows at that stage: with evidence, or with a message to the buyer while PayPal takes no evidence yet.

PayPal APIs used: Vault v3, Orders v2, Payouts, Refunds, Disputes, Webhooks, Transaction Search and the PayPal Agent Toolkit. The ledgers are AG Grid and the operator's dashboard is AG Studio, with Behest's own widgets and a Claude analyst.

## Check it yourself

- [Public key set](${at('/.well-known/jwks.json')}): the Ed25519 keys, as a JWKS, that verify every mandate and receipt Behest signs. Any JOSE library can check them.
- Receipt check: \`POST ${at('/api/receipts/verify')}\` with JSON \`{ "jws": "<receipt>", "cart": <cart>, "sellerSlug": "<seller>" }\` runs the seller's checks on a receipt, for a seller without a JOSE library.
- [Demo seller's catalog](${at('/api/sellers/ravi-spices/catalog')}): Ravi's Spice Co., as JSON, the way outside shopping agents read it. A listing flagged for text aimed at AI agents is never in it.

## Pages

- [Home](${at('/')}): what Behest does and how a purchase goes, and the persona picker.
- [Security](${at('/security')}): ${PURPOSE}
- Buyer, seller and operator pages open once a persona is picked on the home page; there is no sign-up. The buyer's: \`/buyer\` (the mandate), \`/buyer/shop\` (the shopping agent), \`/buyer/approvals\` and \`/buyer/ledger\` (purchases and their receipts). The seller's: \`/seller\`, \`/seller/catalog\` and \`/seller/orders\`. The operator's: \`/ops/disputes\` and \`/dashboard\`.

## Security results

- ${securityFigures(security)}
- The attack comes from [${PAPER.title}](${PAPER.url}) by ${PAPER.authors} (${PAPER.id}).
- What the replay shows Behest does not stop yet, as the security page lists it:
${LIMITS.map(({ title }) => `  - ${title}`).join('\n')}

## Docs

${[...(sourceUrl ? [`- [Source code](${sourceUrl}): the repository.`] : []), ...docs.map(doc)].join('\n')}
`;
}
