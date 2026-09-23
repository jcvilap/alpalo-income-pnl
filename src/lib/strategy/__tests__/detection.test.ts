import { describe, it, expect } from 'vitest';
import { normalizeToOrderGroups } from '../normalize';
import { classifyOrder, DOUBLE_CALENDAR_RULE } from '../rules';
import { buildTrades } from '../pairing';
import { computeMetrics, cumulativePnlSeries } from '../metrics';
import {
    DOUBLE_CAL_WIN,
    DOUBLE_CAL_LOSS,
    IRON_CONDOR,
    DOUBLE_CAL_OPEN,
} from './fixtures';

describe('normalizeToOrderGroups', () => {
    it('groups transfer items by orderId into one 4-leg order per trade', () => {
        const groups = normalizeToOrderGroups(DOUBLE_CAL_WIN);
        expect(groups).toHaveLength(2);
        const [open, close] = groups;
        expect(open.orderId).toBe('1001');
        expect(open.legs).toHaveLength(4);
        expect(open.netAmount).toBe(-200);
        expect(close.orderId).toBe('1002');
        expect(close.netAmount).toBe(320);
    });

    it('drops non-TRADE and non-option noise', () => {
        const withNoise = [
            ...DOUBLE_CAL_WIN,
            { type: 'DIVIDEND_OR_INTEREST', orderId: 9999, time: '2025-02-05T00:00:00Z', netAmount: 5 },
        ];
        const groups = normalizeToOrderGroups(withNoise);
        expect(groups.map(g => g.orderId)).toEqual(['1001', '1002']);
    });
});

describe('DOUBLE_CALENDAR rule', () => {
    it('matches a real double calendar order (open and close)', () => {
        const groups = normalizeToOrderGroups(DOUBLE_CAL_WIN);
        for (const g of groups) {
            expect(DOUBLE_CALENDAR_RULE.matches(g)).toBe(true);
            expect(classifyOrder(g)?.strategy).toBe('DOUBLE_CALENDAR');
        }
    });

    it('does NOT match an iron condor (single expiration, 4 strikes)', () => {
        const groups = normalizeToOrderGroups(IRON_CONDOR);
        expect(groups).toHaveLength(1);
        expect(DOUBLE_CALENDAR_RULE.matches(groups[0])).toBe(false);
        expect(classifyOrder(groups[0])).toBeNull();
    });

    it('reports open vs close side from positionEffect', () => {
        const groups = normalizeToOrderGroups(DOUBLE_CAL_WIN);
        expect(classifyOrder(groups[0])?.side).toBe('OPEN');
        expect(classifyOrder(groups[1])?.side).toBe('CLOSE');
    });

    it('gives matching open/close orders the same signature', () => {
        const groups = normalizeToOrderGroups(DOUBLE_CAL_WIN);
        const openSig = classifyOrder(groups[0])!.signature;
        const closeSig = classifyOrder(groups[1])!.signature;
        expect(openSig).toBe(closeSig);
    });
});

describe('buildTrades pairing', () => {
    it('pairs an open with its close and computes realized P&L', () => {
        const trades = buildTrades(normalizeToOrderGroups(DOUBLE_CAL_WIN));
        expect(trades).toHaveLength(1);
        const t = trades[0];
        expect(t.status).toBe('closed');
        expect(t.realizedPnl).toBe(120); // -200 + 320
        expect(t.openOrderId).toBe('1001');
        expect(t.closeOrderId).toBe('1002');
        expect(t.strikes).toEqual([490, 500]);
        expect(t.holdDays).toBe(11);
    });

    it('leaves an unclosed open as status "open" with no realized P&L', () => {
        const trades = buildTrades(normalizeToOrderGroups(DOUBLE_CAL_OPEN));
        expect(trades).toHaveLength(1);
        expect(trades[0].status).toBe('open');
        expect(trades[0].realizedPnl).toBeUndefined();
    });
});

describe('computeMetrics', () => {
    it('computes win rate, avg profit, and profit factor across a win and a loss', () => {
        const all = [...DOUBLE_CAL_WIN, ...DOUBLE_CAL_LOSS];
        const trades = buildTrades(normalizeToOrderGroups(all));
        const closed = trades.filter(t => t.status === 'closed');
        expect(closed).toHaveLength(2);

        const m = computeMetrics('DOUBLE_CALENDAR', trades);
        expect(m.closedTrades).toBe(2);
        expect(m.wins).toBe(1);
        expect(m.losses).toBe(1);
        expect(m.winRate).toBe(0.5);
        expect(m.totalPnl).toBe(20); // +120 - 100
        expect(m.avgPnl).toBe(10);
        expect(m.avgWin).toBe(120);
        expect(m.avgLoss).toBe(-100);
        expect(m.profitFactor).toBeCloseTo(1.2, 5); // 120 / 100
        expect(m.bestTrade).toBe(120);
        expect(m.worstTrade).toBe(-100);
    });

    it('builds a cumulative P&L series ordered by close date', () => {
        const all = [...DOUBLE_CAL_WIN, ...DOUBLE_CAL_LOSS];
        const trades = buildTrades(normalizeToOrderGroups(all));
        const series = cumulativePnlSeries(trades);
        expect(series).toHaveLength(2);
        expect(series[0].cumulative).toBe(120); // SPY win closes first (2025-02-14)
        expect(series[1].cumulative).toBe(20); // then QQQ loss (2025-03-10)
    });
});
