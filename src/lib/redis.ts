import { createClient, RedisClientType } from 'redis';

/**
 * Create and connect a Redis client from REDIS_URL.
 *
 * This is the same Redis instance used by the sibling `alpalo-v2` project, so
 * Schwab OAuth tokens seeded/refreshed there are readable here. Callers are
 * responsible for calling `client.quit()` when done (see `withRedis`).
 */
export async function connectRedis(): Promise<RedisClientType> {
    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl) {
        throw new Error('REDIS_URL is not configured. Set it to the same value as alpalo-v2.');
    }

    const client = createClient({ url: redisUrl }) as RedisClientType;
    client.on('error', (err: Error) => console.error('Redis Client Error:', err.message));
    await client.connect();
    return client;
}

/**
 * Run `fn` with a connected Redis client and always clean up the connection.
 */
export async function withRedis<T>(fn: (redis: RedisClientType) => Promise<T>): Promise<T> {
    const redis = await connectRedis();
    try {
        return await fn(redis);
    } finally {
        try {
            await redis.quit();
        } catch (e) {
            console.warn('Failed to disconnect Redis:', e);
        }
    }
}
