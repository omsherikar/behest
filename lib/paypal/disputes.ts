// Reading the disputes buyers open against Behest's captures, and answering one with evidence.
// Amounts become integer cents and must be USD; statuses and reasons are PayPal's own strings.
// Whether to submit evidence is an operator's decision: provideEvidence sends what it is given.

import { paypalRequest } from './http';
import { toCents } from './money';
import type { DisputeSummary, PaypalPort } from './port';

const DISPUTES = '/v1/customer/disputes';
/** The most disputes PayPal returns on one page. */
const PAGE_SIZE = 50;
/** The most pages read, so a list that never ends cannot keep the caller waiting forever. */
const MAX_PAGES = 100;

type Link = { href?: string; rel?: string };
type Message = { posted_by?: string; time_posted?: string; content?: string };
type Dispute = {
  dispute_id?: string;
  status?: string;
  reason?: string;
  create_time?: string;
  dispute_amount?: { currency_code?: string; value?: string };
  /** Present on a dispute read by id. List items usually leave it out. */
  disputed_transactions?: { seller_transaction_id?: string }[];
  messages?: Message[];
  /** Present once PayPal has decided the dispute. */
  dispute_outcome?: { outcome_code?: string };
};
type DisputePage = { items?: Dispute[]; links?: Link[] };

function amountCents(id: string, amount: Dispute['dispute_amount']): number {
  if (amount?.currency_code !== 'USD') {
    throw new Error(`PayPal dispute ${id} is in ${amount?.currency_code ?? 'no currency'}, but Behest handles only USD`);
  }
  try {
    return toCents(amount.value ?? '');
  } catch (error) {
    throw new Error(`PayPal dispute ${id} has an amount that is not whole cents`, { cause: error });
  }
}

function toSummary(dispute: Dispute): DisputeSummary {
  const { dispute_id: id, status, reason, create_time: createTime } = dispute;
  if (!id) throw new Error('PayPal sent a dispute with no dispute id');
  if (!status || !reason || !createTime) throw new Error(`PayPal dispute ${id} came back without a status, reason or create time`);
  return {
    id,
    status,
    reason,
    amountCents: amountCents(id, dispute.dispute_amount),
    // For Behest, the merchant of record, the seller's side of the disputed payment is the capture.
    captureId: dispute.disputed_transactions?.[0]?.seller_transaction_id ?? null,
    createTime,
  };
}

/** The path and query of the next page's link, or null on the last page. */
function nextPagePath(links: Link[] | undefined): string | null {
  const href = links?.find((link) => link.rel === 'next')?.href;
  if (!href) return null;
  // Only the path and query matter: paypalRequest always sends to PayPal's own host.
  const url = new URL(href, 'https://api-m.sandbox.paypal.com');
  return `${url.pathname}${url.search}`;
}

export const listDisputes: PaypalPort['listDisputes'] = async () => {
  const disputes: DisputeSummary[] = [];
  const read = new Set<string>();
  let path: string | null = `${DISPUTES}?page_size=${PAGE_SIZE}`;
  // A next link back to a page already read would otherwise loop forever.
  while (path !== null && !read.has(path)) {
    if (read.size === MAX_PAGES) throw new Error(`PayPal listed more than ${MAX_PAGES} pages of disputes, so the list was not read to the end`);
    read.add(path);
    const page: DisputePage | undefined = await paypalRequest<DisputePage | undefined>('GET', path);
    disputes.push(...(page?.items ?? []).map(toSummary));
    path = nextPagePath(page?.links);
  }
  return disputes;
};

/** When a message was posted, in milliseconds. A message with no readable time counts as the latest. */
function postedAt(message: Message): number {
  const time = Date.parse(message.time_posted ?? '');
  return Number.isNaN(time) ? Number.POSITIVE_INFINITY : time;
}

/** The buyer's earliest message with any text, by time posted, whatever order PayPal lists them in. */
function firstBuyerMessage(messages: Message[] | undefined): Message | undefined {
  const written = (messages ?? []).filter((message) => message.posted_by === 'BUYER' && message.content);
  return written.reduce<Message | undefined>((first, message) => (first && postedAt(first) <= postedAt(message) ? first : message), undefined);
}

export const getDispute: PaypalPort['getDispute'] = async (id) => {
  const dispute = await paypalRequest<Dispute | undefined>('GET', `${DISPUTES}/${encodeURIComponent(id)}`);
  // PayPal keeps what each side wrote in `messages`. The buyer's earliest written message is taken
  // as their account of the dispute.
  return {
    ...toSummary(dispute ?? {}),
    buyerNotes: firstBuyerMessage(dispute?.messages)?.content ?? null,
    outcome: dispute?.dispute_outcome?.outcome_code ?? null,
  };
};

export const provideEvidence: PaypalPort['provideEvidence'] = async (id, { notes }) => {
  const input = { evidences: [{ evidence_type: 'OTHER', notes }] };
  const form = new FormData();
  form.append('input', new Blob([JSON.stringify(input)], { type: 'application/json' }));
  await paypalRequest('POST', `${DISPUTES}/${encodeURIComponent(id)}/provide-evidence`, { form, requestId: `${id}:evidence` });
};
