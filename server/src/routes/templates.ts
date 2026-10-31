// Modèles de pages : fournis par Notabene ou enregistrés à partir d'une page d'un espace.
// Un modèle est lisible par toute personne connectée qui lit son espace ; il se crée depuis une page qu'on peut modifier,
// et seul son auteur ou un administrateur le renomme ou le supprime.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { guard } from '../auth/context.js';
import { loadWritablePage, readableSpaceIds, requireSpaceRole } from '../lib/access.js';
import { audit } from '../lib/audit.js';
import { BUILTIN_TEMPLATES, builtinTemplate } from '../lib/builtin-templates.js';
import { sanitizeDoc } from '../lib/content.js';
import { HttpError, idSchema, newId } from '../lib/http.js';
import { governingPage } from '../lib/page-acl.js';

const MAX_PER_SPACE = 50;
const idParams = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'identifiant invalide') });
const name = z.string().trim().min(1).max(80);
const createBody = z.object({ pageId: idSchema, name: name.optional() });
const renameBody = z.object({ name });

interface TemplateRow {
  id: string; space_id: string; name: string; icon: string; content: string;
  created_at: number; created_by: string | null; updated_at: number; author_name?: string | null;
}

const toItem = (r: TemplateRow) => ({
  id: r.id, builtin: false, spaceId: r.space_id, name: r.name, icon: r.icon, description: '',
  createdBy: r.created_by, author: r.author_name ?? null, updatedAt: r.updated_at,
});

export default async function templateRoutes(app: FastifyInstance) {
  const { db } = app;
  const tags = ['templates'];
  const SELECT = 'SELECT t.*, u.name AS author_name FROM page_templates t LEFT JOIN users u ON u.id = t.created_by';
  const rowOf = (id: string) => db.prepare(`${SELECT} WHERE t.id = ?`).get(id) as TemplateRow | undefined;

  // Un modèle d'un espace illisible est introuvable (on ne révèle pas son existence).
  const readableRow = (req: Parameters<typeof readableSpaceIds>[1], id: string) => {
    const row = rowOf(id);
    if (!row || !readableSpaceIds(db, req).includes(row.space_id)) throw new HttpError(404, 'Modèle introuvable');
    return row;
  };
  const manageable = (req: { auth: { user: { id: string; role: string } } | null }, row: TemplateRow) => {
    if (row.created_by !== req.auth?.user.id && req.auth?.user.role !== 'admin') throw new HttpError(403, 'Seul l’auteur du modèle ou un administrateur peut le modifier');
  };

  app.get('/templates', {
    preHandler: guard('read'),
    schema: { tags, summary: 'Modèles disponibles (fournis, et ceux des espaces lisibles)', querystring: z.object({ spaceId: idSchema.optional() }) },
  }, async (req) => {
    const { spaceId } = req.query as { spaceId?: string };
    const spaces = readableSpaceIds(db, req).filter((s) => !spaceId || s === spaceId);
    const custom = db.prepare(`${SELECT} WHERE t.space_id IN (SELECT value FROM json_each(?)) ORDER BY t.name COLLATE NOCASE, t.created_at`)
      .all(JSON.stringify(spaces)) as TemplateRow[];
    return {
      items: [
        ...BUILTIN_TEMPLATES.map((t) => ({ id: t.id, builtin: true, spaceId: null, name: t.name, icon: t.icon, description: t.description, createdBy: null, author: null, updatedAt: 0 })),
        ...custom.map(toItem),
      ],
    };
  });

  app.get('/templates/:id', { preHandler: guard('read'), schema: { tags, summary: 'Contenu d’un modèle', params: idParams } }, async (req) => {
    const { id } = req.params as { id: string };
    const builtin = builtinTemplate(id);
    if (builtin) return { id, builtin: true, name: builtin.name, icon: builtin.icon, content: builtin.content };
    const row = readableRow(req, id);
    return { ...toItem(row), content: JSON.parse(row.content) };
  });

  app.post('/templates', {
    preHandler: guard('write'),
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    schema: { tags, summary: 'Enregistrer une page comme modèle (page modifiable, sans permissions restreintes)', body: createBody },
  }, async (req, reply) => {
    const body = req.body as z.output<typeof createBody>;
    const page = loadWritablePage(db, req, body.pageId);
    // Un modèle est lisible de tout l'espace : y copier une page réservée à certaines personnes la rendrait visible aux autres.
    if (governingPage(db, page.id)) throw new HttpError(403, 'Une page à permissions restreintes ne peut pas devenir un modèle');
    const { n } = db.prepare('SELECT count(*) AS n FROM page_templates WHERE space_id = ?').get(page.space_id) as { n: number };
    if (n >= MAX_PER_SPACE) throw new HttpError(400, `Un espace compte au plus ${MAX_PER_SPACE} modèles`);
    const id = newId();
    const now = Date.now();
    const content = JSON.stringify(sanitizeDoc(JSON.parse(page.content)));
    db.prepare('INSERT INTO page_templates (id, space_id, name, icon, content, created_at, created_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, page.space_id, body.name ?? (page.title.trim().slice(0, 80) || 'Sans titre'), page.icon, content, now, req.auth?.user.id ?? null, now);
    audit(db, req, 'template.create', id, { pageId: page.id });
    return reply.status(201).send(toItem(rowOf(id)!));
  });

  app.patch('/templates/:id', {
    preHandler: guard('write'),
    schema: { tags, summary: 'Renommer un modèle (auteur ou administrateur)', params: idParams, body: renameBody },
  }, async (req) => {
    const row = readableRow(req, (req.params as { id: string }).id);
    requireSpaceRole(db, req, row.space_id, 'edit');
    manageable(req, row);
    db.prepare('UPDATE page_templates SET name = ?, updated_at = ? WHERE id = ?').run((req.body as z.output<typeof renameBody>).name, Date.now(), row.id);
    audit(db, req, 'template.rename', row.id);
    return toItem(rowOf(row.id)!);
  });

  app.delete('/templates/:id', {
    preHandler: guard('write'),
    schema: { tags, summary: 'Supprimer un modèle (auteur ou administrateur)', params: idParams },
  }, async (req, reply) => {
    const row = readableRow(req, (req.params as { id: string }).id);
    requireSpaceRole(db, req, row.space_id, 'edit');
    manageable(req, row);
    db.prepare('DELETE FROM page_templates WHERE id = ?').run(row.id);
    audit(db, req, 'template.delete', row.id);
    return reply.status(204).send();
  });
}
