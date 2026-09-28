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

function toTradeShape(open: StrategyMatch, contracts?: number) {
    const legs = open.order.legs;
    const expirations = distinctSorted(legs.map(l => l.expiration));
    return {
        legs,
        strikes: distinctSorted(legs.map(l => l.strike)),
        expirations,
        expirationDtes: expirations.map(e => daysAt(open.order.time, e)),
        // `dte` (remaining days to expiration) is intentionally left unset
        // here — it depends on "now", not the open time, so it must be
        // computed fresh on every request. See `applyRemainingDte` in
        // lib/transactions/service.ts.
        contracts: contracts ?? matchContracts(open),
    };
}

/** Contract size of a match: max absolute leg quantity (uniform across legs of one multi-leg order). */
function matchContracts(match: StrategyMatch): number | undefined {
    const legs = match.order.legs;
    return legs.length > 0 ? Math.max(...legs.map(l => Math.abs(l.quantity))) : undefined;
}

/** A queued open with contracts consumed so far by prior partial closes. */
interface OpenLot {
    match: StrategyMatch;
    totalContracts: number;
    remainingContracts: number;
}

/** Days from `fromIso` to an expiration date, floored at 0. */
function daysAt(fromIso: string, expiration: string): number {
    try {
        return Math.max(0, differenceInCalendarDays(parseISO(expiration), parseISO(fromIso)));
    } catch {
        return 0;
    }
}

function pctGain(pnl: number | undefined, openNet: number): number | undefined {
    if (pnl == null || openNet === 0) return undefined;
    return (pnl / Math.abs(openNet)) * 100;
}

/**
 * Build StrategyTrades by pairing opening orders with their matching closing
 * orders. Orders are matched on `signature` (same underlying + leg structure),
 * FIFO within each signature. Unpaired opens remain `status: 'open'`.
 *
 * Pairing is contract-quantity-aware, not just order-to-order: a close order
 * can close more (or fewer) contracts than the oldest queued open holds — e.g.
 * two separate 1-contract opens later closed together in a single 2-contract
 * close order. Each close's total net cash and contract count are split
 * pro-rata across however many open lots (FIFO) it actually consumes, so a
 * fully-consumed lot gets its fair share of the close's cash and a
 * partially-consumed lot stays 'open' with its remaining contracts and its
 * remaining (unconsumed) share of its own open net.
 *
 * Realized P&L = openNet + closeNet, where each net is the signed cash of the
 * order (negative = debit paid, positive = credit received). For a debit double
 * calendar you pay to open (negative openNet) and receive to close (positive
 * closeNet); the sum is the realized profit/loss including commissions/fees.
 */
export function buildTrades(orderGroups: OrderGroup[]): StrategyTrade[] {
    const matches: StrategyMatch[] = [];
    for (const order of orderGroups) {
        matches.push(...classifyOrder(order));
    }

    // Chronological so FIFO pairing is correct.
    matches.sort((a, b) => a.order.time.localeCompare(b.order.time));

    // Queue of unclosed open lots per signature.
    const openQueues = new Map<string, OpenLot[]>();
    const trades: StrategyTrade[] = [];

    for (const match of matches) {
        if (match.side === 'OPEN') {
            const contracts = matchContracts(match) ?? 1;
            const q = openQueues.get(match.signature) ?? [];
            q.push({ match, totalContracts: contracts, remainingContracts: contracts });
            openQueues.set(match.signature, q);
            continue;
        }

        // CLOSE — consume open lots FIFO until this close's contracts are used up.
        let remainingToClose = matchContracts(match) ?? 1;
        const totalCloseContracts = remainingToClose;
        const q = openQueues.get(match.signature) ?? [];

        while (remainingToClose > 0 && q.length > 0) {
            const lot = q[0];
            const consumed = Math.min(lot.remainingContracts, remainingToClose);
            const openShare = (consumed / lot.totalContracts) * lot.match.order.netAmount;
            const closeShare = (consumed / totalCloseContracts) * match.order.netAmount;

            const shape = toTradeShape(lot.match, consumed);
            const pnl = openShare + closeShare;
            const daysOpen = safeHoldDays(lot.match.order.time, match.order.time);
            trades.push({
                id: `${lot.match.order.orderId}-${match.order.orderId}-${lot.totalContracts - lot.remainingContracts}`,
                strategy: lot.match.strategy,
                underlying: lot.match.order.underlying,
                status: 'closed',
                openOrderId: lot.match.order.orderId,
                openedAt: lot.match.order.time,
                openNet: openShare,
                closeOrderId: match.order.orderId,
                closedAt: match.order.time,
                closeNet: closeShare,
                pnl,
                pctGain: pctGain(pnl, openShare),
                daysOpen,
                ...shape,
            });

            lot.remainingContracts -= consumed;
            remainingToClose -= consumed;
            if (lot.remainingContracts === 0) q.shift();
        }

        if (remainingToClose > 0) {
            // Close with no (or insufficient) recorded open (history starts
            // mid-trade). Record a closed trade with only the unmatched
            // close portion so P&L isn't silently lost.
            const closeShare = (remainingToClose / totalCloseContracts) * match.order.netAmount;
            const shape = toTradeShape(match, remainingToClose);
            trades.push({
                id: `close-${match.order.orderId}-${remainingToClose}`,
                strategy: match.strategy,
                underlying: match.order.underlying,
                status: 'closed',
                openOrderId: '(unknown)',
                openedAt: match.order.time,
                openNet: 0,
                closeOrderId: match.order.orderId,
                closedAt: match.order.time,
                closeNet: closeShare,
                pnl: closeShare,
                daysOpen: 0,
                ...shape,
            });
        }
    }

    // Any remaining open lots are still-open trades (using their remaining share of open net).
    for (const q of openQueues.values()) {
        for (const lot of q) {
            const openShare = (lot.remainingContracts / lot.totalContracts) * lot.match.order.netAmount;
            const shape = toTradeShape(lot.match, lot.remainingContracts);
            trades.push({
                id: `open-${lot.match.order.orderId}-${lot.remainingContracts}`,
                strategy: lot.match.strategy,
                underlying: lot.match.order.underlying,
                status: 'open',
                openOrderId: lot.match.order.orderId,
                openedAt: lot.match.order.time,
                openNet: openShare,
                daysOpen: safeHoldDays(lot.match.order.time, new Date().toISOString()),
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
