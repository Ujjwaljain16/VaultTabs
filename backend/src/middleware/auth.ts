/**
 * src/middleware/auth.ts
 *
 * JWT Authentication middleware.
 *
 * WHAT IS A JWT?
 * JWT = JSON Web Token. It's like a signed hall pass.
 * When you log in, the server gives you a token (a long string).
 * You send that token with every request to prove who you are.
 * The server verifies the token's signature to make sure it's real.
 *
 * FORMAT: header.payload.signature
 * Example: eyJhbGciOiJIUzI1NiJ9.eyJ1c2VySWQiOiIxMjMifQ.abc123...
 *
 * The payload (middle part) contains: { userId, email, exp (expiry) }
 * Anyone can decode and READ the payload — it's not encrypted.
 * But only the server can SIGN it (using JWT_SECRET).
 * So if someone tampers with it, the signature breaks and we reject it.
 *
 * HOW TO USE:
 * Add `preHandler: [authenticate]` to any route that requires login.
 * Then access `request.user` to get the logged-in user's info.
 */

import { FastifyRequest, FastifyReply } from 'fastify';

// Extend Fastify's types so TypeScript knows about request.user
declare module 'fastify' {
  interface FastifyRequest {
    user: {
      userId: string;
      email: string;
    };
  }
}

/**
 * Middleware that checks for a valid JWT token.
 * Attach this to routes that require authentication.
 *
 * The client sends the token in the Authorization header like:
 *   Authorization: Bearer eyJhbGciOiJ...
 */
export async function authenticate(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  try {
    // `jwtVerify` is added to `request` by the @fastify/jwt plugin (set up in index.ts)
    // It checks the Authorization header automatically
    await request.jwtVerify();
  } catch (error) {
    // If token is missing, expired, or tampered with → 401 Unauthorized
    reply.status(401).send({
      error: 'Unauthorized',
      message: 'You must be logged in to access this resource. Include your JWT token in the Authorization header.',
    });
  }
}