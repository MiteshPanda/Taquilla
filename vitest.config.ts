import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['{api,payments-mock,web}/test/**/*.test.ts'],
    // Test files share one Postgres database, so they must not run at the same time.
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      include: ['{api,payments-mock,web}/src/**/*.ts'],
      thresholds: {
        'api/src/holds/**': { lines: 80 },
        'api/src/checkout/**': { lines: 80 },
        'api/src/idempotency/**': { lines: 80 },
        'web/src/api/**': { lines: 80 },
        // The mock's entry points run in child processes, which coverage can't see.
        'payments-mock/src/{app,charges,errors,faults,migrate,routes}.ts': { lines: 80 },
      },
    },
  },
});
