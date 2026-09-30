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
const STRATEGY_VERSION = 'v29';
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

/**
 * Root symbols that settle AM — against a special opening quotation (SOQ)
 * computed from constituent opening prices, not the previous day's
 * regular-session close `getPriceOnDate` returns. Confirming worthlessness
 * for an AM-settled leg would need that special settlement value, not the
 * close — since that's not available here, these legs are simply never
 * auto-finalized (left `status: 'open'` rather than risking a wrong $0
 * close from a close/settlement mismatch; see Codex's PR #10 review).
 *
 * Most weekly counterparts (SPXW, RUTW, NDXP) are a genuinely different,
 * PM-settled series and correctly settle against daily close, so they're
 * excluded here. VIXW is the exception: CBOE's own product spec settles
 * both VIX and VIXW against the same VRO special opening quotation — VIXW
 * does NOT follow the SPXW pattern despite the naming similarity. See
 * https://www.cboe.com/tradable_products/vix/vix_options/specifications
 * ("The exercise-settlement value for VIX/VIXW options (Ticker: VRO)...").
 */
const AM_SETTLED_ROOTS = new Set(['SPX', 'NDX', 'RUT', 'VIX', 'VIXW']);

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
 * Key for a trade's *durable* finalization record — independent of the
 * short-lived, date-range/strategy-scoped `parsedKey` cache. `trade.id` is
 * deterministic from the underlying Schwab order (see `buildTrades` in
 * pairing.ts: `open-${orderId}-${remainingContracts}`), so it's stable
 * across any query combination that happens to include this trade, unlike
 * `parsedKey` which changes per date range/strategy selection. See
 * `FinalizedTrade` for why this needs to exist at all.
 */
function finalizedKey(hash: string, tradeId: string): string {
    return `incomepnl:finalized:${STRATEGY_VERSION}:${hash}:${tradeId}`;
}
/** TTL for a durable finalization record — long enough to outlive Schwab's own ~1-year transaction lookback, since a trade older than that will never be re-fetched/re-evaluated anyway. */
const FINALIZED_TTL_SECONDS = 400 * 24 * 60 * 60;

/**
 * The fields `applyUnrealizedPnl` computes once when it confirms a trade
 * expired worthless — persisted independently of the parsed-trade query
 * cache (see `finalizedKey`) so the decision survives that cache's 15-minute
 * TTL and applies no matter which date-range/strategy combination later
 * requests this same trade. Without this, `buildTrades` would reconstruct
 * the trade as `status: 'open'` on the next cache miss and re-evaluate
 * worthlessness against *that request's* live price — unsound, since a
 * later price move back across the strike could flip an already-settled
 * position's classification back and forth forever (see Codex's PR #10
 * review).
 */
interface FinalizedTrade {
    closedAt: string;
    closeNet: number;
    openNet: number;
    pnl: number;
    pctGain?: number;
    daysOpen: number;
    /** Per-leg finalized fields, matched back onto `trade.legs` by (right, strike, expiration) since leg array order isn't guaranteed stable. */
    legs: { right: string; strike: number; expiration: string; closedAt: string; closeNet: number; pnl: number; pctGain?: number }[];
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
    if (openTimes.some(opened => opened >= from && opened <= to) || (closed >= from && closed <= to)) return true;
    // A strangle opened before `from` with one leg closed independently
    // inside the range, while its sibling stays open, has real portfolio
    // activity in this window even though the trade's own openedAt/closedAt
    // both fall outside it (closedAt is unset — the position as a whole
    // isn't done yet). Closing that leg no longer emits its own separate
    // row (see pairing.ts's closeStrangleLeg — one strangle is always one
    // row, not two), so without this check that activity would silently
    // vanish from a historical report scoped to this range entirely.
    return trade.legs.some(l => l.closedAt != null && l.closedAt >= from && l.closedAt <= to);
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

        // Apply any trade already durably confirmed expired-worthless in a
        // *previous* request, no matter which date-range/strategy query
        // produced `allTrades` this time — the parsed-trade cache above is
        // scoped per query combination and only 15 minutes deep, so relying
        // on it alone would let a trade re-appear as "open" (and get
        // re-evaluated against a fresh, possibly different, live price) the
        // moment a different filter combination or a cache expiry hits it.
        // See `finalizedKey`/`FinalizedTrade`.
        const stillOpen = allTrades.filter(t => t.status === 'open');
        const finalizedRecords = await Promise.all(
            stillOpen.map(t => readJson<FinalizedTrade>(redis, finalizedKey(hash, t.id))),
        );
        for (let i = 0; i < stillOpen.length; i++) {
            const record = finalizedRecords[i];
            // A record confirmed closed after this request's own fetch
            // horizon (opts.to) can't be applied here — this request only
            // asked Schwab for transactions through opts.to, so surfacing a
            // later close/realized P&L would show the user information a
            // historical report at this horizon couldn't actually have
            // known yet (e.g. a custom report ending before the expiration
            // that later confirmed it worthless). Leave the trade as
            // whatever buildTrades/live-quote logic already determined.
            if (!record || record.closedAt > opts.to) continue;
            applyFinalizedRecord(stillOpen[i], record);
        }

        // Mark-to-market open trades with live quotes on every request, whether
        // the underlying trade list came from cache or a fresh Schwab fetch.
        // A small subset of trades can also get permanently finalized here
        // (see `applyUnrealizedPnl`'s expired-worthless handling) — once a
        // trade is confirmed closed that way, the decision is written to its
        // own durable `finalizedKey` record (source of truth, checked above
        // on every future request regardless of query params) and also back
        // into this request's parsed-trade cache entry so the *current* view
        // reflects it immediately without waiting for the next cache miss.
        const finalized = await applyUnrealizedPnl(allTrades, account, redis, hash, opts.to);
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
 * Apply a previously-persisted `FinalizedTrade` record onto a freshly
 * rebuilt trade (still `status: 'open'` because `buildTrades` has no memory
 * of prior finalizations — see `finalizedKey`). Matches each finalized leg
 * back onto `trade.legs` by (right, strike, expiration) rather than array
 * index, since leg order isn't guaranteed stable across rebuilds.
 */
function applyFinalizedRecord(trade: StrategyTrade, record: FinalizedTrade): void {
    trade.status = 'closed';
    trade.closedAt = record.closedAt;
    trade.closeNet = record.closeNet;
    trade.openNet = record.openNet;
    trade.pnl = record.pnl;
    trade.pctGain = record.pctGain;
    trade.daysOpen = record.daysOpen;
    trade.pnlIsEstimate = false;
    trade.underlyingPrice = undefined;
    for (const leg of trade.legs) {
        if (leg.openClose === 'CLOSE') continue;
        const finalizedLeg = record.legs.find(
            l => l.right === leg.right && l.strike === leg.strike && l.expiration === leg.expiration,
        );
        if (!finalizedLeg) continue;
        leg.openClose = 'CLOSE';
        leg.closedAt = finalizedLeg.closedAt;
        leg.closeNet = finalizedLeg.closeNet;
        leg.pnl = finalizedLeg.pnl;
        leg.pctGain = finalizedLeg.pctGain;
        leg.pnlIsEstimate = false;
        leg.itm = undefined;
    }
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
    /** Cache-key namespace for this account, used to write a finalized trade's durable record (see `finalizedKey`). */
    hash: string,
    /**
     * The raw-transaction fetch's own horizon (`opts.to` from `getTrades`) —
     * the last date we actually asked Schwab for closing transactions. A
     * leg expiring after this date can't be "confirmed to have no closing
     * transaction", because we never fetched far enough to find one if it
     * existed; only expirations on or before this horizon are eligible for
     * the expired-worthless finalization below. Wall-clock "now" alone
     * isn't a safe substitute — a custom report range ending in the past
     * would otherwise let this fire for expirations we haven't looked at
     * yet (see Codex's PR #9 review).
     */
    fetchHorizon: string,
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
    // Dedupes historical-price lookups across trades/legs that share the
    // same underlying+expiration (e.g. two strangles on the same symbol
    // expiring the same day) — Schwab's price-history endpoint is a
    // separate network call per (symbol, date) pair, not part of the
    // `getQuotes` batch above.
    const settlementPriceCache = new Map<string, Promise<number | null>>();
    const settlementPriceFor = (underlying: string, expiration: string): Promise<number | null> => {
        const key = `${underlying}:${expiration}`;
        let pending = settlementPriceCache.get(key);
        if (!pending) {
            pending = client.getPriceOnDate(quoteSymbolFor(underlying), expiration).catch(e => {
                console.warn(`Failed to fetch settlement price for ${key}:`, e);
                return null;
            });
            settlementPriceCache.set(key, pending);
        }
        return pending;
    };
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
        let allExpiredWithinHorizonAndNoQuote = true;
        let latestExpiration: string | null = null;
        const stillOpenLegs: typeof trade.legs = [];
        // Legs eligible for finalization pending a settlement-price check
        // (see after this loop) — expired, no live quote, within the
        // fetched horizon. `leg.itm` is deliberately NOT used to decide this
        // (it reflects *today's* price for the ITM badge elsewhere in the
        // UI, not the price at the leg's own expiration — using it here
        // previously let a later price move flip an already-settled
        // position's classification; see Codex's PR #10 review).
        const candidateWorthlessLegs: typeof trade.legs = [];
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
            // Finalization-eligible requires: expired (no longer
            // tradeable), no live quote (Schwab's own signal that it's done
            // trading), and within the horizon we actually fetched closing
            // transactions through (`fetchHorizon` — a custom report ending
            // in the past hasn't looked far enough ahead to rule out a real
            // close existing after it, so "no closing transaction found"
            // isn't a safe conclusion past that point; see Codex's PR #9
            // review). Whether it's actually *worthless* is checked after
            // this loop using the settlement price at expiration, not
            // today's price — see `candidateWorthlessLegs` below.
            const expiredWithinFetchedHorizon = expired && leg.expiration <= fetchHorizon;
            if (expiredWithinFetchedHorizon && !hasQuote) {
                candidateWorthlessLegs.push(leg);
            } else {
                allExpiredWithinHorizonAndNoQuote = false;
            }

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

        // Confirm worthlessness using the settlement price at each
        // candidate leg's own expiration date, not today's — the whole
        // point of checking is that today's price can be on either side of
        // the strike regardless of where it was on the day the option
        // actually stopped trading. A candidate leg is worthless only when
        // the historical price is known and lands strictly on the losing
        // side of the strike for whoever is long it; a missing/ambiguous
        // history (e.g. a de-listed or halted symbol) leaves the trade open
        // rather than guessing.
        let allExpiredWorthless = allExpiredWithinHorizonAndNoQuote && openLegCount > 0;
        if (allExpiredWorthless) {
            for (const leg of candidateWorthlessLegs) {
                if (AM_SETTLED_ROOTS.has(leg.underlying)) {
                    allExpiredWorthless = false;
                    break;
                }
                const settlementPrice = await settlementPriceFor(leg.underlying, leg.expiration);
                const confirmedWorthless = settlementPrice != null && (
                    leg.right === 'CALL' ? settlementPrice <= leg.strike : settlementPrice >= leg.strike
                );
                if (!confirmedWorthless) {
                    allExpiredWorthless = false;
                    break;
                }
            }
        }

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
            // `closedAt` must be a full ISO instant, not a bare yyyy-mm-dd —
            // `tradeInRange` compares it lexicographically against
            // `opts.from`/`opts.to`, which are always full ISO instants
            // (see the API route's `toIso`), and a bare date string sorts
            // *before* any same-day ISO instant ("2026-09-04" < "2026-09-04T00:00:00.000Z"
            // is false, since "" < "T..." lexicographically) — that would
            // wrongly exclude a trade that finalized on the range's first day.
            trade.closedAt = `${latestExpiration}T23:59:59.999Z`;
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
                // This leg's own close date is its own expiration — not
                // necessarily `latestExpiration` (the trade-level value),
                // which is the *latest* across all still-open legs and only
                // matches this leg's own date when there's just one.
                leg.closedAt = `${leg.expiration}T23:59:59.999Z`;
                leg.closeNet = 0;
                leg.pnl = leg.openNet ?? 0;
                leg.pnlIsEstimate = false;
                leg.pctGain = leg.openNet && leg.openNet !== 0 ? (leg.pnl / Math.abs(leg.openNet)) * 100 : undefined;
                leg.itm = undefined;
            }
            // Clear the live-quote snapshot now that the trade is done —
            // it's a frozen "as of last live check" reading, not a current
            // price, and a closed trade has nothing left to compare it
            // against (see the Range column's `status === 'closed'` guard
            // in TradesTable.tsx).
            trade.underlyingPrice = undefined;
            // This trade's `pnlIsEstimate` could already be `true` from a
            // previous request's cache write (this same parsed-trade list
            // gets rewritten whenever *any* trade in it finalizes, not just
            // this one) — clear it explicitly rather than leaving whatever
            // was already there, since the P&L is now realized, not a live
            // mark-to-market estimate (see Codex's PR #10 review).
            trade.pnlIsEstimate = false;
            anyFinalized = true;

            const record: FinalizedTrade = {
                closedAt: trade.closedAt,
                closeNet: trade.closeNet,
                openNet: trade.openNet,
                pnl: trade.pnl!,
                pctGain: trade.pctGain,
                daysOpen: trade.daysOpen!,
                legs: stillOpenLegs.map(leg => ({
                    right: leg.right, strike: leg.strike, expiration: leg.expiration,
                    closedAt: leg.closedAt!, closeNet: leg.closeNet!, pnl: leg.pnl!, pctGain: leg.pctGain,
                })),
            };
            await writeJson(redis, finalizedKey(hash, trade.id), record, FINALIZED_TTL_SECONDS);
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
