import type { ParsedLeg } from './parseLegs';

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/** Known weekly-option root tickers whose "W" suffix TOS drops in the order string (the "(Weeklys)" tag already conveys it). */
const WEEKLY_ROOTS = ['SPX', 'RUT', 'NDX'];

/** "10/13/26" -> "13 OCT 26", TOS's native date token. */
function toTosDate(expiration: string): string {
    const [month, day, year] = expiration.split('/').map((p) => parseInt(p, 10));
    return `${day} ${MONTHS[month - 1]} ${year.toString().padStart(2, '0')}`;
}

/** Signed ratio for a leg relative to the order's base quantity: BTO/STC are long (+), STO/BTC are short (-). */
function signedRatio(leg: ParsedLeg): number {
    const sign = leg.action === 'BTO' || leg.action === 'STC' ? 1 : -1;
    return sign * leg.ratio;
}

function formatStrike(strike: number): string {
    return Number.isInteger(strike) ? String(strike) : strike.toFixed(2).replace(/0$/, '');
}

/** "SPXW" -> "SPX": TOS shows the root ticker and conveys weeklys via "(Weeklys)" instead. */
function tosUnderlying(underlying: string): string {
    const root = WEEKLY_ROOTS.find((r) => underlying === `${r}W`);
    return root ?? underlying;
}

/** Parses an MM/DD/YY expiration into a comparable number (YYMMDD) for chronological sorting. */
function expirationSortKey(expiration: string): number {
    const [month, day, year] = expiration.split('/').map((p) => parseInt(p, 10));
    return year * 10000 + month * 100 + day;
}

export interface BuildOrderOptions {
    /** Net order price to display. Defaults to the computed net price from leg prices when omitted. */
    price?: number;
}

/**
 * A double calendar/diagonal: exactly 2 distinct expirations, exactly one PUT
 * and one CALL leg per expiration (4 legs total), same ratio throughout.
 * Matches TOS's "DBL DIAG" order-bar grammar regardless of whether strikes
 * match across expirations (calendar) or differ (diagonal) — confirmed
 * against two live TOS-pasted examples.
 */
function isDoubleCalendarOrDiagonal(legs: ParsedLeg[]): boolean {
    if (legs.length !== 4) return false;
    const expirations = Array.from(new Set(legs.map((l) => l.expiration)));
    if (expirations.length !== 2) return false;
    const ratio = legs[0].ratio;
    if (!legs.every((l) => l.ratio === ratio)) return false;
    for (const exp of expirations) {
        const legsAtExp = legs.filter((l) => l.expiration === exp);
        if (legsAtExp.length !== 2) return false;
        const rights = new Set(legsAtExp.map((l) => l.right));
        if (rights.size !== 2) return false;
    }
    return true;
}

/** Builds the "DBL DIAG" order-bar string for a double calendar/diagonal (see isDoubleCalendarOrDiagonal). */
function buildDoubleDiagonalString(legs: ParsedLeg[], price: number): string {
    const underlying = tosUnderlying(legs[0].underlying);
    const expirations = Array.from(new Set(legs.map((l) => l.expiration))).sort((a, b) => expirationSortKey(b) - expirationSortKey(a));

    const strikes: string[] = [];
    const rights: string[] = [];
    for (const exp of expirations) {
        for (const right of ['PUT', 'CALL'] as const) {
            const leg = legs.find((l) => l.expiration === exp && l.right === right);
            if (!leg) throw new Error('Double diagonal must have one PUT and one CALL leg per expiration.');
            strikes.push(formatStrike(leg.strike));
            rights.push(right);
        }
    }

    const ratio = legs[0].ratio;
    const verb = price >= 0 ? 'SELL' : 'BUY';
    const qty = verb === 'BUY' ? `+${ratio}` : `-${ratio}`;
    const dateClause = expirations.map(toTosDate).join('/');

    return `${verb} ${qty} DBL DIAG ${underlying} 100 (Weeklys) ${dateClause} ${strikes.join('/')} ${rights.join('/')} @${Math.abs(price).toFixed(2)} LMT`;
}

/**
 * A strangle: exactly 2 legs, same expiration, same ratio, one PUT and one
 * CALL. Matches TOS's "STRANGLE" order-bar grammar — confirmed against a
 * live TOS-pasted example.
 */
function isStrangle(legs: ParsedLeg[]): boolean {
    if (legs.length !== 2) return false;
    if (legs[0].expiration !== legs[1].expiration) return false;
    if (legs[0].ratio !== legs[1].ratio) return false;
    const rights = new Set(legs.map((l) => l.right));
    return rights.size === 2;
}

/** Builds the "STRANGLE" order-bar string for a strangle (see isStrangle): strikes/rights ordered CALL then PUT, single expiration printed once. */
function buildStrangleString(legs: ParsedLeg[], price: number): string {
    const underlying = tosUnderlying(legs[0].underlying);
    const call = legs.find((l) => l.right === 'CALL')!;
    const put = legs.find((l) => l.right === 'PUT')!;

    const ratio = legs[0].ratio;
    const verb = price >= 0 ? 'SELL' : 'BUY';
    const qty = verb === 'BUY' ? `+${ratio}` : `-${ratio}`;

    return `${verb} ${qty} STRANGLE ${underlying} 100 (Weeklys) ${toTosDate(call.expiration)} ${formatStrike(call.strike)}/${formatStrike(put.strike)} CALL/PUT @${Math.abs(price).toFixed(2)} LMT`;
}

/** Whether a leg opens/holds a short position (STO) vs. long (BTO). */
function isShort(leg: ParsedLeg): boolean {
    return leg.action === 'STO';
}

/**
 * An iron condor: exactly 4 legs, same expiration, same ratio, 2 CALLs (one
 * short + one long) and 2 PUTs (one short + one long). Matches TOS's
 * "IRON CONDOR" order-bar grammar — confirmed against a live TOS-pasted
 * example.
 */
function isIronCondor(legs: ParsedLeg[]): boolean {
    if (legs.length !== 4) return false;
    if (new Set(legs.map((l) => l.expiration)).size !== 1) return false;
    const ratio = legs[0].ratio;
    if (!legs.every((l) => l.ratio === ratio)) return false;

    const calls = legs.filter((l) => l.right === 'CALL');
    const puts = legs.filter((l) => l.right === 'PUT');
    if (calls.length !== 2 || puts.length !== 2) return false;

    const oneShortOneLong = (pair: ParsedLeg[]) => isShort(pair[0]) !== isShort(pair[1]);
    return oneShortOneLong(calls) && oneShortOneLong(puts);
}

/**
 * Builds the "IRON CONDOR" order-bar string (see isIronCondor): strikes/
 * rights grouped CALL pair then PUT pair, each pair ordered short-leg-first
 * then long-leg, single expiration printed once.
 */
function buildIronCondorString(legs: ParsedLeg[], price: number): string {
    const underlying = tosUnderlying(legs[0].underlying);
    const expiration = legs[0].expiration;

    const strikes: string[] = [];
    for (const right of ['CALL', 'PUT'] as const) {
        const pair = legs.filter((l) => l.right === right).sort((a, b) => (isShort(a) === isShort(b) ? 0 : isShort(a) ? -1 : 1));
        strikes.push(...pair.map((l) => formatStrike(l.strike)));
    }

    const ratio = legs[0].ratio;
    const verb = price >= 0 ? 'SELL' : 'BUY';
    const qty = verb === 'BUY' ? `+${ratio}` : `-${ratio}`;

    return `${verb} ${qty} IRON CONDOR ${underlying} 100 (Weeklys) ${toTosDate(expiration)} ${strikes.join('/')} CALL/PUT @${Math.abs(price).toFixed(2)} LMT`;
}

/**
 * Builds a best-effort thinkorswim "CUSTOM" order-bar string from parsed legs.
 * Verified against TOS's grammar for single-expiration combos (date/strike/right
 * tokens, "100 (Weeklys)" multiplier block, "@price LMT" suffix); the per-leg
 * repetition of date+strike+right for multi-expiration custom combos is
 * best-effort and un-verified against a live TOS order — confirm by pasting
 * before trusting it to route.
 */
function buildCustomString(legs: ParsedLeg[], price: number): string {
    const underlying = tosUnderlying(legs[0].underlying);

    const legClauses = legs.map((leg) => {
        const ratio = signedRatio(leg);
        const ratioStr = ratio > 0 ? `+${ratio}` : `${ratio}`;
        return `${ratioStr} ${toTosDate(leg.expiration)} ${formatStrike(leg.strike)} ${leg.right}`;
    });

    const verb = price >= 0 ? 'SELL' : 'BUY';
    const baseQty = verb === 'BUY' ? '+1' : '-1';

    return `${verb} ${baseQty} CUSTOM ${underlying} 100 (Weeklys) ${legClauses.join('/')} @${Math.abs(price).toFixed(2)} LMT`;
}

/** Builds a thinkorswim order-bar string from parsed legs, picking a recognized strategy shape (e.g. DBL DIAG) when the legs match one, or falling back to a generic CUSTOM combo. */
export function buildOrderString(legs: ParsedLeg[], netPrice: number, options: BuildOrderOptions = {}): string {
    if (legs.length === 0) {
        throw new Error('Cannot build an order string with no legs.');
    }

    const price = options.price ?? netPrice;

    if (isDoubleCalendarOrDiagonal(legs)) {
        return buildDoubleDiagonalString(legs, price);
    }
    if (isStrangle(legs)) {
        return buildStrangleString(legs, price);
    }
    if (isIronCondor(legs)) {
        return buildIronCondorString(legs, price);
    }
    return buildCustomString(legs, price);
}
