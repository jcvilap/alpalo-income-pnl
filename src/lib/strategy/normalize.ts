import type { SchwabTransaction, SchwabTransferItem } from '@/live/schwabClient';
import type { Leg, OpenClose, OptionRight, OrderGroup } from './types';

/** Normalize a Schwab expiration string to yyyy-mm-dd. */
function normalizeExpiration(raw?: string): string {
    if (!raw) return '';
    // Schwab returns e.g. "2025-06-20T00:00:00.000+00:00" — keep the date part.
    return raw.slice(0, 10);
}

/** True when a transfer item represents a tradeable option leg (not a fee/cash item). */
function isOptionLeg(item: SchwabTransferItem): boolean {
    const inst = item.instrument;
    if (!inst) return false;
    if (inst.assetType !== 'OPTION') return false;
    if (inst.putCall !== 'CALL' && inst.putCall !== 'PUT') return false;
    if (typeof item.amount !== 'number' || item.amount === 0) return false;
    return true;
}

function toLeg(item: SchwabTransferItem): Leg | null {
    const inst = item.instrument!;
    const right = inst.putCall as OptionRight;
    const strike = inst.strikePrice ?? NaN;
    const expiration = normalizeExpiration(inst.expirationDate);
    const quantity = item.amount ?? 0; // signed
    if (Number.isNaN(strike) || !expiration) return null;

    // Prefer Schwab's explicit positionEffect; fall back to sign of quantity is
    // unreliable for opens/closes, so default OPENING when unknown.
    const effect = (item.positionEffect ?? '').toUpperCase();
    const openClose: OpenClose = effect === 'CLOSING' ? 'CLOSE' : 'OPEN';

    return {
        underlying: inst.underlyingSymbol ?? '',
        right,
        strike,
        expiration,
        quantity,
        openClose,
        price: item.price ?? 0,
        symbol: inst.symbol,
    };
}

/**
 * Group Schwab TRADE transactions into OrderGroups keyed by orderId.
 *
 * The user opens/closes each strategy as a single multi-leg order, so one
 * orderId corresponds to one strategy leg-set. Fee/cash transfer items are
 * dropped from `legs` but their cash impact is already reflected in each
 * transaction's `netAmount`, which we sum into `OrderGroup.netAmount`.
 */
export function normalizeToOrderGroups(transactions: SchwabTransaction[]): OrderGroup[] {
    const byOrder = new Map<string, OrderGroup>();

    for (const txn of transactions) {
        if (txn.type !== 'TRADE') continue;
        if (txn.orderId == null) continue;

        const orderId = String(txn.orderId);
        const legs: Leg[] = [];
        for (const item of txn.transferItems ?? []) {
            if (!isOptionLeg(item)) continue;
            const leg = toLeg(item);
            if (leg) legs.push(leg);
        }
        // Skip transactions that carry no option legs (pure equity/fee noise).
        if (legs.length === 0) continue;

        const time = txn.time ?? '';
        const underlying = legs[0].underlying;
        const netAmount = txn.netAmount ?? 0;

        const existing = byOrder.get(orderId);
        if (existing) {
            existing.legs.push(...legs);
            existing.netAmount += netAmount;
            // Keep the earliest execution time for the order.
            if (time && (!existing.time || time < existing.time)) existing.time = time;
        } else {
            byOrder.set(orderId, { orderId, time, underlying, legs, netAmount });
        }
    }

    // Merge duplicate legs (same right/strike/expiration/effect) that arrived as
    // separate fills within one order, summing quantity and volume-weighting price.
    for (const group of byOrder.values()) {
        group.legs = mergeLegs(group.legs);
    }

    return Array.from(byOrder.values()).sort((a, b) => a.time.localeCompare(b.time));
}

function mergeLegs(legs: Leg[]): Leg[] {
    const map = new Map<string, Leg>();
    for (const leg of legs) {
        const key = `${leg.right}|${leg.strike}|${leg.expiration}|${leg.openClose}`;
        const existing = map.get(key);
        if (existing) {
            const totalQty = existing.quantity + leg.quantity;
            const absExisting = Math.abs(existing.quantity);
            const absNew = Math.abs(leg.quantity);
            const denom = absExisting + absNew;
            existing.price = denom > 0
                ? (existing.price * absExisting + leg.price * absNew) / denom
                : existing.price;
            existing.quantity = totalQty;
        } else {
            map.set(key, { ...leg });
        }
    }
    return Array.from(map.values());
}
