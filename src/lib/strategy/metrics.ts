import type { StrategyId, StrategyMetrics, StrategyTrade } from './types';

/**
 * Compute aggregate P&L metrics for a set of trades of one strategy.
 *
 * Win rate, avg win/loss, and profit factor are computed over CLOSED trades
 * only (open trades have no realized P&L yet). Open trades are still counted in
 * totalTrades / openTrades for context.
 */
export function computeMetrics(strategies: StrategyId[], trades: StrategyTrade[]): StrategyMetrics {
    const closed = trades.filter(t => t.status === 'closed' && typeof t.pnl === 'number');
    const openTrades = trades.length - closed.length;

    const pnls = closed.map(t => t.pnl as number);
    const wins = closed.filter(t => (t.pnl as number) > 0);
    const losses = closed.filter(t => (t.pnl as number) < 0);
    const winsArr = wins.map(t => t.pnl as number);
    const lossesArr = losses.map(t => t.pnl as number);
    const winsPctArr = wins.map(t => t.pctGain).filter((p): p is number => typeof p === 'number');
    const lossesPctArr = losses.map(t => t.pctGain).filter((p): p is number => typeof p === 'number');

    const totalPnl = pnls.reduce((s, p) => s + p, 0);
    const grossProfit = winsArr.reduce((s, p) => s + p, 0);
    const grossLoss = Math.abs(lossesArr.reduce((s, p) => s + p, 0));

    const holdDays = closed
        .map(t => t.daysOpen)
        .filter((d): d is number => typeof d === 'number');

    const bestTradeEntry = closed.reduce<StrategyTrade | undefined>(
        (best, t) => (best == null || (t.pnl as number) > (best.pnl as number) ? t : best),
        undefined,
    );
    const worstTradeEntry = closed.reduce<StrategyTrade | undefined>(
        (worst, t) => (worst == null || (t.pnl as number) < (worst.pnl as number) ? t : worst),
        undefined,
    );

    return {
        strategies,
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
        avgWinPct: winsPctArr.length > 0 ? winsPctArr.reduce((s, p) => s + p, 0) / winsPctArr.length : undefined,
        avgLossPct: lossesPctArr.length > 0 ? lossesPctArr.reduce((s, p) => s + p, 0) / lossesPctArr.length : undefined,
        avgHoldDays: holdDays.length > 0 ? holdDays.reduce((s, d) => s + d, 0) / holdDays.length : 0,
        bestTrade: bestTradeEntry?.pnl ?? 0,
        worstTrade: worstTradeEntry?.pnl ?? 0,
        bestTradePct: bestTradeEntry?.pctGain,
        worstTradePct: worstTradeEntry?.pctGain,
    };
}

/**
 * Build a cumulative realized-P&L series over time from closed trades, ordered
 * by close date. Useful for an equity-curve chart.
 */
export function cumulativePnlSeries(trades: StrategyTrade[]): { date: string; pnl: number; cumulative: number }[] {
    const closed = trades
        .filter(t => t.status === 'closed' && typeof t.pnl === 'number' && t.closedAt)
        .sort((a, b) => (a.closedAt as string).localeCompare(b.closedAt as string));

    let cumulative = 0;
    return closed.map(t => {
        const pnl = t.pnl as number;
        cumulative += pnl;
        return { date: (t.closedAt as string).slice(0, 10), pnl, cumulative };
    });
}
