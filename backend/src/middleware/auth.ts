// JWT authentication with server-side revocation.
//
// Tokens carry { sub: user id, tv: token_version }. Bumping users.token_version (password change,
// recovery, "sign out everywhere") or deleting the user invalidates every token issued before.

import type { FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import '@fastify/jwt';
import { HttpError } from '../errors.js';
import type { UserRepository } from '../repositories/user.repository.js';
import { isUuid } from '../schemas.js';
import type { TokenClaims } from '../services/auth.service.js';

export interface AuthUser {
  userId: string;
  email: string;
  /** token_version the token was issued for (long-lived streams re-check it). */
  tokenVersion: number;
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: TokenClaims;
    user: AuthUser;
  }
}

const tokenInvalid = () =>
  new HttpError(401, 'Your session has ended. Please log in again.', 'token_invalid');

export function createAuthenticate(users: UserRepository): preHandlerAsyncHookHandler {
  return async function authenticate(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const header = request.headers.authorization;
    const match = header ? /^Bearer\s+(\S+)\s*$/i.exec(header) : null;
    if (!match) {
      throw new HttpError(
        401,
        'Authentication required: send Authorization: Bearer <token>.',
        'unauthorized',
      );
    }

    let claims: TokenClaims;
    try {
      claims = request.server.jwt.verify<TokenClaims>(match[1]!);
    } catch {
      throw tokenInvalid();
    }
    if (!isUuid(claims.sub) || !Number.isInteger(claims.tv)) throw tokenInvalid();

    const state = await users.findTokenState(claims.sub);
    if (!state || state.token_version !== claims.tv) throw tokenInvalid();

    request.user = { userId: claims.sub, email: state.email, tokenVersion: claims.tv };
  };
}
