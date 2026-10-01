'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { Lock } from 'lucide-react';

const SESSION_KEY = 'alpalo-income-pnl:authed';
const PASSWORD_KEY = 'alpalo-income-pnl:password';
const USERNAME = 'admin';
const PASSWORD = '123';

/**
 * Lightweight client-side speed bump, not real authentication — the
 * credentials are hardcoded and checked entirely in the browser. Good enough
 * to keep the dashboard off a shared screen's default view, not to protect
 * the underlying data (the API routes remain unauthenticated).
 */
export function LoginGate({ children }: { children: React.ReactNode }) {
    const [authed, setAuthed] = useState<boolean | null>(null);
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState(false);

    useEffect(() => {
        // Skip the speed bump entirely in local dev — there's no shared
        // screen to protect against on localhost.
        const isLocalhost = ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname);
        if (isLocalhost) {
            setAuthed(true);
            return;
        }
        setAuthed(sessionStorage.getItem(SESSION_KEY) === 'true');
        const savedPassword = sessionStorage.getItem(PASSWORD_KEY);
        if (savedPassword) setPassword(savedPassword);
    }, []);

    const onSubmit = (e: FormEvent) => {
        e.preventDefault();
        if (username === USERNAME && password === PASSWORD) {
            sessionStorage.setItem(SESSION_KEY, 'true');
            sessionStorage.setItem(PASSWORD_KEY, password);
            setAuthed(true);
            setError(false);
        } else {
            setError(true);
        }
    };

    if (authed === null) return null;
    if (authed) return <>{children}</>;

    return (
        <main
            className="min-h-screen flex items-center justify-center px-4 transition-theme"
            style={{ background: 'var(--color-background)' }}
        >
            <form
                onSubmit={onSubmit}
                className="w-full max-w-sm rounded-2xl p-8 flex flex-col gap-5 bg-surface transition-theme"
                style={{ border: '1px solid var(--color-border)' }}
            >
                <div className="flex flex-col items-center gap-2 text-center">
                    <div
                        className="w-11 h-11 rounded-full flex items-center justify-center"
                        style={{ background: 'var(--color-surface-hover)' }}
                    >
                        <Lock size={18} style={{ color: 'var(--color-primary)' }} />
                    </div>
                    <h1 className="text-lg font-semibold" style={{ color: 'var(--color-text-primary)' }}>
                        Alpalo Income P&amp;L
                    </h1>
                    <p className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>
                        Sign in to view the dashboard
                    </p>
                </div>

                <div className="flex flex-col gap-3">
                    <input
                        type="text"
                        autoFocus
                        placeholder="Username"
                        value={username}
                        onChange={(e) => {
                            setUsername(e.target.value);
                            setError(false);
                        }}
                        className="rounded-lg px-3 py-2 text-sm bg-surface"
                        style={{ border: '1px solid var(--color-border)', color: 'var(--color-text-primary)' }}
                    />
                    <input
                        type="password"
                        placeholder="Password"
                        value={password}
                        onChange={(e) => {
                            setPassword(e.target.value);
                            setError(false);
                        }}
                        className="rounded-lg px-3 py-2 text-sm bg-surface"
                        style={{ border: '1px solid var(--color-border)', color: 'var(--color-text-primary)' }}
                    />
                </div>

                {error && (
                    <p className="text-xs text-center" style={{ color: 'var(--color-danger)' }}>
                        Incorrect username or password.
                    </p>
                )}

                <button
                    type="submit"
                    className="rounded-lg px-4 py-2 text-sm font-medium text-white bg-gradient-button hover:bg-gradient-button-hover"
                >
                    Sign in
                </button>
            </form>
        </main>
    );
}
