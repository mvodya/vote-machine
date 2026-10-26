import type {ComponentProps} from 'react';

// Use the same spacing in all forms
export function Form({className = '', ...props}: ComponentProps<'form'>) {
  return <form className={`min-w-0 space-y-5 ${className}`} {...props} />;
}
