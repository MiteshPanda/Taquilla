import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { createLogger, defineConfig, loadEnv } from 'vite';
import type { Logger, Plugin } from 'vite';
import { parseWebConfig } from './src/config.js';

// The repo's one .env, shared with the API. Vite hands only VITE_ variables to the page, so the
// API's secrets in the same file never reach the browser.
const envDir = resolve(import.meta.dirname, '..');

// The API allows exactly this origin (CORS_ORIGINS), so the page must never move to another port.
const PORT = 5173;

// `npm run build` must finish with zero warnings, so the build fails on the first one.
function failOnWarnings(logger: Logger): Plugin {
  let warnings = 0;
  const warn = logger.warn.bind(logger);
  const warnOnce = logger.warnOnce.bind(logger);
  logger.warn = (message, options) => {
    warnings += 1;
    warn(message, options);
  };
  logger.warnOnce = (message, options) => {
    warnings += 1;
    warnOnce(message, options);
  };
  return {
    name: 'taquilla:fail-on-warnings',
    apply: 'build',
    closeBundle() {
      if (warnings > 0) throw new Error(`The build logged ${warnings} warning(s); fix them.`);
    },
  };
}

export default defineConfig(({ mode }) => {
  // Checked here as well as in the page, so a bad address stops the build or dev server at once.
  parseWebConfig(loadEnv(mode, envDir, 'VITE_'));

  const logger = createLogger();
  return {
    envDir,
    customLogger: logger,
    plugins: [react(), failOnWarnings(logger)],
    server: { port: PORT, strictPort: true },
    preview: { port: PORT, strictPort: true },
  };
});
