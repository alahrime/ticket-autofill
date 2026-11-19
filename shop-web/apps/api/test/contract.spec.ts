// The OpenAPI contract (openapi.yaml) against the real app: every /api/ route is in it, every operation in it
// answers a signed-in admin, and each reply matches the schema the spec gives for its status.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020';
import type { Express } from 'express';
import { parse } from 'yaml';
import { createApp } from '../src/app';
import { loadContract, validRequest } from '../src/http/contract';
import { CAR, makeServer, type TestServer } from './helpers';
import { tempDir } from './py';

jest.setTimeout(60_000);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any; // the spec, as loosely as YAML gives it

const SPEC: J = parse(readFileSync(join(__dirname, '..', 'openapi.yaml'), 'utf8'));
const METHODS = ['get', 'post', 'put', 'patch', 'delete'];

/** Every route the app serves: "METHOD /path" (:name params written {name}) -> whether it runs validRequest. */
function routes(app: Express): Map<string, boolean> {
  const found = new Map<string, boolean>();
  const walk = (stack: J[]): void => {
    for (const layer of stack) {
      if (layer.route) {
        const path = String(layer.route.path).replace(/:(\w+)/g, '{$1}');
        const validated = layer.route.stack.some((l: J) => l.handle === validRequest);
        for (const m of Object.keys(layer.route.methods)) found.set(`${m.toUpperCase()} ${path}`, validated);
      } else if (layer.handle?.stack) walk(layer.handle.stack);
    }
  };
  walk((app as J).router.stack);
  return found;
}

/** Every operation in the spec, in file order. */
const operations = (): Array<[string, string, J]> =>
  Object.entries(SPEC.paths as Record<string, J>).flatMap(([path, item]) =>
    METHODS.filter((m) => item[m]).map((m): [string, string, J] => [m, path, item[m]]),
  );

/** An Ajv over the spec's components: validate(ref, value) -> the errors, or null. */
function responseChecker(): (schema: J, value: unknown) => unknown {
  const ajv = new Ajv2020({ allErrors: true, allowUnionTypes: true, strict: true });
  ajv.addVocabulary(['x-error', 'x-checked-in']);
  const toSpec = (v: unknown): J => JSON.parse(JSON.stringify(v).replace(/"#\/components\/schemas\//g, '"spec#/$defs/'));
  ajv.addSchema({ $id: 'spec', $defs: toSpec(SPEC.components.schemas) });
  return (schema, value) => {
    const check = ajv.compile(toSpec(schema));
    return check(value) ? null : check.errors;
  };
}

let s: TestServer;
beforeEach(async () => {
  s = await makeServer();
});
afterEach(() => s.close());

describe('the OpenAPI contract', () => {
  it('is OpenAPI 3.1 with the shared schemas', () => {
    expect(SPEC.openapi).toMatch(/^3\.1\./);
    for (const name of ['Ticket', 'Line', 'Deposit', 'Totals', 'Error', 'User', 'Me', 'Hint', 'NewTicket', 'CheckIn', 'Edit', 'Move'])
      expect(SPEC.components.schemas).toHaveProperty(name);
    expect(SPEC.components.schemas.Ticket.additionalProperties).toBe(true); // Python's unknown keys ride along
  });

  it('every route is in the spec', () => {
    const served = routes(createApp({ store: s.store, accounts: s.accounts, config: s.config }));
    const api = [...served.keys()].filter((r) => r.split(' ')[1]?.startsWith('/api/'));
    expect(api.length).toBeGreaterThan(10);
    const ops = new Map(operations().map(([m, p, op]) => [`${m.toUpperCase()} ${p}`, op]));
    expect(api.filter((r) => !ops.has(r))).toEqual([]);
    expect([...ops.keys()].filter((r) => !api.includes(r))).toEqual([]); // and nothing the app doesn't serve
    // a route the spec gives a body or a query string checks it against the spec
    const takesInput = [...ops].filter(([, op]) => op.requestBody || (op.parameters ?? []).some((p: J) => p.in === 'query'));
    expect(takesInput.length).toBeGreaterThan(5);
    expect(takesInput.map(([r]) => r).filter((r) => !served.get(r))).toEqual([]);
  });

  it('every spec path answers', async () => {
    const a = await s.admin();
    expect((await s.call('/api/tickets', CAR, a)).body).toMatchObject({ id: 1 }); // the examples' ticket 1
    const check = responseChecker();
    for (const [method, path, op] of operations()) {
      const params: J[] = (op.parameters ?? []).map((p: J) =>
        p.$ref ? SPEC.components.parameters[String(p.$ref).replace('#/components/parameters/', '')] : p,
      );
      let url = path.replace(/\{(\w+)\}/g, (_, name: string) => {
        const p = params.find((x) => x.in === 'path' && x.name === name);
        if (p?.example === undefined) throw new Error(`${path}: no example for {${name}}`);
        return encodeURIComponent(String(p.example));
      });
      const query = params.filter((x) => x.in === 'query' && x.example !== undefined);
      if (query.length) url += `?${new URLSearchParams(query.map((x): [string, string] => [x.name, String(x.example)])).toString()}`;
      let body: unknown;
      if (method === 'post') {
        body = op.requestBody?.content?.['application/json']?.example;
        if (body === undefined) throw new Error(`${method} ${path}: no request example`);
      }
      const r = await s.call(url, body, a);
      const where = `${method.toUpperCase()} ${url} -> ${r.status}`;
      expect([where, r.status === 404]).toEqual([where, false]);
      expect([where, r.status]).toEqual([where, 200]); // the examples are good input, in file order
      const reply = op.responses[String(r.status)] ?? op.responses.default;
      expect([where, reply !== undefined]).toEqual([where, true]);
      const schema = reply?.content?.['application/json']?.schema;
      if (schema) expect([where, check(schema, r.body)]).toEqual([where, null]);
    }
  });

  it('a mechanic gets the mechanic view, as the spec says', async () => {
    const check = responseChecker();
    const t = await s.call('/api/tickets', { ...CAR, deposits: [{ amount: 5 }] }, await s.tech('Al Fixit'));
    expect(t.status).toBe(200);
    expect(check({ $ref: '#/components/schemas/Ticket' }, t.body)).toBeNull();
    expect(t.body).not.toHaveProperty('deposits');
    const reply = SPEC.paths['/api/tickets'].post.responses['200'].content['application/json'].schema;
    expect(check(reply, t.body)).toBeNull();
  });

  it('validation messages come from the spec, never the input', () => {
    const { dir, done } = tempDir();
    try {
      const file = join(dir, 'openapi.yaml');
      writeFileSync(
        file,
        [
          'openapi: 3.1.0',
          'info: { title: t, version: "1" }',
          'paths:',
          '  /api/x:',
          '    post:',
          '      requestBody:',
          '        content:',
          '          application/json:',
          '            schema:',
          '              type: object',
          '              required: [n]',
          '              properties:',
          '                n: { type: integer }',
          '                free: { type: integer, x-checked-in: domain }',
          '              additionalProperties: { type: string }',
          '      responses: { "200": { description: ok } }',
        ].join('\n'),
      );
      const body = loadContract(file).operations.get('POST /api/x')?.body;
      if (!body) throw new Error('no body check');
      const msg = (v: unknown): string | null => (body.validate(v) ? null : body.message(body.validate.errors?.[0] as J));
      expect(msg({ n: 1, free: 'anything' })).toBeNull(); // x-checked-in: left to the domain
      expect(msg({})).toBe('n is required');
      expect(msg({ n: 'x' })).toBe('n is not valid');
      expect(msg({ n: 1, '<b>x</b>': 5 })).toBe('bad request'); // a key the spec doesn't name is never echoed
    } finally {
      done();
    }
  });

  it('a request the spec refuses is 400 {error}, after the sign-in and role gates', async () => {
    const a = await s.admin();
    const t = (await s.call('/api/tickets', CAR, a)).body as J;
    const url = `/api/tickets/${t.id}`;
    expect((await s.call(url, { version: '<b>x</b>', notes: 'x' })).status).toBe(401); // signed out: 401 first
    const r = await s.call(url, { version: '<b>x</b>', notes: 'x' }, a);
    expect([r.status, r.body]).toEqual([400, { error: 'version must be a whole number' }]); // the input isn't echoed
    expect((await s.call('/api/users', { name: 7 }, await s.tech('Al Fixit'))).status).toBe(403); // role before body
    const bad = await s.call('/api/users', { name: 7, role: 'mechanic', secret: '11223344' }, a);
    expect(bad.status).toBe(400);
    expect(bad.body).toHaveProperty('errors.name'); // the domain's field errors keep their shape
  });
});
