import type { Request, RequestHandler } from 'express';
import { AppError } from '../errors.js';
import { verifyToken } from './tokens.js';

// A JWT is three base64url parts joined by dots.
const BEARER = /^Bearer ([\w-]+\.[\w-]+\.[\w-]+)$/i;

const userIds = new WeakMap<Request, number>();

export function requireAuth(secret: string): RequestHandler {
  return (req, _res, next) => {
    const token = BEARER.exec(req.headers.authorization ?? '')?.[1];
    if (token === undefined) {
      throw new AppError(401, 'UNAUTHORIZED', 'Log in to continue.');
    }
    userIds.set(req, verifyToken(token, secret));
    next();
  };
}

// Fails closed: a route that forgot requireAuth answers 401 instead of acting for nobody.
export function userIdOf(req: Request): number {
  const userId = userIds.get(req);
  if (userId === undefined) {
    throw new AppError(401, 'UNAUTHORIZED', 'Log in to continue.');
  }
  return userId;
}
