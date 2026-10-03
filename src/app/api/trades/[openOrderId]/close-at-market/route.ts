import { NextResponse } from 'next/server';
import { closeAtMarketOrder, TakeProfitError } from '@/lib/transactions/service';
import { SchwabError } from '@/live/schwabClient';

export const dynamic = 'force-dynamic';

/**
 * POST /api/trades/[openOrderId]/close-at-market
 *
 * Places (or replaces, if one is already working) a GTC limit order closing
 * every open leg of the trade identified by its opening Schwab orderId, at
 * the position's current live bid/ask mid price — a manual take-profit or
 * stop-loss, closing out at whatever the market happens to be right now. No
 * body needed — the server fetches live quotes itself (see
 * `closeAtMarketOrder`), so a caller can't dictate the price or legs.
 */
export async function POST(_request: Request, { params }: { params: Promise<{ openOrderId: string }> }) {
    const { openOrderId } = await params;
    try {
        const result = await closeAtMarketOrder(openOrderId);
        return NextResponse.json({ ok: true, ...result });
    } catch (error) {
        const status = error instanceof TakeProfitError ? 400 : 500;
        const msg = error instanceof Error ? error.message : String(error);
        const schwabBody = error instanceof SchwabError ? error.responseBody : undefined;
        console.error(`POST /api/trades/${openOrderId}/close-at-market failed:`, msg, schwabBody ?? '');
        return NextResponse.json({ error: msg, schwabBody }, { status });
    }
}
