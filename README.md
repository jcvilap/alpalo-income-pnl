# Alpalo Income P&L

A Vercel-hosted Next.js dashboard that queries **Charles Schwab** transactions,
identifies which manual option-income strategy each order belongs to, and
computes P&L metrics (win rate, avg win/loss, best/worst trade, …).

**Current scope: double calendars, double diagonals, strangles, and LEAPS.**
The detection layer is rule-based, so jade lizards and iron condors can be
added later by adding a rule — no engine changes. The dashboard's strategy
filter is a multiselect; selected strategies are pooled into one combined
view (trades, stat tiles, equity curve all sum across the selection).

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
  which already includes commissions/fees. `pctGain = pnl / |openNet| * 100`.
- **Unrealized P&L** for still-open trades is a live mark-to-market estimate:
  `openNet + Σ(leg.quantity * quote.mark * 100)` using `SchwabClient.getQuotes`.
  Flagged with `pnlIsEstimate: true` (shown as `*` in the table). See
  `applyUnrealizedPnl` in `lib/transactions/service.ts` for the sign-convention
  derivation — it's easy to get backwards, don't re-derive it without reading
  that comment first.
- **Double calendar (strict):** one call calendar + one put calendar, same
  underlying, same near/far expiration pair, 2 distinct strikes (near=far
  strike within each leg pair) — 4 legs total.
- **Double diagonal (strict):** same shape as a double calendar, but each
  leg pair's near/far strikes differ — 4 distinct strikes total instead of 2.
  Both rules share `matchDoubleTimeSpread` in `src/lib/strategy/rules.ts`.
- **Strangle:** one call + one put, same underlying, same expiration,
  different strikes, opened in a single 2-leg order. **Known limitation:**
  pairing is whole-order-signature based (see below), so this only detects
  the *opening* shape and pairs it with a close that also arrives as a single
  matching 2-leg order. If the two legs are closed independently in separate
  orders (a common real-world strangle-management pattern — closing one side
  early), the trade never re-matches the 2-leg shape on close and shows as
  permanently `open` with an estimated, not realized, P&L. Fixing this
  requires per-leg pairing state in `pairing.ts` rather than a shape rule —
  a deliberate scope cut for this pass, not an oversight.
- **LEAPS:** a single-leg order (one call or put, long or short) with an
  expiration more than 365 days from the order's execution time. LEAPS
  positions are sometimes rolled (closed and reopened at a new strike/
  expiration); this isn't roll-chained — a roll shows up as one trade closing
  and a new one opening under ordinary FIFO signature pairing.
- **Lookback widening:** every fetch pulls Schwab's full ~1-year lookback
  ending at `to`, regardless of the user's selected `from` — a trade's
  opening order can sit before the visible window, and without the wider
  fetch we can't find it and wrongly treat the close as a $0-cost-basis
  windfall. Only trades whose open or close falls in `[from, to]` are
  displayed; the fetched-but-hidden data exists purely to resolve real cost
  basis. See `clampLookback` / `tradeInRange` in `lib/transactions/service.ts`.

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

**Gotcha:** Schwab refresh tokens expire after 7 days. If `pnpm schwab:test`
fails with `invalid_grant`, the shared refresh token has expired — reauth via
alpalo-v2's `pnpm reauth-schwab` script (interactive browser login), which
seeds fresh tokens into the shared Redis. This project cannot mint its own
tokens; it only ever reads/refreshes what alpalo-v2 (or a manual reauth)
seeded. Also: tokens written by alpalo-v2's `upload-env-to-redis.ts` omit
`refresh_token_saved_at`; `loadTokenFromRedis` in `src/live/schwabClient.ts`
backfills it on load so `getRefreshTokenRemainingDays()` doesn't misreport
`0.0d` for a token that's actually fresh.

## Auth

`src/components/LoginGate.tsx` wraps the dashboard with a hardcoded
username/password check (see `USERNAME`/`PASSWORD` in that file), gated on
`sessionStorage`. This is a screen-privacy speed bump, **not real
authentication** — the API routes underneath remain unauthenticated. Don't
treat it as a security boundary.

## Develop

```bash
pnpm install
pnpm dev          # http://localhost:3004
pnpm build        # production build
pnpm schwab:test  # smoke-test Schwab auth + transactions against shared Redis
```

No test suite by design — this repo is kept intentionally light for low-token
agentic iteration. Verify changes with `pnpm build` (typecheck) and
`pnpm schwab:test` / `pnpm dev` against real data instead. Redis caches trade
results for ~15 min (see `RAW_TTL_SECONDS`/`PARSED_TTL_SECONDS` in
`lib/transactions/service.ts`) — pass `refresh=true` or bump `STRATEGY_VERSION`
after changing detection/normalization/pairing logic, or you'll be debugging
against stale cached output.

## API

- `GET /api/trades?from=YYYY-MM-DD&to=YYYY-MM-DD&strategy=double_calendar,double_diagonal[&refresh=true]`
  → `{ strategies, trades, metrics, equityCurve, cached, fetchedAt }`.
  `strategy` is a comma-separated list (case-insensitive, `-`/`_` interchangeable);
  unrecognized ids are dropped. Range defaults to YTD. Results are cached in
  Redis (~15 min); `refresh=true` bypasses the cache.
- `GET /api/cron/token-renew` → renews Schwab tokens (safety net).
  Requires `Authorization: Bearer $CRON_SECRET`. Add `?seed=true` to push fresh
  tokens from `ACCOUNTS` into Redis after a manual re-authorization.

Scheduled daily via `vercel.json`.

## Adding a new strategy

1. Add a `StrategyRule` in `src/lib/strategy/rules.ts` implementing `matches()`
   against an `OrderGroup`'s legs, and register it in `STRATEGY_RULES`.
2. Add its id to the `StrategyId` union in `src/lib/strategy/types.ts`.
3. Enable it in the dashboard's strategy multiselect (`STRATEGIES` in
   `src/app/page.tsx`, set `enabled: true`) and the API allow-list
   (`SUPPORTED_STRATEGIES` in `src/app/api/trades/route.ts`).
4. Add its display label to `STRATEGY_LABELS` in `src/components/TradesTable.tsx`.
5. Bump `STRATEGY_VERSION` in `src/lib/transactions/service.ts` to invalidate
   stale cached trade lists (they won't have the new strategy classified).

Pairing and metrics are strategy-agnostic and need no changes — *unless* the
new strategy's legs can close independently across separate orders (like a
strangle), in which case whole-order signature pairing in `pairing.ts` can't
represent it and needs a per-leg pairing model instead. See the strangle
entry above for the specifics of that gap.

## Layout

```
src/
  live/schwabClient.ts        Schwab OAuth2 client (transactions, quotes), Redis-backed tokens
  live/schwabRenewTokens.ts   Token renewal used by the cron
  config/accounts.ts          ACCOUNTS parsing/validation
  lib/redis.ts                Shared Redis helper
  lib/format.ts                Currency/percent/date display formatters
  lib/strategy/                types, normalize, rules, pairing, metrics
  lib/transactions/service.ts  Fetch + cache + widen-lookback + detect + unrealized-P&L + metrics
  app/api/trades/route.ts      Dashboard data endpoint (multi-strategy query parsing)
  app/api/cron/token-renew/    Token renewal cron endpoint
  app/page.tsx                 Dashboard UI: strategy multiselect, date presets, stat tiles
  components/                  LoginGate, StatTile, EquityCurve, TradesTable, ThemeToggle
```

`TradesTable.tsx` uses `@tanstack/react-table` (headless) for sort/filter/group/
column-pinning — `% Gain` is pinned right; if you pin another column, remember
TanStack returns headers/cells in column-definition order regardless of pin
state, so the render code reorders them via `orderByPinning` before mapping,
or pinned columns will visually overlap unpinned ones.
