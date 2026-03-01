// JWT Authentication middleware

import { FastifyRequest, FastifyReply } from 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    user: {
      userId: string;
      email: string;
    };
  }
}

export async function authenticate(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  try {
    await request.jwtVerify();
  } catch (error) {
    reply.status(401).send({
      error: 'Unauthorized',
      message: 'You must be logged in to access this resource. Include your JWT token in the Authorization header.',
    });
  }
}