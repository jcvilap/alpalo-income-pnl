import type { Leg, OpenClose, OrderGroup, OptionRight, StrategyId, StrategyMatch } from './types';

/**
 * A pluggable strategy classifier. Add a new strategy (jade lizard, iron
 * condor, strangle, ...) by adding a rule object here — no changes to the
 * detection engine required.
 */
export interface StrategyRule {
    id: StrategyId;
    name: string;
    /** Returns true when the order's leg-set matches this strategy's shape. */
    matches(order: OrderGroup): boolean;
}

/**
 * One "time spread": same right, two expirations, a near short + a far long,
 * each at its own strike. When both strikes are equal it's a calendar; when
 * they differ it's a diagonal.
 */
interface TimeSpread {
    right: OptionRight;
    nearStrike: number;
    farStrike: number;
    nearExpiration: string;
    farExpiration: string;
}

/**
 * Identify a calendar or diagonal spread among legs of a single right.
 *
 * Requires exactly two legs of the same right, on two distinct expirations,
 * with a short leg on the near expiration and a long leg on the far
 * expiration. Sign of quantity distinguishes long (+) from short (-). This
 * holds for both the opening order (sell near / buy far) and the closing
 * order (buy near / sell far) because we key off strike/expiration structure,
 * and require one long + one short across the two expirations. Strikes may
 * be equal (calendar) or different (diagonal) — callers decide which shape
 * they need.
 */
function detectTimeSpread(legsOfRight: Leg[]): TimeSpread | null {
    if (legsOfRight.length !== 2) return null;

    const expirations = Array.from(new Set(legsOfRight.map(l => l.expiration))).sort();
    if (expirations.length !== 2) return null;

    const [near, far] = expirations;
    const nearLeg = legsOfRight.find(l => l.expiration === near)!;
    const farLeg = legsOfRight.find(l => l.expiration === far)!;

    // Opposite signs across the two expirations (one long, one short).
    if (Math.sign(nearLeg.quantity) === Math.sign(farLeg.quantity)) return null;
    if (nearLeg.quantity === 0 || farLeg.quantity === 0) return null;

    return {
        right: legsOfRight[0].right,
        nearStrike: nearLeg.strike,
        farStrike: farLeg.strike,
        nearExpiration: near,
        farExpiration: far,
    };
}

/** Shared 4-leg (2 calls + 2 puts) time-spread shape check for the double-calendar/diagonal rules. */
function matchDoubleTimeSpread(
    order: OrderGroup,
    strikeShape: (spread: TimeSpread) => boolean,
    crossPairShape: (callSpread: TimeSpread, putSpread: TimeSpread) => boolean,
): boolean {
    const legs = order.legs;
    if (legs.length !== 4) return false;

    const calls = legs.filter(l => l.right === 'CALL');
    const puts = legs.filter(l => l.right === 'PUT');
    if (calls.length !== 2 || puts.length !== 2) return false;

    const callSpread = detectTimeSpread(calls);
    const putSpread = detectTimeSpread(puts);
    if (!callSpread || !putSpread) return false;

    if (!strikeShape(callSpread) || !strikeShape(putSpread)) return false;
    if (!crossPairShape(callSpread, putSpread)) return false;

    // Both spreads should share the same near/far expiration pair.
    if (callSpread.nearExpiration !== putSpread.nearExpiration) return false;
    if (callSpread.farExpiration !== putSpread.farExpiration) return false;

    return true;
}

/**
 * Strict double calendar: one call calendar + one put calendar on the same
 * underlying, opened/closed in a single order, at two different strikes.
 */
export const DOUBLE_CALENDAR_RULE: StrategyRule = {
    id: 'DOUBLE_CALENDAR',
    name: 'Double Calendar',
    matches(order: OrderGroup): boolean {
        return matchDoubleTimeSpread(
            order,
            (spread) => spread.nearStrike === spread.farStrike,
            (callSpread, putSpread) => callSpread.nearStrike !== putSpread.nearStrike,
        );
    },
};

/**
 * Strict double diagonal: one call diagonal + one put diagonal on the same
 * underlying, opened/closed in a single order. Like a double calendar, but
 * each diagonal's near/far legs sit at different strikes — 4 distinct strikes
 * total instead of 2.
 */
export const DOUBLE_DIAGONAL_RULE: StrategyRule = {
    id: 'DOUBLE_DIAGONAL',
    name: 'Double Diagonal',
    matches(order: OrderGroup): boolean {
        return matchDoubleTimeSpread(
            order,
            (spread) => spread.nearStrike !== spread.farStrike,
            (callSpread, putSpread) => {
                const strikes = new Set([
                    callSpread.nearStrike,
                    callSpread.farStrike,
                    putSpread.nearStrike,
                    putSpread.farStrike,
                ]);
                return strikes.size === 4;
            },
        );
    },
};

/** A year, in days, for the LEAPS long-dated threshold. */
const LEAPS_MIN_DAYS = 365;

/**
 * LEAPS: a single-leg order (one call or put, bought or sold) with an
 * expiration more than a year out from the order's execution time. LEAPS
 * positions are sometimes rolled (closed and reopened at a new strike/
 * expiration), but this rule doesn't chain rolls together — a roll shows up
 * as one FIFO-paired trade closing and a new one opening, same as any other
 * strategy here. See `legSetSignature` / `buildTrades` in pairing.ts.
 *
 * Known gap: this >365-day threshold applies to close orders too, using the
 * *current* remaining days rather than the days-at-open. A LEAPS position
 * held long enough that its remaining term drops to 365 days or less by the
 * time it's closed won't match here on the close side. Shape rules have no
 * memory of what's actually open, so they can't tell "this is a LEAPS
 * closing" from "this is some other single-leg option closing" — that
 * requires pairing-time state. `buildTrades` in pairing.ts handles this: when
 * a single-leg CLOSE order doesn't match any rule, it checks whether the
 * order's leg signature matches a currently-open LEAPS lot and, if so,
 * synthesizes a LEAPS close for it.
 */
export const LEAPS_RULE: StrategyRule = {
    id: 'LEAPS',
    name: 'LEAPS',
    matches(order: OrderGroup): boolean {
        if (order.legs.length !== 1) return false;
        const [leg] = order.legs;
        const days = daysBetween(order.time, leg.expiration);
        return days != null && days > LEAPS_MIN_DAYS;
    },
};

function daysBetween(fromIso: string, toDateStr: string): number | null {
    const from = new Date(fromIso);
    const to = new Date(`${toDateStr}T00:00:00.000Z`);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return null;
    return (to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000);
}

/**
 * Strangle: one call + one put, same underlying, same expiration, different
 * strikes, opened in a single 2-leg order (the "made in a single transaction"
 * requirement). Only matches whole-order shapes — this rule does NOT detect a
 * lone leg closing independently of its partner, since a single-leg CLOSE
 * order is structurally indistinguishable from a LEAPS close or naked-option
 * close by shape alone. Practical effect: a strangle whose two legs are
 * closed in separate orders will never re-match this 2-leg shape on close,
 * so `buildTrades`'s FIFO pairing won't find a closing match and the trade
 * will show as permanently 'open' with an estimated (not realized) P&L. Only
 * strangles closed both-legs-in-one-order will resolve to 'closed'. Fixing
 * the independent-leg-close case requires per-leg pairing state in
 * pairing.ts, not just a shape rule — flagged as a known follow-up.
 */
export const STRANGLE_RULE: StrategyRule = {
    id: 'STRANGLE',
    name: 'Strangle',
    matches(order: OrderGroup): boolean {
        const legs = order.legs;
        if (legs.length !== 2) return false;

        const calls = legs.filter(l => l.right === 'CALL');
        const puts = legs.filter(l => l.right === 'PUT');
        if (calls.length !== 1 || puts.length !== 1) return false;

        const [call] = calls;
        const [put] = puts;
        if (call.expiration !== put.expiration) return false;
        if (call.strike === put.strike) return false;

        return true;
    },
};

/** Registry of active strategy rules. Order = detection priority. */
export const STRATEGY_RULES: StrategyRule[] = [
    DOUBLE_CALENDAR_RULE,
    DOUBLE_DIAGONAL_RULE,
    STRANGLE_RULE,
    LEAPS_RULE,
];

/**
 * Derive whether an order opened or closed the position from its legs'
 * positionEffect. If mixed (a roll), we treat it as CLOSE so it terminates the
 * prior open trade; the reopened leg-set is handled by v1 as a separate open in
 * a later refinement.
 */
function orderSide(order: OrderGroup): OpenClose {
    const anyClose = order.legs.some(l => l.openClose === 'CLOSE');
    const anyOpen = order.legs.some(l => l.openClose === 'OPEN');
    if (anyClose && !anyOpen) return 'CLOSE';
    if (anyOpen && !anyClose) return 'OPEN';
    // Mixed/unknown — bias to CLOSE so an existing open trade gets resolved.
    return anyClose ? 'CLOSE' : 'OPEN';
}

/**
 * A signature that is identical for the opening and closing order of the same
 * position: underlying + sorted (right, strike, expiration) tuples. Quantity
 * sign is intentionally excluded because it flips between open and close.
 */
export function legSetSignature(order: OrderGroup): string {
    const parts = order.legs
        .map(l => `${l.right}:${l.strike}:${l.expiration}`)
        .sort();
    return `${order.underlying}|${parts.join(',')}`;
}

/** A fill's cash impact per Schwab's convention (see AGENTS.md): -quantity * price * 100. */
export function legNetAmount(leg: Leg): number {
    return -leg.quantity * leg.price * 100;
}

/** Signature of a single leg (underlying + right/strike/expiration), used to match a lone leg against one leg of an open multi-leg lot. */
export function legSignature(underlying: string, leg: Pick<Leg, 'right' | 'strike' | 'expiration'>): string {
    return `${underlying}|${leg.right}:${leg.strike}:${leg.expiration}`;
}

/**
 * Classify a single order against the rule registry. Returns every matching
 * strategy found in the order, or `[]` if none match (order is filtered out
 * of the dashboard).
 *
 * Tries the whole order first (double calendars/diagonals/strangles are only
 * ever meaningful as a whole multi-leg unit). If nothing matches the order as
 * a whole and it has more than one leg, falls back to classifying each leg
 * independently as its own synthetic single-leg order — this recovers cases
 * where Schwab batches economically-unrelated single-leg trades (e.g. opening
 * a new LEAPS while closing an unrelated short-dated put) under one shared
 * orderId. Without this fallback, that whole order — including the
 * legitimate LEAPS leg — would silently vanish from every strategy view.
 */
export function classifyOrder(order: OrderGroup): StrategyMatch[] {
    for (const rule of STRATEGY_RULES) {
        if (rule.matches(order)) {
            return [{
                strategy: rule.id,
                order,
                side: orderSide(order),
                signature: legSetSignature(order),
            }];
        }
    }

    if (order.legs.length <= 1) return [];

    // Fallback: try each leg as its own independent single-leg order.
    const matches: StrategyMatch[] = [];
    for (const leg of order.legs) {
        const legOrder: OrderGroup = {
            orderId: order.orderId,
            time: order.time,
            underlying: leg.underlying,
            legs: [leg],
            netAmount: legNetAmount(leg),
        };
        for (const rule of STRATEGY_RULES) {
            if (rule.matches(legOrder)) {
                matches.push({
                    strategy: rule.id,
                    order: legOrder,
                    side: leg.openClose,
                    signature: legSetSignature(legOrder),
                });
                break;
            }
        }
    }
    return matches;
}
