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
import { queryValues } from '../view';

export const SPEC_FILE = 'openapi.yaml';
const SPEC_ID = 'openapi';
const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

type Schema = Record<string, unknown>;
/** A compiled schema and how to tell its first error. */
type Check = { validate: ValidateFunction; message(e: ErrorObject, name?: string): string };
type Operation = { body?: Check; query: Array<{ name: string; check: Check }> };
export type Contract = { operations: Map<string, Operation> };

const isObject = (v: unknown): v is Schema => typeof v === 'object' && v !== null && !Array.isArray(v);

export const PACKAGE = '@shop/api';

/** The package's name in dir/package.json, or undefined (no file, or not JSON). */
function packageName(dir: string): unknown {
  try {
    return (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: unknown }).name;
  } catch {
    return undefined;
  }
}

/**
 * openapi.yaml at the @shop/api package root: the nearest folder above `from` whose package.json is that
 * package (apps/api, from src/http or from dist). Never a folder above it: a missing spec throws.
 */
export function specPath(from = __dirname): string {
  for (let d = resolve(from); ; d = dirname(d)) {
    if (packageName(d) === PACKAGE) {
      const file = join(d, SPEC_FILE);
      if (!existsSync(file)) throw new Error(`${SPEC_FILE} not found in ${PACKAGE}`);
      return file;
    }
    if (dirname(d) === d) throw new Error(`${PACKAGE} not found above ${from}`);
  }
}

const SCHEMAS = '#/components/schemas/';

/**
 * A copy for Ajv: every `x-checked-in` schema made `{}`, those properties dropped from their object's
 * `required` (left out, the route or domain says so in its own words and order), and #/components/schemas/
 * $refs pointed at Ajv's copy. `components` are the spec's schemas, to see through a $ref.
 */
function prepare(v: unknown, components: Schema): unknown {
  const checkedIn = (s: unknown): boolean => {
    if (!isObject(s)) return false;
    if ('x-checked-in' in s) return true;
    const ref = s['$ref'];
    return typeof ref === 'string' && ref.startsWith(SCHEMAS) && checkedIn(components[ref.slice(SCHEMAS.length)]);
  };
  const walk = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(walk);
    if (!isObject(x)) return x;
    if ('x-checked-in' in x) return {};
    const out = Object.fromEntries(
      Object.entries(x).map(([k, y]) => [
        k,
        k === '$ref' && typeof y === 'string' && y.startsWith(SCHEMAS)
          ? `${SPEC_ID}#/$defs/${y.slice(SCHEMAS.length)}`
          : walk(y),
      ]),
    );
    const props = x['properties'];
    if (Array.isArray(x['required']) && isObject(props))
      out['required'] = (x['required'] as unknown[]).filter((n) => !checkedIn(props[String(n)]));
    return out;
  };
  return walk(v);
}

/** "/api/tickets/{id}" -> "/api/tickets/:id", as the routes are written. */
const routePath = (p: string): string => p.replace(/\{(\w+)\}/g, ':$1');

/** The compiled checks of every operation in the spec, keyed "METHOD /route/:path". */
export function loadContract(file = specPath()): Contract {
  const spec = parse(readFileSync(file, 'utf8')) as Schema;
  const ajv = new Ajv2020({ strict: true, allowUnionTypes: true, verbose: true });
  ajv.addVocabulary(['x-error', 'x-checked-in']);
  const schemas = ((spec['components'] as Schema | undefined)?.['schemas'] ?? {}) as Schema;
  ajv.addSchema({ $id: SPEC_ID, $defs: prepare(schemas, schemas) });

  /** The schema a $ref names (as prepared), else the schema itself. */
  const deref = (s: unknown): Schema | undefined => {
    if (!isObject(s)) return undefined;
    const ref = s['$ref'];
    return typeof ref === 'string' ? deref(ajv.getSchema(ref)?.schema) : s;
  };
  const compile = (schema: unknown): Check => {
    const root = prepare(schema, schemas) as Schema;
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
    const message = e ? c.message(e, name) : 'bad request';
    c.validate.errors = null; // verbose errors hold the input: don't keep it past this request
    throw new BadInput(message);
  };
  if (op.body) check(op.body, req.body);
  if (op.query.length) {
    // read as the routes read it (queryValues, Python's parse_qs): every non-blank value of each name
    for (const { name, check: c } of op.query) for (const v of queryValues(req.originalUrl, name)) check(c, v, name);
  }
  next();
};
