import type { BookingStrategy } from '../config.js';
import { createLockStrategy } from './lock.js';
import type { HoldStrategy, StrategyOptions } from './strategy.js';

// Placeholder until WP 3.3 builds cas and serializable. No route calls hold() yet;
// POST /events/:id/holds arrives in WP 3.4.
function notBuiltYet(name: BookingStrategy): () => HoldStrategy {
  return () => ({
    name,
    hold: () => Promise.reject(new Error(`The ${name} hold strategy is not built yet.`)),
  });
}

// A Record, so TypeScript fails the build if a strategy named in config has no implementation.
const STRATEGIES: Record<BookingStrategy, (options: StrategyOptions) => HoldStrategy> = {
  lock: createLockStrategy,
  cas: notBuiltYet('cas'),
  serializable: notBuiltYet('serializable'),
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
