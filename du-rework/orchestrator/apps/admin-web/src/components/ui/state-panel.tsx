import * as React from 'react';
import { AlertCircle, AlertTriangle, CheckCircle2, Info, Loader2, Lock, RotateCcw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from './button';

export interface SkeletonProps extends React.HTMLAttributes<HTMLDivElement> {}

export function Skeleton({ className, ...props }: SkeletonProps) {
  return (
    <div
      className={cn('animate-pulse rounded-[var(--radius-sm)] bg-[var(--border-subtle)]/70', className)}
      {...props}
    />
  );
}

export interface LoadingStateProps {
  title?: string;
  description?: string;
  className?: string;
}

export function LoadingState({
  title = 'Loading...',
  description = 'Please wait while data is being fetched.',
  className,
}: LoadingStateProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        'flex flex-col items-center justify-center py-12 px-4 text-center rounded-[var(--radius-md)] border border-dashed border-[var(--border-subtle)] bg-[var(--bg-subtle)]/50',
        className
      )}
    >
      <Loader2 className="size-8 animate-spin text-[var(--cf-blue)] mb-3" aria-hidden="true" />
      <h4 className="text-sm font-semibold text-[var(--text-main)] mb-1">{title}</h4>
      <p className="text-xs text-[var(--text-sub)] max-w-sm">{description}</p>
    </div>
  );
}

export interface EmptyStateProps {
  title?: string;
  description?: string;
  icon?: React.ReactNode;
  actionText?: string;
  onAction?: () => void;
  className?: string;
}

export function EmptyState({
  title = 'No items found',
  description = 'There are no records to display at this time.',
  icon,
  actionText,
  onAction,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center py-12 px-4 text-center rounded-[var(--radius-md)] border border-dashed border-[var(--border-subtle)] bg-[var(--bg-card)]',
        className
      )}
    >
      <div className="size-12 rounded-full bg-[var(--bg-subtle)] border border-[var(--border-subtle)] flex items-center justify-center mb-3 text-[var(--text-sub)] [&>svg]:size-6">
        {icon || <Info className="size-6" />}
      </div>
      <h4 className="text-base font-semibold text-[var(--text-main)] mb-1">{title}</h4>
      <p className="text-xs text-[var(--text-sub)] max-w-sm mb-4 leading-normal">{description}</p>
      {actionText && onAction && (
        <Button variant="outline" size="sm" onClick={onAction}>
          {actionText}
        </Button>
      )}
    </div>
  );
}

export interface ErrorStateProps {
  title?: string;
  description?: string;
  statusCode?: number | string;
  error?: Error | string | null;
  onRetry?: () => void;
  className?: string;
}

export function ErrorState({
  title = 'An error occurred',
  description = 'Failed to load resources. Please try again.',
  statusCode,
  error,
  onRetry,
  className,
}: ErrorStateProps) {
  const errorMsg = typeof error === 'string' ? error : error?.message;

  return (
    <div
      role="alert"
      className={cn(
        'flex flex-col items-center justify-center py-12 px-4 text-center rounded-[var(--radius-md)] border border-[var(--badge-danger-border)] bg-[var(--badge-danger-bg)]/40',
        className
      )}
    >
      <div className="size-12 rounded-full bg-[var(--badge-danger-bg)] border border-[var(--badge-danger-border)] flex items-center justify-center mb-3 text-[var(--badge-danger-text)]">
        <AlertTriangle className="size-6" />
      </div>
      <div className="flex items-center gap-2 mb-1">
        <h4 className="text-base font-semibold text-[var(--badge-danger-text)]">{title}</h4>
        {statusCode && (
          <span className="text-xs font-mono font-bold px-1.5 py-0.5 rounded-sm bg-[var(--badge-danger-border)] text-[var(--badge-danger-text)]">
            {statusCode}
          </span>
        )}
      </div>
      <p className="text-xs text-[var(--text-muted)] max-w-md mb-2 leading-normal">
        {errorMsg || description}
      </p>
      {onRetry && (
        <Button
          variant="outline"
          size="sm"
          onClick={onRetry}
          leftIcon={<RotateCcw className="size-3.5" />}
          className="mt-2"
        >
          Try again
        </Button>
      )}
    </div>
  );
}

export interface DeniedStateProps {
  title?: string;
  description?: string;
  tenantId?: string;
  requiredRole?: string;
  className?: string;
}

export function DeniedState({
  title = 'Access Denied',
  description = 'You do not have the required permissions or tenant scope to access this section.',
  tenantId,
  requiredRole,
  className,
}: DeniedStateProps) {
  return (
    <div
      role="alert"
      className={cn(
        'flex flex-col items-center justify-center py-12 px-4 text-center rounded-[var(--radius-md)] border border-[var(--badge-warning-border)] bg-[var(--badge-warning-bg)]/40',
        className
      )}
    >
      <div className="size-12 rounded-full bg-[var(--badge-warning-bg)] border border-[var(--badge-warning-border)] flex items-center justify-center mb-3 text-[var(--badge-warning-text)]">
        <Lock className="size-6" />
      </div>
      <h4 className="text-base font-semibold text-[var(--badge-warning-text)] mb-1">{title}</h4>
      <p className="text-xs text-[var(--text-muted)] max-w-md mb-3 leading-normal">{description}</p>
      {(tenantId || requiredRole) && (
        <div className="flex flex-wrap gap-2 text-xs font-mono text-[var(--text-sub)]">
          {tenantId && <span>Tenant: {tenantId}</span>}
          {requiredRole && <span>Required: {requiredRole}</span>}
        </div>
      )}
    </div>
  );
}

export interface AlertBannerProps {
  variant?: 'info' | 'success' | 'warning' | 'error';
  title?: string;
  children: React.ReactNode;
  className?: string;
}

export function AlertBanner({
  variant = 'info',
  title,
  children,
  className,
}: AlertBannerProps) {
  const variantStyles = {
    info: 'border-[var(--badge-info-border)] bg-[var(--badge-info-bg)] text-[var(--badge-info-text)]',
    success: 'border-[var(--badge-success-border)] bg-[var(--badge-success-bg)] text-[var(--badge-success-text)]',
    warning: 'border-[var(--badge-warning-border)] bg-[var(--badge-warning-bg)] text-[var(--badge-warning-text)]',
    error: 'border-[var(--badge-danger-border)] bg-[var(--badge-danger-bg)] text-[var(--badge-danger-text)]',
  };

  const icons = {
    info: <Info className="size-4 shrink-0 mt-0.5" />,
    success: <CheckCircle2 className="size-4 shrink-0 mt-0.5" />,
    warning: <AlertTriangle className="size-4 shrink-0 mt-0.5" />,
    error: <AlertCircle className="size-4 shrink-0 mt-0.5" />,
  };

  return (
    <div
      role="alert"
      className={cn('flex items-start gap-2.5 p-3 rounded-[var(--radius-sm)] border text-xs leading-normal', variantStyles[variant], className)}
    >
      {icons[variant]}
      <div className="flex-1 min-w-0">
        {title && <strong className="font-semibold block mb-0.5">{title}</strong>}
        <div>{children}</div>
      </div>
    </div>
  );
}

export interface StatePanelProps {
  state: 'loading' | 'ready' | 'empty' | 'error' | 'denied';
  children: React.ReactNode;
  loadingProps?: LoadingStateProps;
  emptyProps?: EmptyStateProps;
  errorProps?: ErrorStateProps;
  deniedProps?: DeniedStateProps;
}

/**
 * Universal StatePanel wrapper handling the 5 contract screen states.
 */
export function StatePanel({
  state,
  children,
  loadingProps,
  emptyProps,
  errorProps,
  deniedProps,
}: StatePanelProps) {
  switch (state) {
    case 'loading':
      return <LoadingState {...loadingProps} />;
    case 'empty':
      return <EmptyState {...emptyProps} />;
    case 'error':
      return <ErrorState {...errorProps} />;
    case 'denied':
      return <DeniedState {...deniedProps} />;
    case 'ready':
    default:
      return <>{children}</>;
  }
}
