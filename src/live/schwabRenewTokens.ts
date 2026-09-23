import { RedisClientType } from 'redis';
import { AccountConfig, BrokerType } from '../config/accounts';
import { SchwabClient } from './schwabClient';

export interface SchwabRenewResult {
    account: string;
    status: 'refreshed' | 'skipped_valid' | 'failed';
    remainingSeconds?: number;
    remainingDays?: string;
    error?: string;
}

export interface SchwabRenewSummary {
    refreshed: number;
    skipped_valid: number;
    failed: number;
    elapsed_ms: number;
    results: SchwabRenewResult[];
}

/**
 * Refresh Schwab access tokens for all configured Schwab accounts.
 *
 * Schwab tokens rotate on each refresh — both access_token (30 min) and
 * refresh_token (7 days) are updated. Tokens are persisted to Redis so the
 * live trading runtime always has a valid access token available.
 *
 * Call this at least every 6 days so the refresh token never lapses.
 */
export async function renewSchwabTokens(
    accounts: AccountConfig[],
    redis: RedisClientType,
    options?: { force?: boolean; seed?: boolean }
): Promise<SchwabRenewSummary> {
    const startTime = Date.now();
    const schwabAccounts = accounts.filter(a => a.broker === BrokerType.SCHWAB);
    console.log(`Found ${schwabAccounts.length} Schwab account(s).`);

    const results: SchwabRenewResult[] = [];

    for (const account of schwabAccounts) {
        const client = new SchwabClient({
            name: account.name,
            clientId: account.key,
            clientSecret: account.secret,
            accessToken: account.accessToken,
            refreshToken: account.refreshToken,
            accountHash: account.accountIdKey,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            redis: redis as any
        });

        try {
            // --seed: bypass Redis and load tokens directly from config (.env)
            // This is used after manually obtaining new tokens to push them into Redis
            await client.authenticate({ skipRedis: options?.seed });

            const remaining = client.getTokenRemainingSeconds();
            // Refresh if: forced, or less than 5 minutes left on the access token
            // (the refresh token itself rotates on every refresh, so we keep it alive)
            // seed always forces a refresh — the goal is to push fresh config tokens into Redis
            const needsRefresh = options?.seed || options?.force || client.isAccessTokenExpired(300);

            const refreshDaysRemaining = client.getRefreshTokenRemainingDays();
            const refreshDaysLabel = refreshDaysRemaining > 0 ? `${refreshDaysRemaining.toFixed(1)}d` : 'unknown';

            if (!needsRefresh) {
                console.log(`[${account.name}] Schwab access token still valid (${remaining.toFixed(0)}s remaining, refresh token ~${refreshDaysLabel}). Skipping.`);
                results.push({ account: account.name, status: 'skipped_valid', remainingSeconds: remaining, remainingDays: refreshDaysLabel });
                continue;
            }

            console.log(`[${account.name}] Refreshing Schwab tokens (remaining: ${remaining.toFixed(0)}s)...`);
            await client.refreshAccessToken();

            const newRemaining = client.getTokenRemainingSeconds();
            const newRefreshDays = client.getRefreshTokenRemainingDays();
            const newRefreshDaysLabel = newRefreshDays > 0 ? `${newRefreshDays.toFixed(1)}d` : 'unknown';
            console.log(`[${account.name}] Schwab tokens refreshed. New access token expires in ${newRemaining.toFixed(0)}s, refresh token ~${newRefreshDaysLabel}.`);
            results.push({ account: account.name, status: 'refreshed', remainingSeconds: newRemaining, remainingDays: newRefreshDaysLabel });
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            console.error(`[${account.name}] Schwab token refresh FAILED: ${msg}`);
            results.push({ account: account.name, status: 'failed', error: msg });
        }
    }

    const elapsed = Date.now() - startTime;
    return {
        refreshed: results.filter(r => r.status === 'refreshed').length,
        skipped_valid: results.filter(r => r.status === 'skipped_valid').length,
        failed: results.filter(r => r.status === 'failed').length,
        elapsed_ms: elapsed,
        results
    };
}
