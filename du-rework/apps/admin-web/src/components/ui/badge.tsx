import * as React from 'react';
import { cn } from '@/lib/utils';

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: 'success' | 'info' | 'warning' | 'danger' | 'neutral';
  size?: 'sm' | 'md';
  dot?: boolean;
  icon?: React.ReactNode;
}

export const Badge = React.forwardRef<HTMLSpanElement, BadgeProps>(
  ({ className, variant = 'neutral', size = 'sm', dot = false, icon, children, ...props }, ref) => {
    const variantStyles: Record<NonNullable<BadgeProps['variant']>, string> = {
      success:
        'bg-[var(--badge-success-bg)] text-[var(--badge-success-text)] border-[var(--badge-success-border)]',
      info:
        'bg-[var(--badge-info-bg)] text-[var(--badge-info-text)] border-[var(--badge-info-border)]',
      warning:
        'bg-[var(--badge-warning-bg)] text-[var(--badge-warning-text)] border-[var(--badge-warning-border)]',
      danger:
        'bg-[var(--badge-danger-bg)] text-[var(--badge-danger-text)] border-[var(--badge-danger-border)]',
      neutral:
        'bg-[var(--badge-neutral-bg)] text-[var(--badge-neutral-text)] border-[var(--border-subtle)]',
    };

    const dotColorStyles: Record<NonNullable<BadgeProps['variant']>, string> = {
      success: 'bg-[var(--badge-success-dot)]',
      info: 'bg-[var(--badge-info-dot)]',
      warning: 'bg-[var(--badge-warning-dot)]',
      danger: 'bg-[var(--badge-danger-dot)]',
      neutral: 'bg-[var(--badge-neutral-dot)]',
    };

    const sizeStyles: Record<NonNullable<BadgeProps['size']>, string> = {
      sm: 'px-2 py-0.5 text-xs',
      md: 'px-2.5 py-1 text-sm',
    };

    return (
      <span
        ref={ref}
        className={cn(
          'inline-flex items-center gap-1.5 rounded-full border font-medium select-none tracking-tight whitespace-nowrap',
          variantStyles[variant],
          sizeStyles[size],
          className
        )}
        {...props}
      >
        {dot && (
          <span
            className={cn('size-1.5 rounded-full shrink-0', dotColorStyles[variant])}
            aria-hidden="true"
          />
        )}
        {icon && <span className="shrink-0 [&>svg]:size-3.5" aria-hidden="true">{icon}</span>}
        <span>{children}</span>
      </span>
    );
  }
);

Badge.displayName = 'Badge';
