import * as React from 'react';
import { cn } from '@/lib/utils';
import { Button } from './button';

export interface TableContainerProps extends React.HTMLAttributes<HTMLDivElement> {
  /** When set, bounds the table viewport and enables vertical as well as horizontal scrolling. */
  maxHeight?: number | string;
}

export const TableContainer = React.forwardRef<HTMLDivElement, TableContainerProps>(
  ({ className, maxHeight, style, role, tabIndex, 'aria-label': ariaLabel, ...props }, ref) => (
    <div
      ref={ref}
      role={role ?? (maxHeight !== undefined && ariaLabel ? 'region' : undefined)}
      aria-label={ariaLabel}
      tabIndex={tabIndex ?? (maxHeight === undefined ? undefined : 0)}
      className={cn(
        'relative w-full min-w-0 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-card)] shadow-[var(--shadow-card)]',
        maxHeight === undefined ? 'overflow-x-auto' : 'overflow-auto',
        className
      )}
      style={{ ...style, ...(maxHeight === undefined ? {} : { maxHeight }) }}
      {...props}
    />
  )
);
TableContainer.displayName = 'TableContainer';

export interface TableProps extends React.TableHTMLAttributes<HTMLTableElement> {
  density?: 'default' | 'compact';
}

export const Table = React.forwardRef<HTMLTableElement, TableProps>(
  ({ className, density = 'default', ...props }, ref) => (
    <table
      ref={ref}
      className={cn(
        'w-full caption-bottom text-sm border-collapse text-[var(--text-main)]',
        density === 'compact' && 'text-xs [&_th]:h-8 [&_th]:px-3 [&_td]:px-3 [&_td]:py-2 [&_td]:text-xs',
        className
      )}
      {...props}
    />
  )
);
Table.displayName = 'Table';

export interface TableHeaderProps extends React.HTMLAttributes<HTMLTableSectionElement> {
  sticky?: boolean;
}

export const TableHeader = React.forwardRef<HTMLTableSectionElement, TableHeaderProps>(
  ({ className, sticky = false, ...props }, ref) => (
    <thead
      ref={ref}
      className={cn(
        'bg-[var(--bg-subtle)] border-b border-[var(--border-subtle)]',
        sticky && 'sticky top-0 z-10',
        className
      )}
      {...props}
    />
  )
);
TableHeader.displayName = 'TableHeader';

export const TableBody = React.forwardRef<HTMLTableSectionElement, React.HTMLAttributes<HTMLTableSectionElement>>(
  ({ className, ...props }, ref) => (
    <tbody
      ref={ref}
      className={cn('divide-y divide-[var(--border-subtle)] bg-[var(--bg-card)]', className)}
      {...props}
    />
  )
);
TableBody.displayName = 'TableBody';

export const TableFooter = React.forwardRef<HTMLTableSectionElement, React.HTMLAttributes<HTMLTableSectionElement>>(
  ({ className, ...props }, ref) => (
    <tfoot
      ref={ref}
      className={cn('border-t border-[var(--border-subtle)] bg-[var(--bg-subtle)] font-medium', className)}
      {...props}
    />
  )
);
TableFooter.displayName = 'TableFooter';

export const TableRow = React.forwardRef<HTMLTableRowElement, React.HTMLAttributes<HTMLTableRowElement>>(
  ({ className, ...props }, ref) => (
    <tr
      ref={ref}
      className={cn(
        'transition-colors hover:bg-[var(--bg-hover)] data-[state=selected]:bg-[var(--bg-subtle)]',
        className
      )}
      {...props}
    />
  )
);
TableRow.displayName = 'TableRow';

export const TableHead = React.forwardRef<HTMLTableCellElement, React.ThHTMLAttributes<HTMLTableCellElement>>(
  ({ className, ...props }, ref) => (
    <th
      ref={ref}
      className={cn(
        'h-10 px-4 text-left align-middle text-xs font-semibold text-[var(--text-sub)] uppercase tracking-wider select-none',
        className
      )}
      {...props}
    />
  )
);
TableHead.displayName = 'TableHead';

export const TableCell = React.forwardRef<HTMLTableCellElement, React.TdHTMLAttributes<HTMLTableCellElement>>(
  ({ className, ...props }, ref) => (
    <td
      ref={ref}
      className={cn('px-4 py-3 align-middle text-sm text-[var(--text-main)] break-words', className)}
      {...props}
    />
  )
);
TableCell.displayName = 'TableCell';

export interface TableEmptyProps {
  colSpan: number;
  message?: React.ReactNode;
  icon?: React.ReactNode;
}

export function TableEmpty({ colSpan, message = 'No data available', icon }: TableEmptyProps) {
  return (
    <TableRow>
      <TableCell colSpan={colSpan} className="h-28 text-center text-[var(--text-sub)]">
        <div className="flex flex-col items-center justify-center gap-2">
          {icon && <span className="[&>svg]:size-6 text-[var(--text-sub)] opacity-60">{icon}</span>}
          <span>{message}</span>
        </div>
      </TableCell>
    </TableRow>
  );
}

export interface TablePaginationProps extends React.HTMLAttributes<HTMLElement> {
  hasPreviousPage: boolean;
  hasNextPage: boolean;
  onPreviousPage?: () => void;
  onNextPage?: () => void;
  pending?: boolean;
  status?: React.ReactNode;
  previousLabel?: React.ReactNode;
  nextLabel?: React.ReactNode;
  ariaLabel?: string;
}

/**
 * Callback-only paging controls for server-paginated or otherwise externally paged data.
 * This component does not slice rows or infer totals from the currently loaded page.
 */
export const TablePagination = React.forwardRef<HTMLElement, TablePaginationProps>(
  (
    {
      className,
      hasPreviousPage,
      hasNextPage,
      onPreviousPage,
      onNextPage,
      pending = false,
      status,
      previousLabel = 'Previous page',
      nextLabel = 'Next page',
      ariaLabel = 'Table pagination',
      ...props
    },
    ref
  ) => (
    <nav
      ref={ref}
      aria-label={ariaLabel}
      aria-busy={pending ? true : undefined}
      className={cn(
        'flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between',
        className
      )}
      {...props}
    >
      {status !== undefined && status !== null && (
        <span role="status" aria-live="polite" className="min-w-0 break-words text-xs text-[var(--text-sub)]">
          {status}
        </span>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={pending || !hasPreviousPage || !onPreviousPage}
          onClick={onPreviousPage}
        >
          {previousLabel}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={pending || !hasNextPage || !onNextPage}
          onClick={onNextPage}
        >
          {nextLabel}
        </Button>
      </div>
    </nav>
  )
);
TablePagination.displayName = 'TablePagination';
