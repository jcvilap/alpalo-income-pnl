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

The one exception is `src/lib/convert/` (the `/convert` route, a standalone
BTO/STO fill-line → thinkorswim order-string tool with no Schwab
dependency) — it was built with unit tests on explicit request. Run them with
`pnpm test` (Node's built-in test runner via `tsx`, no new dependency added).

`buildOrderString.ts` picks a TOS order-bar shape based on the parsed legs:
- **STRANGLE** (2 legs, same expiration, one PUT + one CALL), **IRON CONDOR**
  (4 legs, same expiration, 2 CALLs + 2 PUTs each with one short + one long),
  and **DBL DIAG** (4 legs, exactly 2 expirations, one PUT + one CALL per
  expiration) are verified against real strings pasted from a live
  thinkorswim account (see the "real broker example" tests in
  `__tests__/convert.test.ts`) — trust these.
- Everything else falls back to a generic **CUSTOM** combo, which is
  best-effort and *not* verified against a live TOS paste (the per-leg
  date/strike/right repetition for irregular multi-expiration structures
  wasn't found in any confirmed TOS example when this was built). If a user
  reports a CUSTOM string that doesn't route, that's expected until someone
  pastes a real counter-example to fix the format against.
- The order of legs in the pasted input never affects the output — DBL DIAG,
  STRANGLE, and IRON CONDOR all re-sort by expiration/right/short-vs-long
  internally (see `isDoubleCalendarOrDiagonal`/`isStrangle`/`isIronCondor`
  and their builders).
- **How to actually paste this into thinkorswim** (confirmed working):
  click into the order entry line/ticket, paste with Cmd+V, then press
  Enter. TOS's separate "paste order from clipboard" *button* in the Order
  Entry Tools panel expects a different format and silently fails on this
  string — don't route users to that button.
- Price sign convention throughout: `computeNetPrice`/`buildOrderString`'s
  `price` is signed like Schwab's own convention (credit positive, debit
  negative). `convertOrder`'s `overridePriceMagnitude` is different on
  purpose — it's the plain positive number a user types in the UI, and the
  function re-signs it to match the computed net price's direction. Don't
  conflate the two when touching this code.

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
