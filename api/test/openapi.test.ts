// docs/openapi.yaml against the code (WP 8.3): every route the API serves is in the spec and every
// operation in the spec is a route, and the real API's answers, from a real database and the
// payment mock, match the spec's statuses, headers and schemas.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import type { Pool } from 'pg';
import request from 'supertest';
import type { Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import type { Faults } from '../../payments-mock/src/faults.js';
import { createTestSchema, startMock } from '../../payments-mock/test/helpers/mock.js';
import type { RunningMock } from '../../payments-mock/test/helpers/mock.js';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/auth/password.js';
import { createPaymentClient } from '../src/checkout/payment-client.js';
import type { PaymentClient } from '../src/checkout/payment-client.js';
import type { Config } from '../src/config.js';
import { createDatabase } from '../src/db.js';
import type { Database } from '../src/db.js';
import { createHoldStrategy } from '../src/holds/strategies.js';
import { createLogger } from '../src/logger.js';
import { runMigrations } from '../src/migrate.js';
import { createRoutes } from '../src/routes.js';
import { seedStadium } from '../src/seed.js';
import { schemaConnectionString } from './helpers/database.js';

// ajv-formats is CommonJS, so its default export arrives one level down under NodeNext.
const addFormats = addFormatsModule as unknown as typeof addFormatsModule.default;

const SPEC_FILE = path.resolve(import.meta.dirname, '../../docs/openapi.yaml');
const SCHEMA = 'openapi_probe';
const PAYMENTS_SCHEMA = 'openapi_payments';
const CONNECTION_STRING = schemaConnectionString(SCHEMA);
const JWT_SECRET = 'openapi-contract-secret-at-least-32-chars';
const PASSWORD = 'fan-password';
const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

interface Media {
  schema: object;
}
interface Header {
  schema?: { const?: string };
}
interface ResponseObject {
  content?: Record<string, Media>;
  headers?: Record<string, Header | { $ref: string }>;
}
interface Operation {
  tags?: string[];
  responses: Record<string, ResponseObject | { $ref: string }>;
}
interface Spec {
  paths: Record<string, Partial<Record<(typeof METHODS)[number], Operation>>>;
  components: Record<string, Record<string, unknown>>;
}

const spec = parse(readFileSync(SPEC_FILE, 'utf8')) as Spec;

// Every operation, as "METHOD /path/{param}".
const operations = Object.entries(spec.paths).flatMap(([route, item]) =>
  METHODS.filter((method) => item[method]).map((method) => `${method.toUpperCase()} ${route}`),
);

// "#/components/responses/Unauthorized" and the like, followed to what they point at.
function resolve<T>(node: T | { $ref: string }): T {
  if (node !== null && typeof node === 'object' && '$ref' in node) {
    const [, section, name] = node.$ref.replace('#/components/', '').match(/^([^/]+)\/(.+)$/) ?? [];
    return resolve(spec.components[section ?? '']?.[name ?? ''] as T | { $ref: string });
  }
  return node;
}

// The whole spec is one schema document, so a response's schema can point into its components.
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema(spec, 'openapi');
const validators = new Map<object, ValidateFunction>();

function validatorFor(schema: object): ValidateFunction {
  let validate = validators.get(schema);
  if (!validate) {
    const rooted = JSON.parse(
      JSON.stringify(schema).replaceAll('"#/components/', '"openapi#/components/'),
    ) as object;
    validate = ajv.compile(rooted);
    validators.set(schema, validate);
  }
  return validate;
}

// Which operations and statuses the flow below has answered, checked once it has run.
const seen = new Set<string>();

// The answer must be one the spec documents for this operation, with that answer's body and
// headers.
function expectDocumented(operation: string, res: Response): void {
  const [method = '', route = ''] = operation.split(' ');
  const op = spec.paths[route]?.[method.toLowerCase() as (typeof METHODS)[number]];
  expect(op, `${operation} is in the spec`).toBeDefined();
  const documented = op?.responses[String(res.status)];
  expect(documented, `${operation} documents ${res.status}: ${res.text}`).toBeDefined();
  if (!documented) return;
  const response = resolve(documented);
  seen.add(`${operation} ${res.status}`);

  expect(res.headers['x-request-id'], 'every answer has X-Request-Id').toBeTruthy();
  for (const [name, header] of Object.entries(response.headers ?? {})) {
    const fixed = resolve(header).schema?.const;
    if (fixed !== undefined && name !== 'Idempotent-Replayed') {
      expect(res.headers[name.toLowerCase()], `${operation} ${res.status} ${name}`).toBe(fixed);
    }
  }

  const media = response.content?.['application/json'];
  if (!media) {
    expect(res.text, `${operation} ${res.status} has no body`).toBe('');
    return;
  }
  expect(res.headers['content-type']).toMatch(/^application\/json/);
  const validate = validatorFor(media.schema);
  expect(validate(res.body), `${operation} ${res.status}: ${ajv.errorsText(validate.errors)}`).toBe(
    true,
  );
}

interface Layer {
  route?: { path: string; methods: Record<string, boolean> };
  handle: { stack?: Layer[] };
}

// The routes an Express router serves, as "METHOD /path/:param", each relative to the router
// that declares it: Express doesn't keep the prefix a router is mounted under.
function routesOf(stack: Layer[]): string[] {
  return stack.flatMap((layer) => {
    if (layer.route) {
      const { path: route, methods } = layer.route;
      return Object.keys(methods).map((method) => `${method.toUpperCase()} ${route}`);
    }
    return layer.handle.stack ? routesOf(layer.handle.stack) : [];
  });
}

function routerFor(nodeEnv: Config['NODE_ENV']) {
  const unused = {} as never;
  return createRoutes({
    db: unused,
    config: { NODE_ENV: nodeEnv, JWT_SECRET, JWT_EXPIRES_IN: 3600, RACE_DELAY_MS: 0 },
    holdStrategy: unused,
    payments: unused,
  }) as unknown as { stack: Layer[] };
}

describe('the spec and the routes (WP 8.3)', () => {
  it('lists every route the API serves, and nothing else', () => {
    const routes = routesOf(routerFor('development').stack);
    const expressStyle = operations.map((operation) => operation.replace(/\{(\w+)\}/g, ':$1'));

    // Each route is the end of exactly one operation's path, after its router's prefix.
    const matched = routes.map((route) => {
      const [method = '', suffix = ''] = route.split(' ');
      const candidates = expressStyle.filter((operation) => {
        const [opMethod = '', opPath = ''] = operation.split(' ');
        return (
          opMethod === method &&
          opPath.endsWith(suffix) &&
          /^(\/[\w-]+)*$/.test(opPath.slice(0, -suffix.length))
        );
      });
      expect(candidates, `${route} is in the spec`).toHaveLength(1);
      return candidates[0];
    });

    expect(new Set(matched).size).toBe(routes.length);
    expect(routes).toHaveLength(operations.length);
  });

  it('marks as Dev exactly the routes a production server leaves out', () => {
    const dev = routesOf(routerFor('development').stack);
    const production = routesOf(routerFor('production').stack);
    const devOnly = operations.filter((operation) => {
      const [method = '', route = ''] = operation.split(' ');
      return spec.paths[route]?.[method.toLowerCase() as (typeof METHODS)[number]]?.tags?.includes(
        'Dev',
      );
    });

    expect(dev.length - production.length).toBe(devOnly.length);
    expect(devOnly).toEqual(['POST /dev/buy-naive']);
    expect(production).not.toContain('POST /buy-naive');
  });

  it('lists every error code the API has, and only those', () => {
    const source = readFileSync(path.resolve(import.meta.dirname, '../src/errors.ts'), 'utf8');
    const union = source.match(/export type ErrorCode =([^;]+);/)?.[1] ?? '';
    const codes = [...union.matchAll(/'([A-Z_]+)'/g)].map((match) => match[1]);
    const documented = (spec.components.schemas?.ErrorCode as { enum: string[] }).enum;

    expect(codes.length).toBeGreaterThan(10);
    expect([...documented].sort()).toEqual([...codes].sort());
  });
});

describe('the real API answers as the spec says (WP 8.3)', { timeout: 30_000 }, () => {
  const logger = createLogger('silent');
  let db: Database;
  let mockPool: Pool;
  let mock: RunningMock;
  let app: ReturnType<typeof createApp>;
  let token = '';
  let rivalToken = '';
  const provider = { decline: false, down: false };

  const faults: Faults = {
    delay: () => Promise.resolve(),
    decline: () => provider.decline,
    loseResponse: () => false,
  };

  const auth = () => `Bearer ${token}`;
  const call = async (operation: string, res: Promise<Response> | Response) => {
    const answer = await res;
    expectDocumented(operation, answer);
    return answer;
  };
  const hold = (seatIds: number[], key?: string, as = auth()) => {
    let req = request(app).post('/events/1/holds').set('Authorization', as).send({ seatIds });
    if (key) req = req.set('Idempotency-Key', key);
    return req;
  };

  beforeAll(async () => {
    db = createDatabase({ connectionString: CONNECTION_STRING, logger });
    await db.pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await db.pool.query(`CREATE SCHEMA ${SCHEMA}`);
    // Outside production, so the dev route's table is there too.
    await runMigrations({ connectionString: CONNECTION_STRING, logger, production: false });
    const hash = await hashPassword(PASSWORD);
    await db.withTransaction((client) => seedStadium(client, hash));

    mockPool = await createTestSchema(PAYMENTS_SCHEMA);
    mock = await startMock(mockPool, faults);
    const real = createPaymentClient({ baseUrl: mock.url, logger, wait: () => Promise.resolve() });
    const payments: PaymentClient = {
      charge: (charge, context) =>
        provider.down ? Promise.resolve({ status: 'unavailable' }) : real.charge(charge, context),
      refund: (key, context) => real.refund(key, context),
    };
    const config = {
      NODE_ENV: 'development' as const,
      JWT_SECRET,
      JWT_EXPIRES_IN: 3600,
      RACE_DELAY_MS: 0,
    };
    app = createApp({
      config: { CORS_ORIGINS: [] },
      logger,
      routes: createRoutes({
        db,
        config,
        holdStrategy: createHoldStrategy('lock', { db, holdSeconds: 300, logger }),
        payments,
      }),
    });
  });

  afterAll(async () => {
    await mock.close();
    await mockPool.query(`DROP SCHEMA IF EXISTS ${PAYMENTS_SCHEMA} CASCADE`);
    await mockPool.end();
    await db.pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await db.close();
  });

  it('health and readiness', async () => {
    await call('GET /health', request(app).get('/health'));
    await call('GET /ready', request(app).get('/ready'));
  });

  it('signing up and logging in', async () => {
    const fan = { email: 'new.fan@example.com', password: 'a-long-password' };
    await call('POST /auth/signup', request(app).post('/auth/signup').send(fan));
    await call('POST /auth/signup', request(app).post('/auth/signup').send(fan));
    await call('POST /auth/signup', request(app).post('/auth/signup').send({ email: 'nope' }));

    const login = (email: string, password: string) =>
      request(app).post('/auth/login').send({ email, password });
    const tokenOf = async (email: string) =>
      ((await call('POST /auth/login', login(email, PASSWORD))).body as { token: string }).token;
    token = await tokenOf('fan1@taquilla.test');
    rivalToken = await tokenOf('fan2@taquilla.test');
    await call('POST /auth/login', login('fan1@taquilla.test', 'wrong-password'));
    await call('POST /auth/login', request(app).post('/auth/login').send({}));
  });

  it('the seat map and the seat states', async () => {
    await call('GET /events/{id}/seats', request(app).get('/events/1/seats'));
    await call('GET /events/{id}/seats', request(app).get('/events/abc/seats'));
    await call('GET /events/{id}/seats/states', request(app).get('/events/1/seats/states'));
    await call('GET /events/{id}/seats/states', request(app).get('/events/999/seats/states'));
  });

  it('holding seats, with and without a key, and the ways a hold is refused', async () => {
    const op = 'POST /events/{id}/holds';
    await call(
      op,
      request(app)
        .post('/events/1/holds')
        .send({ seatIds: [41] }),
    );
    await call(op, hold([41, 42], 'hold-key-1'));
    const replay = await call(op, hold([41, 42], 'hold-key-1'));
    expect(replay.headers['idempotent-replayed']).toBe('true');
    await call(op, hold([43], 'hold-key-1'));
    await call(op, hold([42], undefined, `Bearer ${rivalToken}`));
    await call(op, hold([99_999]));
    await call(op, hold([]));
    await call(
      op,
      request(app)
        .post('/events/999/holds')
        .set('Authorization', auth())
        .send({ seatIds: [1] }),
    );
  });

  it('releasing a hold', async () => {
    const { holdId } = (await hold([60])).body as { holdId: string };
    await call(
      'DELETE /holds/{id}',
      request(app).delete(`/holds/${holdId}`).set('Authorization', auth()),
    );
    await call(
      'DELETE /holds/{id}',
      request(app).delete('/holds/not-a-hold').set('Authorization', auth()),
    );
    await call('DELETE /holds/{id}', request(app).delete(`/holds/${holdId}`));
  });

  it('paying for a hold, and the order it makes', async () => {
    const op = 'POST /holds/{id}/checkout';
    const pay = (holdId: string, key?: string) => {
      let req = request(app).post(`/holds/${holdId}/checkout`).set('Authorization', auth());
      if (key) req = req.set('Idempotency-Key', key);
      return req;
    };
    const { holdId } = (await hold([70, 71])).body as { holdId: string };

    await call(op, pay(holdId));
    await call(op, request(app).post(`/holds/${holdId}/checkout`).set('Idempotency-Key', 'k'));
    await call(op, pay('00000000-0000-4000-8000-000000000000', 'pay-unknown'));
    const paid = await call(op, pay(holdId, 'pay-key-1'));
    const replay = await call(op, pay(holdId, 'pay-key-1'));
    expect(replay.headers['idempotent-replayed']).toBe('true');

    const { orderId } = paid.body as { orderId: string };
    await call(
      'GET /orders/{id}',
      request(app).get(`/orders/${orderId}`).set('Authorization', auth()),
    );
    await call(
      'GET /orders/{id}',
      request(app).get('/orders/not-an-order').set('Authorization', auth()),
    );
    await call('GET /orders/{id}', request(app).get(`/orders/${orderId}`));

    const declined = (await hold([72])).body as { holdId: string };
    provider.decline = true;
    await call(op, pay(declined.holdId, 'pay-declined'));
    provider.decline = false;

    const unanswered = (await hold([73])).body as { holdId: string };
    provider.down = true;
    await call(op, pay(unanswered.holdId, 'pay-down'));
    provider.down = false;

    // The rival takes a seat of a lapsed hold before it's paid for.
    const lapsed = (await hold([74])).body as { holdId: string };
    await db.pool.query(`UPDATE seats SET held_until = now() - interval '1 second' WHERE id = 74`);
    await hold([74], undefined, `Bearer ${rivalToken}`);
    await call(op, pay(lapsed.holdId, 'pay-lapsed'));
    await call(op, pay(holdId, 'pay-key-1').send({ different: true }));
  });

  it('the dev-only naive buy', async () => {
    const op = 'POST /dev/buy-naive';
    const buy = (body: object) =>
      request(app).post('/dev/buy-naive').set('Authorization', auth()).send(body);
    await call(op, buy({ seatId: 100 }));
    await call(op, buy({ seatId: 100 }));
    await call(op, buy({ seatId: 99_999 }));
    await call(op, buy({}));
    await call(op, request(app).post('/dev/buy-naive').send({ seatId: 100 }));
  });

  it('an unknown route, and too many attempts at /auth', async () => {
    const unknown = await request(app).get('/nowhere');
    expect(unknown.status).toBe(404);
    expect(validatorFor({ $ref: '#/components/schemas/Error' })(unknown.body)).toBe(true);

    let res: Response | undefined;
    for (let i = 0; i < 12 && res?.status !== 429; i += 1) {
      res = await request(app)
        .post('/auth/login')
        .send({ email: 'fan1@taquilla.test', password: 'x' });
    }
    await call('POST /auth/login', res as Response);
    // One limit covers every /auth route.
    await call(
      'POST /auth/signup',
      request(app)
        .post('/auth/signup')
        .send({ email: 'late@example.com', password: 'long-enough' }),
    );
  });

  it("answered every operation's success and every 4xx the spec documents", () => {
    const missing = operations.flatMap((operation) => {
      const [method = '', route = ''] = operation.split(' ');
      const op = spec.paths[route]?.[method.toLowerCase() as (typeof METHODS)[number]];
      return Object.keys(op?.responses ?? {})
        .filter((status) => /^[24]/.test(status))
        .map((status) => `${operation} ${status}`)
        .filter((key) => !seen.has(key));
    });

    expect(missing).toEqual([]);
  });
});
