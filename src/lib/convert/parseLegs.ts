/** Parses pasted broker-fill-style option leg lines into structured legs. */

export type LegAction = 'BTO' | 'STO' | 'BTC' | 'STC';

export interface ParsedLeg {
    action: LegAction;
    /** Absolute contract ratio for this leg (e.g. 2 for "-2x"). Defaults to 1. */
    ratio: number;
    underlying: string;
    strike: number;
    right: 'CALL' | 'PUT';
    /** Expiration normalized to MM/DD/YY. */
    expiration: string;
    price: number;
}

const LINE_RE =
    /^(BTO|STO|BTC|STC)\s+(?:([+-]?\d+)\s*[x×]\s+)?([A-Z0-9.]+)\s+(\d+(?:\.\d+)?)([CP])\s+(\d{1,2}\/\d{1,2}\/\d{2,4})\s+at\s+\$?(\d+(?:\.\d+)?)\s*$/i;

export class ParseError extends Error {
    constructor(
        message: string,
        public lineNumber: number,
        public line: string,
    ) {
        super(message);
        this.name = 'ParseError';
    }
}

function normalizeExpiration(raw: string): string {
    const parts = raw.split('/');
    const month = parts[0].padStart(2, '0');
    const day = parts[1].padStart(2, '0');
    let year = parts[2];
    if (year.length === 4) year = year.slice(2);
    return `${month}/${day}/${year}`;
}

/** Parses the full pasted text block into an ordered list of legs (one per non-blank line). */
export function parseLegs(input: string): ParsedLeg[] {
    const lines = input
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0);

    if (lines.length === 0) {
        throw new ParseError('No legs found — paste at least one order line.', 0, '');
    }

    return lines.map((line, i) => {
        const match = LINE_RE.exec(line);
        if (!match) {
            throw new ParseError(`Could not parse line: "${line}"`, i + 1, line);
        }
        const [, action, ratioRaw, underlying, strike, right, expiration, price] = match;
        const ratio = ratioRaw ? Math.abs(parseInt(ratioRaw, 10)) : 1;
        if (ratio === 0) {
            throw new ParseError(`Leg quantity cannot be zero: "${line}"`, i + 1, line);
        }
        return {
            action: action.toUpperCase() as LegAction,
            ratio,
            underlying: underlying.toUpperCase(),
            strike: parseFloat(strike),
            right: right.toUpperCase() === 'C' ? 'CALL' : 'PUT',
            expiration: normalizeExpiration(expiration),
            price: parseFloat(price),
        };
    });
}
