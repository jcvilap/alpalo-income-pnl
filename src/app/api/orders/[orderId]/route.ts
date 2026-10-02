import { NextResponse } from 'next/server';
import { firstSchwabAccount } from '@/lib/transactions/service';
import { SchwabClient } from '@/live/schwabClient';
import { withRedis } from '@/lib/redis';

export const dynamic = 'force-dynamic';

/**
 * DELETE /api/orders/[orderId]
 *
 * Cancels a still-working Schwab order (e.g. a pending closing order shown as
 * a trade's `workingCloseOrder` in /api/trades). Irreversible against the
 * live brokerage account — the UI must confirm with the user before calling
 * this.
 */
export async function DELETE(_request: Request, { params }: { params: Promise<{ orderId: string }> }) {
    const { orderId } = await params;
    try {
        const account = firstSchwabAccount();
        await withRedis(async (redis) => {
            const client = new SchwabClient({
                name: account.name,
                clientId: account.key,
                clientSecret: account.secret,
                accessToken: account.accessToken,
                refreshToken: account.refreshToken,
                accountHash: account.accountIdKey,
                redis,
            });
            await client.cancelOrder(orderId);
        });
        return NextResponse.json({ ok: true });
    } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`DELETE /api/orders/${orderId} failed:`, msg);
        return NextResponse.json({ error: msg }, { status: 500 });
    }
}
