// "Link by bill number": the admin's override for any bill the candidates don't offer (one already taken,
// a pair unlinked before, or one outside the dates). 1 to 7 digits, checked here before it is sent.
import { type FormEvent, useId, useState } from 'react';
import { BILL_NO } from '../lib/format';

type Props = {
  /** Sends the link; true when it went through (the box then clears). */
  onLink(invoiceNo: string): Promise<boolean>;
  disabled?: boolean;
};

export function LinkByNumber({ onLink, disabled = false }: Props) {
  const id = useId();
  const [value, setValue] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  async function submit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    const no = value.trim();
    if (!BILL_NO.test(no)) {
      setProblem('A bill number is 1 to 7 digits.');
      return;
    }
    setProblem(null);
    if (await onLink(no)) setValue('');
  }

  return (
    <form className="inline-form" onSubmit={(e) => void submit(e)} noValidate>
      <label htmlFor={`${id}-no`}>Link by bill number</label>
      <input
        id={`${id}-no`}
        inputMode="numeric"
        autoComplete="off"
        maxLength={7}
        size={9}
        value={value}
        aria-invalid={problem ? true : undefined}
        aria-describedby={problem ? `${id}-problem` : undefined}
        onChange={(e) => setValue(e.target.value)}
      />
      <button type="submit" disabled={disabled}>
        Link bill
      </button>
      {problem && (
        <p id={`${id}-problem`} className="error" role="alert">
          {problem}
        </p>
      )}
    </form>
  );
}
