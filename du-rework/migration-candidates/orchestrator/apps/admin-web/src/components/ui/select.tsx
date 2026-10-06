import * as React from 'react';
import { Select as BaseSelect } from '@base-ui/react';
import { Check, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';

export const SelectRoot = BaseSelect.Root;
export const SelectPortal = BaseSelect.Portal;
export const SelectValue = BaseSelect.Value;
export const SelectGroup = BaseSelect.Group;
export const SelectItemText = BaseSelect.ItemText;

export interface SelectTriggerProps extends React.ComponentPropsWithoutRef<typeof BaseSelect.Trigger> {
  isError?: boolean;
}

export const SelectTrigger = React.forwardRef<HTMLButtonElement, SelectTriggerProps>(
  ({ className, isError, children, ...props }, ref) => (
    <BaseSelect.Trigger
      ref={ref}
      className={cn(
        'flex h-9 w-full min-w-0 items-center justify-between rounded-[var(--radius-sm)] border border-[var(--border-dark)] bg-[var(--bg-card)] px-3 py-1.5 text-sm text-[var(--text-main)] shadow-xs transition-colors select-none',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] focus-visible:border-transparent',
        'disabled:cursor-not-allowed disabled:opacity-50 disabled:bg-[var(--bg-subtle)]',
        isError && 'border-[var(--badge-danger-border)] text-[var(--badge-danger-text)] focus-visible:ring-[var(--badge-danger-dot)]',
        className
      )}
      {...props}
    >
      <span className="truncate">{children}</span>
      <BaseSelect.Icon className="shrink-0 text-[var(--text-sub)]">
        <ChevronDown className="size-4 opacity-70" aria-hidden="true" />
      </BaseSelect.Icon>
    </BaseSelect.Trigger>
  )
);
SelectTrigger.displayName = 'SelectTrigger';

export const SelectPositioner = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof BaseSelect.Positioner>
>(({ className, ...props }, ref) => (
  <BaseSelect.Positioner
    ref={ref}
    sideOffset={4}
    className={cn('z-50 min-w-[8rem]', className)}
    {...props}
  />
));
SelectPositioner.displayName = 'SelectPositioner';

export const SelectPopup = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof BaseSelect.Popup>
>(({ className, ...props }, ref) => (
  <BaseSelect.Popup
    ref={ref}
    className={cn(
      'relative z-50 max-h-96 min-w-[8rem] overflow-hidden rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-card)] text-[var(--text-main)] shadow-[var(--shadow-pop)] p-1 animate-in fade-in-80',
      className
    )}
    {...props}
  />
));
SelectPopup.displayName = 'SelectPopup';

export const SelectItem = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof BaseSelect.Item>
>(({ className, children, ...props }, ref) => (
  <BaseSelect.Item
    ref={ref}
    className={cn(
      'relative flex w-full cursor-pointer select-none items-center rounded-[var(--radius-sm)] py-1.5 pl-8 pr-2 text-sm outline-none transition-colors',
      'hover:bg-[var(--bg-hover)] focus:bg-[var(--bg-hover)] data-[highlighted]:bg-[var(--bg-hover)]',
      'data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
      className
    )}
    {...props}
  >
    <span className="absolute left-2 flex size-3.5 items-center justify-center">
      <BaseSelect.ItemIndicator>
        <Check className="size-4 text-[var(--cf-blue)]" aria-hidden="true" />
      </BaseSelect.ItemIndicator>
    </span>
    <BaseSelect.ItemText>{children}</BaseSelect.ItemText>
  </BaseSelect.Item>
));
SelectItem.displayName = 'SelectItem';

export const SelectGroupLabel = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof BaseSelect.GroupLabel>
>(({ className, ...props }, ref) => (
  <BaseSelect.GroupLabel
    ref={ref}
    className={cn('px-2 py-1.5 text-xs font-semibold text-[var(--text-sub)]', className)}
    {...props}
  />
));
SelectGroupLabel.displayName = 'SelectGroupLabel';

export const SelectSeparator = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof BaseSelect.Separator>
>(({ className, ...props }, ref) => (
  <BaseSelect.Separator
    ref={ref}
    className={cn('-mx-1 my-1 h-px bg-[var(--border-subtle)]', className)}
    {...props}
  />
));
SelectSeparator.displayName = 'SelectSeparator';

export interface NativeSelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  isError?: boolean;
}

/**
 * Accessible styled native select wrapper with custom Chevron indicator and design token styling.
 */
export const NativeSelect = React.forwardRef<HTMLSelectElement, NativeSelectProps>(
  ({ className, isError, disabled, children, ...props }, ref) => {
    return (
      <div className="relative flex items-center w-full min-w-0">
        <select
          ref={ref}
          disabled={disabled}
          aria-invalid={isError ? true : undefined}
          className={cn(
            'flex h-9 w-full min-w-0 appearance-none rounded-[var(--radius-sm)] border border-[var(--border-dark)] bg-[var(--bg-card)] pl-3 pr-8 py-1.5 text-sm text-[var(--text-main)] shadow-xs transition-colors',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] focus-visible:border-transparent',
            'disabled:cursor-not-allowed disabled:opacity-50 disabled:bg-[var(--bg-subtle)]',
            isError && 'border-[var(--badge-danger-border)] text-[var(--badge-danger-text)] focus-visible:ring-[var(--badge-danger-dot)]',
            className
          )}
          {...props}
        >
          {children}
        </select>
        <span
          className="pointer-events-none absolute right-2.5 flex items-center text-[var(--text-sub)]"
          aria-hidden="true"
        >
          <ChevronDown className="size-4 opacity-70" />
        </span>
      </div>
    );
  }
);
NativeSelect.displayName = 'NativeSelect';
