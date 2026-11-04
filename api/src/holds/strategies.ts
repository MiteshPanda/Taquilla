import type { BookingStrategy } from '../config.js';
import type { Database } from '../db.js';
import type { HoldStrategy } from './strategy.js';

export interface StrategyOptions {
  db: Pick<Database, 'pool' | 'withTransaction'>;
  holdSeconds: number;
}

// Placeholder until WP 3.2 (lock) and WP 3.3 (cas, serializable) build the real ones. No route
// calls hold() yet; POST /events/:id/holds arrives in WP 3.4.
function notBuiltYet(name: BookingStrategy): () => HoldStrategy {
  return () => ({
    name,
    hold: () => Promise.reject(new Error(`The ${name} hold strategy is not built yet.`)),
  });
}

// A Record, so TypeScript fails the build if a strategy named in config has no implementation.
const STRATEGIES: Record<BookingStrategy, (options: StrategyOptions) => HoldStrategy> = {
  lock: notBuiltYet('lock'),
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
