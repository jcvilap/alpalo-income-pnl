'use client';

import type { StrategyTrade } from '@/lib/strategy/types';
import { formatCurrency, formatDate } from '@/lib/format';

/** Trades table — the always-available table view of the data. */
export function TradesTable({ trades }: { trades: StrategyTrade[] }) {
    if (trades.length === 0) {
        return (
            <div
                className="rounded-xl p-8 text-center text-sm bg-surface"
                style={{ border: '1px solid var(--color-border)', color: 'var(--color-text-tertiary)' }}
            >
                No trades detected for this strategy in the selected range.
            </div>
        );
    }

    return (
        <div
            className="rounded-xl bg-surface transition-theme overflow-x-auto"
            style={{ border: '1px solid var(--color-border)' }}
        >
            <table className="w-full text-sm border-collapse">
                <thead>
                    <tr style={{ color: 'var(--color-text-secondary)' }} className="text-left">
                        <Th>Underlying</Th>
                        <Th>Status</Th>
                        <Th>Opened</Th>
                        <Th>Closed</Th>
                        <Th>Strikes</Th>
                        <Th>Expirations</Th>
                        <Th right>Open Net</Th>
                        <Th right>Close Net</Th>
                        <Th right>Realized P&amp;L</Th>
                        <Th right>Days</Th>
                    </tr>
                </thead>
                <tbody>
                    {trades.map((t) => {
                        const pnl = t.realizedPnl;
                        const tone = pnl == null ? undefined : pnl > 0 ? 'positive' : pnl < 0 ? 'negative' : undefined;
                        return (
                            <tr
                                key={t.id}
                                style={{ borderTop: '1px solid var(--color-border-light)', color: 'var(--color-text-primary)' }}
                            >
                                <Td className="font-medium">{t.underlying || '—'}</Td>
                                <Td>
                                    <span
                                        className="inline-block px-2 py-0.5 rounded-full text-xs font-medium"
                                        style={
                                            t.status === 'open'
                                                ? { background: 'var(--color-surface-hover)', color: 'var(--color-text-secondary)' }
                                                : { background: 'var(--color-surface-hover)', color: 'var(--color-text-primary)' }
                                        }
                                    >
                                        {t.status}
                                    </span>
                                </Td>
                                <Td className="tabular-nums">{formatDate(t.openedAt)}</Td>
                                <Td className="tabular-nums">{formatDate(t.closedAt)}</Td>
                                <Td className="tabular-nums">{t.strikes.join(' / ')}</Td>
                                <Td className="tabular-nums text-xs">{t.expirations.join(' / ')}</Td>
                                <Td right className="tabular-nums">{formatCurrency(t.openNet, { sign: true })}</Td>
                                <Td right className="tabular-nums">
                                    {t.closeNet == null ? '—' : formatCurrency(t.closeNet, { sign: true })}
                                </Td>
                                <Td right className="tabular-nums font-semibold" tone={tone}>
                                    {pnl == null ? '—' : formatCurrency(pnl, { sign: true })}
                                </Td>
                                <Td right className="tabular-nums">{t.holdDays ?? '—'}</Td>
                            </tr>
                        );
                    })}
                </tbody>
            </table>
        </div>
    );
}

function Th({ children, right }: { children: React.ReactNode; right?: boolean }) {
    return (
        <th
            className={`px-3 py-2 text-xs font-semibold uppercase tracking-wide ${right ? 'text-right' : 'text-left'}`}
            style={{ whiteSpace: 'nowrap' }}
        >
            {children}
        </th>
    );
}

function Td({
    children,
    right,
    className = '',
    tone,
}: {
    children: React.ReactNode;
    right?: boolean;
    className?: string;
    tone?: 'positive' | 'negative';
}) {
    const color =
        tone === 'positive' ? 'var(--color-success)' : tone === 'negative' ? 'var(--color-danger)' : undefined;
    return (
        <td
            className={`px-3 py-2 ${right ? 'text-right' : 'text-left'} ${className}`}
            style={{ whiteSpace: 'nowrap', color }}
        >
            {children}
        </td>
    );
}
