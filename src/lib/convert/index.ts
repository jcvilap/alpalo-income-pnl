import { parseLegs, ParseError } from './parseLegs';
import { computeNetPrice } from './netPrice';
import { buildOrderString } from './buildOrderString';

export { parseLegs, ParseError, computeNetPrice, buildOrderString };
export type { ParsedLeg, LegAction } from './parseLegs';

export interface ConvertResult {
    orderString: string;
    computedNetPrice: number;
    legCount: number;
}

/**
 * Parses pasted fill lines and builds the thinkorswim order string.
 * @param overridePriceMagnitude When provided (e.g. a limit price different
 * from the sum of leg prices), its absolute value is used instead of the
 * computed net price — the debit/credit sign always follows the computed net
 * price's sign, since the override is just a different magnitude for the same
 * trade direction, not a different direction.
 */
export function convertOrder(input: string, overridePriceMagnitude?: number): ConvertResult {
    const legs = parseLegs(input);
    const computedNetPrice = computeNetPrice(legs);
    const price =
        overridePriceMagnitude != null ? Math.sign(computedNetPrice || 1) * Math.abs(overridePriceMagnitude) : undefined;
    const orderString = buildOrderString(legs, computedNetPrice, { price });
    return { orderString, computedNetPrice, legCount: legs.length };
}
