import { STATUS_CODES } from 'node:http';
import type { z } from 'zod';

/** An error whose message is safe to show to the client (always 4xx). */
export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly code: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const badRequest = (message: string, code = 'bad_request', details?: unknown) =>
  new HttpError(400, message, code, details);
export const unauthorized = (message: string, code = 'unauthorized') => new HttpError(401, message, code);
export const notFound = (message = 'Not found', code = 'not_found') => new HttpError(404, message, code);
export const conflict = (message: string, code: string) => new HttpError(409, message, code);

export const invalidCredentials = () =>
  new HttpError(401, 'Email or password is incorrect.', 'invalid_credentials');

export function statusText(status: number): string {
  return STATUS_CODES[status] ?? 'Error';
}

const DEFAULT_CODES: Record<number, string> = {
  400: 'bad_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  405: 'method_not_allowed',
  406: 'not_acceptable',
  408: 'request_timeout',
  409: 'conflict',
  413: 'payload_too_large',
  415: 'unsupported_media_type',
  429: 'rate_limited',
};

export function defaultCode(status: number): string {
  return DEFAULT_CODES[status] ?? (status >= 500 ? 'internal_error' : 'error');
}

/** Parse untrusted input with a zod schema or throw a 400 with the first problem in the message. */
export function parseOrThrow<S extends z.ZodType>(schema: S, data: unknown): z.output<S> {
  const result = schema.safeParse(data ?? {});
  if (result.success) return result.data;
  const issues = result.error.issues.map(i => ({ path: i.path.join('.'), message: i.message }));
  const first = issues[0];
  const message = first
    ? first.path
      ? `${first.path}: ${first.message}`
      : first.message
    : 'Invalid request';
  throw new HttpError(400, `Validation failed — ${message}`, 'validation_failed', issues);
}
