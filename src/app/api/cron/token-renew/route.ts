import { NextResponse } from 'next/server';
import { RedisClientType } from 'redis';
import { getConfiguredAccounts } from '@/config/accounts';
import { renewSchwabTokens } from '@/live/schwabRenewTokens';
import { connectRedis } from '@/lib/redis';

export const dynamic = 'force-dynamic';

/**
 * Safety-net Schwab token renewal cron.
 *
 * The primary token refresh happens in the sibling `alpalo-v2` project against
 * the same Redis + Schwab app. This endpoint independently keeps the tokens
 * fresh so this project never depends on alpalo-v2 running. Scheduled via
 * vercel.json; Vercel Cron sends `Authorization: Bearer $CRON_SECRET`.
 */
export async function GET(request: Request) {
    console.log('=== Token Renewal Cron — START ===');
    console.log(`Timestamp: ${new Date().toISOString()}`);

    const authHeader = request.headers.get('authorization');
    if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
        console.error('Authorization failed — invalid or missing CRON_SECRET');
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    let redis: RedisClientType | null = null;
    try {
        redis = await connectRedis();

        const accounts = getConfiguredAccounts();
        const url = new URL(request.url);
        const force = url.searchParams.get('force') === 'true';
        // seed: bypass Redis and push fresh tokens from ACCOUNTS env var into Redis.
        // Use this after manually re-authorizing Schwab to seed new tokens.
        const seed = url.searchParams.get('seed') === 'true';

        const schwabSummary = await renewSchwabTokens(accounts, redis, { force, seed });

        console.log('=== Token Renewal Cron — END ===\n');
        return NextResponse.json({ message: 'Token renewal completed', schwab: schwabSummary });
    } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`Token renewal FATAL error: ${msg}`);
        console.error('Stack:', error instanceof Error ? error.stack : '(no stack)');
        return NextResponse.json({ error: msg }, { status: 500 });
    } finally {
        if (redis) {
            try {
                await redis.quit();
            } catch (e) {
                console.warn('Failed to disconnect Redis:', e);
            }
        }
    }
}
