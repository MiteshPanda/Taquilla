## What and why

<!-- What changed, why, and the work package and requirement IDs it delivers. -->

## Production standard

Tick every line that applies, and strike through any that doesn't.

### Code

- [ ] TypeScript `strict` passes with no `any`; unknown data is parsed with Zod instead.
- [ ] ESLint and Prettier pass with zero warnings.
- [ ] Every body, query string, route parameter and environment variable is validated at the edge.
- [ ] Every SQL statement is parameterised; no SQL is ever built from strings.
- [ ] Every error is an `AppError` with a code from requirements.md §6.3. Nothing is swallowed, and no stack trace reaches a client.
- [ ] Every outside call has a timeout: HTTP calls, `statement_timeout` and `lock_timeout`.
- [ ] Money is integer paise, and every expiry decision uses the database clock.

### Tests

- [ ] New behaviour is tested against a real Postgres, never a mocked database.
- [ ] Any code that writes seats, holds, orders or charges gets a concurrency test.
- [ ] Tests are deterministic: they put `held_until` in the past instead of sleeping, and switch payment faults off unless the test is about faults.
- [ ] Line coverage stays at 80% or more for `holds`, `checkout` and `idempotency`.

### Logs and security

- [ ] Logs are structured JSON with the request ID; passwords, tokens and `Authorization` headers are redacted.
- [ ] No secret is committed. Every new environment variable goes into config validation, `.env.example` and the README table.
- [ ] Anything a fan owns returns `404` to everyone else.

### Docs and git

- [ ] The README, requirements.md and the OpenAPI spec (from M8) match the code; new dependencies are added to requirements.md §8.3.
- [ ] Commits follow Conventional Commits, such as `feat(holds): add lock strategy`.
- [ ] Nothing merges into `main` until CI is green, so `main` always runs.
