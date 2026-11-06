import { loadAuditConfig } from '../api/src/config.js';
import { createLogger } from '../api/src/logger.js';
import { formatReport, runAudit } from './audit.js';

// Exit codes: 0 when every rule holds, 1 when one is broken (FR-AUD-2), 2 when the audit
// couldn't run at all, such as with the database down or not migrated.
const config = loadAuditConfig();
const logger = createLogger(config.LOG_LEVEL);

try {
  const report = await runAudit({ connectionString: config.DATABASE_URL });
  console.log(formatReport(report));
  process.exitCode = report.passed ? 0 : 1;
} catch (err) {
  logger.fatal({ err }, 'audit could not run; is the database up and migrated (npm run migrate)?');
  process.exitCode = 2;
}
