import type { PaymentClient } from '../../src/checkout/payment-client.js';

// For tests whose routes never reach checkout: any call means a test went somewhere unexpected.
export const NO_PAYMENTS: PaymentClient = {
  charge: () => Promise.reject(new Error('This test does not expect a charge.')),
  refund: () => Promise.reject(new Error('This test does not expect a refund.')),
};
