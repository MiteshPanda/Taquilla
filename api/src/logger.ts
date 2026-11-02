import { pino } from 'pino';
import type { DestinationStream, Logger } from 'pino';
import type { Config } from './config.js';

const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  'password',
  'token',
  '*.password',
  '*.token',
];

export function createLogger(level: Config['LOG_LEVEL'], destination?: DestinationStream): Logger {
  return pino({ level, redact: REDACTED_PATHS }, destination);
}
