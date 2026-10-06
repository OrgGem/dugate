import * as React from 'react';
import { Dialog as BaseDialog } from '@base-ui/react';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from './button';

export const DialogRoot = BaseDialog.Root;
export const DialogTrigger = BaseDialog.Trigger;
export const DialogPortal = BaseDialog.Portal;
export const DialogClose = BaseDialog.Close;

export const DialogBackdrop = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof BaseDialog.Backdrop>
>(({ className, ...props }, ref) => (
  <BaseDialog.Backdrop
    ref={ref}
    className={cn(
      'fixed inset-0 z-50 bg-[var(--bg-backdrop)] backdrop-blur-xs transition-opacity duration-150 animate-in fade-in',
      className
    )}
    {...props}
  />
));
DialogBackdrop.displayName = 'DialogBackdrop';

export const DialogPopup = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof BaseDialog.Popup>
>(({ className, children, ...props }, ref) => (
  <BaseDialog.Popup
    ref={ref}
    className={cn(
      'fixed left-[50%] top-[50%] z-50 grid w-full max-w-lg translate-x-[-50%] translate-y-[-50%] gap-4 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-card)] p-6 text-[var(--text-main)] shadow-[var(--shadow-pop)] duration-150 animate-in fade-in zoom-in-95',
      'max-h-[90vh] overflow-y-auto w-[calc(100vw-2rem)] sm:w-full',
      className
    )}
    {...props}
  >
    {children}
  </BaseDialog.Popup>
));
DialogPopup.displayName = 'DialogPopup';

export const DialogTitle = React.forwardRef<
  HTMLHeadingElement,
  React.ComponentPropsWithoutRef<typeof BaseDialog.Title>
>(({ className, ...props }, ref) => (
  <BaseDialog.Title
    ref={ref}
    className={cn('text-lg font-semibold leading-none tracking-tight text-[var(--text-main)]', className)}
    {...props}
  />
));
DialogTitle.displayName = 'DialogTitle';

export const DialogDescription = React.forwardRef<
  HTMLParagraphElement,
  React.ComponentPropsWithoutRef<typeof BaseDialog.Description>
>(({ className, ...props }, ref) => (
  <BaseDialog.Description
    ref={ref}
    className={cn('text-sm text-[var(--text-sub)] leading-normal', className)}
    {...props}
  />
));
DialogDescription.displayName = 'DialogDescription';

export function DialogHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex flex-col space-y-1.5 text-left', className)} {...props} />;
}

export function DialogBody({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('py-2 text-sm text-[var(--text-main)] min-w-0', className)} {...props} />;
}

export function DialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2 gap-2 pt-2', className)}
      {...props}
    />
  );
}

export interface ModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  maxWidth?: string;
  showCloseButton?: boolean;
}

/**
 * Composite Modal primitive built on top of Base UI Dialog.
 * Enforces focus trap, ESC dismissal, accessible title/desc, and focus restoration.
 */
export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  maxWidth = 'max-w-lg',
  showCloseButton = true,
}: ModalProps) {
  return (
    <DialogRoot open={open} onOpenChange={onOpenChange}>
      <DialogPortal>
        <DialogBackdrop />
        <DialogPopup className={maxWidth}>
          <div className="flex items-start justify-between gap-4">
            <DialogHeader className="flex-1">
              <DialogTitle>{title}</DialogTitle>
              {description && <DialogDescription>{description}</DialogDescription>}
            </DialogHeader>
            {showCloseButton && (
              <DialogClose
                className="rounded-[var(--radius-sm)] p-1 text-[var(--text-sub)] opacity-70 transition-opacity hover:opacity-100 hover:bg-[var(--bg-hover)] focus:outline-none focus:ring-2 focus:ring-[var(--focus-ring)]"
                aria-label="Close dialog"
              >
                <X className="size-4" aria-hidden="true" />
              </DialogClose>
            )}
          </div>

          <DialogBody>{children}</DialogBody>

          {footer && <DialogFooter>{footer}</DialogFooter>}
        </DialogPopup>
      </DialogPortal>
    </DialogRoot>
  );
}

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
  description: React.ReactNode;
  confirmText?: string;
  cancelText?: string;
  variant?: 'primary' | 'destructive';
  isLoading?: boolean;
  onConfirm: () => void;
  onCancel?: () => void;
}

/**
 * Accessible ConfirmDialog to replace native window.confirm calls in admin operations.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  variant = 'primary',
  isLoading = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const handleCancel = () => {
    if (onCancel) onCancel();
    onOpenChange(false);
  };

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      maxWidth="max-w-md"
      footer={
        <>
          <Button variant="secondary" onClick={handleCancel} disabled={isLoading}>
            {cancelText}
          </Button>
          <Button
            variant={variant === 'destructive' ? 'destructive' : 'primary'}
            onClick={onConfirm}
            isLoading={isLoading}
          >
            {confirmText}
          </Button>
        </>
      }
    >
      <div className="py-2" />
    </Modal>
  );
}
