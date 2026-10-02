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
 * Compact axis label: $4,868.78 -> $4.9K. Cents/dollars don't matter on the
 * axis — only the hundreds digit, so one decimal of thousands is enough
 * precision to tell gridlines apart.
 */
function formatCompactCurrency(value: number): string {
    const sign = value < 0 ? '-' : '';
    const abs = Math.abs(value);
    if (abs < 1000) return `${sign}$${Math.round(abs)}`;
    return `${sign}$${(abs / 1000).toFixed(1)}K`;
}

/** Angled Y-axis tick so currency labels take less horizontal width, letting the axis column shrink. */
function AngledYTick({ x, y, payload }: { x?: number; y?: number; payload?: { value: number } }) {
    if (x == null || y == null || !payload) return null;
    return (
        <text
            x={x}
            y={y}
            dy={3}
            textAnchor="end"
            transform={`rotate(-35, ${x}, ${y})`}
            fontSize={11}
            fill="var(--color-text-tertiary)"
        >
            {formatCompactCurrency(payload.value)}
        </text>
    );
}

/**
 * Cumulative realized-P&L curve — a single series (change-over-time), so one
 * hue, no legend (the title names it), a recessive grid, and a crosshair
 * tooltip. Uses the theme's primary chart hue.
 */
export function EquityCurve({ data }: { data: Point[] }) {
    if (data.length === 0) {
        return null;
    }

    const hue = 'var(--color-chart-blue)';

    // Prepend a $0 baseline point so the curve visibly starts from zero
    // instead of jumping straight to the first trade's P&L.
    const chartData: Point[] = [{ date: data[0].date, pnl: 0, cumulative: 0 }, ...data];

    return (
        <div
            className="rounded-xl pt-3 px-3 pb-0 sm:p-4 bg-surface transition-theme"
            style={{ border: '1px solid var(--color-border)' }}
        >
            <h3 className="text-sm font-semibold mb-2 sm:mb-3" style={{ color: 'var(--color-text-primary)' }}>
                Cumulative Realized P&amp;L
            </h3>
            <div style={{ width: '100%', height: 180 }} className="sm:!h-[280px]">
                <ResponsiveContainer>
                    <AreaChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: 2 }}>
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
                            height={24}
                            tickFormatter={(v) => formatDate(String(v))}
                        />
                        <YAxis
                            tick={<AngledYTick />}
                            tickLine={false}
                            axisLine={false}
                            width={28}
                            domain={[(min: number) => Math.min(0, min), (max: number) => Math.max(0, max)]}
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
