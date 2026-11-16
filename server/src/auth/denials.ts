// Refus d'un jeton d'API : la raison est notée sur la requête là où elle est connue (portée insuffisante, espace hors du
// périmètre du jeton), puis journalisée après la réponse (lib/token-activity.ts) sous l'action `auth.denied`. La réponse au
// jeton ne change pas : un espace hors périmètre reste « introuvable ». Le journal est réservé aux administrateurs.
import type { FastifyRequest } from 'fastify';

export type DenialReason = 'scope' | 'space' | 'forbidden';
const marks = new WeakMap<object, DenialReason>();

export function markDenied(req: FastifyRequest, reason: DenialReason): void {
  if (req.auth?.via === 'token' && !marks.has(req)) marks.set(req, reason);
}

export const deniedReason = (req: FastifyRequest): DenialReason | null => marks.get(req) ?? null;
