import * as React from 'react';
import { cn } from '@/lib/utils';

export type BadgeVariant = 'default' | 'primary' | 'secondary' | 'success' | 'warning' | 'destructive' | 'outline' | 'info';

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
  dot?: boolean;
}

const badgeVariants: Record<BadgeVariant, string> = {
  default: 'bg-primary/10 text-primary border-primary/20',
  primary: 'bg-primary text-primary-foreground border-transparent shadow-xs',
  secondary: 'bg-muted text-muted-foreground border-border',
  success: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-400 dark:border-emerald-800',
  warning: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-400 dark:border-amber-800',
  destructive: 'bg-red-50 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-400 dark:border-red-800',
  outline: 'border-border text-foreground bg-transparent',
  info: 'bg-sky-50 text-sky-700 border-sky-200 dark:bg-sky-950/40 dark:text-sky-400 dark:border-sky-800',
};

const dotColors: Record<BadgeVariant, string> = {
  default: 'bg-primary',
  primary: 'bg-white',
  secondary: 'bg-slate-400',
  success: 'bg-emerald-500',
  warning: 'bg-amber-500',
  destructive: 'bg-red-500',
  outline: 'bg-slate-400',
  info: 'bg-sky-500',
};

export function Badge({ className, variant = 'default', dot = false, children, ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium border select-none transition-colors',
        badgeVariants[variant],
        className
      )}
      {...props}
    >
      {dot && <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', dotColors[variant])} />}
      {children}
    </span>
  );
}
