import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';

export const dynamic = 'force-dynamic';

const SESSION_COOKIE = 'alpalo-income-pnl-session';

/** GET /api/session — reports whether the httpOnly session cookie from /api/login is present. The cookie itself isn't readable by browser JS, so LoginGate asks the server instead. */
export async function GET() {
    const store = await cookies();
    const authed = store.get(SESSION_COOKIE)?.value === 'true';
    return NextResponse.json({ authed });
}
