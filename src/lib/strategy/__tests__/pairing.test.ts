import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildTrades } from '../pairing';
import type { Leg, OrderGroup } from '../types';

function leg(right: 'CALL' | 'PUT', strike: number, expiration: string, quantity: number, openClose: 'OPEN' | 'CLOSE', price: number): Leg {
    return { underlying: 'SPX', right, strike, expiration, quantity, openClose, price };
}

describe('buildTrades — double diagonal split-close edge case', () => {
    test('closes a double diagonal whose 4-leg open is matched by two separate 2-leg close orders', () => {
        // Mirrors the screenshots: SPX 7620/7760 double diagonal, opened as one
        // 4-leg order, but Schwab fills the close as two separate 2-leg orders
        // (one per side) instead of one 4-leg order.
        const open: OrderGroup = {
            orderId: 'OPEN1',
            time: '2026-09-22T14:00:00.000Z',
            underlying: 'SPX',
            legs: [
                leg('CALL', 7760, '2026-10-20', -1, 'OPEN', 43.20), // sell near call
                leg('CALL', 7750, '2026-10-13', 1, 'OPEN', 28.57),  // buy far... wait strikes differ, diagonal
                leg('PUT', 7620, '2026-10-20', -1, 'OPEN', 26.35),
                leg('PUT', 7625, '2026-10-13', 1, 'OPEN', 19.81),
            ],
            netAmount: -1000, // arbitrary debit to open
        };

        const closeCallSide: OrderGroup = {
            orderId: 'CLOSE_CALL',
            time: '2026-10-02T15:55:00.000Z',
            underlying: 'SPX',
            legs: [
                leg('CALL', 7760, '2026-10-20', 1, 'CLOSE', 62.30),
                leg('CALL', 7750, '2026-10-13', -1, 'CLOSE', 43.20),
            ],
            netAmount: 1900, // credit received closing call side
        };

        const closePutSide: OrderGroup = {
            orderId: 'CLOSE_PUT',
            time: '2026-10-02T15:55:30.000Z',
            underlying: 'SPX',
            legs: [
                leg('PUT', 7620, '2026-10-20', 1, 'CLOSE', 43.25),
                leg('PUT', 7625, '2026-10-13', -1, 'CLOSE', 26.35),
            ],
            netAmount: 1690, // credit received closing put side
        };

        const trades = buildTrades([open, closeCallSide, closePutSide]);

        const closed = trades.filter(t => t.status === 'closed');
        assert.equal(closed.length, 1, 'expected exactly one closed trade combining both halves');
        const trade = closed[0];
        assert.equal(trade.strategy, 'DOUBLE_DIAGONAL');
        assert.equal(trade.openOrderId, 'OPEN1');
        assert.equal(trade.legs.length, 4);
        assert.ok(trade.legs.every(l => l.openClose === 'CLOSE'));

        // openNet + closeNet === pnl, and nothing should be left open.
        assert.equal(trades.some(t => t.status === 'open'), false);
        assert.ok(trade.closeNet != null);
        const expectedCloseNet = closeCallSide.netAmount + closePutSide.netAmount;
        assert.equal(trade.closeNet, expectedCloseNet);
        assert.equal(trade.openNet, open.netAmount);
        assert.equal(trade.pnl, open.netAmount + expectedCloseNet);
    });

    test('a half-closed double diagonal stays open with 2 closed + 2 open legs until the other half closes', () => {
        const open: OrderGroup = {
            orderId: 'OPEN1',
            time: '2026-09-22T14:00:00.000Z',
            underlying: 'SPX',
            legs: [
                leg('CALL', 7760, '2026-10-20', -1, 'OPEN', 43.20),
                leg('CALL', 7750, '2026-10-13', 1, 'OPEN', 28.57),
                leg('PUT', 7620, '2026-10-20', -1, 'OPEN', 26.35),
                leg('PUT', 7625, '2026-10-13', 1, 'OPEN', 19.81),
            ],
            netAmount: -1000,
        };

        const closeCallSide: OrderGroup = {
            orderId: 'CLOSE_CALL',
            time: '2026-10-02T15:55:00.000Z',
            underlying: 'SPX',
            legs: [
                leg('CALL', 7760, '2026-10-20', 1, 'CLOSE', 62.30),
                leg('CALL', 7750, '2026-10-13', -1, 'CLOSE', 43.20),
            ],
            netAmount: 1900,
        };

        const trades = buildTrades([open, closeCallSide]);
        const openTrades = trades.filter(t => t.status === 'open');
        assert.equal(openTrades.length, 1);
        const trade = openTrades[0];
        assert.equal(trade.strategy, 'DOUBLE_DIAGONAL');
        assert.equal(trade.legs.length, 4);
        assert.equal(trade.legs.filter(l => l.openClose === 'CLOSE').length, 2);
        assert.equal(trade.legs.filter(l => l.openClose === 'OPEN').length, 2);
    });
});
