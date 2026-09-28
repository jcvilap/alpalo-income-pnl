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

/** Registry of active strategy rules. Order = detection priority. */
export const STRATEGY_RULES: StrategyRule[] = [
    DOUBLE_CALENDAR_RULE,
    DOUBLE_DIAGONAL_RULE,
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

/**
 * Classify a single order against the rule registry. Returns the first matching
 * strategy, or null if none match (order is filtered out of the dashboard).
 */
export function classifyOrder(order: OrderGroup): StrategyMatch | null {
    for (const rule of STRATEGY_RULES) {
        if (rule.matches(order)) {
            return {
                strategy: rule.id,
                order,
                side: orderSide(order),
                signature: legSetSignature(order),
            };
        }
    }
    return null;
}
