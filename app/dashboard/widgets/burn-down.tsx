'use client';

// The budget burn-down: how much of the active mandate's budget is left in the current period.
// The line is the budget the gate would still allow; the amber band above it is money reserved
// by purchases still in flight (being charged or waiting for the buyer), and the drop from the
// top is money already captured. It reads the Budget this period and Budget steps tables
// (../studio/data.ts) and ignores page filters: a budget is a fact about the mandate.

import { useEffect, useRef, useState, type PointerEvent } from 'react';
import type { AgWidgetDataFormat, AgWidgetParams } from 'ag-studio';
import { formatUsd } from '@/lib/domain/money';
import { WIDGET_FIELDS } from '../studio/fields';
import { asDate, findFields, toCents, WidgetMessage } from './shared';

export type BurnDownStyle = {
  /** Draw the even-pace line from the full budget at the start to nothing at the end. */
  showPace?: boolean;
};

export interface BurnDownDef {
  type: 'behest-burn-down';
  dataMapping: Record<string, never>;
  format?: AgWidgetDataFormat<BurnDownStyle>;
}

type Budget = {
  mandateId: string;
  period: string;
  start: Date;
  end: Date | null;
  budgetCents: number;
  spentCents: number;
  inFlightCents: number;
  remainingCents: number;
};
type Step = { at: Date; spentCents: number; inFlightCents: number };
type BurnData = { budget: Budget; steps: Step[]; activeMandates: number };

const F = WIDGET_FIELDS;
const BUDGET_FIELDS = [
  F.budgetMandateId,
  F.budgetPeriod,
  F.budgetPeriodStart,
  F.budgetPeriodEnd,
  F.budgetAmount,
  F.budgetSpent,
  F.budgetInFlight,
  F.budgetRemaining,
] as const;
const STEP_FIELDS = [F.stepMandateId, F.stepAt, F.stepSpent, F.stepInFlight] as const;
const UNFILTERED = { filter: false, crossFilter: 'none' } as const;

async function loadBurnDown({ widgetApi }: AgWidgetParams<BurnDownDef>): Promise<BurnData | null> {
  const f = findFields(widgetApi, [...BUDGET_FIELDS, ...STEP_FIELDS]);
  if (!f) return null;
  const [budgets, steps] = await Promise.all([
    widgetApi.getData(
      { fields: BUDGET_FIELDS.map((id) => f[id]), sort: [{ field: f[F.budgetPeriodStart], direction: 'desc' }] },
      { ...UNFILTERED, queryId: 'budgets' },
    ),
    widgetApi.getData(
      { fields: STEP_FIELDS.map((id) => f[id]), sort: [{ field: f[F.stepAt], direction: 'asc' }] },
      { ...UNFILTERED, queryId: 'steps' },
    ),
  ]);

  const row = budgets.results.rows[0];
  const start = row && asDate(row[f[F.budgetPeriodStart].key]);
  if (!row || !start) return null;
  const budget: Budget = {
    mandateId: String(row[f[F.budgetMandateId].key]),
    period: String(row[f[F.budgetPeriod].key]),
    start,
    end: asDate(row[f[F.budgetPeriodEnd].key]),
    budgetCents: toCents(row[f[F.budgetAmount].key]),
    spentCents: toCents(row[f[F.budgetSpent].key]),
    inFlightCents: toCents(row[f[F.budgetInFlight].key]),
    remainingCents: toCents(row[f[F.budgetRemaining].key]),
  };
  return {
    budget,
    activeMandates: budgets.results.rows.length,
    steps: steps.results.rows
      .filter((s) => String(s[f[F.stepMandateId].key]) === budget.mandateId)
      .flatMap((s) => {
        const at = asDate(s[f[F.stepAt].key]);
        return at ? [{ at, spentCents: toCents(s[f[F.stepSpent].key]), inFlightCents: toCents(s[f[F.stepInFlight].key]) }] : [];
      }),
  };
}

// --- Chart --------------------------------------------------------------------------

const MARGIN = { top: 12, right: 16, bottom: 28, left: 52 };
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

const dayLabel = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', timeZone: 'UTC' });
const dateLabel = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const hourLabel = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC' });
const instantLabel = new Intl.DateTimeFormat('en-GB', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZone: 'UTC',
});

/** Round axis ticks from 0 (or below) to the budget. */
function moneyTicks(minCents: number, maxCents: number): number[] {
  const rough = (maxCents - minCents) / 4;
  const magnitude = 10 ** Math.floor(Math.log10(Math.max(rough, 1)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= rough) ?? rough;
  const ticks: number[] = [];
  for (let value = Math.ceil(minCents / step) * step; value <= maxCents + 0.5; value += step) ticks.push(value);
  return ticks;
}

/** Time ticks that suit the period: hours in a day, days in a week, weeks in a month. */
function timeTicks(from: number, to: number): { at: number; label: string }[] {
  const span = to - from;
  const every = span <= 1.5 * DAY_MS ? 6 * HOUR_MS : span <= 10 * DAY_MS ? DAY_MS : span <= 45 * DAY_MS ? 7 * DAY_MS : span / 4;
  const format = every < DAY_MS ? hourLabel : every === DAY_MS ? dayLabel : dateLabel;
  const ticks = [];
  for (let at = from; at < to + 1; at += every) ticks.push({ at, label: format.format(at) });
  return ticks;
}

/** The running totals at instant `t`: those after the last purchase counted at or before it. */
function totalsAt(steps: Step[], t: number) {
  let current = { spentCents: 0, inFlightCents: 0 };
  for (const step of steps) if (step.at.getTime() <= t) current = step;
  return current;
}

function BurnChart({ data, width, height, showPace }: { data: BurnData; width: number; height: number; showPace: boolean }) {
  const { budget, steps } = data;
  const [hover, setHover] = useState<number | null>(null);
  // The instant the chart was drawn, kept steady across re-renders.
  const [now] = useState(() => Date.now());

  const x0 = budget.start.getTime();
  const lastStep = steps.at(-1)?.at.getTime() ?? x0;
  const open = budget.end === null;
  const x1 = budget.end?.getTime() ?? Math.max(now, lastStep, x0 + DAY_MS);
  const tNow = Math.min(Math.max(now, lastStep, x0), x1);
  const lowest = Math.min(0, budget.remainingCents);

  const innerW = Math.max(width - MARGIN.left - MARGIN.right, 10);
  const innerH = Math.max(height - MARGIN.top - MARGIN.bottom, 10);
  const sx = (t: number) => MARGIN.left + ((t - x0) / (x1 - x0)) * innerW;
  const sy = (cents: number) => MARGIN.top + ((budget.budgetCents - cents) / (budget.budgetCents - lowest || 1)) * innerH;

  // Step functions: the budget left after spend (top of the band) and after reservations (the line).
  const corners: { t: number; afterSpend: number; left: number }[] = [{ t: x0, afterSpend: budget.budgetCents, left: budget.budgetCents }];
  for (const step of steps) {
    const t = step.at.getTime();
    const previous = corners.at(-1)!;
    corners.push({ t, afterSpend: previous.afterSpend, left: previous.left });
    corners.push({ t, afterSpend: budget.budgetCents - step.spentCents, left: budget.budgetCents - step.spentCents - step.inFlightCents });
  }
  const last = corners.at(-1)!;
  corners.push({ t: tNow, afterSpend: last.afterSpend, left: last.left });

  const linePath = corners.map((c, i) => `${i ? 'L' : 'M'}${sx(c.t).toFixed(1)},${sy(c.left).toFixed(1)}`).join('');
  const bandPath = [
    ...corners.map((c, i) => `${i ? 'L' : 'M'}${sx(c.t).toFixed(1)},${sy(c.afterSpend).toFixed(1)}`),
    ...corners.toReversed().map((c) => `L${sx(c.t).toFixed(1)},${sy(c.left).toFixed(1)}`),
    'Z',
  ].join('');
  const hasReservations = corners.some((c) => c.afterSpend !== c.left);

  const onPointerMove = (event: PointerEvent<SVGRectElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const t = x0 + ((event.clientX - box.left) / box.width) * (x1 - x0);
    setHover(Math.min(Math.max(t, x0), tNow));
  };

  const hovered = hover === null ? null : totalsAt(steps, hover);
  const tooltipLeft = hover === null ? 0 : sx(hover);
  const flip = tooltipLeft > width - 200;

  return (
    <div className="relative h-full">
      <svg width={width} height={height} className="block" role="img" aria-label={`Budget burn-down: ${formatUsd(budget.remainingCents)} left of ${formatUsd(budget.budgetCents)}`}>
        {moneyTicks(lowest, budget.budgetCents).map((cents) => (
          <g key={cents}>
            <line x1={MARGIN.left} x2={width - MARGIN.right} y1={sy(cents)} y2={sy(cents)} stroke="var(--pp-gridline)" strokeWidth={1} />
            <text x={MARGIN.left - 8} y={sy(cents)} dy="0.32em" textAnchor="end" className="fill-pp-muted text-[11px] tabular-nums">
              {formatUsd(cents).replace('.00', '')}
            </text>
          </g>
        ))}
        {timeTicks(x0, x1).map(({ at, label }) => (
          <text key={at} x={sx(at)} y={height - 8} textAnchor="middle" className="fill-pp-muted text-[11px]">
            {label}
          </text>
        ))}
        <line x1={MARGIN.left} x2={width - MARGIN.right} y1={sy(0)} y2={sy(0)} stroke="var(--pp-border)" strokeWidth={1} />

        {showPace && !open && (
          <line x1={sx(x0)} y1={sy(budget.budgetCents)} x2={sx(x1)} y2={sy(0)} stroke="var(--pp-muted)" strokeOpacity={0.55} strokeWidth={1} />
        )}

        {hasReservations && (
          <>
            <path d={bandPath} fill="var(--pp-warning)" fillOpacity={0.12} />
            <path
              d={corners.map((c, i) => `${i ? 'L' : 'M'}${sx(c.t).toFixed(1)},${sy(c.afterSpend).toFixed(1)}`).join('')}
              fill="none"
              stroke="var(--pp-warning)"
              strokeWidth={1.5}
              strokeLinejoin="round"
            />
          </>
        )}
        <path d={linePath} fill="none" stroke="var(--pp-blue)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />

        <line x1={sx(tNow)} x2={sx(tNow)} y1={MARGIN.top} y2={sy(lowest)} stroke="var(--pp-border)" strokeWidth={1} />
        <text x={sx(tNow)} y={MARGIN.top} dx={4} dy="0.8em" className="fill-pp-muted text-[11px]">
          Now
        </text>
        <circle cx={sx(tNow)} cy={sy(last.left)} r={4.5} fill="var(--pp-blue)" stroke="var(--pp-surface)" strokeWidth={2} />

        {hover !== null && (
          <line x1={sx(hover)} x2={sx(hover)} y1={MARGIN.top} y2={sy(lowest)} stroke="var(--pp-navy)" strokeOpacity={0.4} strokeWidth={1} />
        )}
        <rect
          x={MARGIN.left}
          y={MARGIN.top}
          width={innerW}
          height={innerH}
          fill="transparent"
          onPointerMove={onPointerMove}
          onPointerLeave={() => setHover(null)}
        />
      </svg>

      {hover !== null && hovered && (
        <div
          className="pointer-events-none absolute top-2 z-10 w-48 rounded-md border border-pp-border bg-white px-3 py-2 text-xs shadow-lg"
          style={flip ? { right: width - tooltipLeft + 12 } : { left: tooltipLeft + 12 }}
        >
          <p className="pb-1 text-pp-muted">{instantLabel.format(hover)} UTC</p>
          <TooltipRow color="var(--pp-blue)" label="Budget left" cents={budget.budgetCents - hovered.spentCents - hovered.inFlightCents} />
          <TooltipRow color="var(--pp-warning)" label="Reserved in flight" cents={hovered.inFlightCents} />
          <TooltipRow label="Spent" cents={hovered.spentCents} />
        </div>
      )}
    </div>
  );
}

function TooltipRow({ color, label, cents }: { color?: string; label: string; cents: number }) {
  return (
    <p className="flex items-center gap-2 py-0.5">
      <span className="h-0.5 w-3 rounded-full" style={{ background: color ?? 'transparent' }} aria-hidden />
      <span className="font-semibold tabular-nums text-pp-ink">{formatUsd(cents)}</span>
      <span className="text-pp-muted">{label}</span>
    </p>
  );
}

// --- Widget -------------------------------------------------------------------------

// Budget period labels from ../studio/data.ts, as an adjective.
const PERIOD_KIND: Record<string, string> = { Day: 'daily', Week: 'weekly', Month: 'monthly', 'One off': 'one-off' };

function periodText(budget: Budget) {
  const until = budget.end ? dateLabel.format(budget.end.getTime() - 1) : null;
  const span = until ? `${dateLabel.format(budget.start)} to ${until}` : `since ${dateLabel.format(budget.start)}`;
  return `of a ${formatUsd(budget.budgetCents)} ${PERIOD_KIND[budget.period] ?? ''} budget, ${span} (UTC)`.replace('  ', ' ');
}

function Legend({ budget, showPace }: { budget: Budget; showPace: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-sm">
      <span className="flex items-center gap-2">
        <span className="h-0.5 w-4 rounded-full bg-pp-blue" aria-hidden />
        <span className="font-semibold tabular-nums">{formatUsd(Math.max(budget.remainingCents, 0))}</span>
        <span className="text-pp-muted">left</span>
      </span>
      <span className="flex items-center gap-2">
        <span className="size-3 rounded-sm border border-pp-warning bg-pp-warning/15" aria-hidden />
        <span className="font-semibold tabular-nums">{formatUsd(budget.inFlightCents)}</span>
        <span className="text-pp-muted">reserved in flight</span>
      </span>
      <span className="flex items-center gap-2">
        <span className="font-semibold tabular-nums">{formatUsd(budget.spentCents)}</span>
        <span className="text-pp-muted">spent</span>
      </span>
      {showPace && budget.end && (
        <span className="flex items-center gap-2 text-pp-muted">
          <span className="h-px w-4 bg-pp-muted" aria-hidden />
          Even pace
        </span>
      )}
    </div>
  );
}

export function BurnDownWidget(params: AgWidgetParams<BurnDownDef>) {
  const [data, setData] = useState<BurnData | null | undefined>(undefined);
  const [chart, setChart] = useState<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const loaded = useRef(false);
  const showPace = params.format?.style?.showPace !== false;

  useEffect(() => {
    let stale = false;
    params.widgetApi.setDisplayState('loading', { prominent: !loaded.current });
    loadBurnDown(params)
      .then((next) => {
        if (stale) return;
        loaded.current = true;
        setData(next);
        params.widgetApi.setDisplayState('displayed');
      })
      .catch(() => {
        if (!stale) params.widgetApi.setDisplayState('noData');
      });
    return () => {
      stale = true;
    };
  }, [params]);

  useEffect(() => {
    if (!chart) return;
    const observer = new ResizeObserver(([entry]) =>
      setSize({ width: Math.floor(entry.contentRect.width), height: Math.floor(entry.contentRect.height) }),
    );
    observer.observe(chart);
    return () => observer.disconnect();
  }, [chart]);

  if (data === undefined) return null;
  if (data === null) {
    return (
      <WidgetMessage title="No active mandate">
        The burn-down shows a buyer&apos;s budget for the current period once they sign a mandate.
      </WidgetMessage>
    );
  }

  const { budget } = data;
  const over = budget.remainingCents < 0;
  return (
    <div className="flex h-full flex-col gap-3 px-2 pb-2 font-paypal text-pp-ink">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
        <div>
          <p className="text-[28px] font-semibold leading-none text-pp-navy">
            {over ? `${formatUsd(-budget.remainingCents)} over` : `${formatUsd(budget.remainingCents)} left`}
          </p>
          <p className="mt-1.5 text-sm text-pp-muted">
            {periodText(budget)}
            {data.activeMandates > 1 && `. Showing the newest of ${data.activeMandates} active mandates.`}
          </p>
        </div>
        <Legend budget={budget} showPace={showPace} />
      </div>
      <div ref={setChart} className="min-h-0 flex-1">
        {size.width > 0 && size.height > 0 && <BurnChart data={data} width={size.width} height={size.height} showPace={showPace} />}
      </div>
    </div>
  );
}
