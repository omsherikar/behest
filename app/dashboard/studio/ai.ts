// The AG Studio AI analyst. Its adapter posts each turn to this app's analyst route at
// /api/ai/studio, which calls Claude with the server's Anthropic key, so nothing secret is sent
// from the browser. The route picks the model and the effort, so the chat offers no choice of model.

import { createAiHarness, type AgAiHarnessSetup, type AgAiPromptStarter } from 'ag-studio';
import type { Persona } from '@/lib/session';
import { anthropicAdapter } from './anthropic-adapter';

// Suggestions shown in a new AI conversation, before anything has been typed. Each persona gets
// questions its own data can answer: the seller's data says nothing about budgets or about how
// the buyer's agent decided, so its questions are about orders, items and payouts.
const PROMPT_STARTERS: Record<Persona, AgAiPromptStarter[]> = {
  buyer: [
    { label: 'Approvals this week', prompt: 'Which purchases needed approval this week and why?' },
    { label: 'Budget left', prompt: 'How much of my budget is left this period, and what has used it?' },
    { label: 'Blocked purchases', prompt: 'Show every blocked purchase with its reasons.' },
  ],
  seller: [
    { label: 'Orders this week', prompt: 'Which orders did I receive this week, and what is the status of each?' },
    { label: 'Best sellers', prompt: 'Add a chart of my revenue by item.' },
    { label: 'Pending payouts', prompt: 'Which of my payouts are still pending, and for how much?' },
  ],
  operator: [
    { label: 'Approvals this week', prompt: 'Which purchases needed approval this week and why?' },
    { label: 'Blocked purchases', prompt: 'Show every blocked purchase with its reasons.' },
    { label: 'Unmatched transactions', prompt: 'Which PayPal transactions do not match a purchase?' },
  ],
};

export function buildAi(persona: Persona): AgAiHarnessSetup {
  const adapter = anthropicAdapter({ endpoint: '/api/ai/studio' });

  return ({ api }) =>
    createAiHarness(api, {
      adapter,
      promptStarters: PROMPT_STARTERS[persona],
    });
}
