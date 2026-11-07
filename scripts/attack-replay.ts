import { readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { MAX_TURNS } from '../lib/agent/run';
import { createClaude, dailyCapUsd } from '../lib/llm/client';
import { ATTACKS, REPLAY_MANDATE } from '../lib/security/attacks';
import { INTENT_CHECKS_PER_ATTACK, liveRefusal, maxModelCalls, replayLiveAll } from '../lib/security/live';
import { replayAttacks } from '../lib/security/replay';
import { type LiveResult, LiveRun, type ReplayResult, type ResultsFile } from '../lib/security/results';
import { attackRows, replaceResultsBlock, resultsBlock } from '../lib/security/view';

// Replays the attacks in lib/security/attacks.ts against Behest and records the results in
// lib/security/results.json and in the results table of docs/security.md. The deterministic layers
// run offline, with no model and no network, every time. With ATTACK_LIVE=1 the script also runs the
// live shopping agent and intent check once per attack, which makes paid Claude calls: it refuses
// unless ANTHROPIC_API_KEY is set too, and says how many calls it may make before it makes any.
// Without ATTACK_LIVE the live results already in the file are kept as they are.

const RESULTS = path.join('lib', 'security', 'results.json');
const DOC = path.join('docs', 'security.md');

/**
 * The live results the file already holds, or null when there is no file or no live run yet. Only the
 * live section is read, since the rest is replayed afresh and may be in an older shape; a live section
 * that does not read throws, so no paid result is lost.
 */
async function previousLive(): Promise<LiveRun | null> {
  let text: string;
  try {
    text = await readFile(RESULTS, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const live: unknown = (JSON.parse(text) as { live?: unknown }).live ?? null;
  return LiveRun.nullable().parse(live);
}

/** Whether the live run was asked for: ATTACK_LIVE set to anything but empty or 0. */
function liveRequested(): boolean {
  const value = process.env.ATTACK_LIVE?.trim() ?? '';
  return value !== '' && value !== '0';
}

/** Refuses the live run as liveRefusal says, or prints the most model calls it may make. Runs before anything else. */
function announceLive(): void {
  const refusal = liveRefusal(process.env);
  if (refusal) throw new Error(refusal);
  const cap = dailyCapUsd(process.env);
  console.log(
    `Live replay: at most ${maxModelCalls(ATTACKS.length)} paid model calls, ${ATTACKS.length} attacks of up to ` +
      `${MAX_TURNS} agent turns and ${INTENT_CHECKS_PER_ATTACK} intent checks each. No attack starts once the run's ` +
      `logged cost reaches $${cap.toFixed(2)} (LLM_DAILY_CAP_USD).`,
  );
}

/** Writes the results file and the doc's results table, and returns the file. */
function save(deterministic: ReplayResult[], live: LiveRun | null): ResultsFile {
  const file: ResultsFile = { version: 1, mandate: REPLAY_MANDATE.readback, deterministic, live };
  writeFileSync(RESULTS, `${JSON.stringify(file, null, 2)}\n`);
  writeFileSync(DOC, replaceResultsBlock(readFileSync(DOC, 'utf8'), resultsBlock(file)));
  return file;
}

/** The live run, saved after every attack, so a crash part way loses no paid result already recorded. */
async function liveRun(deterministic: ReplayResult[]): Promise<LiveRun> {
  const ranAt = new Date().toISOString();
  const done: LiveResult[] = [];
  const run = await replayLiveAll({ claude: createClaude(), now: () => new Date() }, ATTACKS, {
    onResult: (result) => {
      done.push(result);
      console.log(`  ${result.attack}: ${result.state}, ${result.calls} model calls, $${result.costUsd.toFixed(4)}`);
      const calls = done.reduce((total, r) => total + r.calls, 0);
      const costUsd = Math.round(done.reduce((total, r) => total + r.costUsd, 0) * 1_000_000) / 1_000_000;
      save(deterministic, { ranAt, calls, costUsd, results: [...done], skipped: [] });
    },
  });
  console.log(`Live replay spent $${run.costUsd.toFixed(4)} over ${run.calls} model calls, as logged in llm_calls.`);
  return run;
}

async function main(): Promise<void> {
  const live = liveRequested();
  if (live) announceLive();
  const deterministic = await replayAttacks();
  const file = save(deterministic, live ? await liveRun(deterministic) : await previousLive());
  for (const row of attackRows(file)) console.log(`${row.name}: ${row.outcome}`);
  console.log(`Wrote ${RESULTS} and the results table in ${DOC}.`);
}

main().catch((error: unknown) => {
  console.error(`The attack replay failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
