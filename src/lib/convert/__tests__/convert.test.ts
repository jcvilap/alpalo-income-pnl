import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseLegs, ParseError } from '../parseLegs';
import { computeNetPrice } from '../netPrice';
import { buildOrderString } from '../buildOrderString';
import { convertOrder } from '../index';

/** Builds a fill line, e.g. line('BTO', 'SPXW', 7705, 'C', '10/13/26', 68.2). */
function line(action: string, underlying: string, strike: number, right: 'C' | 'P', exp: string, price: number, ratio?: number) {
    const qty = ratio && ratio !== 1 ? `${ratio}x ` : '';
    return `${action} ${qty}${underlying} ${strike}${right} ${exp} at ${price}`;
}

describe('parseLegs', () => {
    test('parses a single BTO leg with implicit ratio 1', () => {
        const legs = parseLegs('BTO SPXW 7705C 10/13/26 at 68.20');
        assert.equal(legs.length, 1);
        assert.deepEqual(legs[0], {
            action: 'BTO',
            ratio: 1,
            underlying: 'SPXW',
            strike: 7705,
            right: 'CALL',
            expiration: '10/13/26',
            price: 68.2,
        });
    });

    test('parses explicit ratio with × symbol and sign', () => {
        const legs = parseLegs('STO -2× SPXW 7730C 10/13/26 at 55.25');
        assert.equal(legs[0].ratio, 2);
        assert.equal(legs[0].action, 'STO');
    });

    test('parses explicit ratio with plain x and no sign', () => {
        const legs = parseLegs('BTO 3x SPXW 7600P 10/20/26 at 12.5');
        assert.equal(legs[0].ratio, 3);
        assert.equal(legs[0].right, 'PUT');
    });

    test('parses a dollar-prefixed price', () => {
        const legs = parseLegs('STO -1× META 690P 10/30/26 at $24.80');
        assert.equal(legs[0].price, 24.8);
    });

    test('normalizes 4-digit year expiration', () => {
        const legs = parseLegs('BTO SPXW 7705C 10/13/2026 at 68.20');
        assert.equal(legs[0].expiration, '10/13/26');
    });

    test('is case-insensitive on action and right', () => {
        const legs = parseLegs('bto spxw 7705c 10/13/26 at 68.20');
        assert.equal(legs[0].action, 'BTO');
        assert.equal(legs[0].right, 'CALL');
    });

    test('ignores blank lines between legs', () => {
        const legs = parseLegs('BTO SPXW 7705C 10/13/26 at 68.20\n\n\nSTO SPXW 7730C 10/13/26 at 55.25');
        assert.equal(legs.length, 2);
    });

    test('throws ParseError on empty input', () => {
        assert.throws(() => parseLegs(''), ParseError);
        assert.throws(() => parseLegs('   \n  '), ParseError);
    });

    test('throws ParseError with line number on malformed line', () => {
        try {
            parseLegs('BTO SPXW 7705C 10/13/26 at 68.20\nnot a valid line');
            assert.fail('expected ParseError');
        } catch (e) {
            assert.ok(e instanceof ParseError);
            assert.equal(e.lineNumber, 2);
        }
    });

    test('throws ParseError on zero ratio', () => {
        assert.throws(() => parseLegs('BTO 0x SPXW 7705C 10/13/26 at 68.20'), ParseError);
    });
});

describe('computeNetPrice', () => {
    test('BTO is a debit (negative contribution)', () => {
        const legs = parseLegs('BTO SPXW 7705C 10/13/26 at 68.20');
        assert.equal(computeNetPrice(legs), -68.2);
    });

    test('STO is a credit (positive contribution)', () => {
        const legs = parseLegs('STO SPXW 7730C 10/13/26 at 55.25');
        assert.equal(computeNetPrice(legs), 55.25);
    });

    test('scales by ratio', () => {
        const legs = parseLegs('STO -2× SPXW 7730C 10/13/26 at 55.25');
        assert.equal(computeNetPrice(legs), 110.5);
    });

    test('sums across the user example (5 legs) to a net debit', () => {
        const input = [
            line('BTO', 'SPXW', 7705, 'C', '10/13/26', 68.2),
            line('STO', 'SPXW', 7730, 'C', '10/13/26', 55.25, 2),
            line('BTO', 'SPXW', 7755, 'C', '10/13/26', 44),
            line('BTO', 'SPXW', 7600, 'P', '10/20/26', 58.95),
            line('STO', 'SPXW', 7630, 'P', '10/13/26', 50.95),
        ].join('\n');
        const legs = parseLegs(input);
        // -68.20 + 2*55.25 - 44 - 58.95 + 50.95
        const expected = -68.2 + 2 * 55.25 - 44 - 58.95 + 50.95;
        assert.ok(Math.abs(computeNetPrice(legs) - expected) < 1e-9);
    });
});

describe('buildOrderString', () => {
    test('single leg produces a BUY CUSTOM order for a debit', () => {
        const legs = parseLegs('BTO SPXW 7705C 10/13/26 at 68.20');
        const net = computeNetPrice(legs);
        const order = buildOrderString(legs, net);
        assert.equal(order, 'BUY +1 CUSTOM SPX 100 (Weeklys) +1 13 OCT 26 7705 CALL @68.20 LMT');
    });

    test('single leg produces a SELL CUSTOM order for a credit', () => {
        const legs = parseLegs('STO SPXW 7730C 10/13/26 at 55.25');
        const net = computeNetPrice(legs);
        const order = buildOrderString(legs, net);
        assert.equal(order, 'SELL -1 CUSTOM SPX 100 (Weeklys) -1 13 OCT 26 7730 CALL @55.25 LMT');
    });

    test('honors an explicit price override instead of the computed net', () => {
        const legs = parseLegs('BTO SPXW 7705C 10/13/26 at 68.20');
        const order = buildOrderString(legs, computeNetPrice(legs), { price: -70 });
        assert.match(order, /@70\.00 LMT$/);
        assert.match(order, /^BUY/);
    });

    test('formats fractional strikes without a trailing zero', () => {
        const legs = parseLegs('BTO SPX 4500.5C 10/13/26 at 1.5');
        const order = buildOrderString(legs, computeNetPrice(legs));
        assert.match(order, /4500\.5 CALL/);
    });
});

describe('buildOrderString for double calendars/diagonals (real broker examples)', () => {
    // buildOrderString takes an already-signed price (credit positive, debit
    // negative, matching computeNetPrice's convention) — the user's real
    // examples quote a positive debit magnitude, so pass it negated here.

    test('double calendar with matching strikes across expirations -> DBL DIAG', () => {
        const input = [
            line('STO', 'SPXW', 7660, 'P', '10/30/26', 101.9),
            line('STO', 'SPXW', 7710, 'C', '10/30/26', 115.9),
            line('BTO', 'SPXW', 7660, 'P', '11/30/26', 144.9),
            line('BTO', 'SPXW', 7710, 'C', '11/30/26', 178.25),
        ].join('\n');
        const legs = parseLegs(input);
        const order = buildOrderString(legs, computeNetPrice(legs), { price: -10.5 });
        assert.equal(
            order,
            'BUY +1 DBL DIAG SPX 100 (Weeklys) 30 NOV 26/30 OCT 26 7660/7710/7660/7710 PUT/CALL/PUT/CALL @10.50 LMT',
        );
    });

    test('double diagonal with different strikes across expirations -> DBL DIAG', () => {
        const input = [
            line('STO', 'SPXW', 7620, 'P', '10/30/26', 87.95),
            line('STO', 'SPXW', 7750, 'C', '10/30/26', 95.05),
            line('BTO', 'SPXW', 7660, 'P', '11/30/26', 144.15),
            line('BTO', 'SPXW', 7710, 'C', '11/30/26', 179.15),
        ].join('\n');
        const legs = parseLegs(input);
        const order = buildOrderString(legs, computeNetPrice(legs), { price: -14.02 });
        assert.equal(
            order,
            'BUY +1 DBL DIAG SPX 100 (Weeklys) 30 NOV 26/30 OCT 26 7660/7710/7620/7750 PUT/CALL/PUT/CALL @14.02 LMT',
        );
    });

    test('leg order in the pasted text does not affect the output', () => {
        const shuffled = [
            line('BTO', 'SPXW', 7710, 'C', '11/30/26', 178.25),
            line('STO', 'SPXW', 7710, 'C', '10/30/26', 115.9),
            line('BTO', 'SPXW', 7660, 'P', '11/30/26', 144.9),
            line('STO', 'SPXW', 7660, 'P', '10/30/26', 101.9),
        ].join('\n');
        const legs = parseLegs(shuffled);
        const order = buildOrderString(legs, computeNetPrice(legs), { price: -10.5 });
        assert.equal(
            order,
            'BUY +1 DBL DIAG SPX 100 (Weeklys) 30 NOV 26/30 OCT 26 7660/7710/7660/7710 PUT/CALL/PUT/CALL @10.50 LMT',
        );
    });

    test('a net credit double diagonal produces a SELL verb', () => {
        const input = [
            line('STO', 'SPXW', 7660, 'P', '10/30/26', 101.9),
            line('STO', 'SPXW', 7710, 'C', '10/30/26', 115.9),
            line('BTO', 'SPXW', 7660, 'P', '11/30/26', 144.9),
            line('BTO', 'SPXW', 7710, 'C', '11/30/26', 178.25),
        ].join('\n');
        const legs = parseLegs(input);
        const order = buildOrderString(legs, computeNetPrice(legs), { price: 10.5 });
        assert.match(order, /^SELL -1 DBL DIAG/);
        assert.match(order, /@10\.50 LMT$/);
    });

    test('scales the base quantity with a shared leg ratio', () => {
        const input = [
            line('STO', 'SPXW', 7660, 'P', '10/30/26', 101.9, 2),
            line('STO', 'SPXW', 7710, 'C', '10/30/26', 115.9, 2),
            line('BTO', 'SPXW', 7660, 'P', '11/30/26', 144.9, 2),
            line('BTO', 'SPXW', 7710, 'C', '11/30/26', 178.25, 2),
        ].join('\n');
        const legs = parseLegs(input);
        const order = buildOrderString(legs, computeNetPrice(legs), { price: -21.0 });
        assert.match(order, /^BUY \+2 DBL DIAG/);
    });

    test('falls back to CUSTOM when ratios differ across the 4 legs', () => {
        const input = [
            line('STO', 'SPXW', 7660, 'P', '10/30/26', 101.9),
            line('STO', 'SPXW', 7710, 'C', '10/30/26', 115.9, 2),
            line('BTO', 'SPXW', 7660, 'P', '11/30/26', 144.9),
            line('BTO', 'SPXW', 7710, 'C', '11/30/26', 178.25),
        ].join('\n');
        const legs = parseLegs(input);
        const order = buildOrderString(legs, computeNetPrice(legs));
        assert.match(order, /CUSTOM/);
    });

    test('falls back to CUSTOM when a leg right is duplicated within an expiration', () => {
        const input = [
            line('STO', 'SPXW', 7660, 'P', '10/30/26', 101.9),
            line('STO', 'SPXW', 7600, 'P', '10/30/26', 90),
            line('BTO', 'SPXW', 7660, 'P', '11/30/26', 144.9),
            line('BTO', 'SPXW', 7710, 'C', '11/30/26', 178.25),
        ].join('\n');
        const legs = parseLegs(input);
        const order = buildOrderString(legs, computeNetPrice(legs));
        assert.match(order, /CUSTOM/);
    });
});

describe('convertOrder for double calendars/diagonals, using the plain positive price the user types', () => {
    test('the user\'s first real double-calendar example converts end-to-end', () => {
        const input = [
            'STO -1× SPXW 7660P 10/30/26 at 101.90',
            'STO -1× SPXW 7710C 10/30/26 at 115.90',
            'BTO SPXW 7660P 11/30/26 at 144.90',
            'BTO SPXW 7710C 11/30/26 at 178.25',
        ].join('\n');
        const { orderString } = convertOrder(input, 10.5);
        assert.equal(
            orderString,
            'BUY +1 DBL DIAG SPX 100 (Weeklys) 30 NOV 26/30 OCT 26 7660/7710/7660/7710 PUT/CALL/PUT/CALL @10.50 LMT',
        );
    });

    test('the user\'s second real double-diagonal example converts end-to-end', () => {
        const input = [
            'STO -1× SPXW 7620P 10/30/26 at 87.95',
            'STO -1× SPXW 7750C 10/30/26 at 95.05',
            'BTO SPXW 7660P 11/30/26 at 144.15',
            'BTO SPXW 7710C 11/30/26 at 179.15',
        ].join('\n');
        const { orderString } = convertOrder(input, 14.02);
        assert.equal(
            orderString,
            'BUY +1 DBL DIAG SPX 100 (Weeklys) 30 NOV 26/30 OCT 26 7660/7710/7620/7750 PUT/CALL/PUT/CALL @14.02 LMT',
        );
    });
});

describe('buildOrderString / convertOrder for strangles (real broker example)', () => {
    test('the user\'s real META strangle example converts end-to-end', () => {
        const input = ['STO -1× META 690P 10/30/26 at $24.80', 'STO -1× META 740C 10/30/26 at $29.25'].join('\n');
        const { orderString, computedNetPrice } = convertOrder(input);
        assert.ok(Math.abs(computedNetPrice - 54.05) < 1e-9);
        assert.equal(orderString, 'SELL -1 STRANGLE META 100 (Weeklys) 30 OCT 26 740/690 CALL/PUT @54.05 LMT');
    });

    test('leg order in the pasted text does not affect the output', () => {
        const input = ['STO -1× META 740C 10/30/26 at $29.25', 'STO -1× META 690P 10/30/26 at $24.80'].join('\n');
        const { orderString } = convertOrder(input);
        assert.equal(orderString, 'SELL -1 STRANGLE META 100 (Weeklys) 30 OCT 26 740/690 CALL/PUT @54.05 LMT');
    });

    test('a net debit strangle (buying to open) produces a BUY verb', () => {
        const legs = parseLegs('BTO META 690P 10/30/26 at 24.80\nBTO META 740C 10/30/26 at 29.25');
        const order = buildOrderString(legs, computeNetPrice(legs));
        assert.match(order, /^BUY \+1 STRANGLE/);
    });

    test('scales the base quantity with a shared leg ratio', () => {
        const legs = parseLegs('STO -2× META 690P 10/30/26 at 24.80\nSTO -2× META 740C 10/30/26 at 29.25');
        const order = buildOrderString(legs, computeNetPrice(legs));
        assert.match(order, /^SELL -2 STRANGLE/);
    });

    test('falls back to CUSTOM when both legs share the same right', () => {
        const legs = parseLegs('STO META 690C 10/30/26 at 24.80\nSTO META 740C 10/30/26 at 29.25');
        const order = buildOrderString(legs, computeNetPrice(legs));
        assert.match(order, /CUSTOM/);
    });

    test('falls back to CUSTOM when strangle legs have mismatched ratios', () => {
        const legs = parseLegs('STO -1× META 690P 10/30/26 at 24.80\nSTO -2× META 740C 10/30/26 at 29.25');
        const order = buildOrderString(legs, computeNetPrice(legs));
        assert.match(order, /CUSTOM/);
    });
});

describe('buildOrderString / convertOrder for iron condors (real broker example)', () => {
    test('the user\'s real META iron condor example converts end-to-end', () => {
        const input = [
            'BTO META 715P 10/30/26 at $36.38',
            'STO -1× META 720P 10/30/26 at $39.03',
            'STO -1× META 790C 10/30/26 at $14.83',
            'BTO META 880C 10/30/26 at $3.93',
        ].join('\n');
        const { orderString, computedNetPrice } = convertOrder(input);
        assert.ok(Math.abs(computedNetPrice - 13.55) < 1e-9);
        assert.equal(orderString, 'SELL -1 IRON CONDOR META 100 (Weeklys) 30 OCT 26 790/880/720/715 CALL/PUT @13.55 LMT');
    });

    test('leg order in the pasted text does not affect the output', () => {
        const input = [
            'STO -1× META 790C 10/30/26 at $14.83',
            'BTO META 880C 10/30/26 at $3.93',
            'BTO META 715P 10/30/26 at $36.38',
            'STO -1× META 720P 10/30/26 at $39.03',
        ].join('\n');
        const { orderString } = convertOrder(input);
        assert.equal(orderString, 'SELL -1 IRON CONDOR META 100 (Weeklys) 30 OCT 26 790/880/720/715 CALL/PUT @13.55 LMT');
    });

    test('a net debit iron condor (unusual, but mechanically possible) produces a BUY verb', () => {
        const legs = parseLegs(
            'BTO META 715P 10/30/26 at 40\nSTO -1× META 720P 10/30/26 at 1\nSTO -1× META 790C 10/30/26 at 1\nBTO META 880C 10/30/26 at 40',
        );
        const order = buildOrderString(legs, computeNetPrice(legs));
        assert.match(order, /^BUY \+1 IRON CONDOR/);
    });

    test('scales the base quantity with a shared leg ratio', () => {
        const legs = parseLegs(
            'BTO -2× META 715P 10/30/26 at 36.38\nSTO -2× META 720P 10/30/26 at 39.03\nSTO -2× META 790C 10/30/26 at 14.83\nBTO -2× META 880C 10/30/26 at 3.93',
        );
        const order = buildOrderString(legs, computeNetPrice(legs));
        assert.match(order, /^SELL -2 IRON CONDOR/);
    });

    test('falls back to CUSTOM when a right has two short (or two long) legs instead of one of each', () => {
        const legs = parseLegs(
            'STO META 715P 10/30/26 at 36.38\nSTO META 720P 10/30/26 at 39.03\nSTO META 790C 10/30/26 at 14.83\nBTO META 880C 10/30/26 at 3.93',
        );
        const order = buildOrderString(legs, computeNetPrice(legs));
        assert.match(order, /CUSTOM/);
    });

    test('falls back to CUSTOM when the 4 legs span more than one expiration', () => {
        const legs = parseLegs(
            'BTO META 715P 10/30/26 at 36.38\nSTO -1× META 720P 10/30/26 at 39.03\nSTO -1× META 790C 11/30/26 at 14.83\nBTO META 880C 11/30/26 at 3.93',
        );
        const order = buildOrderString(legs, computeNetPrice(legs));
        assert.match(order, /CUSTOM/);
    });
});

describe('convertOrder end-to-end, scaling from 1 to 7 legs', () => {
    const legSpecs: [string, string, number, 'C' | 'P', string, number, number?][] = [
        ['BTO', 'SPXW', 7705, 'C', '10/13/26', 68.2],
        ['STO', 'SPXW', 7730, 'C', '10/13/26', 55.25, 2],
        ['BTO', 'SPXW', 7755, 'C', '10/13/26', 44],
        ['BTO', 'SPXW', 7600, 'P', '10/20/26', 58.95],
        ['STO', 'SPXW', 7630, 'P', '10/13/26', 50.95],
        ['BTC', 'SPXW', 7500, 'P', '10/20/26', 5.1],
        ['STC', 'SPXW', 7450, 'P', '10/20/26', 2.2, 3],
    ];

    for (let n = 1; n <= 7; n++) {
        test(`converts a ${n}-leg order end-to-end`, () => {
            const input = legSpecs
                .slice(0, n)
                .map(([action, underlying, strike, right, exp, price, ratio]) => line(action, underlying, strike, right, exp, price, ratio))
                .join('\n');

            const result = convertOrder(input);

            assert.equal(result.legCount, n);
            assert.ok(result.orderString.startsWith('BUY') || result.orderString.startsWith('SELL'));
            assert.match(result.orderString, /CUSTOM SPX 100 \(Weeklys\)/);
            assert.match(result.orderString, /@\d+\.\d{2} LMT$/);

            // Exactly n leg clauses, i.e. n-1 internal "/" separators within the leg segment.
            const legSegment = result.orderString.split('(Weeklys) ')[1].split(' @')[0];
            assert.equal(legSegment.split('/').length, n);

            // Every leg clause has the shape "<signed-ratio> <D MMM YY> <strike> <CALL|PUT>".
            for (const clause of legSegment.split('/')) {
                assert.match(clause, /^[+-]\d+ \d{1,2} [A-Z]{3} \d{2} \d+(\.\d+)? (CALL|PUT)$/);
            }
        });
    }

    test('an overridden limit price flows through end-to-end', () => {
        const input = line('BTO', 'SPXW', 7705, 'C', '10/13/26', 68.2);
        const result = convertOrder(input, -65);
        assert.match(result.orderString, /@65\.00 LMT$/);
    });

    test('propagates ParseError for malformed pasted text', () => {
        assert.throws(() => convertOrder('this is not an order line'), ParseError);
    });
});
