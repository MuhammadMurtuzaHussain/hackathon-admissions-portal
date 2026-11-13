'use client';

import { useFormStatus } from 'react-dom';

/** Disables itself the moment the form is sent, so a double click sends one request. */
export function SubmitButton({ children, className = 'btn btn-primary', pendingLabel = 'Working…', ...rest }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className={className} disabled={pending} aria-busy={pending} {...rest}>
      {pending ? pendingLabel : children}
    </button>
  );
}
