// Curseurs de pagination opaques (base64url d'un petit JSON). Validés à la lecture : un curseur forgé donne 400.
import { z } from 'zod';
import { HttpError } from './http.js';

export const encodeCursor = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

export function decodeCursor<T extends z.ZodType>(cursor: string | undefined, schema: T): z.output<T> | null {
  if (!cursor) return null;
  try {
    return schema.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
  } catch {
    throw new HttpError(400, 'Curseur invalide');
  }
}

export const pageQuery = z.object({
  cursor: z.string().max(300).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
