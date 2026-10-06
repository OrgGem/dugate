import * as React from 'react';
import { Tabs as BaseTabs } from '@base-ui/react';
import { cn } from '@/lib/utils';

export const TabsRoot = BaseTabs.Root;

export const TabsList = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof BaseTabs.List>
>(({ className, ...props }, ref) => (
  <BaseTabs.List
    ref={ref}
    className={cn(
      'inline-flex items-center gap-1 border-b border-[var(--border-subtle)] w-full overflow-x-auto select-none p-0.5',
      className
    )}
    {...props}
  />
));
TabsList.displayName = 'TabsList';

export const TabsTab = React.forwardRef<
  HTMLButtonElement,
  React.ComponentPropsWithoutRef<typeof BaseTabs.Tab>
>(({ className, children, ...props }, ref) => (
  <BaseTabs.Tab
    ref={ref}
    className={cn(
      'inline-flex items-center justify-center whitespace-nowrap px-3.5 py-2 text-sm font-medium transition-all outline-none',
      'border-b-2 border-transparent text-[var(--text-sub)] hover:text-[var(--text-main)] hover:bg-[var(--bg-hover)] rounded-t-[var(--radius-sm)]',
      'focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] focus-visible:rounded-[var(--radius-sm)]',
      'data-[selected]:border-[var(--cf-blue)] data-[selected]:text-[var(--cf-blue)] data-[selected]:font-semibold',
      'data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
      className
    )}
    {...props}
  >
    {children}
  </BaseTabs.Tab>
));
TabsTab.displayName = 'TabsTab';

export const TabsPanel = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof BaseTabs.Panel>
>(({ className, ...props }, ref) => (
  <BaseTabs.Panel
    ref={ref}
    className={cn(
      'pt-4 outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] min-w-0 w-full',
      className
    )}
    {...props}
  />
));
TabsPanel.displayName = 'TabsPanel';
