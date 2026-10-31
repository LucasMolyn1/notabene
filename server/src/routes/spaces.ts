// Espaces : visibles par adhésion (personnes, groupes, `everyone`) ou publics. Création, visibilité publique et suppression :
// administrateurs. Membres et paramètres courants : administrateurs et gestionnaires (rôle `full`) de l'espace.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { guard, requireAuth, requireScope } from '../auth/context.js';
import { readableSpaces, requireSpaceRole, type SpaceRow, spaceRoleOf, toSpace } from '../lib/access.js';
import { audit } from '../lib/audit.js';
import { EVERYONE } from '../lib/space-access.js';
import { createPersonalSpace, personalSpaceOf, personalSpacesEnabled } from '../lib/personal-spaces.js';
import { HttpError, idParams, idSchema, newId } from '../lib/http.js';

const fields = {
  name: z.string().trim().min(1).max(80),
  icon: z.string().max(16),
  description: z.string().max(1000),
  visibility: z.enum(['private', 'public']),
};
const spaceBody = z.object({ ...fields, icon: fields.icon.default('folder'), description: fields.description.default(''), visibility: fields.visibility.default('private') });
// Modification : seuls les champs envoyés changent (sans valeurs par défaut, sinon renommer remettrait la visibilité à « privé »).
const patchBody = z.object(fields).partial();
// À la création : qui y a accès au départ. Par défaut les administrateurs seuls (qui voient tout) ; « everyone » ouvre l'édition à tous.
const createBody = spaceBody.extend({ access: z.enum(['admins', 'everyone']).default('admins') });
const memberBody = z.object({ userId: idSchema.optional(), groupId: idSchema.optional(), role: z.enum(['view', 'edit', 'full']) })
  .refine((m) => (m.userId === undefined) !== (m.groupId === undefined), 'Une personne ou un groupe, pas les deux');
const memberParams = z.object({ id: idSchema, kind: z.enum(['user', 'group']), subject: idSchema });
export const MAX_SPACE_MEMBERS = 1000;

export default async function spaceRoutes(app: FastifyInstance) {
  const { db } = app;
  const tags = ['spaces'];

  // Les adresses e-mail ne sont montrées qu'aux administrateurs : un gestionnaire d'espace n'a pas à moissonner l'annuaire.
  const isAdmin = (req: Parameters<typeof requireAuth>[0]) => req.auth?.user.role === 'admin' && !!req.auth.scopes.has('admin');

  // Gérer les droits est une action d'administration : une session web, ou un jeton qui porte la portée « admin » (un jeton de
  // lecture/écriture, même d'un administrateur, ne modifie pas les droits de l'instance).
  const manage = (req: Parameters<typeof requireAuth>[0], id: string) => {
    const auth = requireAuth(req);
    if (auth.via === 'token' && !auth.scopes.has('admin')) throw new HttpError(403, 'Un jeton doit porter la portée admin pour gérer les membres');
    requireSpaceRole(db, req, id, 'full');
    if ((db.prepare('SELECT kind FROM spaces WHERE id = ?').get(id) as { kind: string } | undefined)?.kind === 'personal') throw new HttpError(409, 'Un espace personnel n’a pas d’autres membres');
  };

  app.get('/spaces', { schema: { tags, summary: 'Lister les espaces visibles (avec votre rôle : view, edit ou full)' } }, async (req) =>
    readableSpaces(db, req).map((s) => ({ ...toSpace(s), role: spaceRoleOf(db, req, s.id) })));

  app.post('/spaces', { preHandler: guard('admin'), schema: { tags, summary: 'Créer un espace (admin)', body: createBody } }, async (req, reply) => {
    const body = req.body as z.output<typeof createBody>;
    const now = Date.now();
    const id = newId();
    const position = (db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM spaces').get() as { p: number }).p;
    db.prepare('INSERT INTO spaces (id, name, icon, description, visibility, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, body.name, body.icon, body.description, body.visibility, position, now, now);
    if (body.access === 'everyone') db.prepare('INSERT INTO space_members (space_id, group_id, role) VALUES (?, ?, ?)').run(id, EVERYONE, 'edit');
    audit(db, req, 'space.create', id, { visibility: body.visibility, access: body.access });
    app.bus.publish({ type: 'space.changed' });
    return reply.status(201).send({ ...toSpace(db.prepare('SELECT * FROM spaces WHERE id = ?').get(id) as SpaceRow), role: spaceRoleOf(db, req, id) });
  });

  app.patch('/spaces/:id', {
    preHandler: guard('write'),
    schema: { tags, summary: 'Modifier un espace (gestionnaire ou administrateur ; la visibilité publique est réservée aux administrateurs)', params: idParams, body: patchBody },
  }, async (req) => {
    const { id } = req.params as { id: string };
    const caller = requireAuth(req);
    if (caller.via === 'token' && !caller.scopes.has('admin')) throw new HttpError(403, 'Un jeton doit porter la portée admin pour modifier un espace');
    requireSpaceRole(db, req, id, 'full');
    if ((req.body as { visibility?: string }).visibility !== undefined && (db.prepare('SELECT kind FROM spaces WHERE id = ?').get(id) as { kind: string } | undefined)?.kind === 'personal') throw new HttpError(409, 'Un espace personnel est toujours privé');
    if ((req.body as { visibility?: string }).visibility !== undefined && !isAdmin(req)) throw new HttpError(403, 'Seul un administrateur change la visibilité d’un espace');
    const current = db.prepare('SELECT * FROM spaces WHERE id = ?').get(id) as SpaceRow | undefined;
    if (!current) throw new HttpError(404, 'Espace introuvable');
    const next = { ...current, ...(req.body as Partial<SpaceRow>), updated_at: Date.now() };
    db.prepare('UPDATE spaces SET name = ?, icon = ?, description = ?, visibility = ?, updated_at = ? WHERE id = ?')
      .run(next.name, next.icon, next.description, next.visibility, next.updated_at, id);
    if (next.visibility !== current.visibility) audit(db, req, 'space.visibility', id, { visibility: next.visibility });
    app.bus.publish({ type: 'space.changed' });
    return { ...toSpace(next), role: spaceRoleOf(db, req, id) };
  });

  // ---- Espace personnel -------------------------------------------------------------------
  app.post('/spaces/personal', {
    preHandler: guard('write'),
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    schema: { tags, summary: 'Créer mon espace personnel (si l’instance l’autorise) ; renvoie l’existant sinon' },
  }, async (req, reply) => {
    const auth = requireAuth(req);
    const mine = personalSpaceOf(db, auth.user.id);
    if (mine) return { ...toSpace(mine), role: spaceRoleOf(db, req, mine.id) };
    if (!personalSpacesEnabled(db)) throw new HttpError(403, 'Les espaces personnels ne sont pas activés sur cette instance');
    const id = createPersonalSpace(db, auth.user);
    audit(db, req, 'space.personal.create', id);
    app.bus.publish({ type: 'space.changed' });
    return reply.status(201).send({ ...toSpace(db.prepare('SELECT * FROM spaces WHERE id = ?').get(id) as SpaceRow), role: spaceRoleOf(db, req, id) });
  });

  app.delete('/spaces/personal', {
    preHandler: guard('write'),
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    schema: { tags, summary: 'Supprimer mon espace personnel et toutes ses pages' },
  }, async (req, reply) => {
    const auth = requireAuth(req);
    const mine = personalSpaceOf(db, auth.user.id);
    if (!mine) throw new HttpError(404, 'Vous n’avez pas d’espace personnel');
    db.prepare('DELETE FROM spaces WHERE id = ?').run(mine.id);
    audit(db, req, 'space.personal.delete', mine.id);
    app.bus.publish({ type: 'space.changed' });
    return reply.status(204).send();
  });

  app.delete('/spaces/:id', {
    preHandler: guard('admin'),
    schema: { tags, summary: 'Supprimer un espace et toutes ses pages (admin)', params: idParams },
  }, async (req, reply) => {
    requireScope(req, 'admin');
    const { id } = req.params as { id: string };
    // L'espace personnel d'un compte existant n'appartient qu'à lui (introuvable pour un administrateur) ; un orphelin se supprime ici.
    const target = db.prepare('SELECT kind, owner_id FROM spaces WHERE id = ?').get(id) as { kind: string; owner_id: string | null } | undefined;
    if (target?.kind === 'personal' && target.owner_id) throw new HttpError(404, 'Espace introuvable');
    const count = (db.prepare("SELECT COUNT(*) AS n FROM spaces WHERE kind = 'shared'").get() as { n: number }).n;
    if (count <= 1 && target?.kind !== 'personal') throw new HttpError(409, 'Impossible de supprimer le dernier espace');
    if (db.prepare('DELETE FROM spaces WHERE id = ?').run(id).changes === 0) throw new HttpError(404, 'Espace introuvable');
    audit(db, req, 'space.delete', id);
    app.bus.publish({ type: 'space.changed' });
    return reply.status(204).send();
  });

  // ---- Membres d'un espace -------------------------------------------------------------------
  // Un changement de droits touche des sessions ouvertes : flux temps réel et co-édition revérifiés.
  const accessChanged = (spaceId: string) => { app.bus.publish({ type: 'space.changed', spaceId }); app.collab?.evictAll(); };

  app.get('/spaces/:id/members', {
    preHandler: guard('write'),
    schema: { tags, summary: 'Membres d’un espace (gestionnaires et administrateurs)', params: idParams },
  }, async (req) => {
    const { id } = req.params as { id: string };
    manage(req, id);
    const rows = db.prepare(
      `SELECT m.role, m.user_id, m.group_id, u.name AS user_name, u.email, u.disabled, g.name AS group_name, g.source
       FROM space_members m LEFT JOIN users u ON u.id = m.user_id LEFT JOIN groups g ON g.id = m.group_id
       WHERE m.space_id = ? ORDER BY (m.group_id IS NULL), COALESCE(g.name, u.name) COLLATE NOCASE LIMIT ?`,
    ).all(id, MAX_SPACE_MEMBERS) as { role: string; user_id: string | null; group_id: string | null; user_name: string | null; email: string | null; disabled: number | null; group_name: string | null; source: string | null }[];
    return {
      items: rows.map((r) => (r.group_id
        ? { kind: 'group', id: r.group_id, name: r.group_name, source: r.source, role: r.role }
        : { kind: 'user', id: r.user_id, name: r.user_name, ...(isAdmin(req) ? { email: r.email } : {}), disabled: !!r.disabled, role: r.role })),
    };
  });

  app.put('/spaces/:id/members', {
    preHandler: guard('write'),
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    schema: { tags, summary: 'Donner ou changer le rôle d’une personne ou d’un groupe sur un espace', params: idParams, body: memberBody },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    manage(req, id);
    const b = req.body as z.output<typeof memberBody>;
    // Ouvrir ou modifier l'accès de tous les comptes : réservé aux administrateurs (un gestionnaire cible des personnes et des groupes).
    if (b.groupId === EVERYONE && !isAdmin(req)) throw new HttpError(403, 'Seul un administrateur règle l’accès de « Tout le monde »');
    if (b.userId && !db.prepare('SELECT 1 FROM users WHERE id = ? AND disabled = 0').get(b.userId)) throw new HttpError(404, 'Utilisateur introuvable ou désactivé');
    if (b.groupId && !db.prepare('SELECT 1 FROM groups WHERE id = ?').get(b.groupId)) throw new HttpError(404, 'Groupe introuvable');
    const exists = db.prepare(b.userId ? 'SELECT 1 FROM space_members WHERE space_id = ? AND user_id = ?' : 'SELECT 1 FROM space_members WHERE space_id = ? AND group_id = ?').get(id, b.userId ?? b.groupId);
    if (!exists && (db.prepare('SELECT COUNT(*) AS n FROM space_members WHERE space_id = ?').get(id) as { n: number }).n >= MAX_SPACE_MEMBERS) throw new HttpError(400, `Au plus ${MAX_SPACE_MEMBERS} membres par espace`);
    if (exists) db.prepare(`UPDATE space_members SET role = ? WHERE space_id = ? AND ${b.userId ? 'user_id' : 'group_id'} = ?`).run(b.role, id, b.userId ?? b.groupId);
    else db.prepare('INSERT INTO space_members (space_id, user_id, group_id, role) VALUES (?, ?, ?, ?)').run(id, b.userId ?? null, b.groupId ?? null, b.role);
    audit(db, req, 'space.member.set', id, { [b.userId ? 'userId' : 'groupId']: b.userId ?? b.groupId, role: b.role });
    accessChanged(id);
    return reply.status(204).send();
  });

  app.delete('/spaces/:id/members/:kind/:subject', {
    preHandler: guard('write'),
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    schema: { tags, summary: 'Retirer une personne ou un groupe d’un espace', params: memberParams },
  }, async (req, reply) => {
    const { id, kind, subject } = req.params as z.output<typeof memberParams>;
    manage(req, id);
    db.prepare(`DELETE FROM space_members WHERE space_id = ? AND ${kind === 'user' ? 'user_id' : 'group_id'} = ?`).run(id, subject);
    audit(db, req, 'space.member.remove', id, { [kind === 'user' ? 'userId' : 'groupId']: subject });
    accessChanged(id);
    return reply.status(204).send();
  });

  // Recherche des personnes et groupes à ajouter : réservée à qui gère l'espace, deux caractères au moins, dix résultats au plus.
  app.get('/spaces/:id/member-candidates', {
    preHandler: guard('write'),
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    schema: { tags, summary: 'Chercher des personnes et des groupes à ajouter à un espace', params: idParams, querystring: z.object({ q: z.string().trim().min(2).max(80) }) },
  }, async (req) => {
    const { id } = req.params as { id: string };
    manage(req, id);
    const esc = (req.query as { q: string }).q.replace(/[\\%_]/g, '\\$&').toLocaleLowerCase('fr');
    const like = `%${esc}%`;
    const users = db.prepare(
      `SELECT id, name, email FROM users WHERE disabled = 0 AND lower_fr(name) LIKE ? ESCAPE '\\'
         AND id NOT IN (SELECT user_id FROM space_members WHERE space_id = ? AND user_id IS NOT NULL) ORDER BY name COLLATE NOCASE LIMIT 10`,
    ).all(like, id) as { id: string; name: string; email: string | null }[];
    const groups = db.prepare(
      `SELECT id, name, source FROM groups WHERE lower_fr(name) LIKE ? ESCAPE '\\'
         AND id NOT IN (SELECT group_id FROM space_members WHERE space_id = ? AND group_id IS NOT NULL) ORDER BY name COLLATE NOCASE LIMIT 10`,
    ).all(like, id) as { id: string; name: string; source: string }[];
    return { users: users.map((u) => ({ id: u.id, name: u.name, ...(isAdmin(req) ? { email: u.email } : {}) })), groups };
  });
}
