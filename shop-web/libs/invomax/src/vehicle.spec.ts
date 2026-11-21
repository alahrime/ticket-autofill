import { normalPlate, parseVehicle, phoneDigits, type Vehicles } from './vehicle.js';

const VEHICLES: Vehicles = {
  HONDA: { 'HR-V': [2016, 2027], CIVIC: [1990, 2027] },
  CHEVROLET: { 'SILVERADO 1500': [1999, 2027], SILVERADO: [1999, 2027] },
  'MERCEDES-BENZ': { C300: [2008, 2027] },
};

test.each([
  ['2019 Honda HR-V EX', { year: 2019, make: 'HONDA', model: 'HR-V', trim: 'EX' }],
  ['19 HONDA HRV', { year: 2019, make: 'HONDA', model: 'HR-V', trim: '' }],
  ['2008 Chevy Silverado 1500', { year: 2008, make: 'CHEVROLET', model: 'SILVERADO 1500', trim: '' }],
  ['98 Mercedes C300 sport', { year: 1998, make: 'MERCEDES-BENZ', model: 'C300', trim: 'sport' }],
  ['TRAILER', { year: null, make: '', model: '', trim: 'TRAILER' }],
  ['', { year: null, make: '', model: '', trim: '' }],
])('parseVehicle(%j)', (text, want) => expect(parseVehicle(text, VEHICLES)).toEqual(want));

test('keys', () => {
  expect(normalPlate(' xks-4827 ')).toBe('XKS4827');
  expect(phoneDigits('(555)010-0000')).toBe('5550100000');
});
