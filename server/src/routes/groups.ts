// Groupes (administrateurs) : création, adhésion, liaison à un groupe du fournisseur d'identité.
// La liste (noms seulement) est aussi lisible par les gestionnaires d'un espace, pour qu'ils puissent y ajouter un groupe.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { guard } from '../auth/context.js';
import { audit } from '../lib/audit.js';
import { keepPagesClosed, pagesOnlyOpenTo } from '../lib/page-acl.js';
import { type GroupRow, isEveryone, MAX_GROUP_MEMBERS, MAX_GROUPS, SYNC_SOURCES, toGroup } from '../lib/groups.js';
import { HttpError, idParams, idSchema, newId } from '../lib/http.js';
import { spaceRoles } from '../lib/space-access.js';

// Pas de caractères de contrôle ni de chevrons dans un nom (affiché dans les listes et les journaux).
const nameSchema = z.string().trim().min(1).max(80).refine((n) => ![...n].some((c) => c.charCodeAt(0) < 32 || c === '<' || c === '>'), 'caractères interdits');
const createBody = z.object({
  name: nameSchema,
  description: z.string().trim().max(300).default(''),
  // Groupe lié au fournisseur d'identité : source + nom du groupe chez lui. Absent : groupe local.
  source: z.enum(['local', ...SYNC_SOURCES]).default('local'),
  externalId: z.string().trim().min(1).max(512).optional(),
}).superRefine((b, ctx) => {
  if (b.source !== 'local' && !b.externalId) ctx.addIssue({ code: 'custom', path: ['externalId'], message: 'nom du groupe chez le fournisseur requis' });
  if (b.source === 'local' && b.externalId) ctx.addIssue({ code: 'custom', path: ['externalId'], message: 'réservé aux groupes liés à un fournisseur' });
});
const patchBody = z.object({ name: nameSchema.optional(), description: z.string().trim().max(300).optional(), externalId: z.string().trim().min(1).max(512).optional() });
const memberParams = z.object({ id: idSchema, userId: idSchema });

export default async function groupRoutes(app: FastifyInstance) {
  const { db } = app;
  const tags = ['groups'];

  const load = (id: string): GroupRow => {
    const g = db.prepare('SELECT * FROM groups WHERE id = ?').get(id) as GroupRow | undefined;
    if (!g) throw new HttpError(404, 'Groupe introuvable');
    return g;
  };
  const editable = (id: string): GroupRow => {
    const g = load(id);
    if (isEveryone(g.id)) throw new HttpError(403, 'Le groupe « Tout le monde » ne se modifie pas');
    return g;
  };
  // Un changement d'adhésion change les droits de personnes dont la session est ouverte : flux temps réel et co-édition revérifiés.
  const accessChanged = () => { app.bus.publish({ type: 'space.changed' }); app.collab?.evictAll(); };
  const count = (id: string) => (db.prepare('SELECT COUNT(*) AS n FROM group_members WHERE group_id = ?').get(id) as { n: number }).n;
  // SQLite ne replie la casse que pour l'ASCII (« É » et « é » seraient deux noms) : l'unicité est donc aussi vérifiée ici.
  const uniqueName = (name: string, exceptId?: string) => {
    const wanted = name.toLocaleLowerCase('fr');
    const rows = db.prepare('SELECT id, name FROM groups').all() as { id: string; name: string }[];
    if (rows.some((r) => r.id !== exceptId && r.name.toLocaleLowerCase('fr') === wanted)) throw new HttpError(409, 'Un groupe porte déjà ce nom');
  };

  app.get('/groups', { preHandler: guard('write'), schema: { tags, summary: 'Lister les groupes (administrateurs et gestionnaires d’un espace)' } }, async (req) => {
    const admin = req.auth!.user.role === 'admin' && req.auth!.scopes.has('admin');
    if (!admin && ![...spaceRoles(db, req.auth).values()].includes('full')) throw new HttpError(403, 'Réservé aux administrateurs et aux gestionnaires d’espace');
    const rows = db.prepare('SELECT * FROM groups ORDER BY (id = \'everyone\') DESC, name COLLATE NOCASE').all() as GroupRow[];
    const counts = new Map((db.prepare('SELECT group_id, COUNT(*) AS n FROM group_members GROUP BY group_id').all() as { group_id: string; n: number }[]).map((r) => [r.group_id, r.n]));
    // Les effectifs ne regardent que les administrateurs ; les gestionnaires ne voient que les noms.
    return rows.map((g) => (admin ? toGroup(g, g.id === 'everyone' ? undefined : counts.get(g.id) ?? 0) : toGroup({ ...g, external_id: null })));
  });

  app.post('/groups', {
    preHandler: guard('admin'),
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    schema: { tags, summary: 'Créer un groupe (administrateur)', body: createBody },
  }, async (req, reply) => {
    const body = req.body as z.output<typeof createBody>;
    if ((db.prepare('SELECT COUNT(*) AS n FROM groups').get() as { n: number }).n >= MAX_GROUPS) throw new HttpError(400, `Au plus ${MAX_GROUPS} groupes`);
    uniqueName(body.name);
    const id = newId();
    try {
      db.prepare('INSERT INTO groups (id, name, description, source, external_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, body.name, body.description, body.source, body.source === 'local' ? null : body.externalId, Date.now());
    } catch {
      throw new HttpError(409, 'Ce groupe du fournisseur est déjà lié à un groupe');
    }
    audit(db, req, 'group.create', id, { source: body.source });
    return reply.status(201).send(toGroup(load(id), 0));
  });

  app.patch('/groups/:id', {
    preHandler: guard('admin'),
    schema: { tags, summary: 'Modifier un groupe (administrateur)', params: idParams, body: patchBody },
  }, async (req) => {
    const g = editable((req.params as { id: string }).id);
    const body = req.body as z.output<typeof patchBody>;
    if (body.externalId !== undefined && g.source === 'local') throw new HttpError(400, 'Ce groupe n’est pas lié à un fournisseur');
    if (body.name !== undefined) uniqueName(body.name, g.id);
    try {
      db.prepare('UPDATE groups SET name = ?, description = ?, external_id = ? WHERE id = ?')
        .run(body.name ?? g.name, body.description ?? g.description, body.externalId ?? g.external_id, g.id);
    } catch {
      throw new HttpError(409, 'Ce groupe du fournisseur est déjà lié à un groupe');
    }
    // Lier un autre groupe du fournisseur change qui y appartient à la prochaine connexion, pas avant : on vide l'adhésion recopiée.
    if (body.externalId !== undefined && body.externalId !== g.external_id) db.prepare('DELETE FROM group_members WHERE group_id = ?').run(g.id);
    audit(db, req, 'group.update', g.id, { renamed: body.name !== undefined, relinked: body.externalId !== undefined });
    accessChanged();
    return toGroup(load(g.id), count(g.id));
  });

  app.delete('/groups/:id', {
    preHandler: guard('admin'),
    schema: { tags, summary: 'Supprimer un groupe (administrateur) : retire ses droits sur les espaces et les pages', params: idParams },
  }, async (req, reply) => {
    const g = editable((req.params as { id: string }).id);
    // Une page réservée à ce seul groupe resterait sinon sans restriction : elle reste fermée (entrée de l'administrateur).
    const closed = pagesOnlyOpenTo(db, { groupId: g.id });
    db.transaction(() => {
      db.prepare('DELETE FROM groups WHERE id = ?').run(g.id);
      keepPagesClosed(db, closed, req.auth!.user.id);
    })();
    audit(db, req, 'group.delete', g.id, { pagesKeptClosed: closed.length });
    accessChanged();
    return reply.status(204).send();
  });

  app.get('/groups/:id/members', { preHandler: guard('admin'), schema: { tags, summary: 'Membres d’un groupe (administrateur)', params: idParams } }, async (req) => {
    const g = load((req.params as { id: string }).id);
    if (isEveryone(g.id)) return { everyone: true, items: [] };
    const items = db.prepare(
      'SELECT u.id, u.name, u.email, u.disabled FROM group_members m JOIN users u ON u.id = m.user_id WHERE m.group_id = ? ORDER BY u.name COLLATE NOCASE LIMIT ?',
    ).all(g.id, MAX_GROUP_MEMBERS) as { id: string; name: string; email: string | null; disabled: number }[];
    return { everyone: false, synced: g.source !== 'local', items: items.map((u) => ({ id: u.id, name: u.name, email: u.email, disabled: !!u.disabled })) };
  });

  app.put('/groups/:id/members/:userId', {
    preHandler: guard('admin'),
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    schema: { tags, summary: 'Ajouter une personne à un groupe local (administrateur)', params: memberParams },
  }, async (req, reply) => {
    const { id, userId } = req.params as z.output<typeof memberParams>;
    const g = editable(id);
    if (g.source !== 'local') throw new HttpError(409, 'L’adhésion de ce groupe vient du fournisseur d’identité');
    if (!db.prepare('SELECT 1 FROM users WHERE id = ? AND disabled = 0').get(userId)) throw new HttpError(404, 'Utilisateur introuvable ou désactivé');
    if (count(g.id) >= MAX_GROUP_MEMBERS) throw new HttpError(400, `Au plus ${MAX_GROUP_MEMBERS} membres par groupe`);
    db.prepare('INSERT OR IGNORE INTO group_members (group_id, user_id) VALUES (?, ?)').run(g.id, userId);
    audit(db, req, 'group.member.add', g.id, { userId });
    accessChanged();
    return reply.status(204).send();
  });

  app.delete('/groups/:id/members/:userId', {
    preHandler: guard('admin'),
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    schema: { tags, summary: 'Retirer une personne d’un groupe local (administrateur)', params: memberParams },
  }, async (req, reply) => {
    const { id, userId } = req.params as z.output<typeof memberParams>;
    const g = editable(id);
    if (g.source !== 'local') throw new HttpError(409, 'L’adhésion de ce groupe vient du fournisseur d’identité');
    db.prepare('DELETE FROM group_members WHERE group_id = ? AND user_id = ?').run(g.id, userId);
    audit(db, req, 'group.member.remove', g.id, { userId });
    accessChanged();
    return reply.status(204).send();
  });
}
