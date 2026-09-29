'use client';

import { useCallback, useMemo, useState } from 'react';
import { Copy, Check, ArrowLeftRight } from 'lucide-react';
import { ThemeToggle } from '@/components/ThemeToggle';
import { LoginGate } from '@/components/LoginGate';
import { parseLegs, computeNetPrice, convertOrder, ParseError } from '@/lib/convert';

const PLACEHOLDER = `BTO SPXW 7705C 10/13/26 at 68.20
STO -2× SPXW 7730C 10/13/26 at 55.25
BTO SPXW 7755C 10/13/26 at 44
BTO SPXW 7600P 10/20/26 at 58.95
STO -1× SPXW 7630P 10/13/26 at 50.95`;

export default function ConvertPage() {
    const [text, setText] = useState('');
    const [priceOverride, setPriceOverride] = useState('');
    const [copied, setCopied] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const computed = useMemo(() => {
        if (!text.trim()) return null;
        try {
            const legs = parseLegs(text);
            return { legs, netPrice: computeNetPrice(legs) };
        } catch {
            return null;
        }
    }, [text]);

    const suggestedPrice = computed ? Math.abs(computed.netPrice).toFixed(2) : '';

    const [result, setResult] = useState<string | null>(null);

    const onConvert = useCallback(async () => {
        setError(null);
        setCopied(false);
        try {
            const overrideMagnitude = priceOverride.trim() ? parseFloat(priceOverride) : undefined;
            const { orderString } = convertOrder(text, overrideMagnitude);
            await navigator.clipboard.writeText(orderString);
            setResult(orderString);
            setCopied(true);
        } catch (e) {
            setResult(null);
            setError(e instanceof ParseError ? `Line ${e.lineNumber}: ${e.message}` : e instanceof Error ? e.message : String(e));
        }
    }, [text, priceOverride]);

    return (
        <LoginGate>
            <main
                className="min-h-screen px-4 py-6 sm:px-8 sm:py-10 transition-theme"
                style={{ background: 'var(--color-background)' }}
            >
                <div className="max-w-3xl mx-auto flex flex-col gap-6">
                    <header className="flex items-start justify-between gap-4 flex-wrap">
                        <div>
                            <h1
                                className="text-2xl font-bold flex items-center gap-2"
                                style={{ color: 'var(--color-text-primary)' }}
                            >
                                <ArrowLeftRight size={22} style={{ color: 'var(--color-primary)' }} />
                                Order Converter
                            </h1>
                            <p className="text-sm mt-1" style={{ color: 'var(--color-text-secondary)' }}>
                                Paste fill lines, get a thinkorswim custom order string ready to paste
                            </p>
                        </div>
                        <ThemeToggle />
                    </header>

                    <section
                        className="rounded-xl p-4 flex flex-col gap-3 bg-surface transition-theme"
                        style={{ border: '1px solid var(--color-border)' }}
                    >
                        <label className="flex flex-col gap-1">
                            <span
                                className="text-xs font-medium uppercase tracking-wide"
                                style={{ color: 'var(--color-text-secondary)' }}
                            >
                                Order legs
                            </span>
                            <textarea
                                value={text}
                                onChange={(e) => setText(e.target.value)}
                                placeholder={PLACEHOLDER}
                                rows={8}
                                spellCheck={false}
                                className="rounded-lg px-3 py-2 text-sm font-mono bg-surface resize-y"
                                style={{ border: '1px solid var(--color-border)', color: 'var(--color-text-primary)' }}
                            />
                        </label>

                        <label className="flex flex-col gap-1 max-w-xs">
                            <span
                                className="text-xs font-medium uppercase tracking-wide"
                                style={{ color: 'var(--color-text-secondary)' }}
                            >
                                Contract price {suggestedPrice ? `(suggested ${suggestedPrice})` : ''}
                            </span>
                            <input
                                type="number"
                                step="0.01"
                                value={priceOverride}
                                onChange={(e) => setPriceOverride(e.target.value)}
                                placeholder={suggestedPrice || '0.00'}
                                className="rounded-lg px-3 text-sm bg-surface h-9"
                                style={{ border: '1px solid var(--color-border)', color: 'var(--color-text-primary)' }}
                            />
                            <span className="text-xs" style={{ color: 'var(--color-text-tertiary)' }}>
                                Defaults to the sum of leg prices above — override for a different limit price.
                            </span>
                        </label>

                        <button
                            onClick={onConvert}
                            disabled={!text.trim()}
                            className="rounded-lg px-4 text-sm font-medium text-white bg-gradient-button hover:bg-gradient-button-hover disabled:opacity-60 h-9 self-start flex items-center gap-2"
                        >
                            {copied ? <Check size={14} /> : <Copy size={14} />}
                            {copied ? 'Copied!' : 'Convert & Copy'}
                        </button>
                    </section>

                    {error && (
                        <div
                            className="rounded-xl p-4 text-sm"
                            style={{ background: 'var(--color-danger-bg)', color: 'var(--color-danger-text)' }}
                        >
                            {error}
                        </div>
                    )}

                    {result && !error && (
                        <section
                            className="rounded-xl p-4 flex flex-col gap-2 bg-surface transition-theme"
                            style={{ border: '1px solid var(--color-border)' }}
                        >
                            <span
                                className="text-xs font-medium uppercase tracking-wide"
                                style={{ color: 'var(--color-text-secondary)' }}
                            >
                                thinkorswim order string
                            </span>
                            <code
                                className="text-sm font-mono break-all rounded-lg p-3"
                                style={{ background: 'var(--color-background)', color: 'var(--color-text-primary)' }}
                            >
                                {result}
                            </code>
                            <span className="text-xs" style={{ color: 'var(--color-text-tertiary)' }}>
                                Copied to clipboard. In thinkorswim, click into the order entry line, paste (Cmd+V),
                                and press Enter — the dedicated &quot;paste order from clipboard&quot; button expects a
                                different format and won&apos;t parse this. Strangle, iron condor, and double
                                calendar/diagonal shapes are verified against real thinkorswim pastes; anything else
                                falls back to a best-effort CUSTOM combo — verify those before trusting them to route.
                            </span>
                        </section>
                    )}
                </div>
            </main>
        </LoginGate>
    );
}
