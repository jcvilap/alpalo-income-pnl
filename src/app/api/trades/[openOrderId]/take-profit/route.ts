import { NextResponse } from 'next/server';
import { setTakeProfitOrder, TakeProfitError } from '@/lib/transactions/service';
import { SchwabError } from '@/live/schwabClient';

export const dynamic = 'force-dynamic';

/**
 * POST /api/trades/[openOrderId]/take-profit
 * Body: { pctGain: number }
 *
 * Places (or replaces, if one is already working) a GTC limit order closing
 * every open leg of the trade identified by its opening Schwab orderId, at a
 * price targeting `pctGain`% realized gain. Only a percent crosses the API
 * boundary — the server re-derives the trade's current legs/cost-basis from
 * Schwab itself (see `setTakeProfitOrder`), so a caller can't dictate
 * arbitrary order legs/prices on the live brokerage account.
 */
export async function POST(request: Request, { params }: { params: Promise<{ openOrderId: string }> }) {
    const { openOrderId } = await params;
    try {
        const body = await request.json().catch(() => ({}));
        const pctGain = Number(body?.pctGain);
        if (!Number.isFinite(pctGain) || pctGain <= 0) {
            return NextResponse.json({ error: 'pctGain must be a positive number' }, { status: 400 });
        }

        const result = await setTakeProfitOrder(openOrderId, pctGain);
        return NextResponse.json({ ok: true, ...result });
    } catch (error) {
        const status = error instanceof TakeProfitError ? 400 : 500;
        const msg = error instanceof Error ? error.message : String(error);
        const schwabBody = error instanceof SchwabError ? error.responseBody : undefined;
        console.error(`POST /api/trades/${openOrderId}/take-profit failed:`, msg, schwabBody ?? '');
        return NextResponse.json({ error: msg, schwabBody }, { status });
    }
}
