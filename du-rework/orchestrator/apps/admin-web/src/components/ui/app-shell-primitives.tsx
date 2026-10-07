import * as React from 'react';
import { cn } from '@/lib/utils';

export function AppShellLayout({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('min-h-dvh bg-[var(--bg-canvas)] text-[var(--text-main)] flex flex-col', className)}
      {...props}
    />
  );
}

export function AppShellHeader({ className, ...props }: React.HTMLAttributes<HTMLElement>) {
  return (
    <header
      className={cn(
        'flex flex-wrap items-center gap-3 border-b border-[var(--border-subtle)] bg-[var(--bg-card)] px-4 py-2.5 shadow-xs sticky top-0 z-40',
        className
      )}
      {...props}
    />
  );
}

export function AppShellBrand({
  title = 'Orchestrator Portal',
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { title?: string }) {
  return (
    <div className={cn('flex items-center gap-2 font-semibold text-sm select-none', className)} {...props}>
      <span
        className="inline-block size-3 rounded-full bg-[var(--cf-orange)] shadow-xs ring-2 ring-[var(--brand-mark-ring)]"
        aria-hidden="true"
      />
      <span>{title}</span>
    </div>
  );
}

export function AppShellNav({ className, ...props }: React.HTMLAttributes<HTMLElement>) {
  return (
    <nav
      aria-label="Orchestrator Portal Navigation"
      className={cn('flex items-center gap-1 text-sm overflow-x-auto min-w-0', className)}
      {...props}
    />
  );
}

export interface AppShellNavItemProps extends React.AnchorHTMLAttributes<HTMLAnchorElement> {
  isActive?: boolean;
}

export function AppShellNavItem({ className, isActive, children, ...props }: AppShellNavItemProps) {
  return (
    <a
      className={cn(
        'rounded-[var(--radius-sm)] px-2.5 py-1 text-xs sm:text-sm font-medium transition-colors no-underline select-none whitespace-nowrap',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
        isActive
          ? 'bg-[var(--cf-blue-light)] font-semibold text-[var(--cf-blue)]'
          : 'text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-main)]',
        className
      )}
      {...props}
    >
      {children}
    </a>
  );
}

export function AppShellMain({ className, ...props }: React.HTMLAttributes<HTMLElement>) {
  return (
    <main
      className={cn('mx-auto w-full max-w-5xl px-4 py-6 flex-1 min-w-0', className)}
      {...props}
    />
  );
}

export function AppShellFooter({ className, ...props }: React.HTMLAttributes<HTMLElement>) {
  return (
    <footer
      className={cn(
        'border-t border-[var(--border-subtle)] bg-[var(--bg-card)] px-4 py-3 text-xs text-[var(--text-sub)] flex flex-wrap items-center justify-between gap-2',
        className
      )}
      {...props}
    />
  );
}

export function AppShellStatusBadge({
  label = 'Session Active',
  variant = 'info',
  className,
}: {
  label?: string;
  variant?: 'info' | 'success' | 'warning' | 'danger' | 'neutral';
  className?: string;
}) {
  const styles = {
    info: 'bg-[var(--badge-info-bg)] text-[var(--badge-info-text)] border-[var(--badge-info-border)]',
    success: 'bg-[var(--badge-success-bg)] text-[var(--badge-success-text)] border-[var(--badge-success-border)]',
    warning: 'bg-[var(--badge-warning-bg)] text-[var(--badge-warning-text)] border-[var(--badge-warning-border)]',
    danger: 'bg-[var(--badge-danger-bg)] text-[var(--badge-danger-text)] border-[var(--badge-danger-border)]',
    neutral: 'bg-[var(--badge-neutral-bg)] text-[var(--badge-neutral-text)] border-[var(--border-subtle)]',
  };

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium',
        styles[variant],
        className
      )}
    >
      <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />
      <span>{label}</span>
    </span>
  );
}
