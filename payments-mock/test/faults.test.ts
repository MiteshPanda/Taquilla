import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Charge } from '../src/charges.js';
import { createFaults, NO_FAULTS } from '../src/faults.js';
import { countCharges, createTestSchema, faultsOf, postCharge, startMock } from './helpers/mock.js';
import type { FaultSettings } from '../src/faults.js';

const SCHEMA = 'mock_faults';

const DEFAULTS: FaultSettings = {
  declineRate: 0.05,
  lostResponseRate: 0.02,
  latencyMinMs: 100,
  latencyMaxMs: 800,
};

// Hands out the given numbers in turn, as Math.random would hand out its own.
function randomFrom(...values: number[]): () => number {
  return () => {
    const value = values.shift();
    if (value === undefined) throw new Error('The test ran out of random numbers.');
    return value;
  };
}

function recordSleeps(): { sleeps: number[]; sleep: (ms: number) => Promise<void> } {
  const sleeps: number[] = [];
  return {
    sleeps,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  };
}

describe('createFaults', () => {
  it.each([
    [0, 100],
    [0.5, 450],
    [0.999_999, 800],
  ])('turns random()=%d into a %i ms delay', async (random, ms) => {
    const { sleeps, sleep } = recordSleeps();

    await createFaults(DEFAULTS, { random: randomFrom(random), sleep }).delay();

    expect(sleeps).toEqual([ms]);
  });

  it('does not sleep when latency is switched off', async () => {
    const { sleeps, sleep } = recordSleeps();

    await createFaults(NO_FAULTS, { random: randomFrom(0.999_999), sleep }).delay();

    expect(sleeps).toEqual([]);
  });

  it('really waits when no clock is supplied', async () => {
    const faults = createFaults({ ...NO_FAULTS, latencyMinMs: 50, latencyMaxMs: 50 });
    const started = performance.now();

    await faults.delay();

    // A timer can fire a fraction of a millisecond early, never meaningfully so.
    expect(performance.now() - started).toBeGreaterThanOrEqual(49);
  });

  it.each([
    [0.049, true],
    [0.05, false],
  ])('declines at the default rate of 0.05 when random() is %d: %s', (random, declined) => {
    expect(createFaults(DEFAULTS, { random: randomFrom(random) }).decline()).toBe(declined);
  });

  it.each([
    [0.019, true],
    [0.02, false],
  ])('loses the response at the default rate of 0.02 when random() is %d: %s', (random, lost) => {
    expect(createFaults(DEFAULTS, { random: randomFrom(random) }).loseResponse()).toBe(lost);
  });

  it('never fires a rate of 0 and always fires a rate of 1', () => {
    const extremes = [0, 0.5, 0.999_999];
    const off = createFaults(NO_FAULTS, { random: randomFrom(...extremes, ...extremes) });
    const on = createFaults(
      { ...NO_FAULTS, declineRate: 1, lostResponseRate: 1 },
      { random: randomFrom(...extremes, ...extremes) },
    );

    for (let i = 0; i < extremes.length; i += 1) {
      expect([off.decline(), off.loseResponse()]).toEqual([false, false]);
      expect([on.decline(), on.loseResponse()]).toEqual([true, true]);
    }
  });
});

// Every fault hits a key's first attempt only (FR-MOCK-5), so a retry always gets through.
describe('faults over HTTP', () => {
  let pool: Pool;

  function newCharge() {
    return { orderId: randomUUID(), amountPaise: 150_000 };
  }

  beforeAll(async () => {
    pool = await createTestSchema(SCHEMA);
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE charges');
  });

  afterAll(async () => {
    await pool.end();
  });

  it('records a declined charge, and a retry with the key gets the same decline', async () => {
    const mock = await startMock(pool, faultsOf({ declineRate: 1 }));
    const key = `pay:${randomUUID()}`;
    const body = newCharge();

    try {
      const first = await postCharge(mock, key, body);
      const retry = await postCharge(mock, key, body);

      expect(first.status).toBe(201);
      expect((first.body as Charge).status).toBe('declined');
      expect(retry).toEqual({ status: 200, body: first.body });
      expect(await countCharges(pool)).toBe(1);
    } finally {
      await mock.close();
    }
  });

  it('never declines a retry, even at a decline rate of 1', async () => {
    const calm = await startMock(pool, faultsOf({}));
    const declining = await startMock(pool, faultsOf({ declineRate: 1 }));
    const key = `pay:${randomUUID()}`;
    const body = newCharge();

    try {
      const first = await postCharge(calm, key, body);
      const retry = await postCharge(declining, key, body);

      expect(retry).toEqual({ status: 200, body: first.body });
      expect((retry.body as Charge).status).toBe('succeeded');
    } finally {
      await calm.close();
      await declining.close();
    }
  });

  it('charges, then drops the response; a retry with the key gets that one charge back', async () => {
    const mock = await startMock(pool, faultsOf({ lostResponseRate: 1 }));
    const key = `pay:${randomUUID()}`;
    const body = newCharge();

    try {
      // The client sees a failed connection, as if the network had cut out after the charge.
      await expect(postCharge(mock, key, body)).rejects.toThrow('fetch failed');
      expect(await countCharges(pool, `key = $1 AND status = 'succeeded'`, [key])).toBe(1);

      const retry = await postCharge(mock, key, body);

      expect(retry.status).toBe(200);
      expect(retry.body).toMatchObject({ key, status: 'succeeded', orderId: body.orderId });
      expect(await countCharges(pool)).toBe(1);
    } finally {
      await mock.close();
    }
  });

  it('adds latency to a first attempt only, never to a retry or a refused request', async () => {
    const { sleeps, sleep } = recordSleeps();
    const mock = await startMock(
      pool,
      // One number for the delay, then one each for the decline and lost-response rolls.
      faultsOf(
        { latencyMinMs: 100, latencyMaxMs: 800 },
        { random: randomFrom(0.25, 0.99, 0.99), sleep },
      ),
    );
    const key = `pay:${randomUUID()}`;
    const body = newCharge();

    try {
      await postCharge(mock, key, body);
      await postCharge(mock, key, body);
      await postCharge(mock, undefined, body);
      await postCharge(mock, key, { ...body, amountPaise: 1 });

      expect(sleeps).toEqual([275]);
    } finally {
      await mock.close();
    }
  });
});
