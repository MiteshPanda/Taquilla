import { useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { z } from 'zod';
import { loginSchema, signupSchema } from '../../../api/src/auth/rules.js';
import type { Credentials } from '../../../api/src/auth/rules.js';
import type { ApiClient } from '../api/client.js';
import { ApiError } from '../api/errors.js';
import { demoFanEmail } from './demo.js';
import type { SessionNotice, SessionStore } from './session.js';

type Mode = 'login' | 'signup';
type Field = 'email' | 'password';
export type FieldErrors = Partial<Record<Field, string>>;

const COPY = {
  login: {
    title: 'Log in',
    submit: 'Log in',
    pending: 'Logging in…',
    switchPrompt: 'New here?',
    switchTo: 'Sign up',
    passwordAutoComplete: 'current-password',
  },
  signup: {
    title: 'Sign up',
    submit: 'Sign up',
    pending: 'Signing up…',
    switchPrompt: 'Have an account?',
    switchTo: 'Log in',
    passwordAutoComplete: 'new-password',
  },
} as const;

export const EXPIRED_NOTICE = 'Your session has expired. Log in again.';
export const DEMO_NOT_SEEDED =
  "The demo fans aren't set up yet. Run npm run reset, then try again.";
const UNEXPECTED = 'Something went wrong. Please try again.';

// The first problem with each field, in the API's own words, since both use the same rules.
export function fieldErrorsOf(error: z.ZodError): FieldErrors {
  const errors: FieldErrors = {};
  for (const issue of error.issues) {
    const field = issue.path[0];
    if ((field === 'email' || field === 'password') && errors[field] === undefined) {
      errors[field] = issue.message;
    }
  }
  return errors;
}

export interface AuthPageProps {
  api: ApiClient;
  session: SessionStore;
  notice: SessionNotice | null;
  demoPassword: string;
  random?: (() => number) | undefined;
}

export function AuthPage({ api, session, notice, demoPassword, random }: AuthPageProps) {
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const emailInput = useRef<HTMLInputElement>(null);
  const passwordInput = useRef<HTMLInputElement>(null);
  const id = useId();
  const copy = COPY[mode];

  async function logInWith(credentials: Credentials, { signUpFirst = false, demo = false } = {}) {
    setPending(true);
    setFormError(null);
    try {
      if (signUpFirst) await api.signUp(credentials);
      session.logIn(await api.logIn(credentials), credentials.email);
      // The page now shows the logged-in view, which replaces this one.
    } catch (err) {
      setPending(false);
      if (demo && err instanceof ApiError && err.code === 'UNAUTHORIZED') {
        setFormError(DEMO_NOT_SEEDED);
      } else {
        setFormError(err instanceof ApiError ? err.message : UNEXPECTED);
      }
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const result = (mode === 'login' ? loginSchema : signupSchema).safeParse({ email, password });
    if (!result.success) {
      const errors = fieldErrorsOf(result.error);
      setFieldErrors(errors);
      setFormError(null);
      (errors.email === undefined ? passwordInput : emailInput).current?.focus();
      return;
    }
    setFieldErrors({});
    void logInWith(result.data, { signUpFirst: mode === 'signup' });
  }

  function logInAsDemoFan() {
    setFieldErrors({});
    void logInWith({ email: demoFanEmail(random), password: demoPassword }, { demo: true });
  }

  function switchMode() {
    setMode(mode === 'login' ? 'signup' : 'login');
    setFieldErrors({});
    setFormError(null);
  }

  const emailErrorId = `${id}-email-error`;
  const passwordErrorId = `${id}-password-error`;

  return (
    <section className="auth" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>{copy.title}</h2>
      {notice === 'expired' && (
        <p className="notice" role="status">
          {EXPIRED_NOTICE}
        </p>
      )}
      {/* The shared rules check the form, so the browser's own checks and wording stay out. */}
      <form noValidate onSubmit={submit}>
        <fieldset disabled={pending}>
          <div className="field">
            <label htmlFor={`${id}-email`}>Email</label>
            <input
              ref={emailInput}
              id={`${id}-email`}
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              aria-invalid={fieldErrors.email !== undefined}
              aria-describedby={fieldErrors.email === undefined ? undefined : emailErrorId}
            />
            {fieldErrors.email !== undefined && (
              <p id={emailErrorId} className="field-error">
                {fieldErrors.email}
              </p>
            )}
          </div>
          <div className="field">
            <label htmlFor={`${id}-password`}>Password</label>
            <input
              ref={passwordInput}
              id={`${id}-password`}
              type="password"
              autoComplete={copy.passwordAutoComplete}
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              aria-invalid={fieldErrors.password !== undefined}
              aria-describedby={fieldErrors.password === undefined ? undefined : passwordErrorId}
            />
            {fieldErrors.password !== undefined && (
              <p id={passwordErrorId} className="field-error">
                {fieldErrors.password}
              </p>
            )}
          </div>
          {formError !== null && (
            <p className="form-error" role="alert">
              {formError}
            </p>
          )}
          <div className="actions">
            <button type="submit">{pending ? copy.pending : copy.submit}</button>
            <button type="button" className="secondary" onClick={logInAsDemoFan}>
              Log in as demo fan
            </button>
          </div>
          <p className="switch">
            {copy.switchPrompt}{' '}
            <button type="button" className="link" onClick={switchMode}>
              {copy.switchTo}
            </button>
          </p>
        </fieldset>
      </form>
    </section>
  );
}
