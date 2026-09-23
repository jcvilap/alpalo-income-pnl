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
    | 'JADE_LIZARD'
    | 'IRON_CONDOR'
    | 'STRANGLE'
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

    closeOrderId?: string;
    closedAt?: string;
    /** Net cash of the closing order (positive = credit received to close). */
    closeNet?: number;

    /** Realized P&L = openNet + closeNet. Undefined while open. */
    realizedPnl?: number;
    /** Calendar days held (open→close). Undefined while open. */
    holdDays?: number;

    /** Human-readable leg summary for the UI. */
    legs: Leg[];
    /** Distinct strikes involved, sorted ascending. */
    strikes: number[];
    /** Distinct expirations involved, sorted ascending. */
    expirations: string[];
}

export interface StrategyMetrics {
    strategy: StrategyId;
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
    /** grossProfit / |grossLoss|; Infinity when there are wins but no losses. */
    profitFactor: number;
    avgHoldDays: number;
    bestTrade: number;
    worstTrade: number;
}
