import type { Logger } from 'pino';

// The payment mock's startEmbeddedPayments (payments-mock/src/embedded.ts), as the API uses it.
// test/embedded-payments.test.ts checks that the mock's own type still fits this one.
export interface EmbeddedPayments {
  url: string;
  close(): Promise<void>;
}

export type StartEmbeddedPayments = (options: {
  connectionString: string;
  logger: Logger;
}) => Promise<EmbeddedPayments>;

// The mock is its own package, so the API's build doesn't compile it: the image carries its
// compiled code beside the API's, and under tsx the source is loaded as it is. Loaded only when
// PAYMENTS_IN_PROCESS is on, so nothing else depends on it.
export async function loadEmbeddedPayments(
  from: string = import.meta.url,
): Promise<StartEmbeddedPayments> {
  const file = from.endsWith('.ts')
    ? '../../../payments-mock/src/embedded.ts'
    : '../../../payments-mock/dist/embedded.js';
  const loaded: unknown = await import(new URL(file, from).href);
  const start =
    typeof loaded === 'object' && loaded !== null && 'startEmbeddedPayments' in loaded
      ? loaded.startEmbeddedPayments
      : undefined;
  if (typeof start !== 'function') {
    throw new Error(`${file} doesn't export startEmbeddedPayments.`);
  }
  return start as StartEmbeddedPayments;
}
