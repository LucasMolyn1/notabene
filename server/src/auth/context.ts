// Modèle d'autorisation : un rôle global (issu des groupes OIDC) croisé avec les
// portées du jeton API. Une session navigateur dispose de toutes les portées de son rôle.
import type { FastifyRequest } from 'fastify';
import { HttpError } from '../lib/http.js';

export type Role = 'admin' | 'editor' | 'reader';
export type Scope = 'read' | 'write' | 'ai' | 'admin';
export const ALL_SCOPES: Scope[] = ['read', 'write', 'ai', 'admin'];

export interface AuthUser {
  id: string;
  name: string;
  email: string | null;
  role: Role;
}

export interface Auth {
  user: AuthUser;
  via: 'session' | 'token';
  scopes: Set<Scope>;
  csrf?: string;
  sessionHash?: string;
  tokenId?: string;
  // Compte local sans MFA alors que LOCAL_REQUIRE_MFA est actif : seules l'activation de la MFA et /me restent permises.
  mfaPending?: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: Auth | null;
  }
}

export function roleAllows(role: Role, scope: Scope): boolean {
  if (scope === 'read' || scope === 'ai') return true;
  if (scope === 'write') return role === 'admin' || role === 'editor';
  return role === 'admin';
}

export const scopesForRole = (role: Role) => ALL_SCOPES.filter((s) => roleAllows(role, s));

export function can(auth: Auth | null, scope: Scope): boolean {
  return !!auth && roleAllows(auth.user.role, scope) && auth.scopes.has(scope);
}

export function requireAuth(req: FastifyRequest): Auth {
  if (!req.auth) throw new HttpError(401, 'Authentification requise');
  return req.auth;
}

export function requireScope(req: FastifyRequest, scope: Scope): Auth {
  const auth = requireAuth(req);
  if (!can(auth, scope)) throw new HttpError(403, 'Permission insuffisante');
  return auth;
}

// Garde utilisable en preHandler de route.
export const guard = (scope: Scope) => async (req: FastifyRequest) => {
  requireScope(req, scope);
};
