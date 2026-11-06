// The AG Studio AI analyst. Its adapter posts each turn to this app's analyst route at
// /api/ai/studio, which calls Claude with the server's Anthropic key, so nothing secret is sent
// from the browser. The route picks the model and the effort, so the chat offers no choice of model.

import { createAiHarness, type AgAiHarnessSetup, type AgAiPromptStarter } from 'ag-studio';
import { anthropicAdapter } from './anthropic-adapter';

// Suggestions shown in a new AI conversation, before anything has been typed.
const PROMPT_STARTERS: AgAiPromptStarter[] = [
  {
    label: 'Summarise this page',
    prompt: 'Summarise what this page shows: every widget, the fields it reads, and what stands out.',
  },
  {
    label: 'Overdue invoices',
    prompt: 'Which customers owe the most on overdue invoices?',
  },
  {
    label: 'Revenue by month',
    prompt: 'Add a chart of paid invoice revenue by month.',
  },
];

export function buildAi(): AgAiHarnessSetup {
  const adapter = anthropicAdapter({ endpoint: '/api/ai/studio' });

  return ({ api }) =>
    createAiHarness(api, {
      adapter,
      promptStarters: PROMPT_STARTERS,
    });
}
