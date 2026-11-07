# Deploying the live demo

WP 8.4. The demo runs on three free tiers:

| Part | Host | What runs there |
| --- | --- | --- |
| Database | [Neon](https://neon.tech) | PostgreSQL 16 |
| API | [Render](https://render.com) | One web service from `api/Dockerfile`, with the payment mock and the sweeper in the API's process |
| Page | [Vercel](https://vercel.com) | The static build of `web/` |

Each account is yours, and every secret goes only into that host's dashboard. Nothing secret is committed: `render.yaml` and `vercel.json` hold only the settings that aren't.

> **Never load-test the hosted demo.** The free tiers are small and shared, and their terms forbid it. The load tests are for a stack on your own machine.

## Why the API runs three things in one process

A free Render service sleeps after about 15 minutes without requests, and takes about a minute to wake.

- **A sleeping payment provider would time out every charge,** since the API gives a charge 3 seconds an attempt.
- **A sleeping sweeper would leave lapsed holds held,** breaking the audit's fourth rule.

So the API runs both in its own process, behind two settings:

- **`PAYMENTS_IN_PROCESS=true`:** starts the payment mock on a private port on `127.0.0.1`, after creating its `payments` schema, and sends charges there instead of to `PAYMENTS_URL`. It's the same mock, still called over HTTP.
- **`SWEEPER_IN_PROCESS=true`:** runs the sweeper on the API's own connection pool, every `SWEEP_INTERVAL_SECONDS`.

The local stack keeps them as separate services, as a real deployment would.

## 1. The database, on Neon

1. **Create a project** with PostgreSQL 16, in the region nearest the API: `AWS Asia Pacific (Singapore)` matches `render.yaml`'s `singapore`.
2. **Copy the direct connection string,** with **Connection pooling** switched off. The migrations and the seed take session-level advisory locks, which a transaction pooler doesn't keep. It looks like `postgresql://user:password@ep-….ap-southeast-1.aws.neon.tech/neondb?sslmode=require`.

You don't need to create any tables: the API migrates and seeds an empty database each time it starts.

## 2. The API, on Render

1. **Create the Blueprint:** in Render, **New > Blueprint**, then connect this GitHub repository. Render reads `render.yaml`.
2. **Fill in the two values it asks for:**
   - **`DATABASE_URL`:** the Neon string from step 1.
   - **`CORS_ORIGINS`:** the page's address. You don't know it until step 3, so put `https://example.com` for now.

   Render makes `JWT_SECRET` itself, and `render.yaml` sets the rest:
   - **`PAYMENTS_IN_PROCESS` and `SWEEPER_IN_PROCESS`** are `true`.
   - **`TRUST_PROXY`** is `1`, so the rate limit sees each fan's address rather than Render's proxy.
   - **`NODE_ENV`** is `production`, from the image.
3. **Wait for the first deploy.** It builds the image, then on start:
   - migrates the API's tables, skipping the dev-only table;
   - seeds 1 match, 2,000 seats and 1,000 fans, since the database is empty;
   - creates the mock's schema;
   - serves on Render's `PORT`.
4. **Check it:** `https://<your-service>.onrender.com/ready` should answer `{"status":"ready"}`, and `/events/1/seats/states` should answer `{"held":[],"sold":[]}`.

The seeded fans' password is `SEED_PASSWORD`, `taquilla-dev` by default. The page shows it to anyone through **Log in as demo fan**, which is the point of a demo. Keep that in mind if you change it.

## 3. The page, on Vercel

1. **Import the project:** in Vercel, **Add New > Project**, then import this repository. Keep **Root Directory** as the repository root, because `vercel.json` there sets the install, the build and the output folder.
2. **Set two environment variables** for Production:
   - **`VITE_API_URL`:** the Render address, such as `https://taquilla-api.onrender.com`.
   - **`VITE_DEMO_PASSWORD`:** the same value as `SEED_PASSWORD`, so `taquilla-dev` unless you changed it.

   Vite builds both into the page, so changing one needs a redeploy.
3. **Deploy,** then note the production address, such as `https://taquilla.vercel.app`.

`vercel.json` also sends the page's security headers:
- **A Content Security Policy:** only the page's own scripts, styles and fonts, and calls only to itself and `https://*.onrender.com`. If the API moves to its own domain, add that domain to `connect-src`.
- **Caching:** a year for the fingerprinted assets.

## 4. Connect them

1. **Point the API at the page:** in Render, set `CORS_ORIGINS` to the Vercel address from step 3. It has to be exactly that origin, `https://` and no trailing slash. Render redeploys.
2. **Book a seat:** open the Vercel address in a private window, as a stranger would, and:
   - press **Log in as demo fan**;
   - pick a seat and hold it;
   - check out and pay.

   That's WP 8.4's done-when. If the API was asleep, the first load of the seat map takes up to a minute; the page retries by itself.

## What to expect from the free tiers

- **Cold starts:** the API sleeps after about 15 minutes idle and wakes on the next request, which takes up to a minute. Neon's compute also suspends when idle and wakes in about a second.
- **Holds while asleep:** while the API sleeps, nothing runs, not even the sweeper. A lapsed hold already reads as free to every query, and the sweeper tidies it on the next start.
- **Faults:** the in-process mock still injects its default faults (5% declines, 2% lost answers, 100–800 ms latency), so a fan may see a decline and pay again. Set `DECLINE_RATE` and the others in Render to change them.
- **One instance:** the rate limit is kept in memory, which is right for a single free instance.

## Updating

- **Render** redeploys the API on every push to `main`.
- **Vercel** redeploys the page on every push to `main`, and builds a preview for every pull request. Previews have their own addresses, so their calls to the API are refused by CORS; only production works end to end.
