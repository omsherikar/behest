import type { SellerPort } from '@/lib/purchases/deps';
import { acceptAgentOrder, type IntakeDeps } from './intake';

/**
 * The seller side of an agent purchase as the purchase orchestrator calls it: Behest's own seller
 * intake, which verifies the receipt as any outside seller would. A rejection's reason is its
 * rejection code, such as `replayed`. An UnknownSellerError from intake propagates.
 */
export function sellerPort(deps: IntakeDeps): SellerPort {
  return { acceptAgentOrder: (order) => acceptAgentOrder(deps, order) };
}
