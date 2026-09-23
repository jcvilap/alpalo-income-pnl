import { differenceInCalendarDays, parseISO } from 'date-fns';
import type { OrderGroup, StrategyMatch, StrategyTrade } from './types';
import { classifyOrder } from './rules';

function distinctSorted<T>(values: T[]): T[] {
    return Array.from(new Set(values)).sort((a, b) =>
        typeof a === 'number' && typeof b === 'number'
            ? (a as number) - (b as number)
            : String(a).localeCompare(String(b))
    );
}

function toTradeShape(open: StrategyMatch) {
    const legs = open.order.legs;
    return {
        legs,
        strikes: distinctSorted(legs.map(l => l.strike)),
        expirations: distinctSorted(legs.map(l => l.expiration)),
    };
}

/**
 * Build StrategyTrades by pairing opening orders with their matching closing
 * orders. Orders are matched on `signature` (same underlying + leg structure),
 * FIFO within each signature. Unpaired opens remain `status: 'open'`.
 *
 * Realized P&L = openNet + closeNet, where each net is the signed cash of the
 * order (negative = debit paid, positive = credit received). For a debit double
 * calendar you pay to open (negative openNet) and receive to close (positive
 * closeNet); the sum is the realized profit/loss including commissions/fees.
 */
export function buildTrades(orderGroups: OrderGroup[]): StrategyTrade[] {
    const matches: StrategyMatch[] = [];
    for (const order of orderGroups) {
        const match = classifyOrder(order);
        if (match) matches.push(match);
    }

    // Chronological so FIFO pairing is correct.
    matches.sort((a, b) => a.order.time.localeCompare(b.order.time));

    // Queue of unclosed opens per signature.
    const openQueues = new Map<string, StrategyMatch[]>();
    const trades: StrategyTrade[] = [];

    for (const match of matches) {
        if (match.side === 'OPEN') {
            const q = openQueues.get(match.signature) ?? [];
            q.push(match);
            openQueues.set(match.signature, q);
            continue;
        }

        // CLOSE — pair with the oldest matching open.
        const q = openQueues.get(match.signature);
        const open = q && q.length > 0 ? q.shift() : undefined;

        if (!open) {
            // Close with no recorded open (history starts mid-trade). Record a
            // closed trade with only the close leg so P&L isn't silently lost.
            const shape = toTradeShape(match);
            trades.push({
                id: `close-${match.order.orderId}`,
                strategy: match.strategy,
                underlying: match.order.underlying,
                status: 'closed',
                openOrderId: '(unknown)',
                openedAt: match.order.time,
                openNet: 0,
                closeOrderId: match.order.orderId,
                closedAt: match.order.time,
                closeNet: match.order.netAmount,
                realizedPnl: match.order.netAmount,
                holdDays: 0,
                ...shape,
            });
            continue;
        }

        const shape = toTradeShape(open);
        const realizedPnl = open.order.netAmount + match.order.netAmount;
        const holdDays = safeHoldDays(open.order.time, match.order.time);
        trades.push({
            id: `${open.order.orderId}-${match.order.orderId}`,
            strategy: open.strategy,
            underlying: open.order.underlying,
            status: 'closed',
            openOrderId: open.order.orderId,
            openedAt: open.order.time,
            openNet: open.order.netAmount,
            closeOrderId: match.order.orderId,
            closedAt: match.order.time,
            closeNet: match.order.netAmount,
            realizedPnl,
            holdDays,
            ...shape,
        });
    }

    // Any remaining opens are still-open trades.
    for (const q of openQueues.values()) {
        for (const open of q) {
            const shape = toTradeShape(open);
            trades.push({
                id: `open-${open.order.orderId}`,
                strategy: open.strategy,
                underlying: open.order.underlying,
                status: 'open',
                openOrderId: open.order.orderId,
                openedAt: open.order.time,
                openNet: open.order.netAmount,
                ...shape,
            });
        }
    }

    // Newest first for display.
    return trades.sort((a, b) => (b.openedAt ?? '').localeCompare(a.openedAt ?? ''));
}

function safeHoldDays(open: string, close: string): number {
    try {
        return Math.max(0, differenceInCalendarDays(parseISO(close), parseISO(open)));
    } catch {
        return 0;
    }
}
