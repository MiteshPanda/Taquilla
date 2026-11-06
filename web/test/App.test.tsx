// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../src/App.js';
import { DEMO_NOT_SEEDED, EXPIRED_NOTICE } from '../src/auth/AuthPage.js';
import { STORAGE_KEY } from '../src/auth/session.js';
import { DEFAULT_DEMO_PASSWORD } from '../src/config.js';
import { createServices } from '../src/services.js';
import type { Call } from './helpers.js';
import { bodyOf, fakeFetch, json, makeToken } from './helpers.js';

const HOUR = 3_600_000;
const PASSWORD_RULE = 'Use a password of at least 8 characters and at most 72 bytes.';
const INCORRECT = {
  error: { code: 'UNAUTHORIZED', message: 'The email or password is incorrect.' },
};

type Route = (call: Call) => Response | Promise<Response>;

// The API as the page sees it: /health answers, and each test says what the auth routes do.
function renderApp(routes: Record<string, Route> = {}, random = () => 0.006) {
  const { calls, fetch } = fakeFetch((call) => {
    const route = `${call.init.method} ${new URL(call.url).pathname}`;
    if (route === 'GET /health') return json(200, { status: 'ok' });
    const answer = routes[route];
    if (answer === undefined) throw new Error(`Unexpected request: ${route}`);
    return answer(call);
  });
  const services = createServices({}, window, fetch);
  render(<App services={services} random={random} />);
  const authCalls = () => calls.filter((call) => !call.url.endsWith('/health'));
  return { services, authCalls };
}

function fill(email: string, password: string) {
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: email } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: password } });
}

function click(name: string) {
  fireEvent.click(screen.getByRole('button', { name }));
}

const loggedIn = () => screen.findByText(/Logged in as/);

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
});

afterEach(() => {
  cleanup();
});

describe('the forms check what the API checks, in its words, before sending anything', () => {
  it('refuses a bad email and a short password on sign-up, and points at the first', () => {
    const { authCalls } = renderApp();
    click('Sign up');

    fill('not-an-email', 'short');
    click('Sign up');

    const email = screen.getByLabelText('Email');
    expect(screen.getByText('Enter a valid email address.')).toBeTruthy();
    expect(screen.getByText(PASSWORD_RULE)).toBeTruthy();
    expect(email.getAttribute('aria-invalid')).toBe('true');
    expect(document.getElementById(email.getAttribute('aria-describedby') ?? '')?.textContent).toBe(
      'Enter a valid email address.',
    );
    expect(document.activeElement).toBe(email);
    expect(authCalls()).toEqual([]);
  });

  it('counts a sign-up password in bytes, as bcrypt does: 37 é are 74 bytes', () => {
    const { authCalls } = renderApp();
    click('Sign up');

    fill('fan@taquilla.test', 'é'.repeat(37));
    click('Sign up');

    expect(screen.getByText(PASSWORD_RULE)).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByLabelText('Password'));
    expect(authCalls()).toEqual([]);
  });

  it('asks a login only for some password, as the API does, not for its length', async () => {
    const { authCalls } = renderApp({ 'POST /auth/login': () => json(401, INCORRECT) });

    click('Log in');
    expect(screen.getByText('Enter your password.')).toBeTruthy();
    expect(authCalls()).toEqual([]);

    fill('fan@taquilla.test', 'x');
    click('Log in');

    expect((await screen.findByRole('alert')).textContent).toBe(INCORRECT.error.message);
    expect(screen.queryByText('Enter your password.')).toBeNull();
    expect(authCalls()).toHaveLength(1);
  });

  it('clears the errors when switching between logging in and signing up', () => {
    renderApp();
    click('Log in');
    expect(screen.getByText('Enter a valid email address.')).toBeTruthy();

    click('Sign up');

    expect(screen.queryByText('Enter a valid email address.')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Sign up' })).toBeTruthy();
  });
});

describe('logging in', () => {
  it('sends the email as the API stores it, and keeps the session in this tab only', async () => {
    const token = makeToken(Date.now() + HOUR);
    const { authCalls } = renderApp({ 'POST /auth/login': () => json(200, { token }) });

    fill('  Fan7@Taquilla.TEST ', 'correct horse');
    click('Log in');

    expect((await loggedIn()).textContent).toBe('Logged in as fan7@taquilla.test');
    expect(bodyOf(authCalls()[0])).toEqual({
      email: 'fan7@taquilla.test',
      password: 'correct horse',
    });
    expect(JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? 'null')).toEqual({
      token,
      email: 'fan7@taquilla.test',
    });
    expect(localStorage.length).toBe(0);
  });

  it("shows the API's refusal and lets the fan try again", async () => {
    renderApp({ 'POST /auth/login': () => json(401, INCORRECT) });

    fill('fan@taquilla.test', 'wrong password');
    click('Log in');

    expect((await screen.findByRole('alert')).textContent).toBe(INCORRECT.error.message);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Log in' }).disabled).toBe(false);
    expect(screen.queryByText(/Logged in as/)).toBeNull();
    expect(sessionStorage.length).toBe(0);
  });

  it('shows when the API is out of reach', async () => {
    renderApp({ 'POST /auth/login': () => Promise.reject(new TypeError('Failed to fetch')) });

    fill('fan@taquilla.test', 'correct horse');
    click('Log in');

    expect((await screen.findByRole('alert')).textContent).toBe(
      "Can't reach Taquilla. Check your connection and try again.",
    );
  });

  it('locks the form while it waits for the API', async () => {
    const answer = Promise.withResolvers<Response>();
    renderApp({ 'POST /auth/login': () => answer.promise });

    fill('fan@taquilla.test', 'correct horse');
    click('Log in');

    const pending = screen.getByRole<HTMLButtonElement>('button', { name: 'Logging in…' });
    expect(pending.closest('fieldset')?.disabled).toBe(true);

    answer.resolve(json(200, { token: makeToken(Date.now() + HOUR) }));
    await loggedIn();
  });
});

describe('signing up', () => {
  it('creates the account, then logs straight in', async () => {
    const token = makeToken(Date.now() + HOUR);
    const { authCalls } = renderApp({
      'POST /auth/signup': () => json(201, { id: 1001, email: 'new@taquilla.test' }),
      'POST /auth/login': () => json(200, { token }),
    });
    click('Sign up');

    fill('New@Taquilla.test', 'a long password');
    click('Sign up');

    expect((await loggedIn()).textContent).toBe('Logged in as new@taquilla.test');
    const sent = { email: 'new@taquilla.test', password: 'a long password' };
    expect(authCalls().map((call) => [new URL(call.url).pathname, bodyOf(call)])).toEqual([
      ['/auth/signup', sent],
      ['/auth/login', sent],
    ]);
  });

  it('says so when the email already has an account', async () => {
    const message = 'An account with this email already exists. Log in instead.';
    const { authCalls } = renderApp({
      'POST /auth/signup': () => json(409, { error: { code: 'EMAIL_TAKEN', message } }),
    });
    click('Sign up');

    fill('fan7@taquilla.test', 'a long password');
    click('Sign up');

    expect((await screen.findByRole('alert')).textContent).toBe(message);
    expect(authCalls()).toHaveLength(1);
  });
});

describe('the demo fan', () => {
  it('logs in as a random seeded fan with the demo password, whatever the form holds', async () => {
    const { authCalls } = renderApp(
      { 'POST /auth/login': () => json(200, { token: makeToken(Date.now() + HOUR) }) },
      () => 0.006,
    );
    fill('half typed', '');

    click('Log in as demo fan');

    expect((await loggedIn()).textContent).toBe('Logged in as fan7@taquilla.test');
    expect(bodyOf(authCalls()[0])).toEqual({
      email: 'fan7@taquilla.test',
      password: DEFAULT_DEMO_PASSWORD,
    });
  });

  it("says how to seed the demo fans when the API doesn't know them", async () => {
    renderApp({ 'POST /auth/login': () => json(401, INCORRECT) });

    click('Log in as demo fan');

    expect((await screen.findByRole('alert')).textContent).toBe(DEMO_NOT_SEEDED);
  });

  it('shows any other failure in the API’s words', async () => {
    const message = 'Too many attempts. Wait a minute, then try again.';
    renderApp({
      'POST /auth/login': () => json(429, { error: { code: 'RATE_LIMITED', message } }),
    });

    click('Log in as demo fan');

    expect((await screen.findByRole('alert')).textContent).toBe(message);
  });
});

describe('the end of a session', () => {
  it('logs out back to the login form, with no notice and nothing stored', async () => {
    renderApp({ 'POST /auth/login': () => json(200, { token: makeToken(Date.now() + HOUR) }) });
    click('Log in as demo fan');
    await loggedIn();

    click('Log out');

    expect(screen.getByRole('heading', { name: 'Log in' })).toBeTruthy();
    expect(screen.queryByText(EXPIRED_NOTICE)).toBeNull();
    expect(sessionStorage.length).toBe(0);
  });

  it('sends the fan back to login with a notice when the session expires', async () => {
    const { services } = renderApp({
      'POST /auth/login': () => json(200, { token: makeToken(Date.now() + HOUR) }),
    });
    click('Log in as demo fan');
    await loggedIn();

    act(() => services.session.expire());

    expect(screen.getByRole('heading', { name: 'Log in' })).toBeTruthy();
    expect(screen.getByText(EXPIRED_NOTICE)).toBeTruthy();
  });

  it('opens on login with a notice when the tab kept an expired token', () => {
    sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ token: makeToken(Date.now() - 1), email: 'fan7@taquilla.test' }),
    );

    renderApp();

    expect(screen.getByText(EXPIRED_NOTICE)).toBeTruthy();
    expect(screen.queryByText(/Logged in as/)).toBeNull();
  });

  it('opens logged in when the tab kept a live token', async () => {
    sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ token: makeToken(Date.now() + HOUR), email: 'fan7@taquilla.test' }),
    );

    renderApp();

    expect((await loggedIn()).textContent).toBe('Logged in as fan7@taquilla.test');
    await waitFor(() => expect(screen.getByText(/is up/)).toBeTruthy());
  });
});
