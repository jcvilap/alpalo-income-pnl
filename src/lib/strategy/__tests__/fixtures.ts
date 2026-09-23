import type { SchwabTransaction } from '@/live/schwabClient';

/**
 * Test fixtures modeled on real Schwab /transactions responses.
 *
 * Sign conventions used here (matching Schwab):
 *  - transferItem.amount: + = bought (long), - = sold (short)
 *  - transaction.netAmount: - = net debit paid, + = net credit received
 */

function optionItem(opts: {
    underlying: string;
    right: 'CALL' | 'PUT';
    strike: number;
    expiration: string;
    amount: number; // signed
    price: number;
    effect: 'OPENING' | 'CLOSING';
}): NonNullable<SchwabTransaction['transferItems']>[number] {
    return {
        amount: opts.amount,
        price: opts.price,
        cost: -opts.amount * opts.price * 100,
        positionEffect: opts.effect,
        instrument: {
            assetType: 'OPTION',
            putCall: opts.right,
            strikePrice: opts.strike,
            expirationDate: `${opts.expiration}T00:00:00.000Z`,
            underlyingSymbol: opts.underlying,
            symbol: `${opts.underlying} ${opts.expiration} ${opts.right} ${opts.strike}`,
        },
    };
}

/**
 * A winning double calendar on SPY:
 *  - OPEN order 1001: sell near CALL/PUT, buy far CALL/PUT → pay $2.00 debit
 *  - CLOSE order 1002: reverse the legs → receive $3.20 credit
 *  - Realized P&L = -200 + 320 = +$120
 */
export const DOUBLE_CAL_WIN: SchwabTransaction[] = [
    {
        type: 'TRADE',
        orderId: 1001,
        time: '2025-02-03T15:30:00.000Z',
        netAmount: -200,
        transferItems: [
            optionItem({ underlying: 'SPY', right: 'CALL', strike: 500, expiration: '2025-02-21', amount: -1, price: 3.0, effect: 'OPENING' }),
            optionItem({ underlying: 'SPY', right: 'CALL', strike: 500, expiration: '2025-03-21', amount: 1, price: 4.0, effect: 'OPENING' }),
            optionItem({ underlying: 'SPY', right: 'PUT', strike: 490, expiration: '2025-02-21', amount: -1, price: 3.0, effect: 'OPENING' }),
            optionItem({ underlying: 'SPY', right: 'PUT', strike: 490, expiration: '2025-03-21', amount: 1, price: 4.0, effect: 'OPENING' }),
        ],
    },
    {
        type: 'TRADE',
        orderId: 1002,
        time: '2025-02-14T15:00:00.000Z',
        netAmount: 320,
        transferItems: [
            optionItem({ underlying: 'SPY', right: 'CALL', strike: 500, expiration: '2025-02-21', amount: 1, price: 2.5, effect: 'CLOSING' }),
            optionItem({ underlying: 'SPY', right: 'CALL', strike: 500, expiration: '2025-03-21', amount: -1, price: 4.7, effect: 'CLOSING' }),
            optionItem({ underlying: 'SPY', right: 'PUT', strike: 490, expiration: '2025-02-21', amount: 1, price: 2.5, effect: 'CLOSING' }),
            optionItem({ underlying: 'SPY', right: 'PUT', strike: 490, expiration: '2025-03-21', amount: -1, price: 4.7, effect: 'CLOSING' }),
        ],
    },
];

/**
 * A losing double calendar on QQQ, still one open + one close.
 *  - OPEN order 2001: pay $2.50 debit
 *  - CLOSE order 2002: receive $1.50 credit
 *  - Realized P&L = -250 + 150 = -$100
 */
export const DOUBLE_CAL_LOSS: SchwabTransaction[] = [
    {
        type: 'TRADE',
        orderId: 2001,
        time: '2025-03-01T15:30:00.000Z',
        netAmount: -250,
        transferItems: [
            optionItem({ underlying: 'QQQ', right: 'CALL', strike: 440, expiration: '2025-03-21', amount: -1, price: 3.5, effect: 'OPENING' }),
            optionItem({ underlying: 'QQQ', right: 'CALL', strike: 440, expiration: '2025-04-17', amount: 1, price: 4.5, effect: 'OPENING' }),
            optionItem({ underlying: 'QQQ', right: 'PUT', strike: 430, expiration: '2025-03-21', amount: -1, price: 3.5, effect: 'OPENING' }),
            optionItem({ underlying: 'QQQ', right: 'PUT', strike: 430, expiration: '2025-04-17', amount: 1, price: 4.5, effect: 'OPENING' }),
        ],
    },
    {
        type: 'TRADE',
        orderId: 2002,
        time: '2025-03-10T15:00:00.000Z',
        netAmount: 150,
        transferItems: [
            optionItem({ underlying: 'QQQ', right: 'CALL', strike: 440, expiration: '2025-03-21', amount: 1, price: 3.0, effect: 'CLOSING' }),
            optionItem({ underlying: 'QQQ', right: 'CALL', strike: 440, expiration: '2025-04-17', amount: -1, price: 4.0, effect: 'CLOSING' }),
            optionItem({ underlying: 'QQQ', right: 'PUT', strike: 430, expiration: '2025-03-21', amount: 1, price: 3.0, effect: 'CLOSING' }),
            optionItem({ underlying: 'QQQ', right: 'PUT', strike: 430, expiration: '2025-04-17', amount: -1, price: 4.0, effect: 'CLOSING' }),
        ],
    },
];

/**
 * An iron condor (4 legs, single expiration, two calls + two puts at four
 * different strikes) — must NOT be detected as a double calendar.
 */
export const IRON_CONDOR: SchwabTransaction[] = [
    {
        type: 'TRADE',
        orderId: 3001,
        time: '2025-04-01T15:30:00.000Z',
        netAmount: 180,
        transferItems: [
            optionItem({ underlying: 'IWM', right: 'CALL', strike: 210, expiration: '2025-04-17', amount: -1, price: 2.0, effect: 'OPENING' }),
            optionItem({ underlying: 'IWM', right: 'CALL', strike: 215, expiration: '2025-04-17', amount: 1, price: 1.0, effect: 'OPENING' }),
            optionItem({ underlying: 'IWM', right: 'PUT', strike: 200, expiration: '2025-04-17', amount: -1, price: 2.0, effect: 'OPENING' }),
            optionItem({ underlying: 'IWM', right: 'PUT', strike: 195, expiration: '2025-04-17', amount: 1, price: 1.0, effect: 'OPENING' }),
        ],
    },
];

/** A still-open double calendar (open only, no close). */
export const DOUBLE_CAL_OPEN: SchwabTransaction[] = [DOUBLE_CAL_WIN[0]];
