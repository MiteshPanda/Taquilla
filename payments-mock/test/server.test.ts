import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DOWN_DATABASE_URL } from './helpers/mock.js';

const SERVER = path.resolve(import.meta.dirname, '../src/server.ts');

interface Run {
  child: ChildProcessWithoutNullStreams;
  output: () => { stdout: string; stderr: string };
  // Resolves with the port once the server logs that it is listening.
  listening: Promise<number>;
  exited: Promise<number | null>;
}

// Starts the real server in its own process, as `npm run payments` would. Nothing here needs a
// database: the pool only connects on its first query.
function startServer(env: Record<string, string>): Run {
  const child = spawn(process.execPath, ['--import', 'tsx', SERVER], {
    env: {
      ...process.env,
      LOG_LEVEL: 'info',
      DATABASE_URL: DOWN_DATABASE_URL,
      PAYMENTS_PORT: '0',
      ...env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  const exited = once(child, 'exit').then(([code]) => code as number | null);
  const listening = new Promise<number>((resolve, reject) => {
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      const port = /"port":(\d+).*"msg":"payments mock listening"/.exec(stdout)?.[1];
      if (port) resolve(Number(port));
    });
    void exited.then(() => reject(new Error(`The server exited before listening:\n${stderr}`)));
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  // A test that expects an early exit never awaits this, so its rejection must not go unhandled.
  listening.catch(() => undefined);

  return { child, output: () => ({ stdout, stderr }), listening, exited };
}

describe('the payments mock process', { timeout: 30_000 }, () => {
  it('serves /health on its port and logs its fault settings', async () => {
    const run = startServer({ DECLINE_RATE: '0.1' });

    try {
      const port = await run.listening;
      const response = await fetch(`http://127.0.0.1:${port}/health`);

      expect(response.status).toBe(200);
      expect(run.output().stdout).toContain(
        '"faults":{"declineRate":0.1,"lostResponseRate":0.02,"latencyMinMs":100,"latencyMaxMs":800}',
      );
    } finally {
      run.child.kill();
      await run.exited;
    }
  });

  it('refuses to start with a bad setting, naming it', async () => {
    const run = startServer({ LOST_RESPONSE_RATE: '2' });

    expect(await run.exited).toBe(1);
    expect(run.output().stderr).toContain('LOST_RESPONSE_RATE');
  });

  // Windows can't deliver SIGTERM to another process, so this runs in CI on Linux.
  it.skipIf(process.platform === 'win32')('stops cleanly on SIGTERM', async () => {
    const run = startServer({});
    await run.listening;

    run.child.kill('SIGTERM');

    expect(await run.exited).toBe(0);
    expect(run.output().stdout).toContain('"msg":"payments mock stopped"');
  });
});
