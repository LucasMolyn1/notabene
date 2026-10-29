// Erreurs normalisées RFC 9457 (application/problem+json) pour les versions v2 et suivantes.
import { STATUS_CODES } from 'node:http';

export const usesProblemFormat = (url: string) => /^\/api\/v[2-9]\d*\//.test(url);

export interface Problem {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance: string;
  [extension: string]: unknown;
}

export function problem(status: number, detail: string, instance: string, extensions: Record<string, unknown> = {}): Problem {
  const { type = 'about:blank', ...rest } = extensions as { type?: string };
  return { type, title: STATUS_CODES[status] ?? 'Erreur', status, detail, instance: instance.split('?')[0]!, ...rest };
}
