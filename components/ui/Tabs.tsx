'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

export interface TabItem {
  id: string;
  label: React.ReactNode;
  icon?: React.ReactNode;
  badge?: React.ReactNode;
  disabled?: boolean;
}

export interface TabsProps {
  items: TabItem[];
  activeId: string;
  onChange: (id: string) => void;
  className?: string;
  variant?: 'pill' | 'underline';
}

export function Tabs({ items, activeId, onChange, className, variant = 'pill' }: TabsProps) {
  return (
    <div
      className={cn(
        'flex items-center gap-1.5 overflow-x-auto select-none',
        variant === 'underline' && 'border-b border-border gap-4',
        variant === 'pill' && 'p-1 rounded-xl bg-muted/50 border border-border/50',
        className
      )}
      role="tablist"
    >
      {items.map((tab) => {
        const isActive = tab.id === activeId;

        if (variant === 'underline') {
          return (
            <button
              key={tab.id}
              role="tab"
              aria-selected={isActive}
              disabled={tab.disabled}
              onClick={() => onChange(tab.id)}
              className={cn(
                'flex items-center gap-2 pb-2.5 pt-1 text-sm font-semibold border-b-2 transition-colors relative whitespace-nowrap',
                isActive
                  ? 'border-primary text-primary'
                  : 'border-transparent text-muted-foreground hover:text-foreground hover:border-border',
                tab.disabled && 'opacity-40 pointer-events-none'
              )}
            >
              {tab.icon}
              <span>{tab.label}</span>
              {tab.badge && <span className="ml-1">{tab.badge}</span>}
            </button>
          );
        }

        return (
          <button
            key={tab.id}
            role="tab"
            aria-selected={isActive}
            disabled={tab.disabled}
            onClick={() => onChange(tab.id)}
            className={cn(
              'flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all whitespace-nowrap',
              isActive
                ? 'bg-card text-foreground shadow-xs border border-border/80'
                : 'text-muted-foreground hover:text-foreground hover:bg-card/40 border border-transparent',
              tab.disabled && 'opacity-40 pointer-events-none'
            )}
          >
            {tab.icon}
            <span>{tab.label}</span>
            {tab.badge && <span className="ml-1">{tab.badge}</span>}
          </button>
        );
      })}
    </div>
  );
}
