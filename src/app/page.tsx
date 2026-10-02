'use client';

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Activity, ChevronDown, RefreshCw, TrendingUp } from 'lucide-react';
import { StatTile } from '@/components/StatTile';
import { EquityCurve } from '@/components/EquityCurve';
import { TradesTable } from '@/components/TradesTable';
import { ThemeToggle } from '@/components/ThemeToggle';
import { LoginGate } from '@/components/LoginGate';
import type { StrategyId, StrategyMetrics, StrategyTrade } from '@/lib/strategy/types';
import { computeMetrics } from '@/lib/strategy/metrics';
import { formatCurrency, formatNumber, formatPercent } from '@/lib/format';

function formatSignedPercent(pct: number | undefined): string {
    if (pct == null) return '—';
    return `${pct > 0 ? '+' : ''}${pct.toFixed(1)}%`;
}

interface TradesResponse {
    strategies: string[];
    range: { from: string; to: string };
    trades: StrategyTrade[];
    metrics: StrategyMetrics;
    equityCurve: { date: string; pnl: number; cumulative: number }[];
    cached: boolean;
    fetchedAt: string;
}

const STRATEGIES = [
    { id: 'double_calendar', label: 'Double Calendar', enabled: true },
    { id: 'double_diagonal', label: 'Double Diagonal', enabled: true },
    { id: 'calendar', label: 'Calendar', enabled: true },
    { id: 'diagonal', label: 'Diagonal', enabled: true },
    { id: 'jade_lizard', label: 'Jade Lizard', enabled: false },
    { id: 'iron_condor', label: 'Iron Condor', enabled: true },
    { id: 'butterfly', label: 'Butterfly', enabled: true },
    { id: 'strangle', label: 'Strangle', enabled: true },
    { id: 'leaps', label: 'LEAPS', enabled: true },
];

const RANGE_PRESETS = [
    { id: '1D', label: '1D', days: 1 },
    { id: '1W', label: '1W', days: 7 },
    { id: '1M', label: '1M', days: 30 },
    { id: 'MTD', label: 'MTD', days: null },
    { id: '2M', label: '2M', days: 60 },
    { id: '3M', label: '3M', days: 90 },
    { id: '4M', label: '4M', days: 120 },
    { id: '5M', label: '5M', days: 150 },
    { id: '6M', label: '6M', days: 180 },
    { id: 'YTD', label: 'YTD', days: null },
    { id: 'ALL', label: 'ALL', days: null },
    { id: 'CUSTOM', label: 'Custom', days: null },
] as const;

// On mobile only the most-used presets show, to keep the row compact and
// avoid the strip overflowing its container — the rest stay reachable via
// "Custom" (which must stay visible here, or mobile users lose any way to
// pick the hidden 2–6 month / ALL ranges) or by widening the viewport.
const MOBILE_RANGE_PRESET_IDS = new Set(['1D', '1W', '1M', 'MTD', 'YTD', 'CUSTOM']);

type RangePresetId = (typeof RANGE_PRESETS)[number]['id'];

/** Schwab's /transactions endpoint rejects ranges wider than ~1 year, so "ALL" means that. */
const SCHWAB_MAX_LOOKBACK_DAYS = 364;

function toDateStr(d: Date) {
    return d.toISOString().slice(0, 10);
}

function rangeForPreset(preset: RangePresetId): { from: string; to: string } {
    const now = new Date();
    const to = toDateStr(now);
    const found = RANGE_PRESETS.find((p) => p.id === preset);

    if (preset === 'YTD') {
        return { from: `${now.getFullYear()}-01-01`, to };
    }
    if (preset === 'MTD') {
        // Derive from `to` (already UTC via toISOString) rather than local-time
        // getters — mixing the two bases can pick different months around a
        // UTC/local day boundary and yield an inverted from/to range.
        return { from: `${to.slice(0, 7)}-01`, to };
    }
    if (preset === 'ALL') {
        const from = new Date(now.getTime() - SCHWAB_MAX_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
        return { from: toDateStr(from), to };
    }
    if (preset === '1D') {
        return { from: to, to };
    }
    if (found?.days) {
        const from = new Date(now.getTime() - found.days * 24 * 60 * 60 * 1000);
        return { from: toDateStr(from), to };
    }
    // CUSTOM — caller keeps whatever from/to is already selected.
    return { from: `${now.getFullYear()}-01-01`, to };
}

const VALID_PRESET_IDS = new Set<string>(RANGE_PRESETS.map((p) => p.id));
// Only enabled strategies are deep-link-selectable — a disabled one (e.g.
// jade_lizard) can't be unchecked in the UI and isn't accepted by the API
// either (which silently falls back to DOUBLE_CALENDAR), so allowing it here
// would strand the dashboard showing mismatched data with no way to fix it.
const VALID_STRATEGY_IDS = new Set(STRATEGIES.filter((s) => s.enabled).map((s) => s.id));

function readInitialState(searchParams: URLSearchParams) {
    const presetParam = searchParams.get('preset');
    const preset: RangePresetId = presetParam && VALID_PRESET_IDS.has(presetParam) ? (presetParam as RangePresetId) : 'YTD';

    const strategyParam = searchParams.get('strategy');
    const strategies = strategyParam
        ? strategyParam.split(',').filter((s) => VALID_STRATEGY_IDS.has(s))
        : [];

    const fromParam = searchParams.get('from');
    const toParam = searchParams.get('to');
    const presetRange = rangeForPreset(preset);
    const from = preset === 'CUSTOM' && fromParam ? fromParam : presetRange.from;
    const to = preset === 'CUSTOM' && toParam ? toParam : presetRange.to;

    const statusParam = searchParams.get('status');
    const status: 'all' | 'open' | 'closed' = statusParam === 'open' || statusParam === 'closed' ? statusParam : 'all';

    return {
        preset,
        from,
        to,
        strategies: strategies.length > 0 ? strategies : ['double_calendar'],
        includeUnrealized: searchParams.get('unrealized') === '1',
        status,
    };
}

export default function Home() {
    return (
        <Suspense fallback={null}>
            <HomeContent />
        </Suspense>
    );
}

function HomeContent() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const initial = readInitialState(searchParams);

    const [preset, setPreset] = useState<RangePresetId>(initial.preset);
    const [from, setFrom] = useState(initial.from);
    const [to, setTo] = useState(initial.to);
    const [strategies, setStrategies] = useState<string[]>(initial.strategies);
    const [includeUnrealized, setIncludeUnrealized] = useState(initial.includeUnrealized);
    const [statusFilter, setStatusFilter] = useState<'all' | 'open' | 'closed'>(initial.status);
    const [strategyMenuOpen, setStrategyMenuOpen] = useState(false);
    const strategyMenuRef = useRef<HTMLDivElement>(null);
    const [data, setData] = useState<TradesResponse | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Guards against out-of-order responses: a menu-close and a range-preset
    // click can each fire their own `load()` for the same render (the menu's
    // outside-click `mousedown` fires before the preset button's `onClick`),
    // and with no sequencing the slower request's stale result could
    // overwrite the newer one. Each call stamps its own token; only the
    // still-latest call is allowed to commit its result.
    const loadRequestRef = useRef(0);

    const load = useCallback(
        async (refresh = false, overrideFrom?: string, overrideTo?: string, overrideStrategies?: string[], overrideStatus?: 'all' | 'open' | 'closed') => {
            const requestId = ++loadRequestRef.current;
            setLoading(true);
            setError(null);
            try {
                const params = new URLSearchParams({
                    from: overrideFrom ?? from,
                    to: overrideTo ?? to,
                    strategy: (overrideStrategies ?? strategies).join(','),
                    status: overrideStatus ?? statusFilter,
                });
                if (refresh) params.set('refresh', 'true');
                const res = await fetch(`/api/trades?${params.toString()}`);
                const json = await res.json();
                if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
                if (requestId !== loadRequestRef.current) return;
                setData(json);
            } catch (e) {
                if (requestId !== loadRequestRef.current) return;
                setError(e instanceof Error ? e.message : String(e));
                setData(null);
            } finally {
                if (requestId === loadRequestRef.current) setLoading(false);
            }
        },
        [from, to, strategies, statusFilter],
    );

    useEffect(() => {
        void load(false);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // While the strategy dropdown is open, checkbox clicks only update local
    // draft state — the fetch is deferred until the dropdown closes (blur or
    // outside click) so rapid multi-select toggling doesn't fire a fetch per
    // click, which was producing a confusing lag as stale results kept
    // arriving out of order.
    const strategiesRef = useRef(strategies);
    strategiesRef.current = strategies;

    const toggleStrategy = useCallback((id: string) => {
        setStrategies((prev) => {
            const next = prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id];
            return next.length > 0 ? next : prev;
        });
    }, []);

    const selectOnlyStrategy = useCallback((id: string) => {
        setStrategies([id]);
        setStrategyMenuOpen(false);
        void load(false, from, to, [id]);
    }, [load, from, to]);

    // "Select all" toggles every enabled strategy at once: selects all when
    // not everything is already selected, otherwise clears back down to just
    // the first one (toggleStrategy already refuses to empty the selection
    // entirely, so mirror that floor here instead of landing on zero).
    const toggleAllStrategies = useCallback(() => {
        const enabledIds = STRATEGIES.filter((s) => s.enabled).map((s) => s.id);
        setStrategies((prev) => {
            const allSelected = enabledIds.every((id) => prev.includes(id));
            return allSelected ? enabledIds.slice(0, 1) : enabledIds;
        });
    }, []);

    const closeStrategyMenu = useCallback(() => {
        setStrategyMenuOpen((wasOpen) => {
            if (wasOpen) void load(false, from, to, strategiesRef.current);
            return false;
        });
    }, [load, from, to]);

    // Keep the URL deep-linkable: reflect the current strategy/range/toggle
    // selection in the query string (replace, not push, so filter changes
    // don't pile up browser-history entries).
    useEffect(() => {
        const params = new URLSearchParams({
            strategy: strategies.join(','),
            preset,
        });
        if (preset === 'CUSTOM') {
            params.set('from', from);
            params.set('to', to);
        }
        if (includeUnrealized) params.set('unrealized', '1');
        if (statusFilter !== 'all') params.set('status', statusFilter);
        router.replace(`?${params.toString()}`, { scroll: false });
    }, [router, strategies, preset, from, to, includeUnrealized, statusFilter]);

    useEffect(() => {
        if (!strategyMenuOpen) return;
        const onClickOutside = (e: MouseEvent) => {
            if (strategyMenuRef.current && !strategyMenuRef.current.contains(e.target as Node)) {
                closeStrategyMenu();
            }
        };
        document.addEventListener('mousedown', onClickOutside);
        return () => document.removeEventListener('mousedown', onClickOutside);
    }, [strategyMenuOpen, closeStrategyMenu]);

    const selectPreset = useCallback(
        (id: RangePresetId) => {
            setPreset(id);
            if (id !== 'CUSTOM') {
                const range = rangeForPreset(id);
                setFrom(range.from);
                setTo(range.to);
                void load(false, range.from, range.to, strategies);
            }
        },
        [load, strategies],
    );

    // Recompute client-side rather than trusting `data.metrics` verbatim, so
    // toggling "include unrealized" is instant and doesn't require a refetch
    // — `computeMetrics` is a pure function of the already-fetched trades.
    const m = useMemo(
        () => (data ? computeMetrics(data.strategies as StrategyId[], data.trades, includeUnrealized) : undefined),
        [data, includeUnrealized],
    );
    const enabledStrategies = STRATEGIES.filter((s) => s.enabled);
    const strategyLabel =
        strategies.length === 0
            ? 'Select strategy'
            : strategies.length === enabledStrategies.length
              ? 'All strategies'
              : strategies.map((id) => STRATEGIES.find((s) => s.id === id)?.label ?? id).join(', ');

    return (
        <LoginGate>
        <main
            className="min-h-screen px-3 py-4 sm:px-8 sm:py-10 transition-theme"
            style={{ background: 'var(--color-background)' }}
        >
            {loading && (
                <div
                    className="fixed inset-0 z-50 flex items-center justify-center backdrop-blur-sm"
                    style={{ background: 'color-mix(in srgb, var(--color-background) 55%, transparent)' }}
                >
                    <div
                        className="rounded-full animate-spin"
                        style={{
                            width: 40, height: 40,
                            border: '3px solid var(--color-border)',
                            borderTopColor: 'var(--color-primary)',
                        }}
                    />
                </div>
            )}
            <div className="max-w-6xl mx-auto flex flex-col gap-3 sm:gap-6">
                {/* Header */}
                <header className="flex items-start justify-between gap-4 flex-wrap">
                    <div>
                        <h1 className="text-xl sm:text-2xl font-bold flex items-center gap-2" style={{ color: 'var(--color-text-primary)' }}>
                            <TrendingUp size={22} style={{ color: 'var(--color-primary)' }} />
                            Alpalo Income P&amp;L
                        </h1>
                        <p className="hidden sm:block text-sm mt-1" style={{ color: 'var(--color-text-secondary)' }}>
                            Analyze current income generating strategies
                        </p>
                    </div>
                    <ThemeToggle />
                </header>

                {/* Filters — one row above the charts */}
                <section
                    className="relative rounded-xl p-3 sm:p-4 flex flex-wrap items-start gap-3 sm:gap-4 bg-surface transition-theme"
                    style={{ border: '1px solid var(--color-border)' }}
                >
                    {data && (
                        <span
                            className="hidden sm:block absolute top-2 right-3 text-xs pointer-events-none"
                            style={{ color: 'var(--color-text-tertiary)' }}
                        >
                            {data.cached ? 'cached' : 'live'} · {data.trades.length} trades
                        </span>
                    )}
                    <Field label="Strategy" className="w-full sm:w-auto">
                        <div className="relative w-full sm:w-auto" ref={strategyMenuRef}>
                            <button
                                type="button"
                                onClick={() => (strategyMenuOpen ? closeStrategyMenu() : setStrategyMenuOpen(true))}
                                className="rounded-lg px-3 text-sm bg-surface h-9 flex items-center gap-2 w-full sm:min-w-[160px] justify-between"
                                style={{ border: '1px solid var(--color-border)', color: 'var(--color-text-primary)' }}
                            >
                                <span className="truncate">{strategyLabel}</span>
                                <ChevronDown size={14} style={{ color: 'var(--color-text-tertiary)' }} />
                            </button>
                            {strategyMenuOpen && (
                                <div
                                    className="absolute z-10 mt-1 rounded-lg p-1.5 bg-surface shadow-lg w-full sm:min-w-[320px] sm:w-auto max-h-[60vh] overflow-y-auto"
                                    style={{ border: '1px solid var(--color-border)' }}
                                >
                                    <label
                                        className="flex items-center gap-2 px-2 py-1.5 rounded-md text-sm cursor-pointer hover:opacity-80 font-medium"
                                        style={{ color: 'var(--color-text-primary)' }}
                                    >
                                        <input
                                            type="checkbox"
                                            checked={strategies.length === enabledStrategies.length}
                                            ref={(el) => {
                                                if (el) el.indeterminate = strategies.length > 0 && strategies.length < enabledStrategies.length;
                                            }}
                                            onChange={toggleAllStrategies}
                                        />
                                        Select all
                                    </label>
                                    <div className="my-1" style={{ borderTop: '1px solid var(--color-border-light)' }} />
                                    {STRATEGIES.map((s) => (
                                        <div
                                            key={s.id}
                                            className="flex items-center gap-2 px-2 py-1.5 rounded-md text-sm group"
                                        >
                                            <label
                                                className={`flex items-center gap-2 flex-1 min-w-0 ${
                                                    s.enabled ? 'cursor-pointer hover:opacity-80' : 'cursor-not-allowed opacity-50'
                                                }`}
                                                style={{ color: 'var(--color-text-primary)' }}
                                            >
                                                <input
                                                    type="checkbox"
                                                    checked={strategies.includes(s.id)}
                                                    disabled={!s.enabled}
                                                    onChange={() => toggleStrategy(s.id)}
                                                />
                                                <span className="truncate">
                                                    {s.label}
                                                    {!s.enabled ? ' (soon)' : ''}
                                                </span>
                                            </label>
                                            {s.enabled && (
                                                <button
                                                    type="button"
                                                    onClick={() => selectOnlyStrategy(s.id)}
                                                    className="shrink-0 text-xs font-medium opacity-100 sm:opacity-0 sm:group-hover:opacity-100 hover:underline"
                                                    style={{ color: 'var(--color-primary)' }}
                                                >
                                                    Only
                                                </button>
                                            )}
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    </Field>
                    <Field label="Status" className="shrink-0">
                        <div className="relative w-auto">
                            <select
                                value={statusFilter}
                                onChange={(e) => {
                                    const next = e.target.value as 'all' | 'open' | 'closed';
                                    setStatusFilter(next);
                                    void load(false, from, to, strategies, next);
                                }}
                                className="appearance-none rounded-lg pl-3 pr-8 text-sm bg-surface h-9 w-auto sm:min-w-[160px]"
                                style={{ border: '1px solid var(--color-border)', color: 'var(--color-text-primary)' }}
                            >
                                <option value="all">All statuses</option>
                                <option value="open">Open</option>
                                <option value="closed">Closed</option>
                            </select>
                            <ChevronDown
                                size={14}
                                className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2"
                                style={{ color: 'var(--color-text-tertiary)' }}
                            />
                        </div>
                    </Field>
                    <Field label="Range">
                        <div className="flex flex-wrap gap-1 max-w-full sm:max-w-[360px]">
                            {RANGE_PRESETS.map((p) => (
                                <button
                                    key={p.id}
                                    onClick={() => selectPreset(p.id)}
                                    className={`rounded-lg px-1.5 sm:px-2.5 text-xs font-medium transition-theme h-9 shrink-0 ${
                                        MOBILE_RANGE_PRESET_IDS.has(p.id) ? '' : 'hidden sm:inline-flex sm:items-center'
                                    }`}
                                    style={
                                        preset === p.id
                                            ? { background: 'var(--color-primary)', color: 'white' }
                                            : {
                                                  border: '1px solid var(--color-border)',
                                                  color: 'var(--color-text-secondary)',
                                              }
                                    }
                                >
                                    {p.label}
                                </button>
                            ))}
                        </div>
                    </Field>
                    {preset === 'CUSTOM' && (
                        <>
                            <Field label="From">
                                <DateInput value={from} onChange={setFrom} />
                            </Field>
                            <Field label="To">
                                <DateInput value={to} onChange={setTo} />
                            </Field>
                            <button
                                onClick={() => load(false)}
                                disabled={loading}
                                className="rounded-lg px-4 text-sm font-medium text-white bg-gradient-button hover:bg-gradient-button-hover disabled:opacity-60 h-9 sm:mt-5"
                            >
                                {loading ? 'Loading…' : 'Apply'}
                            </button>
                        </>
                    )}
                    <label
                        className="flex items-center gap-2 text-sm cursor-pointer h-9 px-1 sm:mt-5"
                        style={{ color: 'var(--color-text-secondary)' }}
                        title="Blend live mark-to-market P&L from open trades into the totals below"
                    >
                        <input
                            type="checkbox"
                            checked={includeUnrealized}
                            onChange={(e) => setIncludeUnrealized(e.target.checked)}
                        />
                        Include unrealized P&amp;L
                    </label>
                    <button
                        onClick={() => load(true)}
                        disabled={loading}
                        title="Bypass cache and re-fetch from Schwab"
                        className="rounded-lg px-3 text-sm font-medium flex items-center gap-1.5 disabled:opacity-60 h-9 sm:mt-5"
                        style={{ border: '1px solid var(--color-border)', color: 'var(--color-text-secondary)' }}
                    >
                        <RefreshCw size={14} className={loading ? 'animate-spin-slow' : ''} />
                        Refresh
                    </button>
                </section>

                {error && (
                    <div
                        className="rounded-xl p-4 text-sm"
                        style={{ background: 'var(--color-danger-bg)', color: 'var(--color-danger-text)' }}
                    >
                        {error}
                    </div>
                )}

                {/* Metrics row */}
                {m && (
                    <section className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
                        <StatTile
                            label="Total P&L"
                            value={formatCurrency(m.totalPnl, { sign: true })}
                            tone={m.totalPnl > 0 ? 'positive' : m.totalPnl < 0 ? 'negative' : 'neutral'}
                            icon={<Activity size={14} />}
                        />
                        <StatTile label="Win Rate" value={formatPercent(m.winRate)} hint={`${m.wins}W / ${m.losses}L`} />
                        <StatTile
                            label="Avg P&L"
                            value={formatCurrency(m.avgPnl, { sign: true })}
                            tone={m.avgPnl > 0 ? 'positive' : m.avgPnl < 0 ? 'negative' : 'neutral'}
                        />
                        <StatTile
                            label="Closed / Open"
                            value={`${m.closedTrades} / ${m.openTrades}`}
                            hint={`avg hold ${formatNumber(m.avgHoldDays, 0)}d`}
                        />
                        <div className="hidden sm:block">
                            <StatTile
                                label="Avg Win"
                                value={formatCurrency(m.avgWin, { sign: true })}
                                hint={`${formatSignedPercent(m.avgWinPct)}`}
                                tone="positive"
                            />
                        </div>
                        <div className="hidden sm:block">
                            <StatTile
                                label="Avg Loss"
                                value={formatCurrency(m.avgLoss, { sign: true })}
                                hint={`${formatSignedPercent(m.avgLossPct)}`}
                                tone="negative"
                            />
                        </div>
                        <div className="hidden sm:block">
                            <StatTile
                                label="Biggest Win"
                                value={formatCurrency(m.bestTrade, { sign: true })}
                                hint={`${formatSignedPercent(m.bestTradePct)}`}
                                tone="positive"
                            />
                        </div>
                        <div className="hidden sm:block">
                            <StatTile
                                label="Biggest Loss"
                                value={formatCurrency(m.worstTrade, { sign: true })}
                                hint={`${formatSignedPercent(m.worstTradePct)}`}
                                tone="negative"
                            />
                        </div>
                    </section>
                )}

                {/* Chart */}
                {data && <EquityCurve data={data.equityCurve} />}

                {/* Table */}
                {data && <TradesTable trades={data.trades} statusFilter={statusFilter} onTradesChanged={() => load(true)} />}

                {!data && !error && !loading && (
                    <div className="text-center text-sm py-12" style={{ color: 'var(--color-text-tertiary)' }}>
                        Choose a range to load trades.
                    </div>
                )}
            </div>
        </main>
        </LoginGate>
    );
}

function Field({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
    return (
        <label className={`flex flex-col gap-1 min-w-0 ${className ?? ''}`}>
            <span className="hidden sm:block text-xs font-medium uppercase tracking-wide" style={{ color: 'var(--color-text-secondary)' }}>
                {label}
            </span>
            {children}
        </label>
    );
}

function DateInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
    return (
        <input
            type="date"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            className="rounded-lg px-3 text-sm bg-surface h-9"
            style={{ border: '1px solid var(--color-border)', color: 'var(--color-text-primary)' }}
        />
    );
}
