// GET /api/upkeep/status reports ownBilling (from shop-settings.json, through the config).
import { makeServer, type TestServer } from './helpers';

jest.setTimeout(60_000);

let s: TestServer;
let a: string;

beforeEach(async () => {
  s = await makeServer();
  a = await s.admin();
});
afterEach(() => s.close());

it('status: ownBilling is false by default', async () => {
  const r = await s.call('/api/upkeep/status', undefined, a);
  expect(r.status).toBe(200);
  expect(r.body).toMatchObject({ ownBilling: false });
});

it('status: ownBilling is true when the settings turn it on', async () => {
  s.config.ownBilling = true;
  const r = await s.call('/api/upkeep/status', undefined, a);
  expect(r.body).toMatchObject({ ownBilling: true });
});
