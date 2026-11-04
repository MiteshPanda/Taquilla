import type { BookingStrategy } from '../config.js';
import { createCasStrategy } from './cas.js';
import { createLockStrategy } from './lock.js';
import { createSerializableStrategy } from './serializable.js';
import type { HoldStrategy, StrategyOptions } from './strategy.js';

// A Record, so TypeScript fails the build if a strategy named in config has no implementation.
const STRATEGIES: Record<BookingStrategy, (options: StrategyOptions) => HoldStrategy> = {
  lock: createLockStrategy,
  cas: createCasStrategy,
  serializable: createSerializableStrategy,
};

// Called once at startup with the validated BOOKING_STRATEGY.
export function createHoldStrategy(name: BookingStrategy, options: StrategyOptions): HoldStrategy {
  const create = STRATEGIES[name] as ((options: StrategyOptions) => HoldStrategy) | undefined;
  // Config validation already stops an unknown name, so this only guards a caller that skips it.
  if (create === undefined) {
    throw new Error(`Unknown booking strategy "${String(name)}".`);
  }
  return create(options);
}
