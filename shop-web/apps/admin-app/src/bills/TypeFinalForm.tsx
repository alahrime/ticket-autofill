// "Type the final bill": InvoMax's numbers typed by hand when its bill can't be linked. Dollars to the cent;
// the total must be parts + labor + supplies + tax (InvoMax's own rule, without a discount), checked here first.
import { type FormEvent, useId, useState } from 'react';
import { BILL_NO, cents, money } from '../lib/format';
import type { FinalMoney } from './useBillChanges';

const FIELDS = [
  ['parts', 'Parts'],
  ['labor', 'Labor'],
  ['supplies', 'Supplies'],
  ['tax', 'Tax'],
  ['total', 'Total'],
] as const;
type Field = (typeof FIELDS)[number][0];

type Props = {
  /** Sends it; true when it went through. */
  onSave(final: FinalMoney): Promise<boolean>;
  onCancel(): void;
  disabled?: boolean;
  id?: string;
};

const empty = (): Record<Field, string> => ({ parts: '', labor: '', supplies: '', tax: '', total: '' });

/** The form's values as the API takes them, or what is wrong with them. */
export function checkFinal(invoiceNo: string, values: Record<Field, string>): FinalMoney | string {
  const no = invoiceNo.trim();
  if (no && !BILL_NO.test(no)) return 'A bill number is 1 to 7 digits (or leave it blank).';
  const c = {} as Record<Field, number>;
  for (const [field, label] of FIELDS) {
    const v = cents(values[field] || '0');
    if (v === null) return `${label} must be dollars and cents, like 120.50.`;
    c[field] = v;
  }
  const sum = c.parts + c.labor + c.supplies + c.tax;
  if (c.total !== sum) return `Total must be parts + labor + supplies + tax (${money(sum / 100)}).`;
  const dollars = (n: number): number => n / 100;
  return {
    ...(no ? { invoice_no: no } : {}),
    parts: dollars(c.parts),
    labor: dollars(c.labor),
    supplies: dollars(c.supplies),
    tax: dollars(c.tax),
    total: dollars(c.total),
  };
}

export function TypeFinalForm({ onSave, onCancel, disabled = false, id }: Props) {
  const uid = useId();
  const [invoiceNo, setInvoiceNo] = useState('');
  const [values, setValues] = useState(empty);
  const [problem, setProblem] = useState<string | null>(null);

  async function submit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    const checked = checkFinal(invoiceNo, values);
    if (typeof checked === 'string') {
      setProblem(checked);
      return;
    }
    setProblem(null);
    await onSave(checked);
  }

  return (
    <form id={id} className="final-form" aria-label="Type the final bill" onSubmit={(e) => void submit(e)} noValidate>
      <div className="field">
        <label htmlFor={`${uid}-no`}>Bill number (optional)</label>
        <input
          id={`${uid}-no`}
          inputMode="numeric"
          autoComplete="off"
          maxLength={7}
          value={invoiceNo}
          onChange={(e) => setInvoiceNo(e.target.value)}
        />
      </div>
      {FIELDS.map(([field, label]) => (
        <div className="field" key={field}>
          <label htmlFor={`${uid}-${field}`}>{label}</label>
          <input
            id={`${uid}-${field}`}
            inputMode="decimal"
            autoComplete="off"
            placeholder="0.00"
            value={values[field]}
            onChange={(e) => setValues((v) => ({ ...v, [field]: e.target.value }))}
          />
        </div>
      ))}
      {problem && (
        <p className="error" role="alert">
          {problem}
        </p>
      )}
      <div className="actions">
        <button type="submit" className="primary" disabled={disabled}>
          Save final bill
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
