// AG Studio theme for the dashboard, on the Behest design tokens (app/globals.css): the same dark
// palette, type and borders as the rest of the app, so Studio renders as part of the page rather than
// a component embedded in it. Change a token there and the shell, widgets, grids and charts follow.

import { studioTheme } from 'ag-studio';

/** A Behest token, such as `panel` or `line`. */
const token = (name: string) => `var(--${name})`;
const line = (color: string) => ({ width: 1, color: token(color) });
const sans = 'var(--font-sans-stack)';
const mono = 'var(--font-mono-stack)';

// The chart series keep the --pp-chart-* variables, which globals.css sets for the dark panels.
const palette = Object.fromEntries(
  Array.from({ length: 10 }, (_, i) => [
    [`chartPaletteFills${i + 1}Color`, `var(--pp-chart-${i + 1})`],
    [`chartPaletteStrokes${i + 1}Color`, `var(--pp-chart-${i + 1})`],
  ]).flat(),
);

export const agStudioBehestTheme = studioTheme.withParams({
  // Shared by Studio's UI, grids and charts. Native controls, scrollbars included, are dark too.
  browserColorScheme: 'dark',
  fontFamily: sans,
  fontSize: 14,
  textColor: token('text'),
  foregroundColor: token('text'),
  subtleTextColor: token('muted'),
  backgroundColor: token('panel'),
  borderColor: token('line'),
  accentColor: token('action'),
  iconColor: token('muted'),
  rowHoverColor: token('raised'),

  // No frame: the canvas is the page's own background. Each widget is inset 12px inside its
  // grid cell, so 20px of padding puts widget edges on the header's 32px gutter.
  studioWrapperBorder: false,
  studioWrapperBorderRadius: 0,
  studioWrapperSpacing: 0,
  studioWrapperBackgroundColor: token('bg'),
  studioCanvasBorder: false,
  studioCanvasBorderRadius: 0,
  studioCanvasShadow: false,
  studioCanvasBackgroundColor: token('bg'),
  studioCanvasPadding: 20,
  // Slightly taller rows than the default 16px make room for card padding.
  studioCanvasRowHeight: 18,
  studioCanvasFontFamily: sans,

  // Widgets are panels: the panel colour, a hairline border, an 8px radius.
  studioWidgetBackgroundColor: token('panel'),
  studioWidgetBorder: line('line'),
  studioWidgetBorderRadius: 8,
  studioWidgetPadding: 10,
  studioWidgetTitleFontFamily: sans,
  studioWidgetTitleFontSize: 15,
  studioWidgetTitleFontWeight: 500,
  studioWidgetTitleTextColor: token('text'),
  studioWidgetSubtitleFontFamily: sans,
  studioWidgetSubtitleFontSize: 13,
  studioWidgetSubtitleTextColor: token('muted'),
  studioWidgetCaptionFontFamily: sans,
  studioWidgetCaptionFontSize: 12,
  studioWidgetCaptionTextColor: token('muted'),
  studioWidgetResizeBorderColor: token('action'),

  // Edit-mode panels read as more of the sidebar.
  studioPanelContainerBackgroundColor: token('panel'),
  studioPanelContainerBorder: line('line'),
  studioPanelContainerBorderRadius: 0,
  studioPanelDividerColor: token('line'),
  studioPanelDividerActiveColor: token('action'),
  studioPanelSectionBorderColor: token('line'),
  studioPanelHeaderFontFamily: sans,
  studioPanelHeaderFontWeight: 500,
  studioPanelChevronButtonHoverBackgroundColor: token('raised'),
  studioPanelChevronButtonHoverColor: token('text'),
  // Selected toggles match the sidebar's selected item: raised fill, action edge.
  studioToggleButtonActiveBackgroundColor: token('raised'),
  studioToggleButtonActiveBorderColor: token('action'),
  studioToggleButtonActiveColor: token('text'),

  // Grid widgets: a raised header, hairline dividers, roomy rows, as on the app's own grids.
  gridBrowserColorScheme: 'dark',
  gridFontFamily: sans,
  gridFontSize: 13,
  gridCellTextColor: token('text'),
  gridHeaderBackgroundColor: token('raised'),
  gridHeaderTextColor: token('muted'),
  gridHeaderFontWeight: 500,
  gridHeaderFontSize: 13,
  gridRowHeight: 40,
  gridRowBorder: line('line'),
  gridHeaderRowBorder: line('line'),
  gridPinnedRowBorder: line('line'),
  gridRowHoverColor: token('raised'),
  gridWrapperBorder: false,

  // Charts: axis labels and numbers in mono, as machine values elsewhere are.
  chartFontFamily: mono,
  chartTextColor: token('text'),
  chartSubtleTextColor: token('muted'),
  chartAxisLineColor: token('line'),
  chartGridLineColor: token('line'),
  ...palette,
});
