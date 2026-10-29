// Éléments communs aux connexions fédérées (LDAP, SAML) : rôle d'après les groupes, création du compte.
import type { Role } from './context.js';

export interface GroupRoles { admin: string[]; editor: string[]; reader: string[]; defaultRole: 'reader' | 'none' }

// Un groupe correspond s'il est égal (sans casse) à la valeur configurée, soit en DN complet, soit par son CN.
const cn = (value: string) => /^cn=([^,]+)/i.exec(value)?.[1]?.trim().toLowerCase() ?? value.trim().toLowerCase();
const matches = (userGroups: string[], wanted: string[]) =>
  wanted.some((w) => userGroups.some((g) => g.trim().toLowerCase() === w.trim().toLowerCase() || cn(g) === cn(w)));

export function roleFromGroupList(groups: unknown, cfg: GroupRoles): Role | null {
  const list = (Array.isArray(groups) ? groups : typeof groups === 'string' ? [groups] : []).filter((g): g is string => typeof g === 'string' && !!g);
  if (matches(list, cfg.admin)) return 'admin';
  if (matches(list, cfg.editor)) return 'editor';
  if (matches(list, cfg.reader)) return 'reader';
  return cfg.defaultRole === 'reader' ? 'reader' : null;
}

export const cleanName = (value: unknown, fallback: string) =>
  (typeof value === 'string' && value.trim() ? value.trim() : fallback).slice(0, 120);
