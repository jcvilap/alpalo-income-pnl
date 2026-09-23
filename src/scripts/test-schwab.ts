/**
 * Connection smoke test for the shared Schwab integration.
 *
 * Loads ACCOUNTS + REDIS_URL from .env, reads the Schwab tokens seeded in the
 * shared Redis (by this project's cron or alpalo-v2's), then exercises the two
 * endpoints the dashboard depends on: account resolution and transactions.
 *
 * Run: pnpm schwab:test  [--days=30]
 * Secrets are never printed.
 */
import 'dotenv/config';
import { getConfiguredAccounts, BrokerType } from '../config/accounts';
import { SchwabClient } from '../live/schwabClient';
import { connectRedis } from '../lib/redis';

function argValue(flag: string, fallback: string): string {
    const arg = process.argv.find(a => a.startsWith(`--${flag}=`));
    return arg ? arg.split('=')[1] : fallback;
}

async function main() {
    const days = parseInt(argValue('days', '30'), 10);
    const accounts = getConfiguredAccounts();
    const account = accounts.find(a => a.broker === BrokerType.SCHWAB);
    if (!account) throw new Error('No Schwab account in ACCOUNTS.');

    console.log(`Testing Schwab connection for account: ${account.name}`);

    const redis = await connectRedis();
    try {
        const client = new SchwabClient({
            name: account.name,
            clientId: account.key,
            clientSecret: account.secret,
            accessToken: account.accessToken,
            refreshToken: account.refreshToken,
            accountHash: account.accountIdKey,
            redis,
        });

        await client.authenticate();
        console.log(`  ✓ Authenticated (access token ~${Math.round(client.getTokenRemainingSeconds())}s remaining)`);
        console.log(`  ✓ Refresh token ~${client.getRefreshTokenRemainingDays().toFixed(1)}d remaining`);

        const hashes = await client.getAccountNumbers();
        console.log(`  ✓ Linked accounts: ${hashes.length}`);

        const to = new Date();
        const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
        const txns = await client.getTransactions({
            startDate: from.toISOString(),
            endDate: to.toISOString(),
            types: 'TRADE',
        });
        console.log(`  ✓ TRADE transactions in last ${days}d: ${txns.length}`);

        const withOptions = txns.filter(t =>
            (t.transferItems ?? []).some(i => i.instrument?.assetType === 'OPTION'),
        );
        console.log(`  ✓ Of those, containing option legs: ${withOptions.length}`);
        console.log('\nConnection OK.');
    } finally {
        await redis.quit();
    }
}

main().catch(err => {
    console.error('Schwab connection test FAILED:', err instanceof Error ? err.message : err);
    process.exit(1);
});
