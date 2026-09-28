import { NextResponse } from 'next/server';
import { getTrades } from '@/lib/transactions/service';
import type { StrategyId } from '@/lib/strategy/types';

export const dynamic = 'force-dynamic';

const SUPPORTED_STRATEGIES: StrategyId[] = ['DOUBLE_CALENDAR', 'DOUBLE_DIAGONAL'];

/** Parse a comma-separated strategy query param (case-insensitive, dashes/underscores). */
function parseStrategies(raw: string | null): StrategyId[] {
    if (!raw) return ['DOUBLE_CALENDAR'];
    const ids = raw
        .split(',')
        .map(s => s.trim().toUpperCase().replace(/-/g, '_') as StrategyId)
        .filter(s => SUPPORTED_STRATEGIES.includes(s));
    return ids.length > 0 ? Array.from(new Set(ids)) : ['DOUBLE_CALENDAR'];
}

/** Normalize a date param to an ISO-8601 instant Schwab accepts. */
function toIso(dateStr: string, endOfDay = false): string {
    // Accept yyyy-mm-dd or full ISO. Anchor bare dates to UTC start/end of day.
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        return `${dateStr}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`;
    }
    return new Date(dateStr).toISOString();
}

/**
 * GET /api/trades?from=YYYY-MM-DD&to=YYYY-MM-DD&strategy=double_calendar,double_diagonal&refresh=true
 *
 * Returns detected strategy trades (pooled across all requested strategies) +
 * aggregate metrics + equity curve. Defaults the range to year-to-date when
 * from/to are omitted.
 */
export async function GET(request: Request) {
    try {
        const url = new URL(request.url);
        const strategies = parseStrategies(url.searchParams.get('strategy'));
        const refresh = url.searchParams.get('refresh') === 'true';

        const now = new Date();
        const defaultFrom = `${now.getUTCFullYear()}-01-01`;
        const defaultTo = now.toISOString().slice(0, 10);

        const from = toIso(url.searchParams.get('from') ?? defaultFrom);
        const to = toIso(url.searchParams.get('to') ?? defaultTo, true);

        const result = await getTrades({ from, to, strategies, refresh });
        return NextResponse.json(result);
    } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error('GET /api/trades failed:', msg);
        return NextResponse.json({ error: msg }, { status: 500 });
    }
}
