import * as React from 'react';
import { Input as BaseInput } from '@base-ui/react';
import { cn } from '@/lib/utils';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  isError?: boolean;
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type = 'text', isError = false, leftIcon, rightIcon, disabled, ...props }, ref) => {
    const hasIcons = leftIcon || rightIcon;

    const inputNode = (
      <BaseInput
        ref={ref}
        type={type}
        disabled={disabled}
        aria-invalid={isError ? true : undefined}
        className={cn(
          'flex h-9 w-full min-w-0 rounded-[var(--radius-sm)] border border-[var(--border-dark)] bg-[var(--bg-card)] px-3 py-1.5 text-sm text-[var(--text-main)] shadow-xs transition-colors',
          'placeholder:text-[var(--text-sub)]',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] focus-visible:border-transparent',
          'disabled:cursor-not-allowed disabled:opacity-50 disabled:bg-[var(--bg-subtle)]',
          isError &&
            'border-[var(--badge-danger-border)] text-[var(--badge-danger-text)] focus-visible:ring-[var(--badge-danger-dot)]',
          leftIcon && 'pl-9',
          rightIcon && 'pr-9',
          className
        )}
        {...props}
      />
    );

    if (!hasIcons) {
      return inputNode;
    }

    return (
      <div className="relative flex items-center w-full min-w-0">
        {leftIcon && (
          <span
            className="absolute left-2.5 flex items-center pointer-events-none text-[var(--text-sub)] [&>svg]:size-4"
            aria-hidden="true"
          >
            {leftIcon}
          </span>
        )}
        {inputNode}
        {rightIcon && (
          <span
            className="absolute right-2.5 flex items-center pointer-events-none text-[var(--text-sub)] [&>svg]:size-4"
            aria-hidden="true"
          >
            {rightIcon}
          </span>
        )}
      </div>
    );
  }
);

Input.displayName = 'Input';
