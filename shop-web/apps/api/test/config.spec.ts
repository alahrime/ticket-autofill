// shop-settings.json: ownBilling and the shop's details (made-up values only).
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../src/config';
import { tempDir } from './py';

const EMPTY_SHOP = { name: '', address: [], phone: '', hours: '' };
const SHOP = { name: 'TEST SHOP', address: ['1 MAIN ST', 'ANYTOWN, VA 00000'], phone: '(555)010-0001', hours: 'M-F 8-5' };

let tmp: ReturnType<typeof tempDir>;
let warn: jest.SpyInstance;
const settings = (v: unknown): void => writeFileSync(join(tmp.dir, 'shop-settings.json'), typeof v === 'string' ? v : JSON.stringify(v));
const load = (): ReturnType<typeof loadConfig> => loadConfig({ SHOP_ROOT: tmp.dir });

beforeEach(() => {
  tmp = tempDir();
  warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  warn.mockRestore();
  tmp.done();
});

describe('ownBilling and shop in shop-settings.json', () => {
  it('loads as given', () => {
    settings({ ownBilling: true, shop: SHOP });
    const c = load();
    expect(c.ownBilling).toBe(true);
    expect(c.shopInfo).toEqual(SHOP);
    expect(warn).not.toHaveBeenCalled();
  });

  it('a missing file gives ownBilling false and the empty shop, no warning', () => {
    const c = load();
    expect(c.ownBilling).toBe(false);
    expect(c.shopInfo).toEqual(EMPTY_SHOP);
    expect(warn).not.toHaveBeenCalled();
  });

  it('a file without the keys gives the defaults, no warning', () => {
    settings({ backupTargets: [] });
    const c = load();
    expect(c.ownBilling).toBe(false);
    expect(c.shopInfo).toEqual(EMPTY_SHOP);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    ['shop is a list', []],
    ['shop is a number', 5],
    ['shop.name is a number', { ...SHOP, name: 5 }],
    ['shop.address holds a number', { ...SHOP, address: ['1 MAIN ST', 2] }],
    ['shop.address is text', { ...SHOP, address: '1 MAIN ST' }],
    ['shop.phone is missing', { name: 'TEST SHOP', address: [], hours: '' }],
    ['shop.name is 81 characters', { ...SHOP, name: 'X'.repeat(81) }],
    ['shop.address has 6 lines', { ...SHOP, address: ['A', 'B', 'C', 'D', 'E', 'F'] }],
    ['shop.name has a newline', { ...SHOP, name: 'TEST\nSHOP' }],
    ['shop.hours has a control character', { ...SHOP, hours: 'M-F\u00078-5' }],
  ])('%s: the empty shop and one warning', (_why, shop) => {
    settings({ ownBilling: true, shop });
    const c = load();
    expect(c.ownBilling).toBe(true); // the good key is kept
    expect(c.shopInfo).toEqual(EMPTY_SHOP);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('shop');
  });

  it('80 characters and 5 address lines are fine', () => {
    const shop = { ...SHOP, name: 'X'.repeat(80), address: ['A', 'B', 'C', 'D', 'E'] };
    settings({ shop });
    expect(load().shopInfo).toEqual(shop);
    expect(warn).not.toHaveBeenCalled();
  });

  it('ownBilling as text gives false and one warning naming it; the shop is kept', () => {
    settings({ ownBilling: 'yes', shop: SHOP });
    const c = load();
    expect(c.ownBilling).toBe(false);
    expect(c.shopInfo).toEqual(SHOP);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('ownBilling');
  });

  it('one bad key keeps the others (InvoMax retired stays off)', () => {
    settings({ invomaxDir: null, backupTargets: ['D:'], shop: 5 });
    const c = load();
    expect(c.importInvomax).toBe(false);
    expect(c.backupTargets).toEqual(['D:']);
    expect(c.shopInfo).toEqual(EMPTY_SHOP);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('two bad keys: still one warning, naming both', () => {
    settings({ ownBilling: 1, backupTargets: 'D:' });
    load();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/ownBilling, backupTargets|backupTargets, ownBilling/);
  });

  it('invalid JSON gives all defaults and one warning', () => {
    settings('{ nope');
    const c = load();
    expect(c.importInvomax).toBe(true);
    expect(c.ownBilling).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
