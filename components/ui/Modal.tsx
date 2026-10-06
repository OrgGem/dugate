'use client';

import * as React from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

export type ModalSize = 'sm' | 'md' | 'lg' | 'xl' | 'full';

export interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  description?: React.ReactNode;
  icon?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  size?: ModalSize;
  className?: string;
  closeOnOutsideClick?: boolean;
}

const modalSizes: Record<ModalSize, string> = {
  sm: 'max-w-md',
  md: 'max-w-lg',
  lg: 'max-w-2xl',
  xl: 'max-w-4xl',
  full: 'max-w-6xl',
};

export function Modal({
  isOpen,
  onClose,
  title,
  description,
  icon,
  children,
  footer,
  size = 'md',
  className,
  closeOnOutsideClick = true,
}: ModalProps) {
  const [mounted, setMounted] = React.useState(false);

  React.useEffect(() => {
    setMounted(true);
  }, []);

  React.useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };

    document.addEventListener('keydown', handleKeyDown);
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = 'unset';
    };
  }, [isOpen, onClose]);

  if (!mounted || !isOpen) return null;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs animate-in fade-in duration-200"
      onClick={closeOnOutsideClick ? onClose : undefined}
    >
      <div
        className={cn(
          'relative w-full rounded-2xl border border-border bg-card shadow-2xl text-foreground',
          'flex flex-col max-h-[90vh] overflow-hidden animate-in zoom-in-95 duration-200',
          modalSizes[size],
          className
        )}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        {(title || icon) && (
          <div className="flex items-start justify-between p-6 pb-4 border-b border-border/50 shrink-0">
            <div className="flex items-center gap-3">
              {icon && <div className="text-primary">{icon}</div>}
              <div>
                {title && <h2 className="text-lg font-bold text-foreground leading-tight">{title}</h2>}
                {description && <p className="text-xs text-muted-foreground mt-1">{description}</p>}
              </div>
            </div>
            <button
              onClick={onClose}
              className="p-1 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              aria-label="Đóng"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        )}

        {/* Content */}
        <div className="p-6 overflow-y-auto flex-1">{children}</div>

        {/* Footer */}
        {footer && (
          <div className="flex items-center justify-end gap-3 p-4 px-6 border-t border-border/50 bg-muted/20 shrink-0">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}
