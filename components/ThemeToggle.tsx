'use client';

import * as React from 'react';
import { Moon, Sun, Laptop } from 'lucide-react';
import { useTheme } from 'next-themes';

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = React.useState(false);

  React.useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    return (
      <div className="w-9 h-9 rounded-full bg-muted animate-pulse" />
    );
  }

  return (
    <div className="relative group/theme flex items-center justify-center">
      {/* Current theme Icon button */}
      <button className="flex items-center justify-center w-9 h-9 rounded-full bg-muted text-muted-foreground hover:bg-muted/80 hover:text-foreground transition-colors">
        {theme === 'light' ? (
          <Sun className="w-4 h-4" />
        ) : theme === 'dark' ? (
          <Moon className="w-4 h-4" />
        ) : (
          <Laptop className="w-4 h-4" />
        )}
      </button>

      {/* Dropdown Menu */}
      <div className="absolute right-0 top-full mt-2 w-36 bg-popover border border-border text-popover-foreground shadow-xl rounded-xl p-1.5 opacity-0 invisible group-hover/theme:opacity-100 group-hover/theme:visible transition-all duration-200 z-50">
        <button
          onClick={() => setTheme('light')}
          className={`w-full flex items-center gap-2 px-3 py-2 text-sm rounded-lg font-medium transition-colors ${
            theme === 'light'
              ? 'bg-primary/10 text-primary'
              : 'text-muted-foreground hover:bg-muted hover:text-foreground'
          }`}
        >
          <Sun className="w-4 h-4" /> Sáng (Light)
        </button>
        <button
          onClick={() => setTheme('dark')}
          className={`w-full flex items-center gap-2 px-3 py-2 text-sm rounded-lg font-medium transition-colors ${
            theme === 'dark'
              ? 'bg-primary/10 text-primary'
              : 'text-muted-foreground hover:bg-muted hover:text-foreground'
          }`}
        >
          <Moon className="w-4 h-4" /> Tối (Dark)
        </button>
        <button
          onClick={() => setTheme('system')}
          className={`w-full flex items-center gap-2 px-3 py-2 text-sm rounded-lg font-medium transition-colors ${
            theme === 'system'
              ? 'bg-primary/10 text-primary'
              : 'text-muted-foreground hover:bg-muted hover:text-foreground'
          }`}
        >
          <Laptop className="w-4 h-4" /> Bám Hệ thống
        </button>
      </div>
    </div>
  );
}
