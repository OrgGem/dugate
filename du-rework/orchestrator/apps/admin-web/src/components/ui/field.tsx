import * as React from 'react';
import { Field as BaseField } from '@base-ui/react';
import { cn } from '@/lib/utils';

export interface FieldRootProps extends React.ComponentPropsWithoutRef<typeof BaseField.Root> {}
export const FieldRoot = React.forwardRef<HTMLDivElement, FieldRootProps>(({ className, ...props }, ref) => (
  <BaseField.Root ref={ref} className={cn('flex flex-col gap-1.5 w-full min-w-0', className)} {...props} />
));
FieldRoot.displayName = 'FieldRoot';

export interface FieldLabelProps extends React.ComponentPropsWithoutRef<typeof BaseField.Label> {
  required?: boolean;
}
export const FieldLabel = React.forwardRef<HTMLLabelElement, FieldLabelProps>(
  ({ className, required, children, ...props }, ref) => (
    <BaseField.Label
      ref={ref}
      className={cn('text-xs font-semibold text-[var(--text-main)] select-none flex items-center gap-1', className)}
      {...props}
    >
      {children}
      {required && (
        <span className="text-[var(--badge-danger-text)] font-bold" aria-hidden="true">
          *
        </span>
      )}
    </BaseField.Label>
  )
);
FieldLabel.displayName = 'FieldLabel';

export interface FieldDescriptionProps extends React.ComponentPropsWithoutRef<typeof BaseField.Description> {}
export const FieldDescription = React.forwardRef<HTMLParagraphElement, FieldDescriptionProps>(
  ({ className, ...props }, ref) => (
    <BaseField.Description
      ref={ref}
      className={cn('text-xs text-[var(--text-sub)] leading-normal', className)}
      {...props}
    />
  )
);
FieldDescription.displayName = 'FieldDescription';

export interface FieldErrorProps extends React.ComponentPropsWithoutRef<typeof BaseField.Error> {}
export const FieldError = React.forwardRef<HTMLParagraphElement, FieldErrorProps>(
  ({ className, children, ...props }, ref) => (
    <BaseField.Error
      ref={ref}
      className={cn('text-xs font-medium text-[var(--badge-danger-text)] flex items-center gap-1', className)}
      {...props}
    >
      {children}
    </BaseField.Error>
  )
);
FieldError.displayName = 'FieldError';

export interface FormFieldProps {
  id?: string;
  label?: React.ReactNode;
  description?: React.ReactNode;
  error?: React.ReactNode;
  required?: boolean;
  className?: string;
  children: React.ReactNode;
}

/**
 * Composite FormField wrapper providing structured a11y, labeling, helper description, and error display.
 */
export function FormField({
  id,
  label,
  description,
  error,
  required,
  className,
  children,
}: FormFieldProps) {
  const generatedId = React.useId();
  const fieldId = id || generatedId;
  const descriptionId = description ? `${fieldId}-desc` : undefined;
  const errorId = error ? `${fieldId}-err` : undefined;

  let content = children;
  if (React.isValidElement(children)) {
    const childProps = children.props as Record<string, unknown>;
    const existingDescribedBy =
      typeof childProps['aria-describedby'] === 'string' ? childProps['aria-describedby'] : undefined;
    const describedByParts = [existingDescribedBy, descriptionId, errorId].filter(Boolean);
    const combinedDescribedBy = describedByParts.length > 0 ? describedByParts.join(' ') : undefined;

    content = React.cloneElement(children as React.ReactElement<Record<string, unknown>>, {
      id: childProps.id || fieldId,
      'aria-describedby': combinedDescribedBy,
      'aria-invalid': error ? true : childProps['aria-invalid'],
      'aria-errormessage': error ? errorId : childProps['aria-errormessage'],
    });
  }

  return (
    <div className={cn('flex flex-col gap-1.5 w-full min-w-0', className)}>
      {label && (
        <label
          htmlFor={fieldId}
          className="text-xs font-semibold text-[var(--text-main)] select-none flex items-center gap-1"
        >
          {label}
          {required && (
            <span className="text-[var(--badge-danger-text)] font-bold" aria-hidden="true">
              *
            </span>
          )}
        </label>
      )}

      <div className="w-full min-w-0">{content}</div>

      {description && (
        <p id={descriptionId} className="text-xs text-[var(--text-sub)] leading-normal">
          {description}
        </p>
      )}

      {error && (
        <p
          id={errorId}
          role="alert"
          aria-live="polite"
          className="text-xs font-medium text-[var(--badge-danger-text)] flex items-center gap-1"
        >
          {error}
        </p>
      )}
    </div>
  );
}
