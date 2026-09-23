import type { RedisClientType } from 'redis';
import { getConfiguredAccounts, BrokerType, type AccountConfig } from '@/config/accounts';
import { SchwabClient, type SchwabTransaction } from '@/live/schwabClient';
import { withRedis } from '@/lib/redis';
import { normalizeToOrderGroups } from '@/lib/strategy/normalize';
import { buildTrades } from '@/lib/strategy/pairing';
import { computeMetrics, cumulativePnlSeries } from '@/lib/strategy/metrics';
import type { StrategyId, StrategyMetrics, StrategyTrade } from '@/lib/strategy/types';

/** Bump when detection/normalization logic changes, to invalidate cached results. */
const STRATEGY_VERSION = 'v1';
/** TTL for cached raw transactions and parsed results (seconds). */
const RAW_TTL_SECONDS = 15 * 60;
const PARSED_TTL_SECONDS = 15 * 60;

export interface TradesResult {
    strategy: StrategyId;
    range: { from: string; to: string };
    trades: StrategyTrade[];
    metrics: StrategyMetrics;
    equityCurve: { date: string; pnl: number; cumulative: number }[];
    cached: boolean;
    fetchedAt: string;
}

function firstSchwabAccount(): AccountConfig {
    const accounts = getConfiguredAccounts();
    const schwab = accounts.find(a => a.broker === BrokerType.SCHWAB);
    if (!schwab) {
        throw new Error('No Schwab account configured in ACCOUNTS. Add a broker:"Schwab" entry.');
    }
    return schwab;
}

function rawKey(hash: string, from: string, to: string): string {
    return `incomepnl:txns:${hash}:${from}:${to}`;
}

function parsedKey(strategy: StrategyId, hash: string, from: string, to: string): string {
    return `incomepnl:parsed:${STRATEGY_VERSION}:${strategy}:${hash}:${from}:${to}`;
}

/**
 * Fetch (or read from cache) Schwab transactions for the range, then detect the
 * requested strategy, pair open/close orders, and compute metrics.
 *
 * Caching strategy (all in the shared Redis):
 *  - parsed result cached under a version-stamped key → instant repeat loads
 *  - raw transactions cached separately → re-parse without re-hitting Schwab
 *
 * @param opts.from ISO-8601 start
 * @param opts.to   ISO-8601 end
 * @param opts.strategy which strategy to analyze (default DOUBLE_CALENDAR)
 * @param opts.refresh bypass caches and re-fetch from Schwab
 */
export async function getTrades(opts: {
    from: string;
    to: string;
    strategy?: StrategyId;
    refresh?: boolean;
}): Promise<TradesResult> {
    const strategy: StrategyId = opts.strategy ?? 'DOUBLE_CALENDAR';
    const account = firstSchwabAccount();
    const hash = account.accountIdKey ?? account.key;

    return withRedis(async (redis) => {
        const pKey = parsedKey(strategy, hash, opts.from, opts.to);

        if (!opts.refresh) {
            const cachedParsed = await readJson<TradesResult>(redis, pKey);
            if (cachedParsed) {
                return { ...cachedParsed, cached: true };
            }
        }

        const transactions = await getRawTransactions(redis, account, hash, opts.from, opts.to, opts.refresh);

        const orderGroups = normalizeToOrderGroups(transactions);
        const allTrades = buildTrades(orderGroups);
        const trades = allTrades.filter(t => t.strategy === strategy);
        const metrics = computeMetrics(strategy, trades);
        const equityCurve = cumulativePnlSeries(trades);

        const result: TradesResult = {
            strategy,
            range: { from: opts.from, to: opts.to },
            trades,
            metrics,
            equityCurve,
            cached: false,
            fetchedAt: new Date().toISOString(),
        };

        await writeJson(redis, pKey, result, PARSED_TTL_SECONDS);
        return result;
    });
}

async function getRawTransactions(
    redis: RedisClientType,
    account: AccountConfig,
    hash: string,
    from: string,
    to: string,
    refresh?: boolean,
): Promise<SchwabTransaction[]> {
    const key = rawKey(hash, from, to);

    if (!refresh) {
        const cached = await readJson<SchwabTransaction[]>(redis, key);
        if (cached) return cached;
    }

    const client = new SchwabClient({
        name: account.name,
        clientId: account.key,
        clientSecret: account.secret,
        accessToken: account.accessToken,
        refreshToken: account.refreshToken,
        accountHash: account.accountIdKey,
        redis,
    });

    const transactions = await client.getTransactions({ startDate: from, endDate: to, types: 'TRADE' });
    await writeJson(redis, key, transactions, RAW_TTL_SECONDS);
    return transactions;
}

async function readJson<T>(redis: RedisClientType, key: string): Promise<T | null> {
    try {
        const data = await redis.get(key);
        return data ? (JSON.parse(data) as T) : null;
    } catch (e) {
        console.warn(`Cache read failed for ${key}:`, e);
        return null;
    }
}

async function writeJson(redis: RedisClientType, key: string, value: unknown, ttl: number): Promise<void> {
    try {
        await redis.set(key, JSON.stringify(value), { EX: ttl });
    } catch (e) {
        console.warn(`Cache write failed for ${key}:`, e);
    }
}
