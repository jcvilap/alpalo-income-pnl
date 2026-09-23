# Alpalo Income P&L

A Vercel-hosted Next.js dashboard that queries **Charles Schwab** transactions,
identifies which manual option-income strategy each order belongs to, and
computes P&L metrics (win rate, avg profit, profit factor, …).

**Current scope: double calendars.** The detection layer is rule-based, so
jade lizards, iron condors, and strangles can be added later by adding a rule —
no engine changes.

## How it works

```
Schwab /transactions  →  normalize (group by orderId)  →  classify (strategy rules)
                      →  pair open/close orders (FIFO)  →  compute metrics  →  dashboard
```

- **Trade grouping is by Schwab `orderId`.** Each strategy is opened/closed as a
  single multi-leg order, so one order = one strategy leg-set.
- **Realized P&L** of a completed trade = `netAmount(open order) + netAmount(close order)`.
  Schwab does not return realized P&L on transactions; it's computed from the
  signed net cash of the paired orders (debits negative, credits positive),
  which already includes commissions/fees.
- **Double calendar (strict):** one call calendar + one put calendar on the same
  underlying, same near/far expiration pair, different strikes — 4 legs total.
  See `src/lib/strategy/rules.ts`.

## Credentials — shared with `alpalo-v2`

This project **reuses the same Schwab app and the same Redis** as the sibling
`alpalo-v2` project. `alpalo-v2` already runs a daily cron that refreshes the
Schwab OAuth tokens and stores them in Redis under `schwab:tokens:*`, so this
project reads valid tokens directly. A safety-net renewal cron runs here too.

Copy `.sample.env` to `.env` and set the **same values as alpalo-v2**:

| Var | Purpose |
|-----|---------|
| `REDIS_URL` | Token store + transaction cache. Must match alpalo-v2. |
| `ACCOUNTS` | JSON array with the Schwab entry (client id/secret, tokens, account hash). Must match alpalo-v2. |
| `CRON_SECRET` | Protects `/api/cron/token-renew`. |

## Develop

```bash
pnpm install
pnpm dev          # http://localhost:3004
pnpm build        # production build
pnpm schwab:test  # smoke-test Schwab auth + transactions against shared Redis
```

No test suite by design — this repo is kept intentionally light for low-token
agentic iteration. Verify changes with `pnpm build` (typecheck) and
`pnpm schwab:test` / `pnpm dev` against real data instead.

## API

- `GET /api/trades?from=YYYY-MM-DD&to=YYYY-MM-DD&strategy=double_calendar[&refresh=true]`
  → `{ trades, metrics, equityCurve, cached }`. Range defaults to YTD.
  Results are cached in Redis (~15 min); `refresh=true` bypasses the cache.
- `GET /api/cron/token-renew` → renews Schwab tokens (safety net).
  Requires `Authorization: Bearer $CRON_SECRET`. Add `?seed=true` to push fresh
  tokens from `ACCOUNTS` into Redis after a manual re-authorization.

Scheduled daily via `vercel.json`.

## Adding a new strategy

1. Add a `StrategyRule` in `src/lib/strategy/rules.ts` implementing `matches()`
   against an `OrderGroup`'s legs, and register it in `STRATEGY_RULES`.
2. Add its id to the `StrategyId` union in `src/lib/strategy/types.ts`.
3. Enable it in the dashboard's strategy selector (`src/app/page.tsx`) and the
   API allow-list (`src/app/api/trades/route.ts`).

Pairing and metrics are strategy-agnostic and need no changes.

## Layout

```
src/
  live/schwabClient.ts        Schwab OAuth2 client (+ getTransactions), Redis-backed tokens
  live/schwabRenewTokens.ts   Token renewal used by the cron
  config/accounts.ts          ACCOUNTS parsing/validation
  lib/redis.ts                Shared Redis helper
  lib/strategy/               types, normalize, rules, pairing, metrics
  lib/transactions/service.ts Fetch + cache + detect + metrics orchestration
  app/api/trades/route.ts     Dashboard data endpoint
  app/api/cron/token-renew/   Token renewal cron endpoint
  app/page.tsx                Dashboard UI
  components/                 StatTile, EquityCurve, TradesTable, ThemeToggle
```
