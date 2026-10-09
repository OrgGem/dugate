import { Component, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

type ToastVariant = 'success' | 'error';

interface ToastMessage {
  id: number;
  variant: ToastVariant;
  message: string;
}

interface ToastContextValue {
  success(message: string): void;
  error(message: string): void;
}

interface ToastProviderProps {
  children: ReactNode;
}

interface ToastViewportProps {
  items: ToastMessage[];
  onDismiss(id: number): void;
}

interface ToastItemProps {
  item: ToastMessage;
  onDismiss(id: number): void;
}

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  errorMessage: string | null;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: ToastProviderProps) {
  const [items, setItems] = useState<ToastMessage[]>([]);
  const nextId = useRef(0);

  const push = useCallback((variant: ToastVariant, message: string) => {
    const content = message.trim();
    if (content.length === 0) return;
    const id = ++nextId.current;
    setItems((current) => [...current, { id, variant, message: content }]);
  }, []);
  const dismiss = useCallback((id: number) => {
    setItems((current) => current.filter((item) => item.id !== id));
  }, []);
  const value = useMemo<ToastContextValue>(() => ({
    success: (message) => push('success', message),
    error: (message) => push('error', message),
  }), [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastViewport items={items} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (context === null) throw new Error('useToast must be used within ToastProvider');
  return context;
}

export function ToastViewport({ items, onDismiss }: ToastViewportProps) {
  if (items.length === 0) return null;
  return (
    <aside aria-label="Notifications" className="fixed right-4 top-4 z-[100] flex w-[calc(100vw-2rem)] max-w-sm flex-col gap-2">
      {items.map((item) => <ToastItem key={item.id} item={item} onDismiss={onDismiss} />)}
    </aside>
  );
}

function ToastItem({ item, onDismiss }: ToastItemProps) {
  useEffect(() => {
    const timeout = window.setTimeout(() => onDismiss(item.id), item.variant === 'error' ? 8000 : 5000);
    return () => window.clearTimeout(timeout);
  }, [item.id, item.variant, onDismiss]);

  const isError = item.variant === 'error';
  return (
    <div
      role={isError ? 'alert' : 'status'}
      className={`flex items-start justify-between gap-3 rounded-[var(--radius-md)] border bg-[var(--bg-card)] px-4 py-3 text-sm shadow-[var(--shadow-card)] ${isError ? 'border-red-400' : 'border-emerald-400'}`}
    >
      <p className="m-0">{item.message}</p>
      <button type="button" aria-label="Dismiss notification" className="shrink-0 font-semibold" onClick={() => onDismiss(item.id)}>
        Dismiss
      </button>
    </div>
  );
}

export class GlobalErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { hasError: false, errorMessage: null };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { hasError: true, errorMessage: errorMessageOf(error) };
  }

  override render() {
    if (this.state.hasError) {
      return (
        <main role="alert" className="min-h-screen bg-[var(--bg-page)] p-6 text-[var(--text-main)]">
          <section className="mx-auto mt-12 max-w-2xl rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-card)] p-6 shadow-[var(--shadow-card)]">
            <h1 className="m-0 text-xl font-semibold">Portal unavailable</h1>
            <p className="mb-0 mt-3 break-words">{this.state.errorMessage ?? 'Unavailable'}</p>
          </section>
        </main>
      );
    }
    return this.props.children;
  }
}

function errorMessageOf(error: unknown): string | null {
  if (typeof error === 'string') return error.trim() || null;
  if (typeof error !== 'object' || error === null || !('message' in error)) return null;
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' ? message.trim() || null : null;
}
