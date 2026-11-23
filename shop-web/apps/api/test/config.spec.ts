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
    ['ownBilling is text', { ownBilling: 'yes' }],
    ['shop is a list', { ownBilling: true, shop: [] }],
    ['shop.name is a number', { ownBilling: true, shop: { ...SHOP, name: 5 } }],
    ['shop.address holds a number', { ownBilling: true, shop: { ...SHOP, address: ['1 MAIN ST', 2] } }],
    ['shop.address is text', { ownBilling: true, shop: { ...SHOP, address: '1 MAIN ST' } }],
    ['shop.phone is missing', { ownBilling: true, shop: { name: 'TEST SHOP', address: [], hours: '' } }],
  ])('%s: the defaults and one warning', (_why, v) => {
    settings(v);
    const c = load();
    expect(c.ownBilling).toBe(false);
    expect(c.shopInfo).toEqual(EMPTY_SHOP);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
