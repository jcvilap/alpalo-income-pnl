'use client';

import type { ReactNode } from 'react';

interface StatTileProps {
    label: string;
    value: ReactNode;
    /** Optional secondary line under the value. */
    hint?: ReactNode;
    /** 'positive' | 'negative' tint the value with reserved status colors. */
    tone?: 'neutral' | 'positive' | 'negative';
    icon?: ReactNode;
}

/**
 * A single headline metric. Values use text/status tokens (never a chart series
 * color); positive/negative tone uses the reserved success/danger status colors.
 */
export function StatTile({ label, value, hint, tone = 'neutral', icon }: StatTileProps) {
    const valueColor =
        tone === 'positive'
            ? 'var(--color-success)'
            : tone === 'negative'
              ? 'var(--color-danger)'
              : 'var(--color-text-primary)';

    return (
        <div
            className="rounded-xl p-4 flex flex-col gap-1 bg-surface transition-theme"
            style={{ border: '1px solid var(--color-border)' }}
        >
            <div className="flex items-center gap-1.5">
                {icon && <span style={{ color: 'var(--color-text-tertiary)' }}>{icon}</span>}
                <span className="text-xs font-medium uppercase tracking-wide" style={{ color: 'var(--color-text-secondary)' }}>
                    {label}
                </span>
            </div>
            <span className="text-2xl font-semibold tabular-nums" style={{ color: valueColor }}>
                {value}
            </span>
            {hint && (
                <span className="text-xs tabular-nums" style={{ color: 'var(--color-text-tertiary)' }}>
                    {hint}
                </span>
            )}
        </div>
    );
}
