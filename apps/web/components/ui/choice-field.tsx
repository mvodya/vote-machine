import type {ReactNode} from 'react';
import {SelectionInput} from './selection-input';

// Keep rich answer content separate from the native selection control
export function ChoiceField({
  id,
  label,
  multiple,
  checked,
  disabled,
  dimDisabled,
  onChange,
  children,
}: {
  // Stable control ID and accessible label
  id: string;
  label: string;
  // Use checkboxes for a multiple-choice question
  multiple: boolean;
  // Current selection and write state
  checked: boolean;
  disabled: boolean;
  // Keep temporary save locks visually still
  dimDisabled?: boolean;
  // Change the selected option
  onChange: () => void;
  // Safe Markdown content
  children: ReactNode;
}) {
  return (
    <div
      className={`flex items-start gap-3 rounded-xl border p-4 ${checked ? 'border-ink bg-accent/60' : 'border-border'}`}
    >
      <SelectionInput
        id={id}
        aria-label={label}
        name="question-choice"
        type={multiple ? 'checkbox' : 'radio'}
        checked={checked}
        disabled={disabled}
        dimDisabled={dimDisabled}
        onChange={onChange}
        className="mt-[calc(0.75rem+0.25rem)] size-5"
      />
      <div className="min-w-0 flex-1">
        <label htmlFor={id} className="block cursor-pointer">
          {children}
        </label>
      </div>
    </div>
  );
}
