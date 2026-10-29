import { randomBytes } from 'node:crypto';
import { z } from 'zod';

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export const newId = () => randomBytes(9).toString('base64url');

export const idSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'identifiant invalide');

export const idParams = z.object({ id: idSchema });
