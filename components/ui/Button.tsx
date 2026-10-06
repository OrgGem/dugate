'use client';

import * as React from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

export type ButtonVariant = 'default' | 'primary' | 'secondary' | 'outline' | 'destructive' | 'ghost' | 'link';
export type ButtonSize = 'default' | 'sm' | 'lg' | 'icon' | 'icon-sm';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  isLoading?: boolean;
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;
}

const variantStyles: Record<ButtonVariant, string> = {
  default: 'bg-primary text-primary-foreground hover:bg-primary/90 border border-transparent shadow-xs font-semibold',
  primary: 'bg-primary text-primary-foreground hover:bg-primary/90 border border-transparent shadow-xs font-semibold',
  secondary: 'bg-muted text-foreground hover:bg-muted/80 border border-border/50 font-medium',
  outline: 'bg-card border border-border text-foreground hover:bg-muted hover:border-slate-400 dark:hover:border-slate-600 font-medium shadow-xs',
  destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive/90 border border-transparent shadow-xs font-semibold',
  ghost: 'text-foreground hover:bg-muted hover:text-foreground font-medium',
  link: 'text-primary underline-offset-4 hover:underline p-0 h-auto font-medium',
};

const sizeStyles: Record<ButtonSize, string> = {
  default: 'h-9 px-4 py-2 text-sm rounded-lg',
  sm: 'h-7.5 px-3 py-1 text-xs rounded-md',
  lg: 'h-10 px-5 py-2.5 text-base font-semibold rounded-xl',
  icon: 'h-9 w-9 p-0 rounded-lg',
  'icon-sm': 'h-7.5 w-7.5 p-0 rounded-md',
};

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      className,
      variant = 'default',
      size = 'default',
      isLoading = false,
      leftIcon,
      rightIcon,
      disabled,
      children,
      ...props
    },
    ref
  ) => {
    return (
      <button
        ref={ref}
        disabled={disabled || isLoading}
        className={cn(
          'inline-flex items-center justify-center gap-2 whitespace-nowrap transition-colors select-none',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-1',
          'disabled:opacity-50 disabled:pointer-events-none active:translate-y-[1px]',
          variantStyles[variant],
          sizeStyles[size],
          className
        )}
        {...props}
      >
        {isLoading ? <Loader2 className="w-4 h-4 animate-spin shrink-0" /> : leftIcon}
        {children}
        {!isLoading && rightIcon}
      </button>
    );
  }
);

Button.displayName = 'Button';
