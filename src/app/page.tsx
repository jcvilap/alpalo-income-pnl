'use client';

import { useCallback, useEffect, useState } from 'react';
import { Activity, RefreshCw, TrendingUp } from 'lucide-react';
import { StatTile } from '@/components/StatTile';
import { EquityCurve } from '@/components/EquityCurve';
import { TradesTable } from '@/components/TradesTable';
import { ThemeToggle } from '@/components/ThemeToggle';
import type { StrategyMetrics, StrategyTrade } from '@/lib/strategy/types';
import { formatCurrency, formatNumber, formatPercent } from '@/lib/format';

interface TradesResponse {
    strategy: string;
    range: { from: string; to: string };
    trades: StrategyTrade[];
    metrics: StrategyMetrics;
    equityCurve: { date: string; pnl: number; cumulative: number }[];
    cached: boolean;
    fetchedAt: string;
}

const STRATEGIES = [
    { id: 'double_calendar', label: 'Double Calendar', enabled: true },
    { id: 'jade_lizard', label: 'Jade Lizard', enabled: false },
    { id: 'iron_condor', label: 'Iron Condor', enabled: false },
    { id: 'strangle', label: 'Strangle', enabled: false },
];

function ytdDefaults() {
    const now = new Date();
    return {
        from: `${now.getFullYear()}-01-01`,
        to: now.toISOString().slice(0, 10),
    };
}

export default function Home() {
    const defaults = ytdDefaults();
    const [from, setFrom] = useState(defaults.from);
    const [to, setTo] = useState(defaults.to);
    const [strategy, setStrategy] = useState('double_calendar');
    const [data, setData] = useState<TradesResponse | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(
        async (refresh = false) => {
            setLoading(true);
            setError(null);
            try {
                const params = new URLSearchParams({ from, to, strategy });
                if (refresh) params.set('refresh', 'true');
                const res = await fetch(`/api/trades?${params.toString()}`);
                const json = await res.json();
                if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
                setData(json);
            } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
                setData(null);
            } finally {
                setLoading(false);
            }
        },
        [from, to, strategy],
    );

    useEffect(() => {
        void load(false);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const m = data?.metrics;

    return (
        <main
            className="min-h-screen px-4 py-6 sm:px-8 sm:py-10 transition-theme"
            style={{ background: 'var(--color-background)' }}
        >
            <div className="max-w-6xl mx-auto flex flex-col gap-6">
                {/* Header */}
                <header className="flex items-start justify-between gap-4 flex-wrap">
                    <div>
                        <h1 className="text-2xl font-bold flex items-center gap-2" style={{ color: 'var(--color-text-primary)' }}>
                            <TrendingUp size={22} style={{ color: 'var(--color-primary)' }} />
                            Alpalo Income P&amp;L
                        </h1>
                        <p className="text-sm mt-1" style={{ color: 'var(--color-text-secondary)' }}>
                            Schwab option-income strategy analytics
                        </p>
                    </div>
                    <ThemeToggle />
                </header>

                {/* Filters — one row above the charts */}
                <section
                    className="rounded-xl p-4 flex flex-wrap items-end gap-4 bg-surface transition-theme"
                    style={{ border: '1px solid var(--color-border)' }}
                >
                    <Field label="Strategy">
                        <select
                            value={strategy}
                            onChange={(e) => setStrategy(e.target.value)}
                            className="rounded-lg px-3 py-2 text-sm bg-surface"
                            style={{ border: '1px solid var(--color-border)', color: 'var(--color-text-primary)' }}
                        >
                            {STRATEGIES.map((s) => (
                                <option key={s.id} value={s.id} disabled={!s.enabled}>
                                    {s.label}
                                    {!s.enabled ? ' (soon)' : ''}
                                </option>
                            ))}
                        </select>
                    </Field>
                    <Field label="From">
                        <DateInput value={from} onChange={setFrom} />
                    </Field>
                    <Field label="To">
                        <DateInput value={to} onChange={setTo} />
                    </Field>
                    <button
                        onClick={() => load(false)}
                        disabled={loading}
                        className="rounded-lg px-4 py-2 text-sm font-medium text-white bg-gradient-button hover:bg-gradient-button-hover disabled:opacity-60"
                    >
                        {loading ? 'Loading…' : 'Apply'}
                    </button>
                    <button
                        onClick={() => load(true)}
                        disabled={loading}
                        title="Bypass cache and re-fetch from Schwab"
                        className="rounded-lg px-3 py-2 text-sm font-medium flex items-center gap-1.5 disabled:opacity-60"
                        style={{ border: '1px solid var(--color-border)', color: 'var(--color-text-secondary)' }}
                    >
                        <RefreshCw size={14} className={loading ? 'animate-spin-slow' : ''} />
                        Refresh
                    </button>
                    {data && (
                        <span className="text-xs ml-auto self-center" style={{ color: 'var(--color-text-tertiary)' }}>
                            {data.cached ? 'cached' : 'live'} · {data.trades.length} trades
                        </span>
                    )}
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
                        <StatTile label="Profit Factor" value={formatNumber(m.profitFactor, 2)} />
                        <StatTile
                            label="Closed / Open"
                            value={`${m.closedTrades} / ${m.openTrades}`}
                            hint={`avg hold ${formatNumber(m.avgHoldDays, 0)}d`}
                        />
                        <StatTile
                            label="Best / Worst"
                            value={formatCurrency(m.bestTrade, { sign: true })}
                            hint={formatCurrency(m.worstTrade, { sign: true })}
                            tone="neutral"
                        />
                    </section>
                )}

                {/* Chart */}
                {data && <EquityCurve data={data.equityCurve} />}

                {/* Table */}
                {data && <TradesTable trades={data.trades} />}

                {!data && !error && !loading && (
                    <div className="text-center text-sm py-12" style={{ color: 'var(--color-text-tertiary)' }}>
                        Choose a range and click Apply.
                    </div>
                )}
            </div>
        </main>
    );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <label className="flex flex-col gap-1">
            <span className="text-xs font-medium uppercase tracking-wide" style={{ color: 'var(--color-text-secondary)' }}>
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
            className="rounded-lg px-3 py-2 text-sm bg-surface"
            style={{ border: '1px solid var(--color-border)', color: 'var(--color-text-primary)' }}
        />
    );
}
