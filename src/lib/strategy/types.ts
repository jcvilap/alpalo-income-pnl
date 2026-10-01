/**
 * Normalized domain model for strategy detection & P&L.
 *
 * Schwab transactions are messy (per-leg transfer items, fee items, signed
 * amounts). We normalize them into `OrderGroup`s (one per Schwab orderId, since
 * the user opens/closes each strategy as a single multi-leg order), classify
 * each group against pluggable `StrategyRule`s, then pair opening groups with
 * their closing groups to form completed `StrategyTrade`s for P&L.
 */

export type OptionRight = 'CALL' | 'PUT';
export type OpenClose = 'OPEN' | 'CLOSE';

/** Known strategy identifiers. Extend this union as new rules are added. */
export type StrategyId =
    | 'DOUBLE_CALENDAR'
    | 'DOUBLE_DIAGONAL'
    | 'CALENDAR'
    | 'DIAGONAL'
    | 'JADE_LIZARD'
    | 'IRON_CONDOR'
    | 'BUTTERFLY'
    | 'STRANGLE'
    | 'LEAPS'
    | 'UNKNOWN';

/** A single option leg within an order (fees excluded). */
export interface Leg {
    underlying: string;
    right: OptionRight;
    strike: number;
    /** ISO-8601 expiration date (yyyy-mm-dd granularity is enough). */
    expiration: string;
    /** Signed contract quantity: positive = long (bought), negative = short (sold). */
    quantity: number;
    openClose: OpenClose;
    /** Per-contract price. */
    price: number;
    /** OCC option symbol as reported by Schwab. */
    symbol?: string;
    /**
     * This leg's own share of entry cash (-quantity * price * 100). Populated
     * for STRANGLE legs only, so the UI's per-leg detail row can show each
     * leg's own open/close/P&L figures — see `legNetAmount` in rules.ts and
     * the detail-row synthesis in `TradesTable.tsx`.
     */
    openNet?: number;
    /** This leg's own live mark-to-market close value, once quoted. STRANGLE legs only. */
    closeNet?: number;
    /**
     * ISO-8601 instant this specific leg was closed (by its own closing
     * order, or by confirmed-worthless expiration) — independent of the
     * parent trade's `closedAt`, which only reflects when the *whole*
     * position finished. Set alongside `closeNet`/`pnl` whenever a leg
     * closes; stays unset while `openClose === 'OPEN'`. STRANGLE legs only.
     */
    closedAt?: string;
    /** This leg's own P&L: realized (closeNet != null) or live estimate. STRANGLE legs only. */
    pnl?: number;
    /** True when `pnl` is a live mark-to-market estimate rather than realized cash. */
    pnlIsEstimate?: boolean;
    /** pnl / |openNet| as a percentage. */
    pctGain?: number;
    /**
     * True when this leg is currently in-the-money: underlying mark > strike
     * for a CALL, or underlying mark < strike for a PUT. Only set for open
     * legs of open trades, once the underlying's live quote is available —
     * see `applyItmFlags` in transactions/service.ts.
     */
    itm?: boolean;
}

/** All legs that share one Schwab orderId. */
export interface OrderGroup {
    orderId: string;
    /** ISO-8601 execution time (earliest transferItem time in the order). */
    time: string;
    underlying: string;
    legs: Leg[];
    /**
     * Signed net cash for the order: negative = net debit paid,
     * positive = net credit received. Sum of transaction netAmounts.
     */
    netAmount: number;
}

/** A detected strategy occurrence on a single order (before open/close pairing). */
export interface StrategyMatch {
    strategy: StrategyId;
    order: OrderGroup;
    /** OPEN if the order opened the position, CLOSE if it closed it. */
    side: OpenClose;
    /**
     * Stable signature of the leg set (rights/strikes/expirations) used to pair
     * an opening order with its matching closing order.
     */
    signature: string;
}

/** A completed or still-open strategy trade with realized P&L when closed. */
export interface StrategyTrade {
    id: string;
    strategy: StrategyId;
    underlying: string;
    status: 'open' | 'closed';

    openOrderId: string;
    openedAt: string;
    /** Net cash of the opening order (negative = debit paid to open). */
    openNet: number;
    /**
     * Every distinct fill time that contributed to this position's open side
     * — usually just `[openedAt]`, but a position increased on a later day
     * (see `mergeIntoOpenLot` in pairing.ts) has one entry per merged order.
     * `openedAt` stays the *earliest* of these for display, but range
     * filtering (`tradeInRange` in transactions/service.ts) checks every
     * entry here so a fresh in-range addition to an old position doesn't
     * disappear just because the position's original open predates the
     * requested range.
     */
    openFillTimes?: string[];

    closeOrderId?: string;
    closedAt?: string;
    /** Net cash of the closing order (positive = credit received to close). */
    closeNet?: number;

    /**
     * P&L: realized (openNet + closeNet) when closed, or a live mark-to-market
     * estimate (openNet + current value of the open legs) when open.
     */
    pnl?: number;
    /** True when `pnl` is a live estimate (open trade) rather than realized cash. */
    pnlIsEstimate?: boolean;
    /**
     * True for a standalone closed-leg record (see `closeStrangleLeg` in
     * pairing.ts) whose sibling leg is still open — that leg's realized `pnl`
     * is also folded into the still-open sibling trade's own `pnl` (see
     * `realizedLegPnl` in `applyUnrealizedPnl`), so this record must be
     * excluded from aggregate metrics to avoid double-counting the same
     * realized result. The row still displays normally in the trades table —
     * only `computeMetrics` needs to skip it.
     */
    excludeFromMetrics?: boolean;
    /** pnl / |openNet| as a percentage, e.g. debit 10 -> credit 11.5 is +15. */
    pctGain?: number;
    /** Calendar days held: open->close when closed, open->now when still open. */
    daysOpen?: number;
    /**
     * Remaining days to the nearest expiration, measured from now (clamped to
     * 0 once expired). Recomputed fresh on every request — never cached —
     * since "remaining" only makes sense relative to the current date. See
     * `applyRemainingDte` in `lib/transactions/service.ts`.
     */
    dte?: number;
    /** Number of contracts traded per leg (max absolute leg quantity at open). */
    contracts?: number;

    /** Human-readable leg summary for the UI. */
    legs: Leg[];
    /** Distinct strikes involved, sorted ascending. */
    strikes: number[];
    /** Distinct expirations involved, sorted ascending. */
    expirations: string[];
    /**
     * Original days-to-expiration (at open) for each entry in `expirations`,
     * same order/index. E.g. expirations[i] was `expirationDtes[i]` days out
     * when the trade was opened.
     */
    expirationDtes: number[];
    /**
     * Live underlying mark (or lastPrice fallback) at the time of the last
     * quote fetch. Only set for open trades — see `applyUnrealizedPnl` in
     * transactions/service.ts. Powers the strikes-vs-price range gauge in
     * the UI.
     */
    underlyingPrice?: number;
}

export interface StrategyMetrics {
    strategies: StrategyId[];
    totalTrades: number;
    closedTrades: number;
    openTrades: number;
    wins: number;
    losses: number;
    /** Fraction 0..1 of closed trades with realizedPnl > 0. */
    winRate: number;
    totalPnl: number;
    /** Average realized P&L across closed trades. */
    avgPnl: number;
    avgWin: number;
    avgLoss: number;
    /** Average pctGain across winning / losing closed trades. Undefined when unavailable (e.g. no cost basis). */
    avgWinPct?: number;
    avgLossPct?: number;
    avgHoldDays: number;
    bestTrade: number;
    worstTrade: number;
    /** pctGain of the single best / worst closed trade by dollar P&L. Undefined when it has no cost basis (e.g. unmatched close). */
    bestTradePct?: number;
    worstTradePct?: number;
}
