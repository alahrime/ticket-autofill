// Request validation against openapi.yaml (OpenAPI 3.1, so its schemas are JSON Schema 2020-12 for Ajv).
// `validRequest` sits in a route's chain after the sign-in / role gate and jsonBody, so 401 / 403 and the body
// rules (size cap, depth limit, UTF-8, stall) all come first, as in shop.py; it checks the parsed body and the
// query string. A schema marked `x-checked-in` (domain or route) is accepted as anything here: those checks
// keep their own messages, field errors and order. A failure is BadInput: 400 {error}, never the input.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import Ajv2020, { type ErrorObject, type ValidateFunction } from 'ajv/dist/2020';
import type { Request, RequestHandler } from 'express';
import { parse } from 'yaml';
import { BadInput } from '../errors';

export const SPEC_FILE = 'openapi.yaml';
const SPEC_ID = 'openapi';
const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

type Schema = Record<string, unknown>;
/** A compiled schema and how to tell its first error. */
type Check = { validate: ValidateFunction; message(e: ErrorObject, name?: string): string };
type Operation = { body?: Check; query: Array<{ name: string; check: Check }> };
export type Contract = { operations: Map<string, Operation> };

const isObject = (v: unknown): v is Schema => typeof v === 'object' && v !== null && !Array.isArray(v);

/** openapi.yaml in the nearest folder above this file (apps/api, from src/http or from dist). */
export function specPath(from = __dirname): string {
  for (let d = resolve(from); ; d = dirname(d)) {
    if (existsSync(join(d, SPEC_FILE))) return join(d, SPEC_FILE);
    if (dirname(d) === d) throw new Error(`${SPEC_FILE} not found`);
  }
}

const SCHEMAS = '#/components/schemas/';

/** A copy with every `x-checked-in` schema made `{}` and #/components/schemas/ $refs pointed at Ajv's copy. */
function prepare(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(prepare);
  if (!isObject(v)) return v;
  if ('x-checked-in' in v) return {};
  return Object.fromEntries(
    Object.entries(v).map(([k, x]) => [
      k,
      k === '$ref' && typeof x === 'string' && x.startsWith(SCHEMAS)
        ? `${SPEC_ID}#/$defs/${x.slice(SCHEMAS.length)}`
        : prepare(x),
    ]),
  );
}

/** "/api/tickets/{id}" -> "/api/tickets/:id", as the routes are written. */
const routePath = (p: string): string => p.replace(/\{(\w+)\}/g, ':$1');

/** The compiled checks of every operation in the spec, keyed "METHOD /route/:path". */
export function loadContract(file = specPath()): Contract {
  const spec = parse(readFileSync(file, 'utf8')) as Schema;
  const ajv = new Ajv2020({ strict: true, allowUnionTypes: true, verbose: true });
  ajv.addVocabulary(['x-error', 'x-checked-in']);
  const schemas = (spec['components'] as Schema | undefined)?.['schemas'] ?? {};
  ajv.addSchema({ $id: SPEC_ID, $defs: prepare(schemas) });

  /** The schema a $ref names (as prepared), else the schema itself. */
  const deref = (s: unknown): Schema | undefined => {
    if (!isObject(s)) return undefined;
    const ref = s['$ref'];
    return typeof ref === 'string' ? deref(ajv.getSchema(ref)?.schema) : s;
  };
  const compile = (schema: unknown): Check => {
    const root = prepare(schema) as Schema;
    const named = (deref(root)?.['properties'] ?? {}) as Schema;
    return {
      validate: ajv.compile(root),
      // the failing schema's x-error; else "<field> ..." when the spec names the field; else "bad request".
      // Built from the spec only, so nothing sent comes back.
      message(e, name) {
        const parent = deref(e.parentSchema);
        if (e.keyword === 'required') {
          const missing = String((e.params as { missingProperty?: unknown }).missingProperty);
          const prop = deref((parent?.['properties'] as Schema | undefined)?.[missing]);
          return typeof prop?.['x-error'] === 'string' ? prop['x-error'] : `${missing} is required`;
        }
        if (typeof parent?.['x-error'] === 'string') return parent['x-error'];
        if (name !== undefined) return `${name} is not valid`;
        const field = e.instancePath.split('/')[1]?.replace(/~1/g, '/').replace(/~0/g, '~') ?? '';
        return field && Object.hasOwn(named, field) ? `${field} is not valid` : 'bad request';
      },
    };
  };

  const PARAMS = '#/components/parameters/';
  const shared = ((spec['components'] as Schema | undefined)?.['parameters'] ?? {}) as Record<string, Schema>;
  /** A parameter, or the shared one its $ref names. */
  const param = (p: Schema): Schema => {
    const ref = p['$ref'];
    if (typeof ref !== 'string') return p;
    const found = ref.startsWith(PARAMS) ? shared[ref.slice(PARAMS.length)] : undefined;
    if (!found) throw new Error(`${SPEC_FILE}: no parameter ${ref}`);
    return found;
  };

  const operations = new Map<string, Operation>();
  for (const [path, item] of Object.entries((spec['paths'] ?? {}) as Record<string, Schema>)) {
    for (const method of METHODS) {
      const op = item[method];
      if (!isObject(op)) continue;
      const body = ((op['requestBody'] as Schema | undefined)?.['content'] as Schema | undefined)?.['application/json'];
      const params = [...((item['parameters'] as Schema[]) ?? []), ...((op['parameters'] as Schema[]) ?? [])].map(param);
      operations.set(`${method.toUpperCase()} ${routePath(path)}`, {
        body: isObject(body) && body['schema'] ? compile(body['schema']) : undefined,
        query: params
          .filter((p) => p['in'] === 'query')
          .map((p) => ({ name: String(p['name']), check: compile(p['schema'] ?? {}) })),
      });
    }
  }
  return { operations };
}

let loaded: Contract | undefined;

/** The server's contract, loaded and compiled once. */
export const contract = (): Contract => (loaded ??= loadContract());

const contractOf = (req: Request): Contract => req.app.locals['contract'] as Contract;

/** Checks req.body and the query string against the spec's operation for this route; 400 {error} if not. */
export const validRequest: RequestHandler = (req, _res, next) => {
  const route = (req.route as { path?: unknown } | undefined)?.path;
  const method = req.method === 'HEAD' ? 'GET' : req.method; // Express answers HEAD with the GET route
  const op = contractOf(req).operations.get(`${method} ${String(route)}`);
  if (!op) throw new Error('route not in openapi.yaml'); // a 500; the contract test says which
  const check = (c: Check, value: unknown, name?: string): void => {
    if (c.validate(value)) return;
    const e = c.validate.errors?.[0];
    throw new BadInput(e ? c.message(e, name) : 'bad request');
  };
  if (op.body) check(op.body, req.body);
  if (op.query.length) {
    const q = req.originalUrl.indexOf('?');
    // as the routes read it (Python's parse_qs): every value of each name
    const params = new URLSearchParams(q < 0 ? '' : req.originalUrl.slice(q + 1).split('#')[0]);
    for (const { name, check: c } of op.query) for (const v of params.getAll(name)) check(c, v, name);
  }
  next();
};
