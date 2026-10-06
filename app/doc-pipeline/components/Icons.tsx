// app/doc-pipeline/components/Icons.tsx
// Standardized Lucide Icon components with backward compatibility

import React from 'react';
import { Loader2, Check, UploadCloud, X, AlertTriangle } from 'lucide-react';

export function SpinnerIcon({ className }: { className?: string }) {
  return <Loader2 className={`animate-spin ${className || 'w-5 h-5'}`} aria-hidden="true" />;
}

export function CheckIcon({ className }: { className?: string }) {
  return <Check className={className || 'w-5 h-5'} aria-hidden="true" />;
}

export function UploadCloudIcon({ className }: { className?: string }) {
  return <UploadCloud className={className || 'w-12 h-12'} aria-hidden="true" />;
}

export function XIcon({ className }: { className?: string }) {
  return <X className={className || 'w-4 h-4'} aria-hidden="true" />;
}

export function AlertTriangleIcon({ className }: { className?: string }) {
  return <AlertTriangle className={className || 'w-5 h-5'} aria-hidden="true" />;
}
