import { randomBytes } from 'node:crypto';
import { z } from 'zod';

// Retire les « / » finaux sans expression régulière : /\/+$/ est quadratique sur une entrée choisie par l'utilisateur.
export function trimTrailingSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 47) end--;
  return s.slice(0, end);
}

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
