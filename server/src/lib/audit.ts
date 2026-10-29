import type { FastifyRequest } from 'fastify';
import type { DB } from '../db.js';

// Journal d'audit des actions sensibles (jamais de secret ni de contenu de page).
export function audit(db: DB, req: FastifyRequest | null, action: string, target?: string | null, meta?: Record<string, unknown>) {
  db.prepare('INSERT INTO audit_log (at, user_id, action, target, ip, meta) VALUES (?, ?, ?, ?, ?, ?)').run(
    Date.now(),
    req?.auth?.user.id ?? null,
    action,
    target ?? null,
    req?.ip ?? null,
    meta ? JSON.stringify(meta) : null,
  );
}
