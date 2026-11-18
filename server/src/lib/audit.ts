import type { FastifyRequest } from 'fastify';
import type { DB } from '../db.js';

// Journal d'audit des actions sensibles (jamais de secret ni de contenu de page).
// `opts.actorId` : auteur quand la requête n'a pas encore d'identité (connexion : la personne qui vient de se connecter).
export function audit(db: DB, req: FastifyRequest | null, action: string, target?: string | null, meta?: Record<string, unknown>, opts?: { actorId?: string }) {
  db.prepare('INSERT INTO audit_log (at, user_id, action, target, ip, meta, token_id, token_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    Date.now(),
    req?.auth?.user.id ?? opts?.actorId ?? null,
    action,
    target ?? null,
    req?.ip ?? null,
    meta ? JSON.stringify(meta) : null,
    req?.auth?.via === 'token' ? (req.auth.tokenId ?? null) : null,
    req?.auth?.via === 'token' ? (req.auth.tokenName ?? null) : null,
  );
}

// Actions fréquentes (enregistrement d'une page, modification d'une ligne de base) : au plus une ligne par minute pour une même
// action, une même cible et un même auteur (compte et jeton) ; les champs modifiés entre-temps sont réunis dans la suivante.
export const THROTTLE_MS = 60_000;
const MAX_THROTTLE_KEYS = 10_000;
const recent = new Map<string, { at: number; fields: Set<string> }>();

export function auditThrottled(db: DB, req: FastifyRequest | null, action: string, target: string, fields: string[], extra?: Record<string, unknown>, now = Date.now()) {
  const key = `${action}|${target}|${req?.auth?.user.id ?? ''}|${req?.auth?.via === 'token' ? req.auth.tokenId : ''}`;
  const seen = recent.get(key);
  if (seen && now - seen.at < THROTTLE_MS) {
    for (const f of fields) seen.fields.add(f);
    return;
  }
  const all = new Set([...(seen?.fields ?? []), ...fields]);
  if (recent.size >= MAX_THROTTLE_KEYS) recent.clear();
  recent.set(key, { at: now, fields: new Set() });
  audit(db, req, action, target, { fields: [...all].sort(), ...extra });
}

/** Pour les tests : oublie les dernières écritures (la limite d'une ligne par minute repart de zéro). */
export const resetAuditThrottle = () => recent.clear();
