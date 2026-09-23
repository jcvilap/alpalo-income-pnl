/** Shared display formatters for the dashboard. */

export function formatCurrency(value: number, opts?: { sign?: boolean }): string {
    const formatted = new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    }).format(Math.abs(value));
    if (opts?.sign) {
        if (value > 0) return `+${formatted}`;
        if (value < 0) return `-${formatted}`;
    }
    return value < 0 ? `-${formatted}` : formatted;
}

export function formatPercent(fraction: number, digits = 1): string {
    return `${(fraction * 100).toFixed(digits)}%`;
}

export function formatNumber(value: number, digits = 0): string {
    if (!Number.isFinite(value)) return value > 0 ? '∞' : '—';
    return value.toFixed(digits);
}

export function formatDate(iso?: string): string {
    if (!iso) return '—';
    return iso.slice(0, 10);
}
