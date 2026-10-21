// ===== Общие UI-хелперы =====
import { useEffect, useRef, useState } from 'react';

/** Числовое поле для редактирования прямо в ячейке. Пустое значение = null. */
export function NumCell({
  value, onCommit, className, title, disabled, placeholder, min, step,
}: {
  value: number | null | undefined;
  onCommit: (v: number | null) => void;
  className?: string;
  title?: string;
  disabled?: boolean;
  placeholder?: string;
  min?: number;
  step?: number | string;
}) {
  const [text, setText] = useState(value === null || value === undefined ? '' : String(value));
  const focusedRef = useRef(false);
  useEffect(() => {
    if (!focusedRef.current) {
      setText(value === null || value === undefined ? '' : formatEditable(value));
    }
  }, [value]);

  return (
    <input
      className={`cell-input ${className ?? ''}`}
      type="number"
      inputMode="decimal"
      step={step ?? 'any'}
      min={min}
      title={title}
      disabled={disabled}
      placeholder={placeholder}
      value={text}
      onFocus={() => { focusedRef.current = true; }}
      onChange={(e) => {
        setText(e.target.value);
        const v = e.target.value.trim();
        if (v === '') onCommit(null);
        else {
          const n = Number(v);
          if (Number.isFinite(n)) onCommit(n);
        }
      }}
      onBlur={() => {
        focusedRef.current = false;
        const v = text.trim();
        if (v === '') onCommit(null);
        else {
          const n = Number(v);
          onCommit(Number.isFinite(n) ? n : (value ?? null));
        }
        setText(v === '' ? '' : String(Number(text)));
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
      }}
    />
  );
}

function formatEditable(v: number): string {
  if (Number.isInteger(v)) return String(v);
  return String(Math.round(v * 10000) / 10000);
}

/** Текстовое поле ячейки */
export function TextCell({
  value, onCommit, className, placeholder,
}: {
  value: string;
  onCommit: (v: string) => void;
  className?: string;
  placeholder?: string;
}) {
  const [text, setText] = useState(value);
  const focusedRef = useRef(false);
  useEffect(() => {
    if (!focusedRef.current) setText(value);
  }, [value]);
  return (
    <input
      className={`cell-input text ${className ?? ''}`}
      value={text}
      placeholder={placeholder}
      onFocus={() => { focusedRef.current = true; }}
      onChange={(e) => { setText(e.target.value); }}
      onBlur={() => { focusedRef.current = false; onCommit(text); }}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
    />
  );
}

export function useDialog() {
  const ref = useRef<HTMLDialogElement>(null);
  return {
    ref,
    open: () => ref.current?.showModal(),
    close: () => ref.current?.close(),
  };
}
