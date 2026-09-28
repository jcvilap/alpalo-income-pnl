import type { RedisClientType } from 'redis';
import { getConfiguredAccounts, BrokerType, type AccountConfig } from '@/config/accounts';
import { SchwabClient, type SchwabTransaction } from '@/live/schwabClient';
import { withRedis } from '@/lib/redis';
import { normalizeToOrderGroups } from '@/lib/strategy/normalize';
import { buildTrades } from '@/lib/strategy/pairing';
import { computeMetrics, cumulativePnlSeries } from '@/lib/strategy/metrics';
import type { StrategyId, StrategyMetrics, StrategyTrade } from '@/lib/strategy/types';

/** Bump when detection/normalization logic changes, to invalidate cached results. */
const STRATEGY_VERSION = 'v6';
/** TTL for cached raw transactions and parsed results (seconds). */
const RAW_TTL_SECONDS = 15 * 60;
const PARSED_TTL_SECONDS = 15 * 60;
/** Schwab's /transactions endpoint rejects ranges wider than ~1 year; stay just under it. */
const SCHWAB_MAX_LOOKBACK_DAYS = 364;

export interface TradesResult {
    strategies: StrategyId[];
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

function parsedKey(strategies: StrategyId[], hash: string, from: string, to: string): string {
    const strategyKey = [...strategies].sort().join('+');
    return `incomepnl:parsed:${STRATEGY_VERSION}:${strategyKey}:${hash}:${from}:${to}`;
}

/**
 * Widen `from` to Schwab's full ~1-year lookback ending at `to` (never
 * narrower than requested, and never wider than the API allows). A trade's
 * opening order can sit well before the user's visible window, so we always
 * fetch as much history as Schwab permits to resolve real cost basis — see
 * `tradeInRange` for how the *displayed* trades still respect opts.from.
 */
function clampLookback(to: string): string {
    const earliestAllowed = new Date(new Date(to).getTime() - SCHWAB_MAX_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
    return earliestAllowed.toISOString();
}

/** True when a trade's open or close falls anywhere inside [from, to]. */
function tradeInRange(trade: StrategyTrade, from: string, to: string): boolean {
    const opened = trade.openedAt;
    const closed = trade.closedAt ?? trade.openedAt;
    return (opened >= from && opened <= to) || (closed >= from && closed <= to);
}

/**
 * Fetch (or read from cache) Schwab transactions for the range, then detect the
 * requested strategies, pair open/close orders, and compute pooled metrics.
 *
 * Caching strategy (all in the shared Redis):
 *  - parsed result cached under a version-stamped key → instant repeat loads
 *  - raw transactions cached separately → re-parse without re-hitting Schwab
 *
 * @param opts.from ISO-8601 start of the *displayed* range
 * @param opts.to   ISO-8601 end of the *displayed* range (also the fetch's end)
 * @param opts.strategies which strategies to pool together (default [DOUBLE_CALENDAR])
 * @param opts.refresh bypass caches and re-fetch from Schwab
 */
export async function getTrades(opts: {
    from: string;
    to: string;
    strategies?: StrategyId[];
    refresh?: boolean;
}): Promise<TradesResult> {
    const strategies: StrategyId[] = opts.strategies && opts.strategies.length > 0 ? opts.strategies : ['DOUBLE_CALENDAR'];
    const strategySet = new Set(strategies);
    const account = firstSchwabAccount();
    const hash = account.accountIdKey ?? account.key;

    // Always fetch the full 1-year lookback ending at `to`, not just the
    // user's selected range — a trade's opening order can sit well before the
    // visible window, and without it we'd wrongly treat the close as a $0
    // cost-basis windfall (see pairing.ts's "unmatched close" fallback).
    const fetchFrom = clampLookback(opts.to);

    return withRedis(async (redis) => {
        const pKey = parsedKey(strategies, hash, fetchFrom, opts.to);
        let allTrades: StrategyTrade[];
        let cached: boolean;
        let fetchedAt: string;

        const cachedParsed = !opts.refresh ? await readJson<TradesResult>(redis, pKey) : null;
        if (cachedParsed) {
            allTrades = cachedParsed.trades;
            cached = true;
            fetchedAt = cachedParsed.fetchedAt;
        } else {
            const transactions = await getRawTransactions(redis, account, hash, fetchFrom, opts.to, opts.refresh);
            const orderGroups = normalizeToOrderGroups(transactions);
            const classified = buildTrades(orderGroups);
            allTrades = classified.filter(t => strategySet.has(t.strategy));
            cached = false;
            fetchedAt = new Date().toISOString();

            await writeJson(redis, pKey, { strategies, range: { from: fetchFrom, to: opts.to }, trades: allTrades, cached: false, fetchedAt } as TradesResult, PARSED_TTL_SECONDS);
        }

        // Mark-to-market open trades with live quotes on every request, whether
        // the underlying trade list came from cache or a fresh Schwab fetch.
        await applyUnrealizedPnl(allTrades, account, redis);

        // Only show trades whose open or close actually falls in the user's
        // requested range — the wider fetch above exists purely to resolve
        // cost basis, not to change what's displayed.
        const trades = allTrades.filter(t => tradeInRange(t, opts.from, opts.to));

        const metrics = computeMetrics(strategies, trades);
        const equityCurve = cumulativePnlSeries(trades);

        return {
            strategies,
            range: { from: opts.from, to: opts.to },
            trades,
            metrics,
            equityCurve,
            cached,
            fetchedAt,
        };
    });
}

/**
 * Mark-to-market open trades in place using live option quotes.
 *
 * Unrealized P&L = openNet + cash from closing every open leg at its current mark.
 * A leg's quantity is signed position-delta from the opening fill (positive =
 * bought/long, negative = sold/short). Closing it reverses that delta, and Schwab's
 * own convention (see normalize.ts) is cash = -quantity * price * 100 for a fill of
 * signed size `quantity`. The closing fill's delta is `-quantity`, so its cash is
 * `-(-quantity) * mark * 100 = +quantity * mark * 100`.
 */
async function applyUnrealizedPnl(
    trades: StrategyTrade[],
    account: AccountConfig,
    redis: RedisClientType,
): Promise<void> {
    const openTrades = trades.filter(t => t.status === 'open');
    if (openTrades.length === 0) return;

    const symbols = Array.from(
        new Set(openTrades.flatMap(t => t.legs.map(l => l.symbol).filter((s): s is string => !!s))),
    );
    if (symbols.length === 0) return;

    const client = new SchwabClient({
        name: account.name,
        clientId: account.key,
        clientSecret: account.secret,
        accessToken: account.accessToken,
        refreshToken: account.refreshToken,
        accountHash: account.accountIdKey,
        redis,
    });

    let quotes: Record<string, { mark: number }>;
    try {
        quotes = await client.getQuotes(symbols);
    } catch (e) {
        console.warn('Failed to fetch live quotes for unrealized P&L:', e);
        return;
    }

    const OPTION_MULTIPLIER = 100;
    for (const trade of openTrades) {
        let closeValue = 0;
        let missingQuote = false;
        for (const leg of trade.legs) {
            const quote = leg.symbol ? quotes[leg.symbol] : undefined;
            if (!quote || typeof quote.mark !== 'number') {
                missingQuote = true;
                break;
            }
            closeValue += leg.quantity * quote.mark * OPTION_MULTIPLIER;
        }
        if (missingQuote) continue;

        const pnl = trade.openNet + closeValue;
        trade.pnl = pnl;
        trade.pnlIsEstimate = true;
        trade.pctGain = trade.openNet !== 0 ? (pnl / Math.abs(trade.openNet)) * 100 : undefined;
    }
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
