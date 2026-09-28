# AGENTS.md

Read `README.md` first — it has the architecture, data-flow diagram, key
invariants (P&L sign conventions, lookback widening, strategy-rule shape),
credential setup, and API contract. This file only adds what the README
doesn't cover: how to work in this repo as an agent.

## Verify changes like this

```bash
pnpm build             # typecheck (no test suite by design)
pnpm schwab:test       # exercises real Schwab auth + a live transactions call
pnpm dev               # http://localhost:3004 — start here for UI changes
```

No unit tests exist on purpose (see README "Develop" section) — don't add a
test suite unless explicitly asked. Verify logic changes by running
`pnpm schwab:test` or hitting `/api/trades` directly with `curl` against real
account data; the account is a real Schwab account, so treat any orders/
positions you see as real, not fixtures.

## Cache invalidation is manual

Redis caches parsed trade results (~15 min TTL) keyed by
`STRATEGY_VERSION` in `src/lib/transactions/service.ts`. If you change
`normalize.ts`, `rules.ts`, `pairing.ts`, `metrics.ts`, or any `StrategyTrade`
field shape, **bump `STRATEGY_VERSION`** — otherwise you'll test against
stale cached objects missing your new fields and waste a debugging cycle
concluding your code is broken when it's actually not running at all. Pass
`refresh=true` on `/api/trades` to bypass cache for a single request without
bumping the version.

## Schwab token lifecycle (don't re-derive this)

- Access tokens live 30 min, refresh tokens live 7 days and rotate on every
  refresh. Tokens live in the Redis shared with sibling project `alpalo-v2`,
  under `schwab:tokens:<accountHash>`.
- If `pnpm schwab:test` fails with `invalid_grant`, the refresh token has
  expired — this requires an **interactive browser login** the user must do
  themselves (via alpalo-v2's `pnpm reauth-schwab`). You cannot fix this by
  writing code; ask the user to run it, then retest.
- Never hardcode or "fix" a token value directly — always go through
  `SchwabClient`'s Redis-backed refresh flow.

## Sign conventions that are easy to get backwards

Schwab's own convention (see `normalize.ts`): a fill's cash impact is
`-quantity * price * 100`. When computing what it would cost to *close* an
already-open leg (quantity `q`), the closing fill's delta is `-q`, so its
cash is `-(-q) * mark * 100 = +q * mark * 100` — the sign flips twice. This
bit an earlier implementation of `applyUnrealizedPnl` in
`lib/transactions/service.ts` (produced a -200% P&L on a 3-day-old trade that
should have been near breakeven). If you touch P&L math, sanity-check the
result against a trade you can eyeball by hand before trusting it.

## Before publishing a data-shape change

Any new field on `StrategyTrade`/`StrategyMetrics` needs updates in four
places or it'll silently be `undefined` in the UI: `types.ts` (the field),
`pairing.ts` or `metrics.ts` (compute it), `TradesTable.tsx` or `page.tsx`
(render it), and `STRATEGY_VERSION` (invalidate old cache). Grep for an
existing field like `dte` or `contracts` to see the full pattern across files
before adding a new one.
