import type { StrategyId, StrategyMetrics, StrategyTrade } from './types';

/**
 * Compute aggregate P&L metrics for a set of trades of one strategy.
 *
 * By default, win rate, avg win/loss, and totals are computed over CLOSED
 * trades only (realized P&L) — open trades are still counted in
 * totalTrades / openTrades for context but excluded from the P&L rollups.
 *
 * @param includeUnrealized When true, open trades with a live mark-to-market
 * `pnl` estimate (see `applyUnrealizedPnl` in transactions/service.ts) are
 * folded into every P&L figure alongside closed trades — "Total P&L" becomes
 * realized + unrealized, win rate includes currently-winning open positions,
 * etc. Off by default so the tiles show realized performance unless the user
 * opts in.
 */
export function computeMetrics(strategies: StrategyId[], trades: StrategyTrade[], includeUnrealized = false): StrategyMetrics {
    const closed = trades.filter(t => t.status === 'closed' && typeof t.pnl === 'number');
    const openWithPnl = includeUnrealized
        ? trades.filter(t => t.status === 'open' && typeof t.pnl === 'number')
        : [];
    const counted = [...closed, ...openWithPnl];
    const openTrades = trades.length - closed.length;

    const pnls = counted.map(t => t.pnl as number);
    const wins = counted.filter(t => (t.pnl as number) > 0);
    const losses = counted.filter(t => (t.pnl as number) < 0);
    const winsArr = wins.map(t => t.pnl as number);
    const lossesArr = losses.map(t => t.pnl as number);
    const winsPctArr = wins.map(t => t.pctGain).filter((p): p is number => typeof p === 'number');
    const lossesPctArr = losses.map(t => t.pctGain).filter((p): p is number => typeof p === 'number');

    const totalPnl = pnls.reduce((s, p) => s + p, 0);
    const grossProfit = winsArr.reduce((s, p) => s + p, 0);
    const grossLoss = Math.abs(lossesArr.reduce((s, p) => s + p, 0));

    const holdDays = counted
        .map(t => t.daysOpen)
        .filter((d): d is number => typeof d === 'number');

    const bestTradeEntry = counted.reduce<StrategyTrade | undefined>(
        (best, t) => (best == null || (t.pnl as number) > (best.pnl as number) ? t : best),
        undefined,
    );
    const worstTradeEntry = counted.reduce<StrategyTrade | undefined>(
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
        winRate: counted.length > 0 ? winsArr.length / counted.length : 0,
        totalPnl,
        avgPnl: counted.length > 0 ? totalPnl / counted.length : 0,
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
