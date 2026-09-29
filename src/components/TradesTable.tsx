'use client';

import { Fragment, useMemo, useState } from 'react';
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
import type { StrategyId, StrategyTrade } from '@/lib/strategy/types';
import { formatCurrency, formatDate } from '@/lib/format';

const GROUP_OPTIONS = [
    { id: 'none', label: 'No grouping' },
    { id: 'underlying', label: 'Underlying' },
    { id: 'status', label: 'Status' },
    { id: 'strategy', label: 'Strategy' },
] as const;

const STRATEGY_LABELS: Record<StrategyId, string> = {
    DOUBLE_CALENDAR: 'Double Calendar',
    DOUBLE_DIAGONAL: 'Double Diagonal',
    JADE_LIZARD: 'Jade Lizard',
    IRON_CONDOR: 'Iron Condor',
    STRANGLE: 'Strangle',
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

const NON_NUMERIC_COLUMNS = new Set(['underlying', 'status', 'strategy', 'openedAt', 'closedAt', 'strikes', 'expirations']);

/** True for trades that can show a per-leg breakdown row: strangles only (open or closed). */
function hasLegDetail(trade: StrategyTrade): boolean {
    return trade.strategy === 'STRANGLE';
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
            const v = ctx.getValue<number | undefined>();
            return <span className="tabular-nums">{v == null ? '—' : formatCurrency(v, { sign: true })}</span>;
        },
        aggregationFn: 'sum',
        aggregatedCell: (ctx) => (
            <span className="tabular-nums font-semibold">{formatCurrency(ctx.getValue<number>(), { sign: true })}</span>
        ),
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

/** Trades table — sortable, filterable, groupable via TanStack Table. */
export function TradesTable({ trades }: { trades: StrategyTrade[] }) {
    const [sorting, setSorting] = useState<SortingState>([
        { id: 'status', desc: false },
        { id: 'openedAt', desc: true },
    ]);
    const [grouping, setGrouping] = useState<GroupingState>([]);
    const [globalFilter, setGlobalFilter] = useState('');
    const [statusFilter, setStatusFilter] = useState<'all' | 'open' | 'closed'>('all');
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
            {/* Toolbar */}
            <div className="flex flex-wrap items-center gap-3">
                <input
                    type="text"
                    placeholder="Filter by underlying, strike, expiration…"
                    value={globalFilter}
                    onChange={(e) => setGlobalFilter(e.target.value)}
                    className="rounded-lg px-3 py-2 text-sm bg-surface flex-1 min-w-[220px]"
                    style={{ border: '1px solid var(--color-border)', color: 'var(--color-text-primary)' }}
                />
                <select
                    value={statusFilter}
                    onChange={(e) => setStatusFilter(e.target.value as 'all' | 'open' | 'closed')}
                    className="rounded-lg px-3 py-2 text-sm bg-surface"
                    style={{ border: '1px solid var(--color-border)', color: 'var(--color-text-primary)' }}
                >
                    <option value="all">All statuses</option>
                    <option value="open">Open</option>
                    <option value="closed">Closed</option>
                </select>
                <select
                    value={grouping[0] ?? 'none'}
                    onChange={(e) => setGrouping(e.target.value === 'none' ? [] : [e.target.value])}
                    className="rounded-lg px-3 py-2 text-sm bg-surface"
                    style={{ border: '1px solid var(--color-border)', color: 'var(--color-text-primary)' }}
                >
                    {GROUP_OPTIONS.map((g) => (
                        <option key={g.id} value={g.id}>
                            Group by: {g.label}
                        </option>
                    ))}
                </select>
                <span className="text-xs ml-auto" style={{ color: 'var(--color-text-tertiary)' }}>
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
                <div
                    className="rounded-xl bg-surface transition-theme overflow-x-auto"
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
            )}
        </div>
    );
}
