import { setTimeout as wait } from 'node:timers/promises';

export interface FaultSettings {
  declineRate: number;
  lostResponseRate: number;
  latencyMinMs: number;
  latencyMaxMs: number;
}

// Faults are random, so tests can supply the random source and the clock to make them exact.
export interface FaultSources {
  random?: () => number;
  sleep?: (ms: number) => Promise<unknown>;
}

// What the provider gets wrong on purpose (FR-MOCK-5). The charge route asks these only on a
// key's first attempt, so a retry with the same key always gets a fast, faithful answer.
export interface Faults {
  // Waits a random time between the minimum and maximum latency, as a real provider would.
  delay(): Promise<void>;
  // Whether this new charge is declined.
  decline(): boolean;
  // Whether this new charge's response is dropped after the charge has been recorded.
  loseResponse(): boolean;
}

export const NO_FAULTS: FaultSettings = {
  declineRate: 0,
  lostResponseRate: 0,
  latencyMinMs: 0,
  latencyMaxMs: 0,
};

export function createFaults(
  settings: FaultSettings,
  { random = Math.random, sleep = wait }: FaultSources = {},
): Faults {
  const { declineRate, lostResponseRate, latencyMinMs, latencyMaxMs } = settings;

  return {
    async delay() {
      const ms = latencyMinMs + Math.floor(random() * (latencyMaxMs - latencyMinMs + 1));
      if (ms > 0) await sleep(ms);
    },
    // random() is below 1, so a rate of 1 always fires; it is never below 0, so 0 never does.
    decline: () => random() < declineRate,
    loseResponse: () => random() < lostResponseRate,
  };
}
