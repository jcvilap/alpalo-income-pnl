import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const SESSION_COOKIE = 'alpalo-income-pnl-session';
/** Matches the dashboard's own `sessionStorage`-based speed bump — expires with the browser session, not a fixed duration. */
const SESSION_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 12;

/**
 * POST /api/login
 * Body: { username: string, password: string }
 *
 * Checks credentials against `DASHBOARD_USERNAME`/`DASHBOARD_PASSWORD` server
 * env vars — never bundled into client JS, unlike the previous hardcoded
 * check in LoginGate.tsx. On success, sets an httpOnly session cookie (not
 * readable by browser JS, unlike the old `sessionStorage` flag) so the
 * client holds no credential, just a session marker.
 *
 * Still just a screen-privacy speed bump, not real authentication — the
 * underlying API routes remain unauthenticated by this app's documented
 * design (see README's "Auth" section). This only closes the "credential
 * shipped in the client bundle" gap, nothing more.
 */
export async function POST(request: Request) {
    const expectedUsername = process.env.DASHBOARD_USERNAME;
    const expectedPassword = process.env.DASHBOARD_PASSWORD;
    if (!expectedUsername || !expectedPassword) {
        console.error('POST /api/login: DASHBOARD_USERNAME/DASHBOARD_PASSWORD not configured');
        return NextResponse.json({ error: 'Login is not configured on the server' }, { status: 500 });
    }

    const body = await request.json().catch(() => ({}));
    const { username, password } = body ?? {};

    if (username !== expectedUsername || password !== expectedPassword) {
        return NextResponse.json({ error: 'Incorrect username or password' }, { status: 401 });
    }

    const response = NextResponse.json({ ok: true });
    response.cookies.set(SESSION_COOKIE, 'true', {
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        path: '/',
        maxAge: SESSION_COOKIE_MAX_AGE_SECONDS,
    });
    return response;
}
