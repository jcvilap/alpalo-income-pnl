'use client';

import { Fragment, useEffect, useMemo, useState } from 'react';
import { differenceInCalendarDays, parseISO } from 'date-fns';
import {
    type ColumnDef,
    type GroupingState,
    type SortingState,
    type VisibilityState,
    flexRender,
    getCoreRowModel,
    getExpandedRowModel,
    getFilteredRowModel,
    getGroupedRowModel,
    getSortedRowModel,
    useReactTable,
} from '@tanstack/react-table';
import { ChevronDown, ChevronRight, ChevronsUpDown, ChevronUp } from 'lucide-react';
import type { Leg, StrategyId, StrategyTrade, WorkingCloseOrder } from '@/lib/strategy/types';
import { formatCurrency, formatDate } from '@/lib/format';

const GROUP_OPTIONS = [
    { id: 'none', label: 'No grouping' },
    { id: 'underlying', label: 'Underlying' },
    { id: 'status', label: 'Status' },
    { id: 'strategy', label: 'Strategy' },
] as const;

const STRATEGY_LABELS: Record<StrategyId, string> = {
    DOUBLE_CALENDAR: 'Dbl Cal',
    DOUBLE_DIAGONAL: 'Dbl Diag',
    CALENDAR: 'Cal',
    DIAGONAL: 'Diag',
    JADE_LIZARD: 'Jade Liz',
    IRON_CONDOR: 'Iron Cdr',
    BUTTERFLY: 'Btfly',
    STRANGLE: 'Strgl',
    LEAPS: 'LEAPS',
    UNKNOWN: 'Unknown',
};

function toneColor(value: number | undefined | null): string | undefined {
    if (value == null) return undefined;
    if (value > 0) return 'var(--color-success)';
    if (value < 0) return 'var(--color-danger)';
    return undefined;
}

/** Sticky-right styling for pinned columns (% Gain) so they stay visible while scrolling. */
function pinnedStyle(pinnedSide: 'left' | 'right' | false, offset: number, isGrouped: boolean): React.CSSProperties {
    if (!pinnedSide) return {};
    return {
        position: 'sticky',
        [pinnedSide]: offset,
        background: isGrouped ? 'var(--color-surface-hover)' : 'var(--color-surface)',
        zIndex: 1,
    } as React.CSSProperties;
}

/**
 * TanStack returns headers/cells in column-definition order regardless of
 * pinning — sticky positioning only looks right if pinned-right items are
 * actually last in the DOM, so reorder: unpinned/left-pinned first, then
 * right-pinned, each group keeping its relative order.
 */
function orderByPinning<T extends { column: { getIsPinned: () => 'left' | 'right' | false } }>(items: T[]): T[] {
    const left = items.filter((i) => i.column.getIsPinned() === 'left');
    const center = items.filter((i) => !i.column.getIsPinned());
    const right = items.filter((i) => i.column.getIsPinned() === 'right');
    return [...left, ...center, ...right];
}

const NON_NUMERIC_COLUMNS = new Set(['underlying', 'status', 'strategy', 'openedAt', 'closedAt', 'strikes', 'expirations', 'range']);

/** True for trades that can show a per-leg breakdown row: strangles, calendars, and diagonals (open or closed). */
function hasLegDetail(trade: StrategyTrade): boolean {
    return trade.strategy === 'STRANGLE' || trade.strategy === 'CALENDAR' || trade.strategy === 'DIAGONAL';
}

/**
 * Minimal stand-in for TanStack's CellContext so a synthetic per-leg row can
 * be rendered through the real column cell renderers without spinning up a
 * second `useReactTable` instance. Every column def here only reads
 * `getValue()` and `row.original` — nothing else of CellContext is needed.
 */
function fakeCellContext(columnId: string, trade: StrategyTrade) {
    return {
        getValue: () => (trade as unknown as Record<string, unknown>)[columnId],
        row: { original: trade },
    } as never;
}

/**
 * The two strikes that bound the "at the money" zone for the range gauge.
 *
 * STRANGLE/DOUBLE_CALENDAR always have exactly 2 distinct strikes (one per
 * side) — those are the bounds, no ambiguity. BUTTERFLY has 3 (two outer
 * wings + one middle body) — the body is excluded from the range since it's
 * never a boundary of the position's breakeven zone; the two wing strikes
 * (min/max) are the bounds regardless of symmetric or broken-wing shape.
 *
 * IRON_CONDOR and DOUBLE_DIAGONAL/JADE_LIZARD both have 4 distinct strikes,
 * but they need different logic to find the inner "body" pair:
 *
 * - IRON_CONDOR's 4 legs all share one expiration (see IRON_CONDOR_RULE), so
 *   "nearest expiration per side" can't disambiguate body from wing there —
 *   every leg ties, and picking one is effectively arbitrary leg-array order.
 *   IRON_CONDOR_RULE already guarantees classic condor strike order (put
 *   wing < put body < call body < call wing), so the body pair is just the
 *   middle two strikes once sorted — no need to look at right/expiration.
 * - DOUBLE_DIAGONAL/JADE_LIZARD legs span two expirations, and the shape
 *   rules only require 4 distinct strikes — they never guarantee wing <
 *   body < body < wing sorted order, so a sorted-index pick (e.g. a reverse
 *   diagonal) can silently grab a wing instead of a body. The body/near leg
 *   is unambiguous a different way, though: it's the leg on each side
 *   (call/put) with the *nearer* expiration — the wing is always the
 *   farther-dated leg by construction of a time-spread (see
 *   `detectTimeSpread` in rules.ts). Derive bounds from that instead.
 *
 * Uses every leg, not just still-open ones: a strangle with one leg closed
 * early (see `closeStrangleLeg` in pairing.ts) still has a meaningful
 * original range to show against the live price — only a leg's own P&L
 * stops updating once it's closed, not the strategy's strike shape. Returns
 * null when there aren't at least 2 distinct strikes at all.
 */
function innerStrikes(legs: Leg[], strategy: StrategyId): [number, number] | null {
    const strikes = Array.from(new Set(legs.map(l => l.strike))).sort((a, b) => a - b);
    if (strikes.length < 2) return null;
    if (strikes.length === 2) return [strikes[0], strikes[1]];

    // Butterfly: 3 strikes, single expiration/right — the middle strike is
    // the body, not a bound. Outer two strikes (wings) are the range.
    if (strikes.length === 3) return [strikes[0], strikes[2]];

    // Iron condor: 4 strikes, single expiration — body is the middle two
    // once sorted (strike position alone decides body vs wing here).
    if (strategy === 'IRON_CONDOR' && strikes.length === 4) return [strikes[1], strikes[2]];

    // Double diagonal / jade lizard: 4 strikes across two expirations — pick
    // each side's nearest-expiration leg as its bound.
    const nearestBySide = (right: 'CALL' | 'PUT'): number | null => {
        const sideLegs = legs.filter(l => l.right === right);
        if (sideLegs.length === 0) return null;
        return sideLegs.reduce((nearest, l) => (l.expiration < nearest.expiration ? l : nearest)).strike;
    };
    const putStrike = nearestBySide('PUT');
    const callStrike = nearestBySide('CALL');
    if (putStrike == null || callStrike == null) return null;
    return putStrike <= callStrike ? [putStrike, callStrike] : [callStrike, putStrike];
}

/**
 * Format an ITM% for the range tooltip with just enough decimal places to
 * show its true magnitude — a razor-thin breach (e.g. 0.001%) would round to
 * "0%" at fixed precision and read as "not breached", so this grows the
 * precision until a nonzero value is visible (capped at 4 decimals), then
 * trims trailing zeros. A clean breach still prints as a bare "1%"/"12%".
 */
function formatItmPct(pct: number): string {
    if (pct === 0) return '0';
    for (let digits = 0; digits <= 4; digits++) {
        const fixed = pct.toFixed(digits);
        if (parseFloat(fixed) !== 0) return String(parseFloat(fixed));
    }
    return pct.toFixed(4);
}

/** One label/value line in the shared cell tooltip. An empty label continues the previous row's label visually (see Legs rows). */
interface CellTooltipRow {
    label: string;
    value: string;
    /** Overrides the default value color, e.g. to tone a P&L figure green/red. */
    color?: string;
}

/** Data the shared singleton tooltip needs to render for whichever cell is currently hovered/tapped. */
interface CellTooltipData {
    rows: CellTooltipRow[];
    /** Viewport-relative anchor (the hovered/tapped cell's bounding rect) to position the fixed tooltip against. */
    anchor: { top: number; left: number; width: number };
    width?: number;
}

/**
 * Tiny module-level pub/sub so any cell (range gauge, working-close-order,
 * ...) can publish "I'm hovered/tapped" without each one owning React state
 * — with 30+ cells on screen, per-cell state would mean 30+ components
 * re-rendering on mount just to wire up handlers. Only the single
 * `CellTooltipHost` subscriber re-renders, and only while something is
 * actually active. Shared across cell types so at most one tooltip is ever
 * open at a time — publishing from a new cell simply replaces whatever was
 * showing.
 */
let cellTooltipListener: ((data: CellTooltipData | null) => void) | null = null;
function publishCellTooltip(data: CellTooltipData | null) {
    cellTooltipListener?.(data);
}

/**
 * Single shared tooltip node for every tooltip-bearing cell in the table —
 * mounted once (in `TradesTable`), positioned via `position: fixed` against
 * the hovered/tapped cell's bounding rect so it always escapes the table's
 * `overflow-x: auto` scroll clipping regardless of which row it's in.
 * Renders null (no DOM) when nothing is active. On touch devices a tap on
 * any trigger opens it; tapping anywhere else closes it.
 */
function CellTooltipHost() {
    const [data, setData] = useState<CellTooltipData | null>(null);

    useEffect(() => {
        cellTooltipListener = setData;
        return () => {
            cellTooltipListener = null;
        };
    }, []);

    useEffect(() => {
        if (!data) return;
        // A click on a *different* trigger (or the same one again) bubbles past
        // this same click event all the way to `document` — React's synthetic
        // stopPropagation only stops other React handlers, not a raw
        // `addEventListener` listener further up the real DOM tree — so
        // without the `[data-cell-tooltip]` check below, that click's own
        // `publishCellTooltip` call (which runs first, lower in the tree, via
        // the trigger's own onClick) would immediately be undone by this
        // handler closing it right back out in the same event. Only close
        // when the click landed outside any trigger entirely. `click` (not
        // `touchstart`) is used so this also closes on mouse clicks (e.g. a
        // tooltip left open on desktop by a prior tap/click elsewhere).
        const close = (e: Event) => {
            const target = e.target as Element | null;
            if (target?.closest('[data-cell-tooltip]')) return;
            setData(null);
        };
        document.addEventListener('click', close);
        document.addEventListener('scroll', close, true);
        return () => {
            document.removeEventListener('click', close);
            document.removeEventListener('scroll', close, true);
        };
    }, [data]);

    if (!data) return null;
    const { rows, anchor, width = 190 } = data;

    return (
        <div
            role="tooltip"
            className="rounded-lg px-3 py-2 text-xs shadow-lg bg-surface-elevated"
            style={{
                position: 'fixed',
                zIndex: 50,
                top: anchor.top - 6,
                left: anchor.left + anchor.width / 2,
                transform: 'translate(-50%, -100%)',
                border: '1px solid var(--color-border)',
                color: 'var(--color-text-primary)',
                width,
                pointerEvents: 'none',
            }}
        >
            <div className="flex flex-col gap-0.5">
                {rows.map((r, i) => (
                    <div key={`${r.label}-${i}`} className="flex items-center justify-between gap-3 tabular-nums whitespace-nowrap leading-tight">
                        <span style={{ color: 'var(--color-text-tertiary)' }}>{r.label}</span>
                        <span className="font-medium" style={{ color: r.color }}>{r.value}</span>
                    </div>
                ))}
            </div>
        </div>
    );
}

/** Shared hover/tap wiring for any cell that publishes to `CellTooltipHost`. Attach the returned handlers to the trigger element, and spread `data-cell-tooltip=""` on it too. */
function useCellTooltip(buildRows: () => CellTooltipRow[], width?: number) {
    const publish = (rect: DOMRect) => {
        publishCellTooltip({ rows: buildRows(), anchor: { top: rect.top, left: rect.left, width: rect.width }, width });
    };
    return {
        onMouseEnter: (e: React.MouseEvent<HTMLElement>) => publish(e.currentTarget.getBoundingClientRect()),
        onMouseLeave: () => publishCellTooltip(null),
        // Touch devices have no hover state — a tap opens the tooltip instead.
        // `onClick` (not `onTouchStart`) is used because it's what every mobile
        // browser reliably synthesizes from a tap — `touchstart` alone can be
        // swallowed by the browser's own scroll/zoom gesture disambiguation on
        // an element with no other native interactivity. `CellTooltipHost`
        // closes it on a click outside any trigger, or on scroll (see the
        // `data-cell-tooltip` check there — a click on this same trigger, or a
        // different one, must not immediately close what it just opened).
        onClick: (e: React.MouseEvent<HTMLElement>) => {
            e.stopPropagation();
            publish(e.currentTarget.getBoundingClientRect());
        },
    };
}

/**
 * Gradient gauge: shows the underlying price's position relative to the two
 * inner strikes bounding this strategy. Filled track between the strikes
 * gradients green (safe, centered) to red (near/at a strike); a dot marks
 * the live price. Padding on either side of the strikes gives the dot room
 * to show outside the band when price has moved beyond a strike. Hovering
 * publishes to the shared `CellTooltipHost` (see above) rather than
 * rendering its own tooltip, so only one tooltip DOM node ever exists.
 */
function RangeGauge({
    low,
    high,
    price,
    width = 110,
    height = 16,
    expirations,
}: {
    low: number;
    high: number;
    price: number;
    width?: number;
    height?: number;
    expirations?: { date: string; dte: number | undefined }[];
}) {
    const span = high - low;
    const pad = span > 0 ? span * 0.18 : Math.max(1, low * 0.05);
    const trackLow = low - pad;
    const trackHigh = high + pad;
    const trackSpan = trackHigh - trackLow || 1;

    const bandLow = (low - trackLow) / trackSpan;
    const bandHigh = (high - trackLow) / trackSpan;
    const pricePos = Math.max(0, Math.min(1, (price - trackLow) / trackSpan));

    const breached = price <= low || price >= high;
    const distToEdge = span > 0 ? Math.min(price - low, high - price) / span : 0;
    const zone: 'safe' | 'warn' | 'danger' = breached ? 'danger' : distToEdge < 0.15 ? 'warn' : 'safe';
    const dotColor = zone === 'danger' ? 'var(--color-danger)' : zone === 'warn' ? '#d97706' : 'var(--color-success)';

    const trackTop = height / 2 - 3;
    const tickTop = height / 2 - 6;
    const dotSize = Math.max(9, height * 0.56);

    const buildRows = (): CellTooltipRow[] => {
        const breachedLow = price <= low;
        const breachedHigh = price >= high;
        const itmPct = breachedLow
            ? ((low - price) / low) * 100
            : breachedHigh
                ? ((price - high) / high) * 100
                : null;

        const rows: CellTooltipRow[] = [
            { label: 'Underlying', value: price.toFixed(2) },
            { label: 'Lower Strike', value: String(low) },
            { label: 'Upper Strike', value: String(high) },
        ];
        if (itmPct != null) rows.push({ label: 'ITM %', value: `${formatItmPct(itmPct)}%` });
        expirations?.forEach((e) => {
            rows.push({ label: 'Expiration', value: `${formatDate(e.date)}${e.dte != null ? ` (${e.dte}d)` : ''}` });
        });
        return rows;
    };
    const tooltip = useCellTooltip(buildRows, 190);

    return (
        <span
            data-cell-tooltip=""
            {...tooltip}
            style={{ position: 'relative', display: 'inline-block', width, height, verticalAlign: 'middle', touchAction: 'manipulation' }}
        >
            <span
                style={{
                    position: 'absolute', left: 0, right: 0, top: trackTop, height: 6, borderRadius: 3,
                    background: 'var(--color-border-light)',
                }}
            />
            <span
                style={{
                    position: 'absolute', top: trackTop, height: 6, borderRadius: 3,
                    left: `${bandLow * 100}%`,
                    width: `${Math.max(0, bandHigh - bandLow) * 100}%`,
                    opacity: 0.55,
                    background: 'linear-gradient(90deg, var(--color-danger), #d97706 22%, var(--color-success) 45%, var(--color-success) 55%, #d97706 78%, var(--color-danger))',
                }}
            />
            <span style={{ position: 'absolute', left: `${bandLow * 100}%`, top: tickTop, width: 1.5, height: 12, background: 'var(--color-text-tertiary)' }} />
            <span style={{ position: 'absolute', left: `${bandHigh * 100}%`, top: tickTop, width: 1.5, height: 12, background: 'var(--color-text-tertiary)', transform: 'translateX(-1.5px)' }} />
            <span
                style={{
                    position: 'absolute', left: `${pricePos * 100}%`, top: trackTop + 3 - dotSize / 2, width: dotSize, height: dotSize, marginLeft: -dotSize / 2,
                    borderRadius: '50%', background: dotColor, border: '2px solid var(--color-surface)',
                }}
            />
        </span>
    );
}

const LEG_INSTRUCTION_LABELS: Record<string, string> = {
    BUY_TO_CLOSE: 'BTC',
    SELL_TO_CLOSE: 'STC',
};

/** "11/20 560P" style short leg label for the tooltip. */
function legShortLabel(leg: WorkingCloseOrder['legs'][number]): string {
    const [, month, day] = leg.expiration.split('-');
    return `${leg.underlying} ${month}/${day} ${leg.strike}${leg.right === 'CALL' ? 'C' : 'P'}`;
}

/** Shorter display forms of Schwab's order-type/duration enums, for the close-order tooltip. */
const ORDER_TYPE_LABELS: Record<string, string> = {
    NET_CREDIT: 'CREDIT',
    NET_DEBIT: 'DEBIT',
};
const ORDER_DURATION_LABELS: Record<string, string> = {
    GOOD_TILL_CANCEL: 'GTC',
};

/** The "close order at 25% ($215)" cell shown in the Close column for an open trade with a matched working close order. */
function CloseOrderCell({ order }: { order: WorkingCloseOrder }) {
    const color = order.estPnl > 0 ? 'var(--color-success)' : order.estPnl < 0 ? 'var(--color-danger)' : undefined;

    // Schwab's `price` on a multi-leg order is an unsigned magnitude for the
    // whole combo — direction comes from `orderType` (NET_CREDIT/NET_DEBIT),
    // never the sign of `price` itself.
    const direction = order.orderType === 'NET_CREDIT' ? 'credit' : order.orderType === 'NET_DEBIT' ? 'debit' : '';
    const buildRows = (): CellTooltipRow[] => {
        const orderTypeLabel = order.orderType ? (ORDER_TYPE_LABELS[order.orderType] ?? order.orderType) : 'Limit';
        const durationLabel = order.duration ? (ORDER_DURATION_LABELS[order.duration] ?? order.duration) : undefined;
        const rows: CellTooltipRow[] = [
            { label: 'Type', value: `${orderTypeLabel}${durationLabel ? ` (${durationLabel})` : ''}` },
            { label: 'Limit Price', value: order.price != null ? `${formatCurrency(order.price)}${direction ? ` ${direction}` : ''}` : '—' },
            { label: 'Entered', value: order.enteredTime ? new Date(order.enteredTime).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—' },
        ];
        order.legs.forEach((leg, i) => {
            rows.push({ label: i === 0 ? 'Legs' : '', value: `${LEG_INSTRUCTION_LABELS[leg.instruction] ?? leg.instruction} ${legShortLabel(leg)}` });
        });
        rows.push({ label: 'Est. P&L', value: `${formatCurrency(order.estPnl, { sign: true })} (${order.estPctGain >= 0 ? '+' : ''}${order.estPctGain.toFixed(0)}%)`, color });
        return rows;
    };
    const tooltip = useCellTooltip(buildRows, 220);

    return (
        <span
            data-cell-tooltip=""
            {...tooltip}
            className="tabular-nums cursor-default"
            style={{ touchAction: 'manipulation' }}
        >
            <span className="text-xs">closing @</span>
            <span className="text-xs" style={{ color }}>
                {order.estPctGain.toFixed(0)}% ({formatCurrency(order.estPnl, { decimals: 0 })})
            </span>
        </span>
    );
}

/** Remaining calendar days to `expiration`, measured from now, floored at 0. */
function remainingDte(expiration: string): number | undefined {
    try {
        return Math.max(0, differenceInCalendarDays(parseISO(expiration), new Date()));
    } catch {
        return undefined;
    }
}

/**
 * Build one synthetic per-leg "trade" per leg of a still-open strangle, so
 * the detail row can render through the exact same column defs as the parent
 * row instead of duplicating cell markup. Each leg's own strike/expiration/
 * openNet/pnl/pctGain (stamped server-side — see pairing.ts and service.ts's
 * `applyUnrealizedPnl`) stand in for the parent trade's aggregate fields;
 * everything else (status, dates, strategy) is inherited from the parent.
 */
function legDetailRows(trade: StrategyTrade): StrategyTrade[] {
    return trade.legs.map((leg, i) => ({
        ...trade,
        id: `${trade.id}-leg-${i}`,
        status: leg.openClose === 'CLOSE' ? 'closed' : 'open',
        // This leg's own close date, not the parent trade's — a leg closed
        // early has its own closedAt well before the position as a whole is
        // done (see `Leg.closedAt`); a still-open leg has none.
        closedAt: leg.closedAt,
        legs: [leg],
        strikes: [leg.strike],
        expirations: [leg.expiration],
        expirationDtes: [trade.expirationDtes[trade.expirations.indexOf(leg.expiration)] ?? 0],
        dte: leg.openClose === 'CLOSE' ? undefined : remainingDte(leg.expiration),
        contracts: Math.abs(leg.quantity),
        openNet: leg.openNet ?? 0,
        closeNet: leg.closeNet,
        pnl: leg.pnl,
        pnlIsEstimate: leg.pnlIsEstimate,
        pctGain: leg.pctGain,
    }));
}

const columns: ColumnDef<StrategyTrade>[] = [
    {
        accessorKey: 'underlying',
        header: 'Symbol',
        cell: (ctx) => <span className="font-medium">{ctx.getValue<string>() || '—'}</span>,
        aggregatedCell: () => null,
    },
    {
        accessorKey: 'strategy',
        header: 'Strategy',
        cell: (ctx) => STRATEGY_LABELS[ctx.getValue<StrategyId>()] ?? ctx.getValue<string>(),
        aggregatedCell: () => null,
    },
    {
        accessorKey: 'status',
        header: 'Status',
        cell: (ctx) => {
            const status = ctx.getValue<string>();
            return (
                <span
                    className="inline-block px-2 py-0.5 rounded-full text-xs font-medium"
                    style={{ background: 'var(--color-surface-hover)', color: 'var(--color-text-secondary)' }}
                >
                    {status}
                </span>
            );
        },
        aggregatedCell: () => null,
        // 'open' sorts before 'closed' regardless of asc/desc direction, so the
        // default sort surfaces open trades first.
        sortingFn: (rowA, rowB) => {
            const rank = (s: string) => (s === 'open' ? 0 : 1);
            return rank(rowA.original.status) - rank(rowB.original.status);
        },
    },
    {
        accessorKey: 'openedAt',
        header: 'Opened',
        cell: (ctx) => <span className="tabular-nums">{formatDate(ctx.getValue<string>())}</span>,
        sortingFn: 'alphanumeric',
    },
    {
        accessorKey: 'closedAt',
        header: 'Closed',
        cell: (ctx) => <span className="tabular-nums">{formatDate(ctx.getValue<string | undefined>())}</span>,
        sortingFn: 'alphanumeric',
    },
    {
        accessorKey: 'daysOpen',
        header: 'Days',
        cell: (ctx) => <span className="tabular-nums">{ctx.getValue<number | undefined>() ?? '—'}</span>,
        aggregationFn: 'mean',
        aggregatedCell: (ctx) => (
            <span className="tabular-nums text-xs" style={{ color: 'var(--color-text-tertiary)' }}>
                avg {(ctx.getValue<number>() ?? 0).toFixed(0)}
            </span>
        ),
    },
    {
        accessorKey: 'strikes',
        header: 'Strikes',
        cell: (ctx) => {
            const strikes = ctx.getValue<number[]>();
            const legs = ctx.row.original.legs;
            return (
                <span className="tabular-nums inline-flex items-center gap-1 flex-wrap justify-end">
                    {strikes.map((strike, i) => {
                        const itm = legs.some(l => l.strike === strike && l.itm);
                        return (
                            <span key={strike} className="inline-flex items-center gap-1">
                                {i > 0 && <span>/</span>}
                                <span>{strike}</span>
                                {itm && (
                                    <span
                                        title="In the money"
                                        className="text-[10px] font-semibold px-1 rounded"
                                        style={{ background: 'var(--color-danger-bg)', color: 'var(--color-danger-text)' }}
                                    >
                                        ITM
                                    </span>
                                )}
                            </span>
                        );
                    })}
                </span>
            );
        },
        enableSorting: false,
    },
    {
        accessorKey: 'expirations',
        header: 'Expirations',
        cell: (ctx) => {
            const expirations = ctx.getValue<string[]>();
            const dtes = ctx.row.original.expirationDtes;
            return (
                <span className="tabular-nums text-xs">
                    {expirations.map((e, i) => `${formatDate(e)} (${dtes[i] ?? '—'}d)`).join(' / ')}
                </span>
            );
        },
        enableSorting: false,
    },
    {
        accessorKey: 'dte',
        header: 'DTE Left',
        cell: (ctx) => <span className="tabular-nums">{ctx.getValue<number | undefined>() ?? '—'}</span>,
    },
    {
        accessorKey: 'contracts',
        header: 'Contracts',
        cell: (ctx) => <span className="tabular-nums">{ctx.getValue<number | undefined>() ?? '—'}</span>,
        aggregationFn: 'sum',
        aggregatedCell: (ctx) => <span className="tabular-nums font-semibold">{ctx.getValue<number>()}</span>,
    },
    {
        accessorKey: 'openNet',
        header: 'Open',
        cell: (ctx) => <span className="tabular-nums">{formatCurrency(ctx.getValue<number>(), { sign: true })}</span>,
        aggregationFn: 'sum',
        aggregatedCell: (ctx) => (
            <span className="tabular-nums font-semibold">{formatCurrency(ctx.getValue<number>(), { sign: true })}</span>
        ),
    },
    {
        accessorKey: 'closeNet',
        header: 'Close',
        cell: (ctx) => {
            const trade = ctx.row.original;
            if (trade.status === 'open' && trade.workingCloseOrder) {
                return <CloseOrderCell order={trade.workingCloseOrder} />;
            }
            const v = ctx.getValue<number | undefined>();
            return <span className="tabular-nums">{v == null ? '—' : formatCurrency(v, { sign: true })}</span>;
        },
        aggregationFn: 'sum',
        aggregatedCell: (ctx) => (
            <span className="tabular-nums font-semibold">{formatCurrency(ctx.getValue<number>(), { sign: true })}</span>
        ),
    },
    {
        id: 'range',
        header: 'Range',
        cell: (ctx) => {
            const trade = ctx.row.original;
            // A closed trade's underlying price (if any) is a frozen
            // snapshot from whenever it was last live, not a current
            // reading — showing a gauge against it would misrepresent it
            // as still meaningful to compare against today's market.
            if (trade.status === 'closed') return <span style={{ color: 'var(--color-text-tertiary)' }}>—</span>;
            // A single calendar/diagonal's strikes mark a time spread, not a
            // price range to stay between — no gauge to show.
            if (trade.strategy === 'CALENDAR' || trade.strategy === 'DIAGONAL') {
                return <span style={{ color: 'var(--color-text-tertiary)' }}>—</span>;
            }
            const bounds = innerStrikes(trade.legs, trade.strategy);
            if (!bounds || trade.underlyingPrice == null) return <span style={{ color: 'var(--color-text-tertiary)' }}>—</span>;
            const [low, high] = bounds;
            return <RangeGauge low={low} high={high} price={trade.underlyingPrice} />;
        },
        enableSorting: false,
    },
    {
        accessorKey: 'pnl',
        header: 'P&L',
        cell: (ctx) => {
            const v = ctx.getValue<number | undefined>();
            const isEstimate = ctx.row.original.pnlIsEstimate;
            return (
                <span className="tabular-nums font-semibold" style={{ color: toneColor(v) }}>
                    {v == null ? '—' : formatCurrency(v, { sign: true })}
                    {isEstimate ? <span title="Live mark-to-market estimate">*</span> : null}
                </span>
            );
        },
        aggregationFn: 'sum',
        aggregatedCell: (ctx) => {
            const v = ctx.getValue<number>();
            return (
                <span className="tabular-nums font-semibold" style={{ color: toneColor(v) }}>
                    {formatCurrency(v, { sign: true })}
                </span>
            );
        },
    },
    {
        accessorKey: 'pctGain',
        header: '% Gain',
        cell: (ctx) => {
            const v = ctx.getValue<number | undefined>();
            return (
                <span className="tabular-nums font-semibold" style={{ color: toneColor(v) }}>
                    {v == null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(1)}%`}
                </span>
            );
        },
        // Averaging a % across trades of different sizes is misleading — leave
        // the aggregated (grouped) row blank for this column instead.
        aggregatedCell: () => null,
        enableGrouping: false,
    },
];

/**
 * One trade as a mobile card. Leads with the range gauge full-width and
 * large — per the user's stated usage, that's the thing checked most often
 * when scanning open positions on a phone — with symbol/strategy/P&L as
 * secondary at-a-glance info and the rest tucked into a label/value grid.
 */
function TradeCard({ trade }: { trade: StrategyTrade }) {
    const [expanded, setExpanded] = useState(false);
    const showLegToggle = hasLegDetail(trade);
    const bounds = trade.status === 'open' && trade.strategy !== 'CALENDAR' && trade.strategy !== 'DIAGONAL'
        ? innerStrikes(trade.legs, trade.strategy)
        : null;
    const showGauge = bounds != null && trade.underlyingPrice != null;

    return (
        <div
            className="rounded-xl p-3 flex flex-col gap-2 bg-surface transition-theme"
            style={{ border: '1px solid var(--color-border)' }}
        >
            <div className="flex items-start justify-between gap-2">
                <div className="flex flex-col min-w-0 gap-0.5">
                    <span className="flex items-center gap-1.5 flex-wrap">
                        <span className="font-semibold text-base" style={{ color: 'var(--color-text-primary)' }}>
                            {trade.underlying || '—'}
                        </span>
                        <span
                            className="inline-block px-2 py-0.5 rounded-full text-xs font-medium"
                            style={{ background: 'var(--color-surface-hover)', color: 'var(--color-text-secondary)' }}
                        >
                            {trade.status}
                        </span>
                        {trade.status === 'open' && (
                            <span className="text-xs" style={{ color: 'var(--color-text-tertiary)' }}>
                                {trade.dte ?? '—'}d left
                            </span>
                        )}
                        {trade.status === 'closed' && (
                            <span className="text-xs tabular-nums" style={{ color: 'var(--color-text-tertiary)' }}>
                                on {formatDate(trade.closedAt)}
                            </span>
                        )}
                    </span>
                    <span className="text-xs tabular-nums" style={{ color: 'var(--color-text-secondary)' }}>
                        {trade.contracts != null ? `${trade.contracts} x ` : ''}
                        {STRATEGY_LABELS[trade.strategy] ?? trade.strategy}
                        {' '}
                        {trade.strikes.join(' / ')}
                    </span>
                </div>
                <div className="flex flex-col items-end shrink-0">
                    <span className="tabular-nums font-semibold text-base" style={{ color: toneColor(trade.pnl) }}>
                        {trade.pnl == null ? '—' : formatCurrency(trade.pnl, { sign: true })}
                        {trade.pnlIsEstimate ? <span title="Live mark-to-market estimate">*</span> : null}
                    </span>
                    <span className="tabular-nums text-xs" style={{ color: toneColor(trade.pctGain) }}>
                        {trade.pctGain == null ? '—' : `${trade.pctGain > 0 ? '+' : ''}${trade.pctGain.toFixed(1)}%`}
                    </span>
                </div>
            </div>

            <div className="flex items-center gap-2 py-1">
                <span className="text-xs tabular-nums shrink-0" style={{ color: 'var(--color-text-tertiary)' }}>
                    {trade.daysOpen ?? '—'}d opened
                </span>
                {showGauge && bounds && (
                    <div className="flex-1 flex items-center justify-end">
                        <RangeGauge
                            low={bounds[0]}
                            high={bounds[1]}
                            price={trade.underlyingPrice!}
                            width={190}
                            height={22}
                            expirations={trade.expirations.map((e, i) => ({ date: e, dte: trade.expirationDtes[i] }))}
                        />
                    </div>
                )}
            </div>

            {trade.status === 'open' && trade.workingCloseOrder && (
                <CloseOrderCell order={trade.workingCloseOrder} />
            )}

            {showLegToggle && (
                <button
                    onClick={() => setExpanded((v) => !v)}
                    className="inline-flex items-center gap-1 text-xs font-medium self-start"
                    style={{ color: 'var(--color-primary)' }}
                >
                    {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    {expanded ? 'Hide legs' : 'Show legs'}
                </button>
            )}

            {expanded &&
                legDetailRows(trade).map((leg, i) => (
                    <div
                        key={i}
                        className="rounded-lg p-2 flex items-center justify-between gap-2 text-xs"
                        style={{ background: 'var(--color-surface-hover)' }}
                    >
                        <span className="flex items-center gap-1.5">
                            <span className="font-medium">{leg.strikes[0]}</span>
                            <span className="uppercase tracking-wide" style={{ color: 'var(--color-text-tertiary)' }}>
                                {leg.legs[0].right}
                            </span>
                            <span style={{ color: 'var(--color-text-tertiary)' }}>{formatDate(leg.expirations[0])}</span>
                        </span>
                        <span className="tabular-nums font-medium" style={{ color: toneColor(leg.pnl) }}>
                            {leg.pnl == null ? '—' : formatCurrency(leg.pnl, { sign: true })}
                        </span>
                    </div>
                ))}
        </div>
    );
}

/** Mobile card list — same data/filters as the table, laid out for narrow screens. */
function TradeCardList({ trades }: { trades: StrategyTrade[] }) {
    return (
        <div className="flex flex-col gap-2">
            {trades.map((t) => (
                <TradeCard key={t.id} trade={t} />
            ))}
        </div>
    );
}

/** Trades table — sortable, filterable, groupable via TanStack Table. */
export function TradesTable({ trades, statusFilter }: { trades: StrategyTrade[]; statusFilter: 'all' | 'open' | 'closed' }) {
    const [sorting, setSorting] = useState<SortingState>([
        { id: 'status', desc: false },
        { id: 'openedAt', desc: true },
    ]);
    const [grouping, setGrouping] = useState<GroupingState>([]);
    const [globalFilter, setGlobalFilter] = useState('');
    const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({});
    const [expandedLegRows, setExpandedLegRows] = useState<Set<string>>(new Set());

    const toggleLegRow = (id: string) => {
        setExpandedLegRows((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    const filtered = useMemo(
        () => (statusFilter === 'all' ? trades : trades.filter((t) => t.status === statusFilter)),
        [trades, statusFilter],
    );

    const table = useReactTable({
        data: filtered,
        columns,
        state: { sorting, grouping, globalFilter, columnVisibility, columnPinning: { right: ['pctGain'] } },
        onSortingChange: setSorting,
        onGroupingChange: setGrouping,
        onGlobalFilterChange: setGlobalFilter,
        onColumnVisibilityChange: setColumnVisibility,
        getCoreRowModel: getCoreRowModel(),
        getSortedRowModel: getSortedRowModel(),
        getFilteredRowModel: getFilteredRowModel(),
        getGroupedRowModel: getGroupedRowModel(),
        getExpandedRowModel: getExpandedRowModel(),
        globalFilterFn: (row, _columnId, value) => {
            const needle = String(value).toLowerCase();
            return (
                row.original.underlying.toLowerCase().includes(needle) ||
                row.original.strikes.join(' ').includes(needle) ||
                row.original.expirations.join(' ').includes(needle)
            );
        },
        autoResetExpanded: false,
    });

    return (
        <div className="flex flex-col gap-3">
            <CellTooltipHost />
            {/* Toolbar */}
            <div className="hidden sm:flex flex-wrap items-center gap-3">
                <input
                    type="text"
                    placeholder="Filter by underlying, strike, expiration…"
                    value={globalFilter}
                    onChange={(e) => setGlobalFilter(e.target.value)}
                    className="hidden sm:block rounded-lg px-3 py-2 text-base sm:text-sm bg-surface flex-1 min-w-[160px] sm:min-w-[220px]"
                    style={{ border: '1px solid var(--color-border)', color: 'var(--color-text-primary)' }}
                />
                <select
                    value={grouping[0] ?? 'none'}
                    onChange={(e) => setGrouping(e.target.value === 'none' ? [] : [e.target.value])}
                    className="hidden sm:block rounded-lg px-3 py-2 text-sm bg-surface"
                    style={{ border: '1px solid var(--color-border)', color: 'var(--color-text-primary)' }}
                >
                    {GROUP_OPTIONS.map((g) => (
                        <option key={g.id} value={g.id}>
                            Group by: {g.label}
                        </option>
                    ))}
                </select>
                <span className="hidden sm:block text-xs ml-auto" style={{ color: 'var(--color-text-tertiary)' }}>
                    {filtered.length} of {trades.length} trades
                </span>
            </div>

            {filtered.length === 0 ? (
                <div
                    className="rounded-xl p-8 text-center text-sm bg-surface"
                    style={{ border: '1px solid var(--color-border)', color: 'var(--color-text-tertiary)' }}
                >
                    No trades match the current filters.
                </div>
            ) : (
                <>
                {/* Mobile: card list, no grouping — the range gauge and key figures take priority over the dense table. */}
                <div className="sm:hidden">
                    <TradeCardList trades={table.getSortedRowModel().rows.map((r) => r.original)} />
                </div>
                <div
                    className="hidden sm:block rounded-xl bg-surface transition-theme overflow-x-auto"
                    style={{ border: '1px solid var(--color-border)' }}
                >
                    <table className="w-full min-w-max text-sm border-collapse">
                        <thead>
                            {table.getHeaderGroups().map((headerGroup) => (
                                <tr key={headerGroup.id} style={{ color: 'var(--color-text-secondary)' }} className="text-left">
                                    {orderByPinning(headerGroup.headers).map((header) => {
                                        const sortState = header.column.getIsSorted();
                                        const numeric = !NON_NUMERIC_COLUMNS.has(header.column.id);
                                        const pinnedSide = header.column.getIsPinned();
                                        return (
                                            <th
                                                key={header.id}
                                                onClick={header.column.getToggleSortingHandler()}
                                                className={`px-3 py-2 text-xs font-semibold uppercase tracking-wide select-none ${
                                                    numeric ? 'text-right' : 'text-left'
                                                } ${header.column.getCanSort() ? 'cursor-pointer' : ''}`}
                                                style={{
                                                    whiteSpace: 'nowrap',
                                                    ...pinnedStyle(pinnedSide, pinnedSide === 'right' ? header.column.getAfter('right') : header.column.getStart('left'), false),
                                                }}
                                            >
                                                <span className={`inline-flex items-center gap-1 ${numeric ? 'flex-row-reverse' : ''}`}>
                                                    {flexRender(header.column.columnDef.header, header.getContext())}
                                                    {header.column.getCanSort() && (
                                                        sortState === 'asc' ? (
                                                            <ChevronUp size={12} />
                                                        ) : sortState === 'desc' ? (
                                                            <ChevronDown size={12} />
                                                        ) : (
                                                            <ChevronsUpDown size={12} style={{ opacity: 0.4 }} />
                                                        )
                                                    )}
                                                </span>
                                            </th>
                                        );
                                    })}
                                </tr>
                            ))}
                        </thead>
                        <tbody>
                            {table.getRowModel().rows.map((row) => {
                                const showLegToggle = !row.getIsGrouped() && hasLegDetail(row.original);
                                const legRowExpanded = showLegToggle && expandedLegRows.has(row.id);
                                return (
                                    <Fragment key={row.id}>
                                        <tr
                                            style={{
                                                borderTop: '1px solid var(--color-border-light)',
                                                color: 'var(--color-text-primary)',
                                                background: row.getIsGrouped() ? 'var(--color-surface-hover)' : undefined,
                                            }}
                                        >
                                            {orderByPinning(row.getVisibleCells()).map((cell) => {
                                                const numeric = !NON_NUMERIC_COLUMNS.has(cell.column.id);
                                                const pinnedSide = cell.column.getIsPinned();
                                                const isUnderlyingCell = cell.column.id === 'underlying';
                                                return (
                                                    <td
                                                        key={cell.id}
                                                        className={`px-3 py-2 ${numeric ? 'text-right' : 'text-left'}`}
                                                        style={{
                                                            whiteSpace: 'nowrap',
                                                            ...pinnedStyle(pinnedSide, pinnedSide === 'right' ? cell.column.getAfter('right') : cell.column.getStart('left'), row.getIsGrouped()),
                                                        }}
                                                    >
                                                        {cell.getIsGrouped() ? (
                                                            <button
                                                                onClick={row.getToggleExpandedHandler()}
                                                                className="inline-flex items-center gap-1 font-semibold cursor-pointer"
                                                            >
                                                                {row.getIsExpanded() ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                                                                {flexRender(cell.column.columnDef.cell, cell.getContext())}
                                                                <span className="text-xs font-normal" style={{ color: 'var(--color-text-tertiary)' }}>
                                                                    ({row.subRows.length})
                                                                </span>
                                                            </button>
                                                        ) : cell.getIsAggregated() ? (
                                                            flexRender(cell.column.columnDef.aggregatedCell ?? cell.column.columnDef.cell, cell.getContext())
                                                        ) : cell.getIsPlaceholder() ? null : isUnderlyingCell && showLegToggle ? (
                                                            <button
                                                                onClick={() => toggleLegRow(row.id)}
                                                                className="inline-flex items-center gap-1 cursor-pointer"
                                                            >
                                                                {legRowExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                                                                {flexRender(cell.column.columnDef.cell, cell.getContext())}
                                                            </button>
                                                        ) : (
                                                            flexRender(cell.column.columnDef.cell, cell.getContext())
                                                        )}
                                                    </td>
                                                );
                                            })}
                                        </tr>
                                        {legRowExpanded &&
                                            legDetailRows(row.original).map((legTrade, i) => (
                                                <tr
                                                    key={`${row.id}-leg-${i}`}
                                                    style={{ background: 'var(--color-surface-hover)' }}
                                                >
                                                    {orderByPinning(row.getVisibleCells()).map((cell) => {
                                                        const numeric = !NON_NUMERIC_COLUMNS.has(cell.column.id);
                                                        const pinnedSide = cell.column.getIsPinned();
                                                        const isUnderlyingCell = cell.column.id === 'underlying';
                                                        const legCtx = fakeCellContext(cell.column.id, legTrade);
                                                        return (
                                                            <td
                                                                key={`${cell.id}-leg-${i}`}
                                                                className={`px-3 py-2 text-xs ${numeric ? 'text-right' : 'text-left'}`}
                                                                style={{
                                                                    whiteSpace: 'nowrap',
                                                                    ...pinnedStyle(pinnedSide, pinnedSide === 'right' ? cell.column.getAfter('right') : cell.column.getStart('left'), false),
                                                                }}
                                                            >
                                                                {isUnderlyingCell ? (
                                                                    <span className="pl-5 inline-flex items-center gap-1.5">
                                                                        {flexRender(cell.column.columnDef.cell, legCtx)}
                                                                        <span
                                                                            className="text-[10px] font-medium uppercase tracking-wide"
                                                                            style={{ color: 'var(--color-text-tertiary)' }}
                                                                        >
                                                                            {legTrade.legs[0].right}
                                                                        </span>
                                                                    </span>
                                                                ) : (
                                                                    flexRender(cell.column.columnDef.cell, legCtx)
                                                                )}
                                                            </td>
                                                        );
                                                    })}
                                                </tr>
                                            ))}
                                    </Fragment>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
                </>
            )}
        </div>
    );
}
