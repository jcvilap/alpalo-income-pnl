import type { ParsedLeg } from './parseLegs';

/**
 * Suggested net order price from summing individual leg prices: BTO/BTC are
 * debits (cost), STO/STC are credits (proceeds). Positive = net credit,
 * negative = net debit. Ratios scale each leg relative to the order's base
 * quantity (the smallest common leg ratio, normalized to 1 in buildOrder).
 */
export function computeNetPrice(legs: ParsedLeg[]): number {
    return legs.reduce((sum, leg) => {
        const sign = leg.action === 'STO' || leg.action === 'STC' ? 1 : -1;
        return sum + sign * leg.ratio * leg.price;
    }, 0);
}
