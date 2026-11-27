import { describe, expect, it } from 'vitest';
import { printPhone } from './printPhone';

describe('printPhone', () => {
  it('spaces a 10-digit number however it was typed', () => {
    expect(printPhone('(703)522-3100')).toBe('(703) 522-3100');
    expect(printPhone('703.522.3100')).toBe('(703) 522-3100');
    expect(printPhone('7035223100')).toBe('(703) 522-3100');
  });

  it('drops a leading 1 from 11 digits', () => {
    expect(printPhone('1-703-522-3100')).toBe('(703) 522-3100');
  });

  it('anything else prints as typed, trimmed', () => {
    expect(printPhone(' 5220 ')).toBe('5220');
    expect(printPhone('')).toBe('');
    expect(printPhone('2-703-522-3100')).toBe('2-703-522-3100');
  });
});
