# 5. Keep the login token in sessionStorage

- **Status:** Accepted
- **Date:** 7 Nov 2026

## Context

Login answers with a signed JWT (FR-AUTH-2) that lasts `JWT_EXPIRES_IN`, an hour by default. Every booking call sends it as `Authorization: Bearer <token>`, so the web page has to keep it somewhere its own script can read.

Where it lives decides two things:

1. **What a script injected into the page could do.** Any storage the page's script can read, an injected script can read too, and could send away.
2. **How long a login lasts.** For example, whether a reload keeps the fan logged in, whether a second tab shares the login, and whether it survives closing the browser.

The page and the API are on different origins (`localhost:5173` and `localhost:3000`), and the API reads the token only from the header, never from a cookie. A browser never sends that header on its own, so another site can't make a request as the fan: there is no CSRF risk today.

## Decision

**The token is kept in the tab's `sessionStorage`, never in `localStorage`** (WP 7.2).

- **What is stored:** the token and the fan's email, under `taquilla.session`.
- **Logging out on time:** the page reads the token's own `exp` claim and ends the session the moment it passes.
  - **Without checking the signature:** the API checks that on every request; this only lets the page react in time.
  - **On load:** a stored token that has already expired is dropped, and the page shows "Your session has expired. Log in again."
- **A refused token:** any request whose token the API refuses with `401` ends the session at once, whichever part of the page sent it. That covers a token the clock didn't catch, such as one signed before the API's `JWT_SECRET` changed. The API client reports it through one `onUnauthorized` hook, so no screen has to remember to.
- **Storage blocked:** where the browser blocks site data, the session lives in the page's memory until the page closes.
- **The test that holds it:** `web/test/services.test.ts` fails if the session is ever written to `localStorage`.

## Consequences

**Why `sessionStorage`:**
- **A reload keeps the fan logged in,** so a hold's countdown survives it. A token kept only in memory would not.
- **Each tab is its own login.** Two tabs can be two different fans, which the WP 7.4 race demo uses. They can't silently share one fan either.
- **It ends with the tab.** Nothing is left behind for the next person on a shared computer. `localStorage` would keep the token until it expires, across every tab and browser restart.

**What it doesn't fix:**
- **An injected script can still read the token,** as it could from any storage the page's script can reach, and use it until it expires.
- **The page's defences are about not running such a script at all:**
  - React escapes everything it renders.
  - The page never sets raw HTML.
  - It loads no third-party scripts.
- **The token's short life limits the damage.**

**A new tab needs a new login.** That's a small cost for a booking page.

**A wrong clock:**
- **Ahead:** the page logs out a little early.
- **Behind:** the first request after expiry gets `401`, which ends the session.

## The upgrade: an httpOnly cookie

Before this runs anywhere real, the token should move into a cookie that scripts can't read at all. That needs changes on both sides.

**The API:**
- **Login sets the cookie:** `Set-Cookie: session=<jwt>; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=<JWT_EXPIRES_IN>`.
- **Login also returns `expiresAt`,** so the page can still log out on time.
- **A new `POST /auth/logout` clears the cookie,** since the page can no longer drop the token itself.
- **`requireAuth` reads the cookie.** Load tests can keep the header.

**CORS:**
- The API answers `Access-Control-Allow-Credentials: true` to the exact origins in `CORS_ORIGINS`, which never allow `*`.
- The page sends `credentials: 'include'`.

**Same site:**
- **Production:** serve the page and the API from one site, for example the API under `/api` behind the page's nginx (WP 8.1). Browsers increasingly block cookies sent to another site.
- **Locally,** `localhost:5173` and `localhost:3000` already count as the same site, since a site ignores the port.

**CSRF:**
- A cookie is sent automatically, so every route that changes something needs protection. `SameSite=Lax` stops other sites' `POST`s.
- **The API should also require a header a form can't send:**
  - JSON bodies already force a CORS preflight.
  - Checkout already requires an `Idempotency-Key`.
  - Holds and releases would need one too.

**What it buys:** an injected script can no longer steal the token to use elsewhere. It could still act as the fan while the page is open, so the defences above still matter.

**Why not now:** it needs a logout route, cookie parsing and CSRF rules in the API, outside M7's scope. The demo serves one site on a laptop, and the load tests rely on bearer tokens.

## Alternatives considered

- **`localStorage`:** rejected. It's shared by every tab and kept across browser restarts until the token expires.
- **Memory only:** rejected. A reload, or a mobile browser reclaiming the tab, would log the fan out in the middle of a hold.
- **An httpOnly cookie now:** deferred, for the reasons above.
