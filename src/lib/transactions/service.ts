import { differenceInCalendarDays, parseISO } from 'date-fns';
import type { RedisClientType } from 'redis';
import { getConfiguredAccounts, BrokerType, type AccountConfig } from '@/config/accounts';
import { SchwabClient, type SchwabQuote, type SchwabTransaction } from '@/live/schwabClient';
import { withRedis } from '@/lib/redis';
import { normalizeToOrderGroups } from '@/lib/strategy/normalize';
import { buildTrades, safeHoldDays } from '@/lib/strategy/pairing';
import { computeMetrics, cumulativePnlSeries } from '@/lib/strategy/metrics';
import type { StrategyId, StrategyMetrics, StrategyTrade } from '@/lib/strategy/types';

/** Bump when detection/normalization logic changes, to invalidate cached results. */
const STRATEGY_VERSION = 'v23';
/** TTL for cached raw transactions and parsed results (seconds). */
const RAW_TTL_SECONDS = 15 * 60;
const PARSED_TTL_SECONDS = 15 * 60;
/** Schwab's /transactions endpoint rejects ranges wider than ~1 year; stay just under it. */
const SCHWAB_MAX_LOOKBACK_DAYS = 364;

/**
 * Schwab's `/quotes` endpoint doesn't recognize an option's underlying root
 * (e.g. "SPXW") as a quotable symbol for cash-settled indexes — it wants the
 * $-prefixed index symbol instead. Equity/ETF underlyings (QQQ, SPY, ...)
 * need no translation. See `tosUnderlying` in lib/convert/buildOrderString.ts
 * for the analogous (but separate) SPXW->SPX root-stripping used there.
 */
const INDEX_QUOTE_SYMBOLS: Record<string, string> = {
    SPX: '$SPX', SPXW: '$SPX',
    NDX: '$NDX', NDXP: '$NDX',
    RUT: '$RUT', RUTW: '$RUT',
    VIX: '$VIX', VIXW: '$VIX',
};

function quoteSymbolFor(underlying: string): string {
    return INDEX_QUOTE_SYMBOLS[underlying] ?? underlying;
}

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

/**
 * True when a trade's open or close falls anywhere inside [from, to].
 * Checks every fill that contributed to the open side (`openFillTimes`), not
 * just the earliest (`openedAt`) — a position first opened before the
 * requested range but increased again inside it (see `mergeIntoOpenLot` in
 * pairing.ts) must still show up, since that later fill is genuinely
 * in-range activity even though the position's overall display open date
 * isn't.
 */
function tradeInRange(trade: StrategyTrade, from: string, to: string): boolean {
    const openTimes = trade.openFillTimes && trade.openFillTimes.length > 0 ? trade.openFillTimes : [trade.openedAt];
    const closed = trade.closedAt ?? trade.openedAt;
    return openTimes.some(opened => opened >= from && opened <= to) || (closed >= from && closed <= to);
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
        // A small subset of trades can also get permanently finalized here
        // (see `applyUnrealizedPnl`'s expired-worthless handling) — once a
        // trade is confirmed closed that way, the decision must be written
        // back to the parsed-trade cache so it becomes a durable fact rather
        // than something re-derived from a fresh live quote on every future
        // request. Re-deriving it live would be unsound: a leg's `itm` flag
        // reflects *today's* price, not the price at its own expiration, so
        // a later price move could otherwise flip an already-settled
        // position's classification back and forth on every reparse.
        const finalized = await applyUnrealizedPnl(allTrades, account, redis);
        if (finalized) {
            await writeJson(redis, pKey, { strategies, range: { from: fetchFrom, to: opts.to }, trades: allTrades, cached: false, fetchedAt } as TradesResult, PARSED_TTL_SECONDS);
        }

        // Remaining DTE depends on "now", not the cached trade's open time, so
        // it's recomputed fresh on every request regardless of cache status.
        applyRemainingDte(allTrades);

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
): Promise<boolean> {
    let anyFinalized = false;
    const openTrades = trades.filter(t => t.status === 'open');
    if (openTrades.length === 0) return anyFinalized;

    const optionSymbols = Array.from(
        new Set(
            openTrades.flatMap(t => t.legs.filter(l => l.openClose === 'OPEN').map(l => l.symbol)).filter((s): s is string => !!s),
        ),
    );
    // Underlyings for every open leg's own symbol (not just option symbols) —
    // fetched in the same batch so ITM status can be derived alongside
    // mark-to-market P&L without a second round-trip. Schwab's /quotes
    // endpoint accepts equity symbols the same as option symbols.
    const underlyingSymbols = Array.from(
        new Set(openTrades.flatMap(t => t.legs.filter(l => l.openClose === 'OPEN').map(l => quoteSymbolFor(l.underlying)))),
    );
    const symbols = Array.from(new Set([...optionSymbols, ...underlyingSymbols]));
    if (symbols.length === 0) return anyFinalized;

    const client = new SchwabClient({
        name: account.name,
        clientId: account.key,
        clientSecret: account.secret,
        accessToken: account.accessToken,
        refreshToken: account.refreshToken,
        accountHash: account.accountIdKey,
        redis,
    });

    // `SchwabQuote` declares mark/lastPrice as always-present numbers, but in
    // practice an index underlying's (e.g. SPX) quote payload can omit mark —
    // Partial<> here reflects that and forces the ITM fallback below to be
    // null-checked rather than trusting the declared type.
    let quotes: Record<string, Partial<SchwabQuote>>;
    try {
        quotes = await client.getQuotes(symbols);
    } catch (e) {
        console.warn('Failed to fetch live quotes for unrealized P&L:', e);
        return anyFinalized;
    }

    const OPTION_MULTIPLIER = 100;
    const now = new Date().toISOString();
    for (const trade of openTrades) {
        let closeValue = 0;
        let missingQuote = false;
        // A STRANGLE's `legs` may include legs already closed independently
        // (see pairing.ts's `closeStrangleLeg`/`closedLegs`) — those already
        // carry final realized openNet/closeNet/pnl and must not be re-priced,
        // but their locked-in P&L still has to count toward the whole trade's
        // total below (realizedLegPnl), not just the still-open leg's live mark.
        let realizedLegPnl = 0;
        let realizedLegCloseNet = 0;
        // Tracks whether every still-open leg has both expired *and* been
        // confirmed out-of-the-money (not just expired — an ITM leg would
        // have settled via assignment/exercise for real value, not $0) — see
        // the status-flip check after this loop. `openLegCount` guards
        // against flipping a trade with zero still-open legs (shouldn't
        // happen, but a wrongly-empty `legs` shouldn't silently look "done").
        // `stillOpenLegs` collects the actual Leg objects so they can be
        // finalized (flipped to CLOSE) in place once the trade itself is.
        let openLegCount = 0;
        let allExpiredWorthless = true;
        let latestExpiration: string | null = null;
        const stillOpenLegs: typeof trade.legs = [];
        for (const leg of trade.legs) {
            if (leg.openClose === 'CLOSE') {
                if (trade.strategy === 'STRANGLE' && leg.pnl != null) realizedLegPnl += leg.pnl;
                if (trade.strategy === 'STRANGLE' && leg.closeNet != null) realizedLegCloseNet += leg.closeNet;
                continue;
            }
            // ITM only needs the underlying's own price, not the option's
            // quote — compute it before the option-quote early exit below so
            // a missing/stale option symbol doesn't also suppress ITM for
            // this leg (and, since `missingQuote` aborts the whole trade,
            // every later leg too). Index underlyings (e.g. SPX) often don't
            // carry `mark` on their quote payload, so fall back to `lastPrice`.
            const underlyingQuote = quotes[quoteSymbolFor(leg.underlying)];
            const underlyingPrice = typeof underlyingQuote?.mark === 'number'
                ? underlyingQuote.mark
                : typeof underlyingQuote?.lastPrice === 'number'
                    ? underlyingQuote.lastPrice
                    : undefined;
            if (underlyingPrice != null) {
                leg.itm = leg.right === 'CALL'
                    ? underlyingPrice > leg.strike
                    : underlyingPrice < leg.strike;
                trade.underlyingPrice = underlyingPrice;
            }

            const quote = leg.symbol ? quotes[leg.symbol] : undefined;
            const hasQuote = !!quote && typeof quote.mark === 'number';
            // Schwab stops quoting an option once it's past expiration — a
            // leg nobody explicitly closed (e.g. it expired worthless
            // out-of-the-money, with no assignment/exercise transaction)
            // would otherwise trip `missingQuote` and silently drop the
            // *entire* trade's P&L. We actually know the right value for an
            // expired leg with no quote — 0, since it's no longer tradeable —
            // so price it at 0 instead of aborting the whole trade. A leg
            // still quoted despite being past expiration (e.g. same-day
            // expiry still settling) is priced normally from its live mark.
            const expired = differenceInCalendarDays(parseISO(leg.expiration), parseISO(now)) < 0;
            if (!hasQuote && !expired) {
                missingQuote = true;
                break;
            }
            const mark = hasQuote ? quote!.mark! : 0;
            closeValue += leg.quantity * mark * OPTION_MULTIPLIER;

            openLegCount++;
            stillOpenLegs.push(leg);
            if (!latestExpiration || leg.expiration > latestExpiration) latestExpiration = leg.expiration;
            // Confirmed worthless requires both: expired (no longer
            // tradeable) AND known to be OTM (leg.itm === false, not just
            // undefined — an ITM leg settles via assignment/exercise for
            // real value, so treating it as a $0 close would be wrong; see
            // Codex's PR #9 review). A leg still priced by a live quote
            // despite being past expiration (e.g. same-day expiry still
            // settling) isn't "confirmed worthless" either — its mark is the
            // real closing value, not a synthesized $0.
            if (!(expired && !hasQuote && leg.itm === false)) allExpiredWorthless = false;

            // Per-leg mark-to-market, STRANGLE only — powers the UI's per-leg
            // detail row. Same math as the whole-trade figure below, just
            // scoped to this one leg's own openNet/closeValue.
            if (trade.strategy === 'STRANGLE' && leg.openNet != null) {
                const legCloseValue = leg.quantity * mark * OPTION_MULTIPLIER;
                const legPnl = leg.openNet + legCloseValue;
                leg.closeNet = legCloseValue;
                leg.pnl = legPnl;
                leg.pnlIsEstimate = true;
                leg.pctGain = leg.openNet !== 0 ? (legPnl / Math.abs(leg.openNet)) * 100 : undefined;
            }
        }
        if (missingQuote) continue;

        // Whole-trade P&L = live mark-to-market of the still-open leg(s) plus
        // any already-locked-in P&L from a leg closed independently earlier —
        // otherwise a strangle with one leg already closed would silently
        // drop that realized profit/loss from its total. `trade.openNet` here
        // is already just the still-open leg's own share (see
        // `OpenLot.remainingOpenNet` in pairing.ts), so it only pairs with
        // `closeValue`; `realizedLegPnl` is added on top, not blended in.
        const pnl = trade.openNet + closeValue + realizedLegPnl;
        trade.pnl = pnl;
        const totalOpenNet = trade.openNet + trade.legs.filter(l => l.openClose === 'CLOSE').reduce((s, l) => s + (l.openNet ?? 0), 0);
        trade.pctGain = totalOpenNet !== 0 ? (pnl / Math.abs(totalOpenNet)) * 100 : undefined;

        // Every still-open leg confirmed expired-and-OTM (see the per-leg
        // loop above) means the position is genuinely done — Schwab just
        // never generated an explicit closing transaction for the worthless
        // expiration. Flip it to closed with a real (not estimated) $0
        // close instead of leaving it looking perpetually "open".
        if (openLegCount > 0 && allExpiredWorthless && latestExpiration) {
            trade.status = 'closed';
            trade.closedAt = latestExpiration;
            // Promote openNet to the trade's *total* basis (both legs, not
            // just the still-open share) and closeNet to the sum of every
            // leg's actual close cash (the expired leg's $0 plus any
            // already-realized sibling close), so `openNet + closeNet ===
            // pnl` holds for this now-completed trade the same way it does
            // for any other closed trade in the table.
            trade.openNet = totalOpenNet;
            trade.closeNet = realizedLegCloseNet;
            // `daysOpen` uses the latest leg expiration, not wall-clock
            // "now" — otherwise an already-finished trade's holding period
            // would keep growing every day it's reparsed.
            trade.daysOpen = safeHoldDays(trade.openedAt, latestExpiration);
            // Finalize the still-open leg objects too — otherwise expanding
            // this now-closed trade's per-leg detail row would still show
            // them as "open" with an estimate marker (`legDetailRows` in
            // TradesTable.tsx reads these fields directly off the leg).
            for (const leg of stillOpenLegs) {
                leg.openClose = 'CLOSE';
                leg.closeNet = 0;
                leg.pnl = leg.openNet ?? 0;
                leg.pnlIsEstimate = false;
                leg.pctGain = leg.openNet && leg.openNet !== 0 ? (leg.pnl / Math.abs(leg.openNet)) * 100 : undefined;
            }
            anyFinalized = true;
        } else {
            trade.pnlIsEstimate = true;
        }
    }
    return anyFinalized;
}

/**
 * Set each trade's `dte` to the remaining calendar days to its nearest
 * expiration, measured from now and floored at 0. `expirations` is sorted
 * ascending, so `expirations[0]` is always the near leg.
 */
function applyRemainingDte(trades: StrategyTrade[]): void {
    const now = new Date().toISOString();
    for (const trade of trades) {
        const nearExpiration = trade.expirations[0];
        if (!nearExpiration) {
            trade.dte = undefined;
            continue;
        }
        try {
            trade.dte = Math.max(0, differenceInCalendarDays(parseISO(nearExpiration), parseISO(now)));
        } catch {
            trade.dte = undefined;
        }
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
