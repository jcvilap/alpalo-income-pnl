import type { StrategyId, StrategyMetrics, StrategyTrade } from './types';

/**
 * Compute aggregate P&L metrics for a set of trades of one strategy.
 *
 * Win rate, avg win/loss, and profit factor are computed over CLOSED trades
 * only (open trades have no realized P&L yet). Open trades are still counted in
 * totalTrades / openTrades for context.
 */
export function computeMetrics(strategy: StrategyId, trades: StrategyTrade[]): StrategyMetrics {
    const closed = trades.filter(t => t.status === 'closed' && typeof t.realizedPnl === 'number');
    const openTrades = trades.length - closed.length;

    const pnls = closed.map(t => t.realizedPnl as number);
    const winsArr = pnls.filter(p => p > 0);
    const lossesArr = pnls.filter(p => p < 0);

    const totalPnl = pnls.reduce((s, p) => s + p, 0);
    const grossProfit = winsArr.reduce((s, p) => s + p, 0);
    const grossLoss = Math.abs(lossesArr.reduce((s, p) => s + p, 0));

    const holdDays = closed
        .map(t => t.holdDays)
        .filter((d): d is number => typeof d === 'number');

    return {
        strategy,
        totalTrades: trades.length,
        closedTrades: closed.length,
        openTrades,
        wins: winsArr.length,
        losses: lossesArr.length,
        winRate: closed.length > 0 ? winsArr.length / closed.length : 0,
        totalPnl,
        avgPnl: closed.length > 0 ? totalPnl / closed.length : 0,
        avgWin: winsArr.length > 0 ? grossProfit / winsArr.length : 0,
        avgLoss: lossesArr.length > 0 ? -grossLoss / lossesArr.length : 0,
        profitFactor: grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Infinity : 0),
        avgHoldDays: holdDays.length > 0 ? holdDays.reduce((s, d) => s + d, 0) / holdDays.length : 0,
        bestTrade: pnls.length > 0 ? Math.max(...pnls) : 0,
        worstTrade: pnls.length > 0 ? Math.min(...pnls) : 0,
    };
}

/**
 * Build a cumulative realized-P&L series over time from closed trades, ordered
 * by close date. Useful for an equity-curve chart.
 */
export function cumulativePnlSeries(trades: StrategyTrade[]): { date: string; pnl: number; cumulative: number }[] {
    const closed = trades
        .filter(t => t.status === 'closed' && typeof t.realizedPnl === 'number' && t.closedAt)
        .sort((a, b) => (a.closedAt as string).localeCompare(b.closedAt as string));

    let cumulative = 0;
    return closed.map(t => {
        const pnl = t.realizedPnl as number;
        cumulative += pnl;
        return { date: (t.closedAt as string).slice(0, 10), pnl, cumulative };
    });
}
