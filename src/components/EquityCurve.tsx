'use client';

import {
    Area,
    AreaChart,
    CartesianGrid,
    ResponsiveContainer,
    Tooltip,
    XAxis,
    YAxis,
} from 'recharts';
import { formatCurrency, formatDate } from '@/lib/format';

interface Point {
    date: string;
    pnl: number;
    cumulative: number;
}

/**
 * Cumulative realized-P&L curve — a single series (change-over-time), so one
 * hue, no legend (the title names it), a recessive grid, and a crosshair
 * tooltip. Uses the theme's primary chart hue.
 */
export function EquityCurve({ data }: { data: Point[] }) {
    if (data.length === 0) {
        return (
            <div
                className="rounded-xl p-8 text-center text-sm bg-surface"
                style={{ border: '1px solid var(--color-border)', color: 'var(--color-text-tertiary)' }}
            >
                No closed trades in this range yet.
            </div>
        );
    }

    const hue = 'var(--color-chart-blue)';

    return (
        <div
            className="rounded-xl p-4 bg-surface transition-theme"
            style={{ border: '1px solid var(--color-border)' }}
        >
            <h3 className="text-sm font-semibold mb-3" style={{ color: 'var(--color-text-primary)' }}>
                Cumulative Realized P&amp;L
            </h3>
            <div style={{ width: '100%', height: 280 }}>
                <ResponsiveContainer>
                    <AreaChart data={data} margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
                        <defs>
                            <linearGradient id="pnlFill" x1="0" y1="0" x2="0" y2="1">
                                <stop offset="0%" stopColor={hue} stopOpacity={0.28} />
                                <stop offset="100%" stopColor={hue} stopOpacity={0.02} />
                            </linearGradient>
                        </defs>
                        <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border-light)" vertical={false} />
                        <XAxis
                            dataKey="date"
                            tick={{ fontSize: 11, fill: 'var(--color-text-tertiary)' }}
                            tickLine={false}
                            axisLine={{ stroke: 'var(--color-border)' }}
                            minTickGap={32}
                        />
                        <YAxis
                            tick={{ fontSize: 11, fill: 'var(--color-text-tertiary)' }}
                            tickLine={false}
                            axisLine={false}
                            width={70}
                            tickFormatter={(v) => formatCurrency(v)}
                        />
                        <Tooltip
                            contentStyle={{
                                background: 'var(--color-surface-elevated)',
                                border: '1px solid var(--color-border)',
                                borderRadius: 8,
                                fontSize: 12,
                                color: 'var(--color-text-primary)',
                            }}
                            labelFormatter={(label) => formatDate(String(label))}
                            formatter={(value: number, _name, item) => {
                                const p = item?.payload as Point | undefined;
                                return [
                                    formatCurrency(value, { sign: true }),
                                    p ? `Trade P&L ${formatCurrency(p.pnl, { sign: true })}` : 'Cumulative',
                                ];
                            }}
                            cursor={{ stroke: 'var(--color-text-tertiary)', strokeWidth: 1 }}
                        />
                        <Area
                            type="monotone"
                            dataKey="cumulative"
                            stroke={hue}
                            strokeWidth={2}
                            fill="url(#pnlFill)"
                            dot={false}
                            activeDot={{ r: 4, stroke: 'var(--color-surface)', strokeWidth: 2 }}
                            name="Cumulative P&L"
                        />
                    </AreaChart>
                </ResponsiveContainer>
            </div>
        </div>
    );
}
