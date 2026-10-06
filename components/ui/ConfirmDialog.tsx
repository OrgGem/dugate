'use client';

import * as React from 'react';
import { AlertTriangle, Trash2, HelpCircle } from 'lucide-react';
import { Modal } from './Modal';
import { Button } from './Button';

export interface ConfirmDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
  title: string;
  description: string;
  confirmText?: string;
  cancelText?: string;
  isDestructive?: boolean;
  isLoading?: boolean;
}

export function ConfirmDialog({
  isOpen,
  onClose,
  onConfirm,
  title,
  description,
  confirmText = 'Xác nhận',
  cancelText = 'Hủy',
  isDestructive = false,
  isLoading = false,
}: ConfirmDialogProps) {
  const [internalLoading, setInternalLoading] = React.useState(false);

  const handleConfirm = async () => {
    try {
      setInternalLoading(true);
      await onConfirm();
      onClose();
    } finally {
      setInternalLoading(false);
    }
  };

  const loading = isLoading || internalLoading;

  return (
    <Modal
      isOpen={isOpen}
      onClose={loading ? () => {} : onClose}
      size="sm"
      closeOnOutsideClick={!loading}
      icon={
        isDestructive ? (
          <div className="p-2 rounded-xl bg-destructive/10 text-destructive">
            <Trash2 className="w-5 h-5" />
          </div>
        ) : (
          <div className="p-2 rounded-xl bg-primary/10 text-primary">
            <HelpCircle className="w-5 h-5" />
          </div>
        )
      }
      title={title}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={loading}>
            {cancelText}
          </Button>
          <Button
            variant={isDestructive ? 'destructive' : 'primary'}
            onClick={handleConfirm}
            isLoading={loading}
          >
            {confirmText}
          </Button>
        </>
      }
    >
      <p className="text-sm text-muted-foreground leading-relaxed">{description}</p>
    </Modal>
  );
}
