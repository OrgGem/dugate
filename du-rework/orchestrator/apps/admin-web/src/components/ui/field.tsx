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
  /** Explicitly associate the visible label with this control in a grouped field. */
  primaryControlId?: string;
  label?: React.ReactNode;
  description?: React.ReactNode;
  error?: React.ReactNode;
  required?: boolean;
  /** Reserve one line for a validation message to avoid shifting nearby controls. */
  reserveErrorSpace?: boolean;
  className?: string;
  children: React.ReactNode;
}

const FORM_CONTROL_TAGS = new Set(['input', 'select', 'textarea', 'button']);
const FORM_CONTROL_COMPONENTS = new Set(['Input', 'ReferenceInput', 'NativeSelect', 'SelectTrigger']);

type FormControlElement = React.ReactElement<Record<string, unknown>>;

function isFormControlElement(child: React.ReactElement): child is FormControlElement {
  if (typeof child.type === 'string') return FORM_CONTROL_TAGS.has(child.type);

  const componentType = child.type as { displayName?: string; name?: string };
  return FORM_CONTROL_COMPONENTS.has(componentType.displayName ?? componentType.name ?? '');
}

function collectFormControls(children: React.ReactNode): FormControlElement[] {
  const controls: FormControlElement[] = [];

  React.Children.forEach(children, (child) => {
    if (!React.isValidElement(child)) return;

    if (child.type === React.Fragment) {
      controls.push(...collectFormControls((child.props as { children?: React.ReactNode }).children));
      return;
    }

    if (isFormControlElement(child)) {
      controls.push(child);
      return;
    }

    if (typeof child.type === 'string') {
      controls.push(...collectFormControls((child.props as { children?: React.ReactNode }).children));
    }
  });

  return controls;
}

function mapFormControls(
  children: React.ReactNode,
  mapControl: (control: FormControlElement, index: number) => FormControlElement
): React.ReactNode {
  let controlIndex = 0;

  function mapNested(nodes: React.ReactNode): React.ReactNode {
    return React.Children.map(nodes, (child) => {
      if (!React.isValidElement(child)) return child;

      if (child.type === React.Fragment) {
        const fragment = child as React.ReactElement<{ children?: React.ReactNode }>;
        return React.cloneElement(fragment, undefined, mapNested(fragment.props.children));
      }

      if (isFormControlElement(child)) return mapControl(child, controlIndex++);

      if (typeof child.type === 'string') {
        const wrapper = child as React.ReactElement<{ children?: React.ReactNode }>;
        if (wrapper.props.children !== undefined) {
          return React.cloneElement(wrapper, undefined, mapNested(wrapper.props.children));
        }
      }

      return child;
    });
  }

  return mapNested(children);
}

/**
 * Composite FormField wrapper providing structured a11y, labeling, helper description, and error display.
 */
export function FormField({
  id,
  primaryControlId,
  label,
  description,
  error,
  required,
  reserveErrorSpace = false,
  className,
  children,
}: FormFieldProps) {
  const generatedId = React.useId();
  const controls = collectFormControls(children);
  const requestedPrimaryId = primaryControlId || id;
  const requestedPrimaryIndex = requestedPrimaryId
    ? controls.findIndex((control) => (control.props as { id?: unknown }).id === requestedPrimaryId)
    : -1;
  const hasExistingControlId = controls.some((control) => {
    const controlId = (control.props as { id?: unknown }).id;
    return typeof controlId === 'string' && controlId.length > 0;
  });
  const existingPrimaryIndex = controls.findIndex((control) => {
    const controlId = (control.props as { id?: unknown }).id;
    return typeof controlId === 'string' && controlId.length > 0;
  });
  const requestedPrimaryCanBeAssigned = Boolean(requestedPrimaryId) && !hasExistingControlId;
  const isControlGroup = controls.length > 1 && requestedPrimaryIndex < 0 && !requestedPrimaryCanBeAssigned;
  const primaryControlIndex = isControlGroup
    ? -1
    : requestedPrimaryIndex >= 0
      ? requestedPrimaryIndex
      : existingPrimaryIndex >= 0
        ? existingPrimaryIndex
        : controls.length > 0
          ? 0
          : -1;
  const primaryControl = primaryControlIndex >= 0 ? controls[primaryControlIndex] : undefined;
  const existingPrimaryId = (primaryControl?.props as { id?: unknown } | undefined)?.id;
  const fieldId = (typeof existingPrimaryId === 'string' && existingPrimaryId.length > 0
    ? existingPrimaryId
    : primaryControlIndex >= 0 ? requestedPrimaryId : id) || generatedId;
  const descriptionId = description ? `${fieldId}-desc` : undefined;
  const errorId = error ? `${fieldId}-err` : undefined;

  const content = mapFormControls(children, (control, index) => {
    const childProps = control.props as Record<string, unknown>;
    const existingDescribedBy =
      typeof childProps['aria-describedby'] === 'string' ? childProps['aria-describedby'] : undefined;
    const describedByParts = [existingDescribedBy, descriptionId, errorId].filter(Boolean);
    const combinedDescribedBy = describedByParts.length > 0 ? describedByParts.join(' ') : undefined;
    const existingControlId = typeof childProps.id === 'string' ? childProps.id : undefined;
    const existingAriaRequired = childProps['aria-required'];
    const ariaRequired = existingAriaRequired !== undefined
      ? existingAriaRequired
      : required && !isControlGroup && index === primaryControlIndex
        ? true
        : undefined;

    return React.cloneElement(control, {
      id: existingControlId || (index === primaryControlIndex ? fieldId : undefined),
      'aria-describedby': combinedDescribedBy,
      'aria-invalid': error ? true : childProps['aria-invalid'],
      'aria-errormessage': error ? errorId : childProps['aria-errormessage'],
      'aria-required': ariaRequired,
    });
  });

  const rootClassName = cn('flex flex-col gap-1.5 w-full min-w-0', className);
  const labelClassName = 'text-xs font-semibold text-[var(--text-main)] select-none flex items-center gap-1';
  const requiredMark = required ? (
    <span className="text-[var(--badge-danger-text)] font-bold" aria-hidden="true">
      *
    </span>
  ) : null;
  const messageContent = (
    <>
      <div className="w-full min-w-0">{content}</div>

      {description && (
        <p id={descriptionId} className="min-w-0 break-words text-xs text-[var(--text-sub)] leading-normal">
          {description}
        </p>
      )}

      {(error || reserveErrorSpace) && (
        <p
          id={errorId}
          role={error ? 'alert' : undefined}
          aria-live={error ? 'polite' : undefined}
          aria-hidden={!error ? true : undefined}
          className={cn(
            'min-w-0 break-words text-xs font-medium leading-4 text-[var(--badge-danger-text)]',
            reserveErrorSpace && 'min-h-4'
          )}
        >
          {error || (reserveErrorSpace ? '\u00a0' : null)}
        </p>
      )}
    </>
  );

  if (isControlGroup) {
    return (
      <fieldset className={cn(rootClassName, 'm-0 border-0 p-0')}>
        {label && (
          <legend className={cn(labelClassName, 'p-0')}>
            {label}
            {requiredMark}
            {required && <span className="sr-only"> (required)</span>}
          </legend>
        )}
        {messageContent}
      </fieldset>
    );
  }

  return (
    <div className={rootClassName}>
      {label && (
        <label
          htmlFor={fieldId}
          className={labelClassName}
        >
          {label}
          {requiredMark}
        </label>
      )}
      {messageContent}
    </div>
  );
}
