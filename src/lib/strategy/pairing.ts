import { differenceInCalendarDays, parseISO } from 'date-fns';
import type { Leg, OrderGroup, StrategyMatch, StrategyTrade } from './types';
import { classifyOrder, legNetAmount, legSetSignature, legSignature } from './rules';

function distinctSorted<T>(values: T[]): T[] {
    return Array.from(new Set(values)).sort((a, b) =>
        typeof a === 'number' && typeof b === 'number'
            ? (a as number) - (b as number)
            : String(a).localeCompare(String(b))
    );
}

/**
 * @param liveLegs Current remaining legs of the lot, if different from the
 * original opening order's legs (e.g. a STRANGLE lot whose partner leg was
 * already closed independently — see `closeStrangleLeg`). Defaults to the
 * opening order's own legs. Only affects `legs` (used for live mark-to-market
 * and the UI's per-leg detail rows) — `strikes`/`expirations` always reflect
 * the original opening order's full leg set, so a strangle keeps showing both
 * of its strikes even after one leg closes independently.
 * @param closedLegs STRANGLE lots only: legs already closed independently
 * (see `OpenLot.closedLegs`), appended to `legs` so the UI's per-leg detail
 * row shows every original leg of the strangle, not just what's still open.
 */
function toTradeShape(open: StrategyMatch, contracts?: number, liveLegs?: Leg[], closedLegs?: Leg[]) {
    const originalContracts = matchContracts(open);
    const legs = scaleLegs(liveLegs ?? open.order.legs, originalContracts, contracts);
    const originalLegs = scaleLegs(open.order.legs, originalContracts, contracts);
    const expirations = distinctSorted(originalLegs.map(l => l.expiration));
    return {
        legs: closedLegs && closedLegs.length > 0 ? [...legs, ...closedLegs] : legs,
        strikes: distinctSorted(originalLegs.map(l => l.strike)),
        expirations,
        expirationDtes: expirations.map(e => daysAt(open.order.time, e)),
        // `dte` (remaining days to expiration) is intentionally left unset
        // here — it depends on "now", not the open time, so it must be
        // computed fresh on every request. See `applyRemainingDte` in
        // lib/transactions/service.ts.
        contracts: contracts ?? originalContracts,
    };
}

/**
 * Scale each leg's quantity down to `contracts` out of the order's original
 * `originalContracts` (used when a partial close only consumes some of a
 * multi-contract open lot). Every leg of a uniform multi-leg order shares the
 * same contract multiplier, so scaling all legs by the same ratio preserves
 * the strategy's relative shape. Without this, a partially-closed lot would
 * report its reduced `contracts` count but still carry the *original* full
 * leg quantities, so `applyUnrealizedPnl` would mark-to-market the wrong
 * (larger) size against the smaller remaining cost basis.
 */
function scaleLegs<T extends { quantity: number; openNet?: number }>(legs: T[], originalContracts: number | undefined, contracts: number | undefined): T[] {
    if (contracts == null || originalContracts == null || contracts === originalContracts) return legs;
    const ratio = contracts / originalContracts;
    return legs.map(l => ({
        ...l,
        quantity: Math.sign(l.quantity) * Math.round(Math.abs(l.quantity) * ratio),
        openNet: l.openNet != null ? l.openNet * ratio : l.openNet,
    }));
}

/** Contract size of a match: max absolute leg quantity (uniform across legs of one multi-leg order). */
function matchContracts(match: StrategyMatch): number | undefined {
    const legs = match.order.legs;
    return legs.length > 0 ? Math.max(...legs.map(l => Math.abs(l.quantity))) : undefined;
}

/**
 * Combine two OPEN legs of the same right/strike/expiration into one,
 * volume-weighting the price and summing quantity — same blending a broker's
 * position view uses when the same contract is bought/sold across multiple
 * fills. Assumes both legs share sign (both opening the same direction),
 * which always holds here since both come from OPEN orders on the same
 * strategy signature.
 */
function blendLeg(a: Leg, b: Leg): Leg {
    const absA = Math.abs(a.quantity);
    const absB = Math.abs(b.quantity);
    const denom = absA + absB;
    return {
        ...a,
        quantity: a.quantity + b.quantity,
        price: denom > 0 ? (a.price * absA + b.price * absB) / denom : a.price,
    };
}

/**
 * Merge a newly-opened order into an existing open lot of the *same
 * signature* (same underlying/strategy shape — right/strike/expiration) —
 * e.g. adding 1 more contract to an already-open strangle on a later day.
 * Mirrors how a broker's position view shows one row per contract shape with
 * a blended average price, not one row per fill. Mutates `lot` in place:
 * pools contracts/netAmount, volume-weights each leg's price, and keeps the
 * *earliest* time as the position's display open date (a broker shows when
 * the position was first opened, not when it was last added to).
 *
 * If the lot has already been partially closed, `base` is first rebased down
 * to just its *remaining* contracts/cost basis before blending in the new
 * order — otherwise the already-realized contracts' opening cash would stay
 * mixed into `totalContracts`/`netAmount`, and every later
 * `(consumed / totalContracts) * netAmount` allocation (open share, close
 * share, per-leg P&L) would silently redistribute stale, already-realized
 * cost basis onto the new contracts.
 */
function mergeIntoOpenLot(lot: OpenLot, incoming: StrategyMatch, incomingContracts: number): void {
    const remainingRatio = lot.remainingContracts / lot.totalContracts;
    const base: OrderGroup = remainingRatio === 1
        ? lot.match.order
        : {
              ...lot.match.order,
              legs: lot.match.order.legs.map(l => ({ ...l, quantity: Math.sign(l.quantity) * Math.round(Math.abs(l.quantity) * remainingRatio) })),
              netAmount: lot.match.order.netAmount * remainingRatio,
          };
    const add = incoming.order;

    const mergedLegs = base.legs.map(baseLeg => {
        const addLeg = add.legs.find(l => l.right === baseLeg.right && l.strike === baseLeg.strike && l.expiration === baseLeg.expiration);
        return addLeg ? blendLeg(baseLeg, addLeg) : baseLeg;
    });

    lot.match = {
        ...lot.match,
        order: {
            ...base,
            legs: mergedLegs,
            netAmount: base.netAmount + add.netAmount,
            time: base.time < add.time ? base.time : add.time,
        },
    };
    lot.totalContracts = lot.remainingContracts + incomingContracts;
    lot.remainingContracts += incomingContracts;
    if (lot.openLegs) {
        // Rebase each open leg's own cost basis the same way, then blend.
        const openLegsRebased = remainingRatio === 1
            ? lot.openLegs
            : lot.openLegs.map(l => ({
                  ...l,
                  quantity: Math.sign(l.quantity) * Math.round(Math.abs(l.quantity) * remainingRatio),
                  openNet: l.openNet != null ? l.openNet * remainingRatio : l.openNet,
              }));
        const matchedAddLegs = new Set<Leg>();
        const blended = openLegsRebased.map(openLeg => {
            const addLeg = add.legs.find(l => l.right === openLeg.right && l.strike === openLeg.strike && l.expiration === openLeg.expiration);
            if (!addLeg) return openLeg;
            matchedAddLegs.add(addLeg);
            const merged = blendLeg(openLeg, addLeg);
            return { ...merged, openNet: legNetAmount(merged) };
        });
        // A leg the incoming order carries but `openLegs` no longer has (its
        // sibling was closed independently earlier, splicing it out of
        // openLegs — see `closeStrangleLeg`) isn't a blend target; it's a
        // brand-new open leg and must still be added, or its cost basis would
        // be silently invisible from `legs`/quotes/mark-to-market even though
        // `netAmount`/`remainingOpenNet` below already include its cash.
        const reintroducedLegs = add.legs
            .filter(l => !matchedAddLegs.has(l))
            .map(l => ({ ...l, openNet: legNetAmount(l) }));
        lot.openLegs = [...blended, ...reintroducedLegs];
    }
    // `remainingOpenNet` is already the true remaining basis — it's decremented
    // incrementally as legs close (see `closeStrangleLeg` / the whole-order
    // CLOSE branch below), unlike `base.netAmount` above which is a fresh
    // proportional derivation from `totalContracts` each time. It must NOT be
    // rebased by `remainingRatio` again here — only the new order's cash gets
    // added on top.
    if (lot.remainingOpenNet != null) lot.remainingOpenNet += add.netAmount;
    lot.openFillTimes = [...lot.openFillTimes, add.time];
}

/** A queued open with contracts consumed so far by prior partial closes. */
interface OpenLot {
    match: StrategyMatch;
    totalContracts: number;
    remainingContracts: number;
    /**
     * STRANGLE lots only: remaining (not-yet-independently-closed) legs of
     * this lot. Starts as a copy of `match.order.legs` and shrinks in place
     * as `closeStrangleLeg` below closes one leg at a time. Once only one leg
     * remains, the lot represents a naked single-leg position rather than a
     * strangle — see `toTradeShape`, which always reads live leg state from
     * here rather than the original (possibly stale) `match.order.legs`.
     */
    openLegs?: Leg[];
    /**
     * STRANGLE lots only: the lot's share of `match.order.netAmount` not yet
     * attributed to an independently-closed leg. Starts equal to
     * `match.order.netAmount` and is decremented by each leg's own entry-cash
     * share as `closeStrangleLeg` consumes it, so the lot's still-open
     * remainder reports only the cash tied to what's actually still open.
     */
    remainingOpenNet?: number;
    /**
     * STRANGLE lots only: legs `closeStrangleLeg` has already removed from
     * `openLegs`, kept around (fully realized, `openClose: 'CLOSE'`) so the
     * still-open trade's `legs` can still include them — the UI's per-leg
     * detail row shows every original leg, not just what's still live.
     */
    closedLegs?: Leg[];
    /**
     * Every distinct order time that has contributed to this lot's open
     * side — starts as `[match.order.time]` and gains one entry per merge
     * (see `mergeIntoOpenLot`). Propagated onto the resulting trade's
     * `openFillTimes` so range filtering can see a fresh addition to an old
     * position even though `openedAt` display always shows the earliest.
     */
    openFillTimes: string[];
}

/**
 * This leg's gross fill cash as a fraction of the total gross fill cash
 * across all of `orderLegs` (the whole opening order it belongs to). Used to
 * allocate a shared order-level `netAmount` — which includes commissions/fees
 * on top of gross fill cash — proportionally to one leg, so the fee doesn't
 * simply vanish when that leg is later tracked/closed independently of its
 * sibling. Falls back to an even split if gross cash nets to zero (e.g. a
 * curiously priced spread) to avoid a divide-by-zero.
 */
function legWeight(leg: Leg, orderLegs: Leg[]): number {
    const totalGross = orderLegs.reduce((s, l) => s + Math.abs(legNetAmount(l)), 0);
    if (totalGross === 0) return orderLegs.length > 0 ? 1 / orderLegs.length : 1;
    return Math.abs(legNetAmount(leg)) / totalGross;
}

/** Days from `fromIso` to an expiration date, floored at 0. */
function daysAt(fromIso: string, expiration: string): number {
    try {
        return Math.max(0, differenceInCalendarDays(parseISO(expiration), parseISO(fromIso)));
    } catch {
        return 0;
    }
}

/**
 * Stamp each open leg's own realized `closeNet`/`pnl`/`pctGain` when a
 * STRANGLE's whole 2-leg position closes in a single order (the common case —
 * both legs closed together). Matches each open leg to its corresponding
 * closing-order leg by right/strike/expiration and uses that leg's own
 * `legNetAmount` as its exact closing cash — no proportional guess needed,
 * since the closing order's own per-leg price/quantity are exact. Powers the
 * UI's per-leg detail row for closed strangles the same way `closeStrangleLeg`
 * does for independent leg closes.
 */
function stampStrangleLegCloses(openLegs: Leg[], closeOrderLegs: Leg[], underlying: string, closeOrderTime: string): Leg[] {
    return openLegs.map(leg => {
        const sig = legSignature(underlying, leg);
        const closingLeg = closeOrderLegs.find(l => legSignature(underlying, l) === sig);
        if (!closingLeg || leg.openNet == null) return leg;
        const closeNet = legNetAmount(closingLeg);
        const pnl = leg.openNet + closeNet;
        return { ...leg, openClose: 'CLOSE', closedAt: closeOrderTime, closeNet, pnl, pctGain: pctGain(pnl, leg.openNet) };
    });
}

function pctGain(pnl: number | undefined, openNet: number): number | undefined {
    if (pnl == null || openNet === 0) return undefined;
    return (pnl / Math.abs(openNet)) * 100;
}

/**
 * Handle a single-leg CLOSE order that independently closes just one leg of
 * an open STRANGLE lot (e.g. taking profit on the winning side early and
 * leaving the other side open as a naked position). `STRANGLE_RULE` only
 * matches whole 2-leg orders, so `classifyOrder` can't see this — this
 * function looks the leg up directly against open STRANGLE lots' remaining
 * legs instead.
 *
 * Contracts are consumed FIFO across all open STRANGLE lots that currently
 * hold this exact leg (right/strike/expiration under this underlying) — this
 * can span *multiple distinct lots* (e.g. two separate strangle positions
 * opened on different days, both still holding this same leg), not just
 * multiple legs of one lot. Each lot's own completion is tracked
 * independently: a lot only emits a closed trade once *its own* other leg is
 * also done, regardless of whether a *different* lot touched by this same
 * order still has an open sibling. Returns one trade per lot this order
 * fully completes (usually zero or one, but can be more than one if a single
 * close order happens to finish off several lots at once), or an empty array
 * if no lot was fully completed (either no lot matched, or every touched lot
 * still has a leg open afterward).
 */
function closeStrangleLeg(
    order: OrderGroup,
    closingLeg: Leg,
    openQueues: Map<string, OpenLot[]>,
): StrategyTrade[] {
    const targetSig = legSignature(order.underlying, closingLeg);
    let remainingToClose = Math.abs(closingLeg.quantity);
    if (remainingToClose === 0) return [];
    const totalCloseContracts = remainingToClose;

    // One entry per lot this order actually consumes from, tracked
    // independently — a completed lot's totals must never be blended with
    // another lot's (see the multi-lot bug this replaced: a shared
    // "any lot still has an open sibling" flag could suppress an already-
    // completed lot's own closed trade just because a *different* lot
    // touched by the same order was still partial).
    interface LotClose { lot: OpenLot; openShare: number; closeShare: number; closedLeg: Leg; completed: boolean }
    const lotCloses: LotClose[] = [];

    for (const q of openQueues.values()) {
        for (let i = 0; i < q.length && remainingToClose > 0; ) {
            const lot = q[i];
            const legs = lot.openLegs;
            if (lot.match.strategy !== 'STRANGLE' || !legs) { i++; continue; }

            const legIdx = legs.findIndex(l => legSignature(order.underlying, l) === targetSig);
            if (legIdx === -1) { i++; continue; }

            const leg = legs[legIdx];
            const legQtyAvailable = Math.abs(leg.quantity) * (lot.remainingContracts / lot.totalContracts);
            const consumed = Math.min(legQtyAvailable, remainingToClose);
            if (consumed <= 0) { i++; continue; }

            // Allocate this leg's share of the lot's *actual* opening netAmount
            // (which includes commissions/fees) rather than reconstructing
            // gross fill cash via legNetAmount alone — otherwise the fee
            // residual is silently dropped once the lot's last leg closes and
            // the lot is discarded, understating the true cost basis.
            // Weight = this leg's gross cash as a fraction of the whole
            // opening order's total gross cash across both legs.
            const grossWeight = legWeight(leg, lot.match.order.legs);
            const legOpenShare = grossWeight * (consumed / lot.totalContracts) * lot.match.order.netAmount;
            if (lot.remainingOpenNet != null) lot.remainingOpenNet -= legOpenShare;

            // This lot's own share of the close order's cash, proportional to
            // how much of the close this lot's leg actually consumed — needed
            // to record a fully-realized closed leg on `closedLegs` below,
            // since a single close order can span multiple lots.
            const legCloseShare = (consumed / totalCloseContracts) * order.netAmount;
            const legPnl = legOpenShare + legCloseShare;
            const closedLeg: Leg = {
                ...leg,
                quantity: Math.sign(leg.quantity) * consumed,
                openClose: 'CLOSE',
                closedAt: order.time,
                openNet: legOpenShare,
                closeNet: legCloseShare,
                pnl: legPnl,
                pctGain: pctGain(legPnl, legOpenShare),
            };
            lot.closedLegs = [...(lot.closedLegs ?? []), closedLeg];

            // Shrink this leg's quantity by the consumed amount; drop it once flat.
            const newQty = Math.sign(leg.quantity) * (Math.abs(leg.quantity) - consumed);
            if (newQty === 0) {
                legs.splice(legIdx, 1);
            } else {
                legs[legIdx] = { ...leg, quantity: newQty };
            }

            remainingToClose -= consumed;

            // Lot is fully closed once it has no legs and no other open contracts left.
            const completed = legs.length === 0;
            if (completed) {
                lot.remainingContracts = 0;
                q.splice(i, 1);
            } else {
                i++;
            }
            lotCloses.push({ lot, openShare: legOpenShare, closeShare: legCloseShare, closedLeg, completed });
        }
    }

    const results: StrategyTrade[] = [];
    for (const { lot, openShare, closeShare, closedLeg, completed } of lotCloses) {
        // This lot still has an open leg after this close — its own eventual
        // trade record (still open, or later finalized once the sibling also
        // closes) already carries this closed leg's locked-in data via
        // `lot.closedLegs` + `toTradeShape`. A strangle is exactly one row
        // with exactly two legs, one closed one open, until both are closed
        // — not two separate rows duplicating the same position.
        if (!completed) continue;

        const pnl = openShare + closeShare;
        const daysOpen = safeHoldDays(lot.match.order.time, order.time);
        const thisClosedLeg: Leg = { ...closingLeg, ...closedLeg };

        // This lot's sibling leg(s) may have already closed independently
        // *before* this order (a separate single-leg close) — that realized
        // cash lives only in `lot.closedLegs` and must be folded into this
        // lot's own totals, or it would silently vanish from both the table
        // and aggregate metrics once this lot is discarded and never
        // revisited (see Codex's PR #10 review).
        const siblingClosedLegs = (lot.closedLegs ?? []).filter(l => l !== closedLeg);
        const siblingOpenNet = siblingClosedLegs.reduce((s, l) => s + (l.openNet ?? 0), 0);
        const siblingCloseNet = siblingClosedLegs.reduce((s, l) => s + (l.closeNet ?? 0), 0);
        const totalOpenNet = openShare + siblingOpenNet;
        const totalCloseNet = closeShare + siblingCloseNet;
        const totalPnl = pnl + siblingClosedLegs.reduce((s, l) => s + (l.pnl ?? 0), 0);

        // `siblingClosedLegs` already excludes `closedLeg` itself (see
        // above) — reuse it here rather than `lot.closedLegs` directly, or
        // this leg's own quantity/cash/P&L would be summed twice by the
        // merge-by-signature dedupe below (once as `thisClosedLeg`, once
        // again as its own still-present entry in `lot.closedLegs`; see
        // Codex's PR #10 review). The remaining entries are shallow-copied
        // since they're live objects other code paths (e.g. a still-open
        // sibling trade, before this lot completed) may also reference.
        const allLegs = dedupeLegsBySignature(order.underlying, [thisClosedLeg, ...siblingClosedLegs.map(l => ({ ...l }))]);
        const strikes = distinctSorted(allLegs.map(l => l.strike));
        const expirations = distinctSorted(allLegs.map(l => l.expiration));
        const openedAt = lot.match.order.time;

        results.push({
            // Includes the opening lot's own orderId, not just this close's
            // — a single close order can legitimately complete more than one
            // distinct lot (e.g. two separate strangle positions opened on
            // different days, both holding this same leg), which would
            // otherwise collide on an id keyed by the close order alone.
            id: `strangle-leg-close-${order.orderId}-${lot.match.order.orderId}-${closingLeg.strike}-${closingLeg.right}`,
            strategy: 'STRANGLE',
            underlying: order.underlying,
            status: 'closed',
            openOrderId: lot.match.order.orderId,
            openedAt,
            openNet: totalOpenNet,
            closeOrderId: order.orderId,
            closedAt: order.time,
            closeNet: totalCloseNet,
            pnl: totalPnl,
            pctGain: pctGain(totalPnl, totalOpenNet),
            daysOpen,
            legs: allLegs,
            strikes,
            expirations,
            // DTE-at-open, not at this close — same contract as every other
            // trade's `expirationDtes` (see StrategyTrade.expirationDtes).
            expirationDtes: expirations.map(e => daysAt(openedAt, e)),
            contracts: Math.abs(closedLeg.quantity),
        });
    }
    return results;
}

/** Dedupe legs by right/strike/expiration, keeping the first occurrence. */
/**
 * Merge legs sharing the same (right, strike, expiration) signature into one
 * — a multi-contract leg closed across several separate single-leg orders
 * (e.g. 3 contracts closed on one day, the remaining 2 closed weeks later)
 * produces one `closedLeg` entry per order in `lot.closedLegs`, all with the
 * same signature. A plain dedupe that just keeps the first occurrence would
 * silently drop every later slice's contracts and cash — this sums the
 * cash-flow fields instead so the merged leg's totals reflect every slice,
 * and `pctGain` is recomputed from the merged openNet/pnl rather than kept
 * from whichever slice happened to survive. Non-cash-flow fields (right,
 * strike, expiration, symbol) are taken from the first occurrence since
 * they're identical across every slice by construction of the signature
 * match itself. `closedAt` keeps the *latest* slice's date — that's when
 * this leg was actually fully wound down.
 */
function dedupeLegsBySignature(underlying: string, legs: Leg[]): Leg[] {
    const bySig = new Map<string, Leg[]>();
    for (const leg of legs) {
        const sig = legSignature(underlying, leg);
        const group = bySig.get(sig);
        if (group) group.push(leg);
        else bySig.set(sig, [leg]);
    }
    const result: Leg[] = [];
    for (const group of bySig.values()) {
        if (group.length === 1) {
            result.push(group[0]);
            continue;
        }
        const quantity = group.reduce((s, l) => s + l.quantity, 0);
        const openNet = group.reduce((s, l) => s + (l.openNet ?? 0), 0);
        const closeNet = group.reduce((s, l) => s + (l.closeNet ?? 0), 0);
        const pnl = group.reduce((s, l) => s + (l.pnl ?? 0), 0);
        const closedAt = group.reduce((latest: string | undefined, l) =>
            !l.closedAt ? latest : (!latest || l.closedAt > latest) ? l.closedAt : latest, undefined);
        result.push({ ...group[0], quantity, openNet, closeNet, pnl, pctGain: pctGain(pnl, openNet), closedAt });
    }
    return result;
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
    // Chronological so FIFO pairing — and the LEAPS-close fallback below,
    // which depends on what's open *so far* — are correct.
    const sortedOrders = [...orderGroups].sort((a, b) => a.time.localeCompare(b.time));

    // Queue of unclosed open lots per signature.
    const openQueues = new Map<string, OpenLot[]>();
    const trades: StrategyTrade[] = [];

    for (const order of sortedOrders) {
        const orderMatches = classifyOrder(order);

        // Fallback: a single-leg CLOSE order that matched no rule might still
        // be closing a LEAPS position whose remaining term has since dropped
        // to <=365 days (LEAPS_RULE's threshold no longer matches it on the
        // close side). Shape alone can't tell this apart from any other
        // single-leg close, so check it against currently-open LEAPS lots by
        // signature instead — if one exists, this is a LEAPS close.
        if (orderMatches.length === 0 && order.legs.length === 1 && order.legs[0].openClose === 'CLOSE') {
            const signature = legSetSignature(order);
            const openLeaps = openQueues.get(signature)?.some(lot => lot.match.strategy === 'LEAPS');
            if (openLeaps) {
                orderMatches.push({ strategy: 'LEAPS', order, side: 'CLOSE', signature });
            }
        }

        // Fallback: a single-leg CLOSE order that matched no whole-order rule
        // (and isn't a LEAPS close above) might be independently closing just
        // one leg of an open STRANGLE — e.g. closing the winning side early
        // and leaving the other leg naked. STRANGLE_RULE only ever matches a
        // 2-leg order, so this case is invisible to `classifyOrder` and needs
        // per-leg lookup against currently-open strangle lots instead of a
        // whole-signature match. See `closeStrangleLeg`.
        if (orderMatches.length === 0 && order.legs.length === 1 && order.legs[0].openClose === 'CLOSE') {
            trades.push(...closeStrangleLeg(order, order.legs[0], openQueues));
            continue;
        }

        for (const match of orderMatches) {
            if (match.side === 'OPEN') {
                const contracts = matchContracts(match) ?? 1;
                const q = openQueues.get(match.signature) ?? [];

                // Same underlying/strategy shape already open (from an
                // earlier order, possibly a different day) — merge into it
                // rather than tracking a second parallel lot, so the trade
                // list shows one position with a blended average price, the
                // same way a broker's position view does. Only the most
                // recent lot for this signature is checked: once merged,
                // there's only ever one lot per signature going forward
                // (barring a signature that closed fully and later reopened,
                // which starts a fresh lot after the prior one is shifted out
                // of the queue on close).
                const existingLot = q.length > 0 ? q[q.length - 1] : undefined;
                if (existingLot) {
                    mergeIntoOpenLot(existingLot, match, contracts);
                    continue;
                }

                q.push({
                    match,
                    totalContracts: contracts,
                    remainingContracts: contracts,
                    openLegs: match.strategy === 'STRANGLE'
                        ? match.order.legs.map(l => ({ ...l, openNet: legNetAmount(l) }))
                        : undefined,
                    remainingOpenNet: match.strategy === 'STRANGLE' ? match.order.netAmount : undefined,
                    openFillTimes: [match.order.time],
                });
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

                // Scale each open leg's own cost basis down to just the
                // consumed slice before computing its realized close — a
                // merged multi-contract lot's `openLegs[i].openNet` reflects
                // the *whole* lot, but this close may only consume part of it
                // (see `mergeIntoOpenLot`), so per-leg P&L must be derived
                // from the consumed share, not the lot's full aggregate.
                const consumedOpenLegs = lot.openLegs && consumed !== lot.totalContracts
                    ? scaleLegs(lot.openLegs, lot.totalContracts, consumed)
                    : lot.openLegs;
                const liveLegs = lot.match.strategy === 'STRANGLE' && consumedOpenLegs
                    ? stampStrangleLegCloses(consumedOpenLegs, match.order.legs, lot.match.order.underlying, match.order.time)
                    : lot.openLegs;
                const shape = toTradeShape(lot.match, consumed, liveLegs, lot.closedLegs);
                const pnl = openShare + closeShare;
                const daysOpen = safeHoldDays(lot.match.order.time, match.order.time);
                trades.push({
                    id: `${lot.match.order.orderId}-${match.order.orderId}-${lot.totalContracts - lot.remainingContracts}`,
                    strategy: lot.match.strategy,
                    underlying: lot.match.order.underlying,
                    status: 'closed',
                    openOrderId: lot.match.order.orderId,
                    openedAt: lot.match.order.time,
                    openFillTimes: lot.openFillTimes,
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
                // Keep the lot's remaining cost basis in sync with the contracts
                // actually left — otherwise a partially-closed multi-contract
                // strangle lot would still report its *original* full-size
                // openNet for its now-smaller remaining position (see
                // `OpenLot.remainingOpenNet`).
                if (lot.remainingOpenNet != null) lot.remainingOpenNet -= openShare;
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
    }

    // Any remaining open lots are still-open trades (using their remaining share of open net).
    // Note: a lot whose only still-open leg(s) have already passed expiration is *not* flipped
    // to closed here — pairing.ts has no live price, so it can't tell a worthless OTM expiration
    // (safe to value at $0) from an ITM assignment/exercise (real settlement value, not $0).
    // `applyUnrealizedPnl` in transactions/service.ts does that check with a live quote and
    // flips status there instead — see its handling of `expired` legs.
    for (const q of openQueues.values()) {
        for (const lot of q) {
            const openShare = lot.remainingOpenNet ?? (lot.remainingContracts / lot.totalContracts) * lot.match.order.netAmount;
            const shape = toTradeShape(lot.match, lot.remainingContracts, lot.openLegs, lot.closedLegs);
            trades.push({
                id: `open-${lot.match.order.orderId}-${lot.remainingContracts}`,
                strategy: lot.match.strategy,
                underlying: lot.match.order.underlying,
                status: 'open',
                openOrderId: lot.match.order.orderId,
                openedAt: lot.match.order.time,
                openFillTimes: lot.openFillTimes,
                openNet: openShare,
                daysOpen: safeHoldDays(lot.match.order.time, new Date().toISOString()),
                ...shape,
            });
        }
    }

    // Newest first for display.
    return trades.sort((a, b) => (b.openedAt ?? '').localeCompare(a.openedAt ?? ''));
}

export function safeHoldDays(open: string, close: string): number {
    try {
        return Math.max(0, differenceInCalendarDays(parseISO(close), parseISO(open)));
    } catch {
        return 0;
    }
}
