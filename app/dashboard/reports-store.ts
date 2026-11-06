// Saved reports, kept in this browser's localStorage. Studio's state has no page names, so each
// report carries its page titles alongside the AG Studio state. Each persona sees different data,
// so each keeps its own reports.
//
// The persona's built-in report comes from ./studio/initial-report.ts until it is saved;
// after that the saved copy wins until it is reset to default.

import type { Persona } from '@/lib/session';
import { BUILT_IN_REPORTS } from './studio/initial-report';
import type { ReportState } from './studio/widgets';

export type SavedReport = {
  id: string;
  name: string;
  builtIn?: boolean;
  pageTitles: Record<string, string>;
  state: ReportState;
  updatedAt: string;
};

export type StoredReports = { reports: SavedReport[]; activeId: string };

const storageKey = (persona: Persona) => `behest:reports:v1:${persona}`;

export const BUILT_IN_ID = 'built-in';

export const defaultReport = (persona: Persona): SavedReport => {
  const { name, pageTitles, state } = BUILT_IN_REPORTS[persona];
  return { id: BUILT_IN_ID, name, builtIn: true, pageTitles, state, updatedAt: new Date(0).toISOString() };
};

export const newId = (prefix: string) => `${prefix}-${crypto.randomUUID().slice(0, 8)}`;

export function blankReport(name: string): SavedReport {
  const pageId = newId('page');
  return {
    id: newId('report'),
    name,
    pageTitles: { [pageId]: 'Page 1' },
    state: { selectedPageId: pageId, pages: [{ id: pageId }] },
    updatedAt: new Date().toISOString(),
  };
}

// A copy of a report under a new id. Copies of the built-in report are ordinary reports.
export const copyOf = (source: SavedReport): SavedReport => ({
  ...source,
  id: newId('report'),
  name: `${source.name} (copy)`,
  builtIn: undefined,
  updatedAt: new Date().toISOString(),
});

export const findReport = (reports: SavedReport[], id: string) => reports.find((r) => r.id === id);

// --- Updates ----------------------------------------------------------------------
// Pure: each returns the next StoredReports, for the caller to save.

export function upsert(current: StoredReports, report: SavedReport): StoredReports {
  const exists = current.reports.some((r) => r.id === report.id);
  const reports = exists ? current.reports.map((r) => (r.id === report.id ? report : r)) : [...current.reports, report];
  return { ...current, reports };
}

// Deleting the built-in report resets it to default rather than removing it.
export function remove(current: StoredReports, id: string, persona: Persona): StoredReports {
  if (id === BUILT_IN_ID) return upsert(current, defaultReport(persona));
  const reports = current.reports.filter((r) => r.id !== id);
  return { reports, activeId: current.activeId === id ? BUILT_IN_ID : current.activeId };
}

// Back to a fresh demo: only the built-in report, as defined in initial-report.ts.
export const initialReports = (persona: Persona): StoredReports => ({
  reports: [defaultReport(persona)],
  activeId: BUILT_IN_ID,
});

// --- Storage ----------------------------------------------------------------------

export function loadReports(persona: Persona): StoredReports {
  try {
    const raw = localStorage.getItem(storageKey(persona));
    if (!raw) return initialReports(persona);
    const stored = JSON.parse(raw) as StoredReports;
    // The built-in report is always listed first, from code unless a saved copy exists.
    const reports = [
      stored.reports.find((r) => r.id === BUILT_IN_ID) ?? defaultReport(persona),
      ...stored.reports.filter((r) => r.id !== BUILT_IN_ID),
    ];
    const activeId = reports.some((r) => r.id === stored.activeId) ? stored.activeId : BUILT_IN_ID;
    return { reports, activeId };
  } catch {
    return initialReports(persona);
  }
}

export function saveReports(next: StoredReports, persona: Persona) {
  // Only keep the built-in report once it differs from code, so edits to initial-report.ts show up.
  const builtIn = BUILT_IN_REPORTS[persona];
  const untouched = (r: SavedReport) =>
    r.id === BUILT_IN_ID && r.state === builtIn.state && r.pageTitles === builtIn.pageTitles && r.name === builtIn.name;
  try {
    localStorage.setItem(storageKey(persona), JSON.stringify({ ...next, reports: next.reports.filter((r) => !untouched(r)) }));
  } catch {
    // Storage full or blocked: keep working in memory for this session.
  }
}
