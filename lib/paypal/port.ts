// Everything the purchase flow asks of PayPal. The orchestrator depends on this interface, so tests
// can pass an in-memory fake instead of reaching the network. Amounts are integer cents in USD.

export interface PaypalPort {
  createSetupToken(i: { returnUrl: string; cancelUrl: string; description: string }): Promise<{ id: string; approveUrl: string; customerId: string }>;
  createPaymentToken(setupTokenId: string): Promise<{ id: string; customerId: string }>;
  chargeSavedWallet(i: { paymentTokenId: string; amountCents: number; description: string; invoiceId: string; requestId: string }): Promise<{ orderId: string; captureId: string; status: 'COMPLETED' | 'PENDING' | 'DECLINED' }>;
  createApprovalOrder(i: { amountCents: number; description: string; invoiceId: string; returnUrl: string; cancelUrl: string; requestId: string }): Promise<{ orderId: string; approveUrl: string }>;
  captureOrder(orderId: string, requestId: string): Promise<{ captureId: string; status: 'COMPLETED' | 'PENDING' | 'DECLINED' }>;
  createPayout(i: { receiverEmail: string; amountCents: number; note: string; senderBatchId: string }): Promise<{ payoutBatchId: string }>;
  getPayoutBatch(payoutBatchId: string): Promise<{ batchStatus: string; itemStatus: string | null }>;
  refundCapture(i: { captureId: string; amountCents: number; note: string; requestId: string }): Promise<{ refundId: string; status: string }>;
  listDisputes(): Promise<DisputeSummary[]>;
  getDispute(id: string): Promise<DisputeDetail>;
  provideEvidence(id: string, i: { notes: string }): Promise<void>;
  verifyWebhook(headers: Headers, rawBody: string): Promise<boolean>;
}

export type DisputeSummary = { id: string; status: string; reason: string; amountCents: number; captureId: string | null; createTime: string };
export type DisputeDetail = DisputeSummary & {
  buyerNotes: string | null;
  /** PayPal's outcome code once it has decided the dispute, such as RESOLVED_SELLER_FAVOUR; null before. */
  outcome: string | null;
  /** PayPal's stage for the case, such as INQUIRY or CHARGEBACK; null when PayPal gives none. */
  stage: string | null;
  /**
   * What PayPal lets the seller do with the case now, such as provide_evidence or send_message: the
   * rels of the dispute's links, without `self`.
   */
  actions: string[];
};
