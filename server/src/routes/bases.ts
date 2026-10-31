// Bases (tableaux) : création, lecture, colonnes, lignes, vues et export CSV.
// L'accès est celui de la page qui porte la base (loadReadablePage / loadWritablePage) : lecture = pouvoir lire la page, écriture =
// pouvoir la modifier. Une page qui n'est pas une base répond 404 ici, comme une base inexistante.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { can, guard } from '../auth/context.js';
import { loadReadablePage, loadWritablePage, readableSpaceIds, requireSpaceRole } from '../lib/access.js';
import { audit } from '../lib/audit.js';
import {
  cleanName, addProperty, addRow, addView, checkViewConfig, createBase, MAX_PROPERTIES, MAX_ROWS, optionSchema, patchRow, presentRows, propertiesOf,
  PROPERTY_TYPES, reindexBase, removeProperty, removeRows, rowCount, toCsv, touchBase, updateProperty, viewConfigSchema, viewsOf,
  type Ctx,
} from '../lib/bases.js';
import { HttpError, idParams, idSchema } from '../lib/http.js';
import { canWritePage } from '../lib/page-acl.js';
import { inPersonalSpace } from '../lib/personal-spaces.js';
import { toMeta, type PageRow } from '../lib/pages.js';

const propertyName = cleanName(60);
const viewName = cleanName(60);
const values = z.record(z.string().max(40), z.unknown()).refine((o) => Object.keys(o).length <= MAX_PROPERTIES, 'trop de cellules')
  .refine((o) => JSON.stringify(o).length <= 20_000, 'ligne trop volumineuse');

const createBody = z.object({
  spaceId: idSchema,
  parentId: idSchema.nullable().optional(),
  title: z.string().max(300).optional(),
  icon: z.string().max(16).optional(),
});
const propertyBody = z.object({ name: propertyName, type: z.enum(PROPERTY_TYPES), options: z.array(optionSchema).max(100).optional() });
const propertyPatch = z.object({ name: propertyName.optional(), options: z.array(optionSchema).max(100).optional() });
const propParams = z.object({ id: idSchema, propId: idSchema });
const rowParams = z.object({ id: idSchema, rowId: idSchema });
const viewParams = z.object({ id: idSchema, viewId: idSchema });
const rowBody = z.object({ values: values.default({}) });
const rowsDelete = z.object({ ids: z.array(idSchema).min(1).max(500) });
const viewBody = z.object({ name: viewName, config: viewConfigSchema.default({ sort: [], filters: [], hidden: [] }) });
const viewPatch = z.object({ name: viewName.optional(), config: viewConfigSchema.optional() });

export default async function baseRoutes(app: FastifyInstance) {
  const { db, bus } = app;
  const tags = ['bases'];
  const write = { preHandler: guard('write'), config: { rateLimit: { max: 300, timeWindow: '1 minute' } } };

  const openBase = (req: FastifyRequest, id: string, mode: 'read' | 'write'): PageRow => {
    // Une base n'est jamais lisible sans compte, même dans un espace public (données structurées, noms de personnes) : 404, comme si elle n'existait pas.
    if (!req.auth || !can(req.auth, 'read')) throw new HttpError(404, 'Base introuvable');
    const page = mode === 'write' ? loadWritablePage(db, req, id) : loadReadablePage(db, req, id);
    if (page.kind !== 'base') throw new HttpError(404, 'Base introuvable');
    return page;
  };
  const ctxOf = (req: FastifyRequest, page: PageRow): Ctx => ({ db, auth: req.auth, spaces: new Set(readableSpaceIds(db, req)), baseId: page.id });
  const by = (req: FastifyRequest) => (req.auth ? { id: req.auth.user.id, name: req.auth.user.name } : undefined);
  const userId = (req: FastifyRequest) => req.auth?.user.id ?? null;
  // Après une écriture : texte de recherche, date de modification, événement pour les autres écrans.
  const changed = (req: FastifyRequest, page: PageRow, reindex = true) => {
    if (reindex) reindexBase(db, page.id);
    touchBase(db, page.id, userId(req));
    bus.publish({ type: 'base.changed', spaceId: page.space_id, pageId: page.id, by: by(req) });
  };
  // Dans un espace personnel le journal ne garde pas de détail (comme pour les libellés).
  const detail = (page: PageRow, meta: Record<string, unknown>) => (inPersonalSpace(db, page.id) ? undefined : meta);

  const present = (req: FastifyRequest, page: PageRow) => {
    const props = propertiesOf(db, page.id);
    const ctx = ctxOf(req, page);
    return {
      page: toMeta(page),
      canWrite: can(req.auth, 'write') && canWritePage(db, req.auth, page.id),
      limits: { rows: MAX_ROWS, properties: MAX_PROPERTIES },
      properties: props,
      rows: presentRows(ctx, props, can(req.auth, 'read') && !!req.auth),
      views: viewsOf(db, page.id),
    };
  };

  app.post('/bases', { ...write, schema: { tags, summary: 'Créer une base', body: createBody } }, async (req, reply) => {
    const b = req.body as z.output<typeof createBody>;
    requireSpaceRole(db, req, b.spaceId, 'edit');
    if (b.parentId && !canWritePage(db, req.auth, b.parentId)) throw new HttpError(403, 'Accès en lecture seule sur la page parente');
    const page = createBase(db, b, userId(req));
    audit(db, req, 'base.create', page.id);
    bus.publish({ type: 'page.created', spaceId: page.space_id, pageId: page.id, version: page.version, by: by(req) });
    return reply.status(201).send(present(req, page));
  });

  app.get('/bases/:id', { schema: { tags, summary: 'Lire une base (colonnes, lignes, vues)', params: idParams } }, async (req) =>
    present(req, openBase(req, (req.params as { id: string }).id, 'read')));

  app.get('/bases/:id/export', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    schema: { tags, summary: 'Exporter une base en CSV', params: idParams },
  }, async (req, reply) => {
    const page = openBase(req, (req.params as { id: string }).id, 'read');
    const props = propertiesOf(db, page.id);
    const rows = presentRows(ctxOf(req, page), props, !!req.auth);
    const name = (page.title || 'base').normalize('NFKD').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'base';
    return reply.type('text/csv; charset=utf-8').header('Content-Disposition', `attachment; filename="${name}.csv"`).send(toCsv(props, rows));
  });

  // ----- Colonnes -----
  app.post('/bases/:id/properties', { ...write, schema: { tags, summary: 'Ajouter une colonne', params: idParams, body: propertyBody } }, async (req, reply) => {
    const page = openBase(req, (req.params as { id: string }).id, 'write');
    const b = req.body as z.output<typeof propertyBody>;
    const prop = addProperty(db, page.id, b);
    audit(db, req, 'base.property.add', page.id, detail(page, { type: b.type }));
    changed(req, page);
    return reply.status(201).send(prop);
  });

  app.patch('/bases/:id/properties/:propId', { ...write, schema: { tags, summary: 'Renommer une colonne ou changer ses options', params: propParams, body: propertyPatch } }, async (req) => {
    const p = req.params as z.output<typeof propParams>;
    const page = openBase(req, p.id, 'write');
    const prop = updateProperty(db, page.id, p.propId, req.body as z.output<typeof propertyPatch>);
    changed(req, page);
    return prop;
  });

  app.delete('/bases/:id/properties/:propId', { ...write, schema: { tags, summary: 'Supprimer une colonne et ses valeurs', params: propParams } }, async (req, reply) => {
    const p = req.params as z.output<typeof propParams>;
    const page = openBase(req, p.id, 'write');
    removeProperty(db, page.id, p.propId);
    audit(db, req, 'base.property.remove', page.id);
    changed(req, page);
    return reply.status(204).send();
  });

  // ----- Lignes -----
  app.post('/bases/:id/rows', { ...write, schema: { tags, summary: 'Ajouter une ligne', params: idParams, body: rowBody } }, async (req, reply) => {
    const page = openBase(req, (req.params as { id: string }).id, 'write');
    const row = addRow(ctxOf(req, page), (req.body as z.output<typeof rowBody>).values, userId(req));
    changed(req, page, Object.keys((req.body as z.output<typeof rowBody>).values).length > 0);
    return reply.status(201).send(presentRows(ctxOf(req, page), propertiesOf(db, page.id), !!req.auth, row.id)[0]);
  });

  app.patch('/bases/:id/rows/:rowId', { ...write, schema: { tags, summary: 'Modifier des cellules d’une ligne (null efface)', params: rowParams, body: rowBody } }, async (req) => {
    const p = req.params as z.output<typeof rowParams>;
    const page = openBase(req, p.id, 'write');
    const patch = (req.body as z.output<typeof rowBody>).values;
    const row = patchRow(ctxOf(req, page), p.rowId, patch, userId(req));
    const props = propertiesOf(db, page.id);
    // Le texte de recherche ne dépend ni des cases cochées, ni des personnes, ni des pages liées : inutile de le refaire pour elles.
    const indexed = Object.keys(patch).some((k) => { const t = props.find((x) => x.id === k)?.type; return t !== 'checkbox' && t !== 'person' && t !== 'page_link'; });
    changed(req, page, indexed);
    return presentRows(ctxOf(req, page), props, !!req.auth, row.id)[0];
  });

  app.post('/bases/:id/rows/delete', { ...write, schema: { tags, summary: 'Supprimer des lignes', params: idParams, body: rowsDelete } }, async (req) => {
    const page = openBase(req, (req.params as { id: string }).id, 'write');
    const n = removeRows(db, page.id, (req.body as z.output<typeof rowsDelete>).ids);
    if (n) { audit(db, req, 'base.rows.delete', page.id, detail(page, { count: n, remaining: rowCount(db, page.id) })); changed(req, page); }
    return { deleted: n };
  });

  // ----- Vues -----
  app.post('/bases/:id/views', { ...write, schema: { tags, summary: 'Ajouter une vue', params: idParams, body: viewBody } }, async (req, reply) => {
    const page = openBase(req, (req.params as { id: string }).id, 'write');
    const b = req.body as z.output<typeof viewBody>;
    const { id } = addView(db, page.id, b.name, b.config);
    bus.publish({ type: 'base.changed', spaceId: page.space_id, pageId: page.id, by: by(req) });
    return reply.status(201).send(viewsOf(db, page.id).find((v) => v.id === id));
  });

  app.patch('/bases/:id/views/:viewId', { ...write, schema: { tags, summary: 'Modifier une vue (nom, tri, filtres, colonnes masquées)', params: viewParams, body: viewPatch } }, async (req) => {
    const p = req.params as z.output<typeof viewParams>;
    const page = openBase(req, p.id, 'write');
    const b = req.body as z.output<typeof viewPatch>;
    const cur = viewsOf(db, page.id).find((v) => v.id === p.viewId);
    if (!cur) throw new HttpError(404, 'Vue introuvable');
    const config = b.config ? checkViewConfig(db, page.id, b.config) : cur.config;
    db.prepare('UPDATE base_views SET name = ?, config = ? WHERE id = ?').run(b.name ?? cur.name, JSON.stringify(config), cur.id);
    bus.publish({ type: 'base.changed', spaceId: page.space_id, pageId: page.id, by: by(req) });
    return viewsOf(db, page.id).find((v) => v.id === cur.id);
  });

  app.delete('/bases/:id/views/:viewId', { ...write, schema: { tags, summary: 'Supprimer une vue (il en reste toujours une)', params: viewParams } }, async (req, reply) => {
    const p = req.params as z.output<typeof viewParams>;
    const page = openBase(req, p.id, 'write');
    const views = viewsOf(db, page.id);
    if (!views.some((v) => v.id === p.viewId)) throw new HttpError(404, 'Vue introuvable');
    if (views.length <= 1) throw new HttpError(409, 'Une base garde au moins une vue');
    db.prepare('DELETE FROM base_views WHERE id = ?').run(p.viewId);
    bus.publish({ type: 'base.changed', spaceId: page.space_id, pageId: page.id, by: by(req) });
    return reply.status(204).send();
  });
}
