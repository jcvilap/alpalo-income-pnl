'use client';

import { useEffect, useState } from 'react';
import { Moon, Sun } from 'lucide-react';
import { useTheme } from '@/providers/ThemeProvider';

export function ThemeToggle() {
    const { theme, setTheme } = useTheme();
    const [mounted, setMounted] = useState(false);
    useEffect(() => setMounted(true), []);
    if (!mounted) return null;

    const isDark = theme === 'dark';
    return (
        <button
            aria-label="Toggle theme"
            onClick={() => setTheme(isDark ? 'light' : 'dark')}
            className="rounded-lg p-2 transition-theme"
            style={{ border: '1px solid var(--color-border)', color: 'var(--color-text-secondary)' }}
        >
            {isDark ? <Sun size={16} /> : <Moon size={16} />}
        </button>
    );
}
