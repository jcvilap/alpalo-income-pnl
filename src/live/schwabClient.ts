import { RedisClientType } from 'redis';

function maskToken(token: string | undefined): string {
    if (!token) return '(none)';
    if (token.length < 20) return `${token.substring(0, 6)}...`;
    return `${token.substring(0, 12)}...${token.substring(token.length - 4)}`;
}

export interface SchwabClientConfig {
    name?: string;
    clientId: string;
    clientSecret: string;
    redirectUri?: string;
    accessToken?: string;
    refreshToken?: string;
    redis?: RedisClientType;
    accountHash?: string;
    /** When true, never refreshes tokens or writes to Redis — safe for read-only health checks */
    readOnly?: boolean;
}

export interface SchwabToken {
    access_token: string;
    refresh_token: string;
    token_type: string;
    expires_in: number;
    scope: string;
    /** Epoch ms when the token was saved — used to compute actual expiry */
    saved_at?: number;
    /** Epoch ms when the refresh token was last obtained — used to track its 7-day expiry */
    refresh_token_saved_at?: number;
}

export interface SchwabAccountHash {
    accountNumber: string;
    hashValue: string;
}

export interface SchwabBalance {
    liquidationValue: number;
    cashBalance: number;
    buyingPower?: number;
}

export interface SchwabPosition {
    instrument: {
        symbol: string;
        assetType: string;
    };
    longQuantity: number;
    shortQuantity: number;
    averagePrice: number;
    marketValue: number;
    currentDayProfitLoss?: number;
    currentDayProfitLossPercentage?: number;
}

export interface SchwabAccount {
    type: string;
    accountNumber: string;
    roundTrips?: number;
    isDayTrader?: boolean;
    isClosingOnlyRestricted?: boolean;
    currentBalances: SchwabBalance;
    positions?: SchwabPosition[];
}

export interface SchwabAccountResponse {
    securitiesAccount: SchwabAccount;
}

export interface SchwabQuote {
    symbol: string;
    lastPrice: number;
    bidPrice: number;
    askPrice: number;
    closePrice: number;
    mark: number;
}

// ---------------------------------------------------------------------------
// Transactions API types
// ---------------------------------------------------------------------------

/** Transaction types accepted by the Schwab /transactions endpoint. */
export type SchwabTransactionType =
    | 'TRADE'
    | 'RECEIVE_AND_DELIVER'
    | 'DIVIDEND_OR_INTEREST'
    | 'ACH_RECEIPT'
    | 'ACH_DISBURSEMENT'
    | 'CASH_RECEIPT'
    | 'CASH_DISBURSEMENT'
    | 'ELECTRONIC_FUND'
    | 'WIRE_OUT'
    | 'WIRE_IN'
    | 'JOURNAL'
    | 'MEMORANDUM'
    | 'MARGIN_CALL'
    | 'MONEY_MARKET'
    | 'SMA_ADJUSTMENT';

/** The instrument attached to a single transfer item within a transaction. */
export interface SchwabTransactionInstrument {
    /** OCC-style option symbol, e.g. "SPX   250620C05000000" */
    symbol?: string;
    /** OPTION | EQUITY | COLLECTIVE_INVESTMENT | CURRENCY | ... */
    assetType?: string;
    putCall?: 'CALL' | 'PUT';
    /** Option strike price */
    strikePrice?: number;
    /** ISO-8601 option expiration date */
    expirationDate?: string;
    /** Underlying ticker for an option, e.g. "SPX" */
    underlyingSymbol?: string;
    description?: string;
    cusip?: string;
}

/** A single leg / cash movement inside a transaction. */
export interface SchwabTransferItem {
    instrument?: SchwabTransactionInstrument;
    /** Signed quantity — positive when bought (long), negative when sold (short). */
    amount?: number;
    /** Per-contract price. */
    price?: number;
    /** Signed cash impact of this item (fees/commissions appear as their own items). */
    cost?: number;
    /** OPENING | CLOSING | AUTOMATIC | ... */
    positionEffect?: string;
    feeType?: string;
}

/** A Schwab transaction as returned by the /transactions endpoint. */
export interface SchwabTransaction {
    activityId?: number;
    /** Present for TRADE transactions — the order that produced this fill. */
    orderId?: number;
    /** ISO-8601 execution time. */
    time?: string;
    type?: SchwabTransactionType | string;
    status?: string;
    subAccount?: string;
    /** Signed net cash for the whole transaction: negative = debit paid, positive = credit received. */
    netAmount?: number;
    transferItems?: SchwabTransferItem[];
    description?: string;
}

/**
 * A single leg's instrument + instruction within a working order returned by
 * GET /orders. Unlike the `/transactions` endpoint's instrument shape (see
 * `SchwabTransactionInstrument`), `/orders` only reliably populates
 * `symbol`/`assetType` here — `putCall`/`strikePrice`/`expirationDate`/
 * `underlyingSymbol` come back empty, so callers must decode the OCC
 * `symbol` string themselves (see `parseOccSymbol` in transactions/service.ts).
 */
export interface SchwabWorkingOrderLeg {
    instruction: 'BUY_TO_OPEN' | 'SELL_TO_OPEN' | 'BUY_TO_CLOSE' | 'SELL_TO_CLOSE' | 'BUY' | 'SELL';
    quantity: number;
    instrument: SchwabTransactionInstrument;
}

/** A working/pending order as returned by GET /accounts/{hash}/orders. */
export interface SchwabWorkingOrder {
    orderId: number;
    status: string;
    quantity?: number;
    filledQuantity?: number;
    price?: number;
    orderType?: string;
    complexOrderStrategyType?: string;
    duration?: string;
    enteredTime?: string;
    orderLegCollection?: SchwabWorkingOrderLeg[];
}

export interface SchwabOrderLeg {
    instruction: 'BUY' | 'SELL' | 'BUY_TO_COVER' | 'SELL_SHORT';
    quantity: number;
    instrument: {
        symbol: string;
        assetType: 'EQUITY';
    };
}

export interface SchwabOrderRequest {
    orderType: 'MARKET' | 'LIMIT' | 'STOP' | 'STOP_LIMIT';
    session: 'NORMAL' | 'AM' | 'PM' | 'SEAMLESS';
    duration: 'DAY' | 'GOOD_TILL_CANCEL' | 'FILL_OR_KILL';
    orderStrategyType: 'SINGLE';
    orderLegCollection: SchwabOrderLeg[];
    price?: number;
}

/** One leg of a multi-leg option order (see `SchwabOptionOrderRequest`). */
export interface SchwabOptionOrderLeg {
    instruction: 'BUY_TO_OPEN' | 'SELL_TO_OPEN' | 'BUY_TO_CLOSE' | 'SELL_TO_CLOSE';
    quantity: number;
    instrument: {
        /** OCC-format option symbol, e.g. "SPXW  261016C07750000". */
        symbol: string;
        assetType: 'OPTION';
    };
}

/**
 * A multi-leg (or single-leg) option order — e.g. closing a double calendar/
 * diagonal's 4 legs at a net limit price. `orderStrategyType` stays `SINGLE`
 * even for multiple legs (that field distinguishes OCO/trigger strategies,
 * not leg count); `complexOrderStrategyType: CUSTOM` is accepted by Schwab
 * for any leg combination regardless of whether it matches one of their named
 * complex-strategy shapes, so it's used unconditionally rather than trying to
 * detect/label the specific strategy shape here.
 */
export interface SchwabOptionOrderRequest {
    orderType: 'NET_CREDIT' | 'NET_DEBIT' | 'MARKET' | 'LIMIT';
    session: 'NORMAL' | 'AM' | 'PM' | 'SEAMLESS';
    duration: 'DAY' | 'GOOD_TILL_CANCEL' | 'FILL_OR_KILL';
    orderStrategyType: 'SINGLE';
    complexOrderStrategyType: 'CUSTOM';
    /** Per-spread limit price (positive magnitude — direction comes from `orderType`). */
    price: number;
    orderLegCollection: SchwabOptionOrderLeg[];
}

export class SchwabError extends Error {
    status?: number;
    responseBody?: string;

    constructor(message: string, status?: number, responseBody?: string) {
        super(message);
        this.name = 'SchwabError';
        this.status = status;
        this.responseBody = responseBody;
    }
}

const TRADER_BASE = 'https://api.schwabapi.com/trader/v1';
const MARKETDATA_BASE = 'https://api.schwabapi.com/marketdata/v1';
const AUTH_BASE = 'https://api.schwabapi.com/v1/oauth';

/**
 * Charles Schwab API Client
 *
 * Implements OAuth2 authorization-code flow with automatic token refresh.
 * Tokens are persisted to Redis when available.
 */
export class SchwabClient {
    private readonly config: SchwabClientConfig;
    private token: SchwabToken | null = null;
    private readonly redisKey: string;

    constructor(config: SchwabClientConfig) {
        this.config = config;
        this.redisKey = `schwab:tokens:${config.accountHash || config.clientId}`;
    }

    // ---------------------------------------------------------------------------
    // Auth URL generation (for initial setup)
    // ---------------------------------------------------------------------------

    /**
     * Build the authorization URL the user must visit to grant access.
     * After approving, Schwab redirects to redirectUri with ?code=...
     */
    getAuthorizationUrl(): string {
        const redirectUri = this.config.redirectUri || 'https://127.0.0.1';
        const params = new URLSearchParams({
            response_type: 'code',
            client_id: this.config.clientId,
            scope: 'api',
            redirect_uri: redirectUri
        });
        return `${AUTH_BASE}/authorize?${params.toString()}`;
    }

    /**
     * Exchange an authorization code for access + refresh tokens.
     * Call this once during initial setup with the code from the redirect URL.
     */
    async exchangeAuthCode(code: string): Promise<SchwabToken> {
        const redirectUri = this.config.redirectUri || 'https://127.0.0.1';
        const params = new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            redirect_uri: redirectUri
        });

        const token = await this.fetchToken(params);
        await this.setToken(token);
        return token;
    }

    // ---------------------------------------------------------------------------
    // Token lifecycle
    // ---------------------------------------------------------------------------

    private async loadTokenFromRedis(): Promise<SchwabToken | null> {
        if (!this.config.redis) return null;
        try {
            const data = await this.config.redis.get(this.redisKey);
            if (data) {

                const token: SchwabToken = JSON.parse(data);
                let dirty = false;
                if (token.access_token && !token.saved_at) {
                    // Unknown issue date — treat as expired so a refresh is attempted
                    // rather than falsely reporting the token as valid.
                    token.saved_at = Date.now() - (token.expires_in ?? 1800) * 1000;
                    dirty = true;
                }
                if (token.refresh_token && !token.refresh_token_saved_at) {
                    // Unknown issue date (e.g. uploaded by upload-env-to-redis.ts) —
                    // best guess is that it was just minted, since that script only
                    // uploads tokens it has just verified live.
                    token.refresh_token_saved_at = token.saved_at ?? Date.now();
                    dirty = true;
                }
                if (dirty && !this.config.readOnly) {
                    await this.config.redis.set(this.redisKey, JSON.stringify(token));
                    // readOnly: adjust in memory only, no write back to Redis
                }
                return token;
            }
        } catch (e) {
            console.warn(`[${this.config.name}] Failed to load Schwab token from Redis:`, e);
        }
        return null;
    }

    private async saveToken(): Promise<void> {
        if (!this.token || !this.config.redis || this.config.readOnly) return;
        try {
            this.token.saved_at = Date.now();
            await this.config.redis.set(this.redisKey, JSON.stringify(this.token));
        } catch (e) {
            console.warn(`[${this.config.name}] Failed to save Schwab token to Redis:`, e);
        }
    }

    private async setToken(token: SchwabToken, save: boolean = true, prevRefreshToken?: string): Promise<void> {
        // Track when the refresh token was obtained so we can warn before it expires (7-day window)
        if (!token.refresh_token_saved_at) {
            if (prevRefreshToken && token.refresh_token === prevRefreshToken) {
                // Refresh token unchanged — preserve the original saved_at
                token.refresh_token_saved_at = this.token?.refresh_token_saved_at ?? Date.now();
            } else {
                token.refresh_token_saved_at = Date.now();
            }
        }
        this.token = token;
        if (save) await this.saveToken();
    }

    /** Remaining seconds on the current access token (0 if unknown/expired). */
    getTokenRemainingSeconds(): number {
        if (!this.token?.expires_in || !this.token?.saved_at) return 0;
        const elapsed = (Date.now() - this.token.saved_at) / 1000;
        return Math.max(0, this.token.expires_in - elapsed);
    }

    /** Remaining days on the refresh token (Schwab refresh tokens last 7 days). */
    getRefreshTokenRemainingDays(): number {
        const savedAt = this.token?.refresh_token_saved_at;
        if (!savedAt) return 0;
        const elapsedDays = (Date.now() - savedAt) / (1000 * 60 * 60 * 24);
        return Math.max(0, 7 - elapsedDays);
    }

    /** True when the access token has less than `thresholdSeconds` remaining. */
    isAccessTokenExpired(thresholdSeconds: number = 60): boolean {
        return this.getTokenRemainingSeconds() < thresholdSeconds;
    }

    async authenticate(opts?: { skipRedis?: boolean; redisOnly?: boolean }): Promise<void> {
        // 1. Try Redis (unless skipRedis, e.g. --seed mode or local-only test)
        if (!opts?.skipRedis) {
            const redisToken = await this.loadTokenFromRedis();
            if (redisToken) {
                this.token = redisToken;
                if (!this.isAccessTokenExpired()) {
                    return;
                }
                // Token expiring — skip refresh in readOnly mode; let the API call reveal the truth
                if (!this.config.readOnly) {
                    console.log(`[${this.config.name}] Schwab access token expiring soon, refreshing...`);
                    try {
                        await this.refreshAccessToken();
                        return;
                    } catch (e) {
                        console.warn(`[${this.config.name}] Schwab token refresh failed:`, e);
                        this.token = null;
                    }
                } else if (this.getTokenRemainingSeconds() <= 0) {
                    // Token is fully expired — fail fast instead of making API calls that will hang
                    throw new SchwabError(
                        `[${this.config.name}] Redis access token has expired. ` +
                        'Renew tokens via the alpalo-v2 cron or this project\'s /api/cron/token-renew.'
                    );
                } else {
                    // Within the expiry threshold but not hard-expired — may still be accepted
                    console.log(`[${this.config.name}] Schwab access token near expiry (readOnly mode) — proceeding`);
                    return;
                }
            }

            // No Redis token found
            if (opts?.redisOnly) {
                throw new SchwabError(
                    `[${this.config.name}] No Redis token found. ` +
                    'Seed tokens by running the token-renew cron with ?seed=true, or ensure alpalo-v2 has seeded them.'
                );
            }
        }

        // 2. Fall back to config tokens (.env)
        if (this.config.accessToken) {
            this.token = {
                access_token: this.config.accessToken,
                refresh_token: this.config.refreshToken || '',
                token_type: 'Bearer',
                expires_in: 1800,
                scope: 'api',
                saved_at: Date.now()
            };
            await this.saveToken();
            return;
        }

        throw new SchwabError(
            `[${this.config.name}] No valid Schwab tokens available. ` +
            'See SchwabBroker/token setup instructions.'
        );
    }

    async refreshAccessToken(): Promise<void> {
        const refreshToken = this.token?.refresh_token || this.config.refreshToken;
        if (!refreshToken) {
            throw new SchwabError('No refresh token available for Schwab');
        }

        console.log(`[${this.config.name}] Refreshing Schwab access token (refresh: ${maskToken(refreshToken)})`);

        const params = new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: refreshToken
        });

        try {
            const newToken = await this.fetchToken(params);
            // Preserve the refresh token if the new one is missing (Schwab sometimes omits it)
            if (!newToken.refresh_token) {
                newToken.refresh_token = refreshToken;
            }
            await this.setToken(newToken, true, refreshToken);
            console.log(`[${this.config.name}] Schwab access token refreshed, expires in ${newToken.expires_in}s`);
        } catch (e) {
            throw new SchwabError(`Schwab token refresh failed: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    private async fetchToken(params: URLSearchParams): Promise<SchwabToken> {
        const credentials = Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString('base64');

        const response = await fetch(`${AUTH_BASE}/token`, {
            method: 'POST',
            headers: {
                'Authorization': `Basic ${credentials}`,
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: params.toString()
        });

        if (!response.ok) {
            const body = await response.text();
            throw new SchwabError(`Schwab OAuth failed (${response.status}): ${body}`, response.status, body);
        }

        const data = await response.json();
        return {
            access_token: data.access_token,
            refresh_token: data.refresh_token || '',
            token_type: data.token_type ?? 'Bearer',
            expires_in: data.expires_in ?? 1800,
            scope: data.scope ?? 'api',
            saved_at: Date.now()
        };
    }

    // ---------------------------------------------------------------------------
    // Generic request helper
    // ---------------------------------------------------------------------------

    private async request<T>(
        method: string,
        url: string,
        options?: { body?: unknown; params?: Record<string, string> }
    ): Promise<T> {
        await this.ensureAuthenticated();

        if (options?.params) {
            const qs = new URLSearchParams(options.params);
            url += (url.includes('?') ? '&' : '?') + qs.toString();
        }

        const headers: Record<string, string> = {
            'Accept': 'application/json',
            'Authorization': `Bearer ${this.token!.access_token}`
        };

        if (options?.body) {
            headers['Content-Type'] = 'application/json';
        }

        const response = await fetch(url, {
            method,
            headers,
            body: options?.body ? JSON.stringify(options.body) : undefined
        });

        // Proactively refresh and retry on 401
        if (response.status === 401) {
            if (this.config.readOnly) {
                const body = await response.text();
                throw new SchwabError(`Schwab request failed (401 — token expired, readOnly mode prevents refresh)`, 401, body);
            }
            console.log(`[${this.config.name}] Schwab 401 — refreshing token and retrying`);
            await this.refreshAccessToken();
            const retry = await fetch(url, {
                method,
                headers: {
                    ...headers,
                    'Authorization': `Bearer ${this.token!.access_token}`
                },
                body: options?.body ? JSON.stringify(options.body) : undefined
            });

            if (!retry.ok) {
                const body = await retry.text();
                throw new SchwabError(`Schwab request failed after retry (${retry.status})`, retry.status, body);
            }
            // 201 (order placement) and 204 (no content) never carry a body;
            // some endpoints (e.g. cancel-order) also return 200 with an
            // empty body — reading an empty body as text first, rather than
            // always calling .json(), avoids throwing on those.
            if (retry.status === 201 || retry.status === 204) return undefined as T;
            const retryText = await retry.text();
            return retryText ? JSON.parse(retryText) : (undefined as T);
        }

        if (!response.ok) {
            const body = await response.text();
            throw new SchwabError(`Schwab request failed (${response.status}): ${response.statusText}`, response.status, body);
        }

        // See the retry branch above for why 201/204 short-circuit and why
        // the success path otherwise text-then-parses instead of always
        // calling .json() directly.
        if (response.status === 201 || response.status === 204) return undefined as T;
        const text = await response.text();
        return text ? JSON.parse(text) : (undefined as T);
    }

    private async ensureAuthenticated(): Promise<void> {
        if (!this.token || this.isAccessTokenExpired()) {
            await this.authenticate();
        }
    }

    // ---------------------------------------------------------------------------
    // Account endpoints
    // ---------------------------------------------------------------------------

    /**
     * Get all linked account numbers and their encrypted hash values.
     * The hashValue is required for all subsequent account-specific API calls.
     */
    async getAccountNumbers(): Promise<SchwabAccountHash[]> {
        return this.request<SchwabAccountHash[]>('GET', `${TRADER_BASE}/accounts/accountNumbers`);
    }

    /**
     * Get account details including balances and positions.
     * Uses the configured accountHash or fetches the first linked account.
     */
    async getAccount(hashOverride?: string): Promise<SchwabAccount> {
        const hash = hashOverride ?? await this.resolveAccountHash();
        const response = await this.request<SchwabAccountResponse>(
            'GET',
            `${TRADER_BASE}/accounts/${hash}`,
            { params: { fields: 'positions' } }
        );
        return response.securitiesAccount;
    }

    // ---------------------------------------------------------------------------
    // Transactions endpoint
    // ---------------------------------------------------------------------------

    /**
     * Fetch transactions for the configured account within a date range.
     *
     * Schwab requires ISO-8601 datetimes (e.g. 2025-01-01T00:00:00.000Z) and
     * caps the range at ~1 year per request. Defaults to TRADE transactions,
     * which is what strategy detection needs.
     *
     * @param opts.startDate ISO-8601 start (inclusive)
     * @param opts.endDate   ISO-8601 end (inclusive)
     * @param opts.types     comma-separated transaction types (default "TRADE")
     * @param opts.symbol    optional underlying/symbol filter
     */
    async getTransactions(opts: {
        startDate: string;
        endDate: string;
        types?: string;
        symbol?: string;
    }): Promise<SchwabTransaction[]> {
        const hash = await this.resolveAccountHash();
        const params: Record<string, string> = {
            startDate: opts.startDate,
            endDate: opts.endDate,
            types: opts.types ?? 'TRADE'
        };
        if (opts.symbol) params.symbol = opts.symbol;

        return this.request<SchwabTransaction[]>(
            'GET',
            `${TRADER_BASE}/accounts/${hash}/transactions`,
            { params }
        );
    }

    /**
     * Place an order for the configured account.
     * Returns the order ID extracted from the Location response header.
     */
    async placeOrder(order: SchwabOrderRequest): Promise<string | null> {
        const hash = await this.resolveAccountHash();
        // The API returns 201 with a Location header; no JSON body
        await this.request<undefined>('POST', `${TRADER_BASE}/accounts/${hash}/orders`, { body: order });
        return null; // Order ID would require parsing Location header, which fetch doesn't expose easily
    }

    /**
     * Cancel a working (not-yet-filled) order for the configured account.
     * Schwab returns 200/201/204 with no body on success.
     */
    async cancelOrder(orderId: string): Promise<void> {
        const hash = await this.resolveAccountHash();
        await this.request<undefined>('DELETE', `${TRADER_BASE}/accounts/${hash}/orders/${orderId}`);
    }

    /**
     * Place a new multi-leg (or single-leg) option order — e.g. a take-profit
     * limit order closing a strategy's legs at a target net price.
     */
    async placeOptionOrder(order: SchwabOptionOrderRequest): Promise<void> {
        const hash = await this.resolveAccountHash();
        await this.request<undefined>('POST', `${TRADER_BASE}/accounts/${hash}/orders`, { body: order });
    }

    /**
     * Replace an existing working order with a new one in a single call —
     * Schwab's replace endpoint atomically cancels `orderId` and places
     * `order` in its stead (PUT, not a separate cancel+POST), which avoids a
     * window where neither the old nor the new order is working.
     */
    async replaceOrder(orderId: string, order: SchwabOptionOrderRequest): Promise<void> {
        const hash = await this.resolveAccountHash();
        await this.request<undefined>('PUT', `${TRADER_BASE}/accounts/${hash}/orders/${orderId}`, { body: order });
    }

    /**
     * Fetch working (pending) orders for the configured account.
     * Schwab requires `fromEnteredTime`/`toEnteredTime` even for status-only
     * filtering — defaults to a lookback wide enough to cover any order
     * entered in the last 60 days, which comfortably covers GTC closing
     * orders placed well before they're checked.
     */
    async getOrders(opts?: { status?: string; fromEnteredTime?: string; toEnteredTime?: string }): Promise<SchwabWorkingOrder[]> {
        const hash = await this.resolveAccountHash();
        const now = new Date();
        const toEnteredTime = opts?.toEnteredTime ?? now.toISOString();
        const fromEnteredTime = opts?.fromEnteredTime ?? new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000).toISOString();
        const params: Record<string, string> = { fromEnteredTime, toEnteredTime };
        if (opts?.status) params.status = opts.status;

        return this.request<SchwabWorkingOrder[]>(
            'GET',
            `${TRADER_BASE}/accounts/${hash}/orders`,
            { params }
        );
    }

    // ---------------------------------------------------------------------------
    // Market data endpoints
    // ---------------------------------------------------------------------------

    /**
     * Get real-time quotes for one or more symbols.
     */
    async getQuotes(symbols: string[]): Promise<Record<string, SchwabQuote>> {
        if (symbols.length === 0) return {};

        // Schwab returns { SYMBOL: { assetMainType, quote: { lastPrice, ... } } }
        const raw = await this.request<Record<string, { quote?: SchwabQuote }>>(
            'GET', `${MARKETDATA_BASE}/quotes`, {
                params: {
                    symbols: symbols.join(','),
                    fields: 'quote',
                    indicative: 'false'
                }
            }
        );

        const result: Record<string, SchwabQuote> = {};
        for (const [symbol, data] of Object.entries(raw)) {
            if (data?.quote) result[symbol] = data.quote;
        }
        return result;
    }

    /**
     * Get a symbol's daily closing price on a specific historical date — used
     * to confirm whether an option expired genuinely in- or out-of-the-money
     * (a live quote only reflects *today's* price, which can drift across a
     * strike well after expiration and give a wrong answer; see
     * transactions/service.ts's expired-worthless finalization). Returns
     * `null` if Schwab has no candle for that date (e.g. a weekend/holiday,
     * or a date outside its history retention).
     */
    async getPriceOnDate(symbol: string, dateIso: string): Promise<number | null> {
        // Schwab's daily-candle history is keyed by calendar day, not time of
        // day — request a tight [date, date+1] window so exactly one candle
        // (or none) comes back, rather than parsing a wider range and
        // picking one out.
        const start = new Date(`${dateIso.slice(0, 10)}T00:00:00.000Z`);
        const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);

        // Schwab's pricehistory endpoint only allows frequencyType: 'minute'
        // when periodType is 'day' — daily candles require periodType
        // 'month' (or 'year'/'ytd') paired with frequencyType 'daily'.
        const raw = await this.request<{ candles?: { datetime: number; close: number }[] }>(
            'GET', `${MARKETDATA_BASE}/pricehistory`, {
                params: {
                    symbol,
                    periodType: 'month',
                    period: '1',
                    frequencyType: 'daily',
                    frequency: '1',
                    startDate: String(start.getTime()),
                    endDate: String(end.getTime()),
                    needExtendedHoursData: 'false',
                }
            }
        );

        const candle = raw.candles?.[0];
        return candle ? candle.close : null;
    }

    // ---------------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------------

    private cachedAccountHash: string | null = null;

    private async resolveAccountHash(): Promise<string> {
        if (this.config.accountHash) return this.config.accountHash;
        if (this.cachedAccountHash) return this.cachedAccountHash;

        const accounts = await this.getAccountNumbers();
        if (!accounts || accounts.length === 0) {
            throw new SchwabError('No Schwab accounts found. Check your credentials and account linkage.');
        }

        this.cachedAccountHash = accounts[0].hashValue;
        console.log(`[${this.config.name}] Using Schwab account: ${accounts[0].accountNumber}`);
        return this.cachedAccountHash;
    }
}
