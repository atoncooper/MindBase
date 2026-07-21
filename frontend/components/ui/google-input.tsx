"use client";

import type { ReactNode } from "react";

interface GoogleInputProps {
  id: string;
  label: string;
  type: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete?: string;
  autoFocus?: boolean;
  trailing?: ReactNode;
  required?: boolean;
  name?: string;
}

/**
 * Material-style outlined text field with a floating label.
 * Uses --gemini-* CSS variables so it adapts to light/dark themes.
 */
export function GoogleInput({
  id,
  label,
  type,
  value,
  onChange,
  autoComplete,
  autoFocus,
  trailing,
  required,
  name,
}: GoogleInputProps) {
  return (
    <div className="relative w-full">
      <input
        id={id}
        name={name}
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder=" "
        autoComplete={autoComplete}
        autoFocus={autoFocus}
        required={required}
        className="peer h-[58px] w-full rounded border border-[var(--gemini-border)] bg-[var(--gemini-surface)] text-base text-[var(--gemini-text-primary)] outline-none transition-colors hover:border-[var(--gemini-text-secondary)] focus:border-2 focus:border-[var(--gemini-primary)] disabled:bg-[var(--gemini-surface-variant)]"
        style={{ padding: trailing ? "12px 56px 0 16px" : "12px 16px 0" }}
      />
      <label
        htmlFor={id}
        className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 bg-[var(--gemini-surface)] text-base text-[var(--gemini-text-secondary)] transition-all duration-150 peer-focus:left-3 peer-focus:top-0 peer-focus:text-xs peer-focus:font-medium peer-focus:text-[var(--gemini-primary)] peer-[:not(:placeholder-shown)]:left-3 peer-[:not(:placeholder-shown)]:top-0 peer-[:not(:placeholder-shown)]:text-xs"
        style={{ padding: "0 4px" }}
      >
        {label}
      </label>
      {trailing && <div className="absolute right-2 top-1/2 -translate-y-1/2">{trailing}</div>}
    </div>
  );
}

export function EyeIcon({ open }: { open: boolean }) {
  return open ? (
    <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z" />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
    </svg>
  ) : (
    <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M3.98 8.223A10.477 10.477 0 001.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.45 10.45 0 0112 4.5c4.756 0 8.773 3.162 10.065 7.498a10.523 10.523 0 01-4.293 5.774M6.228 6.228L3 3m3.228 3.228l3.65 3.65m7.894 7.894L21 21m-3.228-3.228l-3.65-3.65m0 0a3 3 0 10-4.243-4.243m4.242 4.242L9.88 9.88" />
    </svg>
  );
}
