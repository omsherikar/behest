// Pure helpers over AG Studio's report state (ReportState). The shell uses these to check for
// unsaved changes and to edit pages; none of them touch the Studio API.

import type { ReportState } from './studio/widgets';

// Whether `state` differs from `saved` in anything worth saving. The selected page, cross-filters,
// selection and panel sizes also live in state, but changing them doesn't make a report unsaved.
export const hasChanges = (state: ReportState, saved: ReportState) => durable(state) !== durable(saved);

const durable = (state: ReportState) =>
  JSON.stringify({
    schema: state.schema,
    pages: state.pages.map(({ id, widgets, widgetLayout, layout, filter }) => ({ id, widgets, widgetLayout, layout, filter })),
  });

// The filters panel starts collapsed whenever a report opens or the mode changes: the report has
// no filters a viewer sets there (its verdict buttons sit on the page), so an open panel would
// only take the report's width to say "No filters available". The viewer can still open it.
// Panel state isn't something Save compares.
export const withFiltersPanelCollapsed = (state: ReportState): ReportState => ({
  ...state,
  panels: { ...state.panels, filters: { ...state.panels?.filters, collapsed: true } },
});

// Studio leaves page navigation to the host: these add, remove and select pages in state.
export const selectPage = (state: ReportState, pageId: string): ReportState => ({ ...state, selectedPageId: pageId });

// The page to show in `state`: `preferredPageId` if it has that page, otherwise its own selection.
export const pageToSelect = (state: ReportState, preferredPageId: string) =>
  state.pages.some((p) => p.id === preferredPageId) ? preferredPageId : state.selectedPageId;

export const addPage = (state: ReportState, pageId: string): ReportState => ({
  ...state,
  pages: [...state.pages, { id: pageId }],
  selectedPageId: pageId,
});

export const removePage = (state: ReportState, pageId: string): ReportState => {
  const index = state.pages.findIndex((p) => p.id === pageId);
  const pages = state.pages.filter((p) => p.id !== pageId);
  const selectedPageId = state.selectedPageId === pageId ? pages[Math.max(0, index - 1)].id : state.selectedPageId;
  return { ...state, pages, selectedPageId };
};

export const pageHasWidgets = (state: ReportState) =>
  Object.keys(state.pages.find((p) => p.id === state.selectedPageId)?.widgets ?? {}).length > 0;
