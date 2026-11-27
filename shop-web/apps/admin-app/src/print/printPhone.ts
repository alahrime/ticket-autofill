// Phone numbers on the printed bill: (703) 522-3100, however the number was typed.

/** 10 digits (or 11 with a leading 1) as (AAA) BBB-CCCC; anything else as typed, trimmed. */
export function printPhone(text: string): string {
  let d = text.replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('1')) d = d.slice(1);
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : text.trim();
}
