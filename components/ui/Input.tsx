'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  helperText?: string;
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type = 'text', label, error, helperText, leftIcon, rightIcon, id, ...props }, ref) => {
    const generatedId = React.useId();
    const inputId = id || generatedId;

    return (
      <div className="w-full space-y-1.5">
        {label && (
          <label htmlFor={inputId} className="block text-xs font-semibold text-foreground uppercase tracking-wider">
            {label}
          </label>
        )}
        <div className="relative flex items-center">
          {leftIcon && (
            <div className="absolute left-3 text-muted-foreground pointer-events-none flex items-center justify-center">
              {leftIcon}
            </div>
          )}
          <input
            id={inputId}
            type={type}
            ref={ref}
            className={cn(
              'w-full h-9 rounded-lg border border-border bg-card px-3 py-1.5 text-sm text-foreground shadow-xs transition-colors',
              'placeholder:text-muted-foreground/70',
              'focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary',
              'disabled:cursor-not-allowed disabled:opacity-50 disabled:bg-muted/40',
              leftIcon && 'pl-9',
              rightIcon && 'pr-9',
              error && 'border-destructive focus:border-destructive focus:ring-destructive',
              className
            )}
            {...props}
          />
          {rightIcon && (
            <div className="absolute right-3 text-muted-foreground flex items-center justify-center">
              {rightIcon}
            </div>
          )}
        </div>
        {error ? (
          <p className="text-xs text-destructive font-medium mt-1">{error}</p>
        ) : helperText ? (
          <p className="text-xs text-muted-foreground mt-1">{helperText}</p>
        ) : null}
      </div>
    );
  }
);

Input.displayName = 'Input';
