import { pino } from 'pino';
import type { DestinationStream, Logger } from 'pino';
import type { Config } from './config.js';

// Every line names the service, so the mock's logs stand apart from the API's in a shared terminal.
export function createLogger(level: Config['LOG_LEVEL'], destination?: DestinationStream): Logger {
  return pino({ level }, destination).child({ service: 'payments-mock' });
}
