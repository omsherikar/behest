import type { MandatePolicy } from '@/lib/domain/policy';
import type { GateInput } from '@/lib/gate/evaluate';
import { block, pass, type Check } from './check';

/** Whether the mandate still authorizes purchases at `now`: active, and past neither its own nor its policy's expiry. */
export function mandateActive({ mandate, now }: Pick<GateInput, 'mandate' | 'now'>, policy: MandatePolicy): Check {
  if (mandate.status === 'revoked') return block('This mandate was revoked');
  if (mandate.status !== 'active') return block('This mandate has expired');
  const expiries = [mandate.expiresAt, policy.expiresAt === null ? null : new Date(policy.expiresAt)];
  if (expiries.some((at) => at !== null && at.getTime() <= now.getTime())) return block('This mandate has expired');
  return pass('The mandate is active and has not expired');
}
