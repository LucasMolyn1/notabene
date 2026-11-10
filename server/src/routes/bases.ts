// Bases (tableaux) : création, lecture, colonnes, lignes, vues et export CSV.
// L'accès est celui de la page qui porte la base (loadReadablePage / loadWritablePage) : lecture = pouvoir lire la page, écriture =
// pouvoir la modifier. Une page qui n'est pas une base répond 404 ici, comme une base inexistante.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { can, guard, requireAuth } from '../auth/context.js';
import { loadReadablePage, loadWritablePage, readableSpaceIds, requireSpaceRole } from '../lib/access.js';
import { audit } from '../lib/audit.js';
import { createOrRotateFeed, feedOf, revokeFeed } from '../lib/base-ical.js';
import {
  cascadeShift, MAX_BLOCKERS, MAX_DEPTH, MAX_SHIFT_DEPTH, MAX_SHIFT_ROWS, setBlockers, setParent, settingsOf, updateSettings,
} from '../lib/base-project.js';
import {
  cleanName, addProperty, addRow, addView, checkViewConfig, createBase, MAX_DELETE, MAX_LINKS, MAX_PROPERTIES, MAX_RELATIONS, MAX_ROLLUPS, MAX_ROWS,
  optionSchema, patchRow, presentProperties, presentRows, propertiesOf, PROPERTY_TYPES, reindexBase, relationInput, removeProperty, removeRows,
  rollupInput, rowCount, toCsv, touchBase, updateProperty, viewConfigSchema, viewsOf, type Ctx,
} from '../lib/bases.js';
import { MAX_TASK_BASES, MAX_TASKS, myTasks, progressOf } from '../lib/base-tasks.js';
import { MAX_FORMULA_CHARS } from '../lib/formula.js';
import { HttpError, idParams, idSchema } from '../lib/http.js';
import { canWritePage } from '../lib/page-acl.js';
import { inPersonalSpace } from '../lib/personal-spaces.js';
import { toMeta, type PageRow } from '../lib/pages.js';
import { restrictionKey, sharingEnabled } from '../lib/shares.js';

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
// `config` : relation { targetId, twoWay? } ou cumul { relationId, targetPropertyId?, fn } ; revalidée selon le type par lib/bases.ts.
const propertyBody = z.object({
  name: propertyName, type: z.enum(PROPERTY_TYPES), options: z.array(optionSchema).max(100).optional(), formula: z.string().max(MAX_FORMULA_CHARS).optional(),
  config: z.union([relationInput, rollupInput]).optional(),
});
const propertyPatch = z.object({ name: propertyName.optional(), options: z.array(optionSchema).max(100).optional(), formula: z.string().max(MAX_FORMULA_CHARS).optional(), config: rollupInput.optional() });
const propParams = z.object({ id: idSchema, propId: idSchema });
const rowParams = z.object({ id: idSchema, rowId: idSchema });
const viewParams = z.object({ id: idSchema, viewId: idSchema });
const rowBody = z.object({
  values: values.default({}),
  parentId: idSchema.nullable().optional(),
  blockedBy: z.array(idSchema).max(MAX_BLOCKERS).optional(),
});
const rowsDelete = z.object({ ids: z.array(idSchema).min(1).max(MAX_DELETE) });
const settingsBody = z.object({
  subitems: z.boolean().optional(),
  dependencies: z.boolean().optional(),
  startPropertyId: idSchema.nullable().optional(),
  endPropertyId: idSchema.nullable().optional(),
}).strict();
const viewBody = z.object({ name: viewName, config: viewConfigSchema.default({ type: 'table', sort: [], filters: [], hidden: [] }) });
const viewPatch = z.object({ name: viewName.optional(), config: viewConfigSchema.optional() });
// « Mes tâches » : `done=false` écarte les tâches terminées ; par défaut (`true`), toutes.
const tasksQuery = z.object({ done: z.enum(['true', 'false']).default('true') });
const icalBody = z.object({ confirmRestricted: z.boolean().optional() }).nullish();

export default async function baseRoutes(app: FastifyInstance) {
  const { db, bus, config } = app;
  const tags = ['bases'];
  const write = { preHandler: guard('write'), config: { rateLimit: { max: 300, timeWindow: '1 minute' } } };

  const openBase = (req: FastifyRequest, id: string, mode: 'read' | 'write'): PageRow => {
    // Une base n'est jamais lisible sans compte, même dans un espace public (données structurées, noms de personnes) : 404, comme si elle n'existait pas.
    if (!req.auth || !can(req.auth, 'read')) throw new HttpError(404, 'Base introuvable');
    const page = mode === 'write' ? loadWritablePage(db, req, id) : loadReadablePage(db, req, id);
    if (page.kind !== 'base') throw new HttpError(404, 'Base introuvable');
    return page;
  };
  const ctxOf = (req: FastifyRequest, page: PageRow): Ctx => ({ db, auth: req.auth, spaces: new Set(readableSpaceIds(db, req)), baseId: page.id, touched: new Set() });
  const by = (req: FastifyRequest) => (req.auth ? { id: req.auth.user.id, name: req.auth.user.name } : undefined);
  const userId = (req: FastifyRequest) => req.auth?.user.id ?? null;
  // Après une écriture : texte de recherche, date de modification, événement pour les autres écrans.
  const changed = (req: FastifyRequest, page: PageRow, reindex = true) => {
    if (reindex) reindexBase(db, page.id);
    touchBase(db, page.id, userId(req));
    bus.publish({ type: 'base.changed', spaceId: page.space_id, pageId: page.id, by: by(req) });
  };
  // Autres bases modifiées par la même écriture (colonne ou cellules miroirs d'une relation double, liens vers des lignes supprimées).
  const changedOthers = (req: FastifyRequest, ctx: Ctx) => {
    for (const id of ctx.touched ?? []) {
      const other = db.prepare('SELECT id, space_id FROM pages WHERE id = ?').get(id) as { id: string; space_id: string } | undefined;
      if (!other) continue;
      touchBase(db, id, userId(req));
      bus.publish({ type: 'base.changed', spaceId: other.space_id, pageId: id, by: by(req) });
    }
  };
  // Dans un espace personnel le journal ne garde pas de détail (comme pour les libellés).
  const detail = (page: PageRow, meta: Record<string, unknown>) => (inPersonalSpace(db, page.id) ? undefined : meta);

  const present = (req: FastifyRequest, page: PageRow) => {
    const props = propertiesOf(db, page.id);
    const ctx = ctxOf(req, page);
    return {
      page: toMeta(page),
      canWrite: can(req.auth, 'write') && canWritePage(db, req.auth, page.id),
      limits: { rows: MAX_ROWS, properties: MAX_PROPERTIES, relations: MAX_RELATIONS, rollups: MAX_ROLLUPS, links: MAX_LINKS, blockers: MAX_BLOCKERS, depth: MAX_DEPTH, shiftDepth: MAX_SHIFT_DEPTH, shiftRows: MAX_SHIFT_ROWS, delete: MAX_DELETE },
      settings: settingsOf(db, page.id),
      // Agrégat de lignes que le lecteur voit déjà : visible de tout lecteur de la base.
      progress: progressOf(db, page.id, props),
      properties: presentProperties(ctx, props),
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
    const ctx = ctxOf(req, page);
    const prop = addProperty(db, page.id, b, ctx);
    audit(db, req, 'base.property.add', page.id, detail(page, { type: b.type, ...(ctx.touched?.size ? { linked: [...ctx.touched] } : {}) }));
    changed(req, page);
    changedOthers(req, ctx);
    return reply.status(201).send(presentProperties(ctx, propertiesOf(db, page.id)).find((x) => x.id === prop.id));
  });

  app.patch('/bases/:id/properties/:propId', { ...write, schema: { tags, summary: 'Renommer une colonne ou changer ses options', params: propParams, body: propertyPatch } }, async (req) => {
    const p = req.params as z.output<typeof propParams>;
    const page = openBase(req, p.id, 'write');
    const ctx = ctxOf(req, page);
    const prop = updateProperty(db, page.id, p.propId, req.body as z.output<typeof propertyPatch>, ctx);
    changed(req, page);
    return presentProperties(ctx, propertiesOf(db, page.id)).find((x) => x.id === prop.id);
  });

  app.delete('/bases/:id/properties/:propId', { ...write, schema: { tags, summary: 'Supprimer une colonne et ses valeurs', params: propParams } }, async (req, reply) => {
    const p = req.params as z.output<typeof propParams>;
    const page = openBase(req, p.id, 'write');
    const ctx = ctxOf(req, page);
    removeProperty(db, page.id, p.propId, ctx.touched);
    audit(db, req, 'base.property.remove', page.id, ctx.touched?.size ? detail(page, { linked: [...ctx.touched] }) : undefined);
    changed(req, page);
    changedOthers(req, ctx);
    return reply.status(204).send();
  });

  // ----- Lignes -----
  // Écriture d'une ligne : cellules, puis parent et dépendances, puis décalage en cascade, le tout dans une transaction (un refus
  // à n'importe quelle étape n'écrit rien, ni dans cette base ni dans une base liée).
  const writeRow = (ctx: Ctx, rowId: string | null, b: z.output<typeof rowBody>, uid: string | null) => db.transaction(() => {
    const id = rowId === null ? addRow(ctx, b.values, uid).id : patchRow(ctx, rowId, b.values, uid).id;
    if (b.parentId !== undefined) setParent(ctx, id, b.parentId);
    if (b.blockedBy !== undefined) setBlockers(ctx, id, b.blockedBy);
    return { id, shifted: cascadeShift(ctx, id, uid) };
  })();
  // Le texte de recherche ne dépend ni des cases cochées, ni des personnes, ni des pages ou lignes liées : inutile de le refaire pour elles.
  const indexedBy = (pageId: string, patch: Record<string, unknown>, shifted: number) => {
    const props = propertiesOf(db, pageId);
    return shifted > 0 || Object.keys(patch).some((k) => { const t = props.find((x) => x.id === k)?.type; return t !== 'checkbox' && t !== 'person' && t !== 'page_link' && t !== 'relation'; });
  };

  app.post('/bases/:id/rows', { ...write, schema: { tags, summary: 'Ajouter une ligne (cellules, ligne parente, lignes bloquantes)', params: idParams, body: rowBody } }, async (req, reply) => {
    const page = openBase(req, (req.params as { id: string }).id, 'write');
    const b = req.body as z.output<typeof rowBody>;
    const ctx = ctxOf(req, page);
    const { id, shifted } = writeRow(ctx, null, b, userId(req));
    changed(req, page, indexedBy(page.id, b.values, shifted.length));
    changedOthers(req, ctx);
    return reply.status(201).send(presentRows(ctx, propertiesOf(db, page.id), !!req.auth, id)[0]);
  });

  // Réponse : la ligne (champs à la racine, comme avant), plus `row` (la même) et `shifted` (lignes décalées en cascade). Ajout compatible.
  app.patch('/bases/:id/rows/:rowId', { ...write, schema: { tags, summary: 'Modifier une ligne : cellules (null efface), ligne parente, lignes bloquantes', params: rowParams, body: rowBody } }, async (req) => {
    const p = req.params as z.output<typeof rowParams>;
    const page = openBase(req, p.id, 'write');
    const b = req.body as z.output<typeof rowBody>;
    const ctx = ctxOf(req, page);
    const { id, shifted } = writeRow(ctx, p.rowId, b, userId(req));
    changed(req, page, indexedBy(page.id, b.values, shifted.length));
    changedOthers(req, ctx);
    const all = presentRows(ctx, propertiesOf(db, page.id), !!req.auth, [id, ...shifted]);
    const row = all.find((r) => r.id === id)!;
    return { ...row, row, shifted: all.filter((r) => r.id !== id) };
  });

  app.post('/bases/:id/rows/delete', { ...write, schema: { tags, summary: 'Supprimer des lignes et leurs sous-éléments', params: idParams, body: rowsDelete } }, async (req) => {
    const page = openBase(req, (req.params as { id: string }).id, 'write');
    const ctx = ctxOf(req, page);
    const n = removeRows(db, page.id, (req.body as z.output<typeof rowsDelete>).ids, ctx.touched);
    if (n) {
      audit(db, req, 'base.rows.delete', page.id, detail(page, { count: n, remaining: rowCount(db, page.id), ...(ctx.touched?.size ? { linked: [...ctx.touched] } : {}) }));
      changed(req, page);
      changedOthers(req, ctx);
    }
    return { deleted: n };
  });

  // ----- Réglages -----
  app.patch('/bases/:id/settings', { ...write, schema: { tags, summary: 'Modifier les réglages (sous-éléments, dépendances, colonnes de début et de fin)', params: idParams, body: settingsBody } }, async (req) => {
    const page = openBase(req, (req.params as { id: string }).id, 'write');
    const b = req.body as z.output<typeof settingsBody>;
    const settings = updateSettings(db, page.id, b);
    audit(db, req, 'base.settings', page.id, detail(page, { ...settings }));
    changed(req, page, false);
    return settings;
  });

  // ----- Flux iCalendar (adresse secrète en lecture, sans compte : routes/ical.ts) -----
  // Gestion : droit d'écriture sur la base. Lire l'état et créer (ou changer) l'adresse : session web seulement, comme le partage
  // public d'une page ; révoquer : aussi par jeton d'API de portée write (couper un accès ne doit jamais être plus difficile). Le
  // jeton n'est rendu qu'à la création ou à la rotation, dans l'adresse ; il n'est ni stocké (empreinte seulement), ni audité.
  const icalLimit = { preHandler: guard('write'), config: { rateLimit: { max: 30, timeWindow: '1 minute' } } };
  const spaceAllows = (spaceId: string) => !!db.prepare('SELECT 1 FROM spaces WHERE id = ? AND sharing_enabled = 1').get(spaceId);
  const icalUrl = (token: string) => `${config.PUBLIC_URL}/ical/${token}.ics`;
  const needSession = (req: FastifyRequest) => {
    if (requireAuth(req).via !== 'session') throw new HttpError(403, 'Le flux iCalendar se règle depuis la session web');
  };

  app.get('/bases/:id/ical', { ...icalLimit, schema: { tags, summary: 'État du flux iCalendar d’une base (jamais l’adresse)', params: idParams } }, async (req) => {
    needSession(req);
    const page = openBase(req, (req.params as { id: string }).id, 'write');
    const feed = feedOf(db, page.id);
    return { available: sharingEnabled(db) && spaceAllows(page.space_id), active: !!feed, createdAt: feed?.created_at ?? null };
  });

  app.post('/bases/:id/ical', { ...icalLimit, schema: { tags, summary: 'Créer le flux iCalendar d’une base ou changer son adresse (montrée une seule fois)', params: idParams, body: icalBody } }, async (req, reply) => {
    needSession(req);
    const page = openBase(req, (req.params as { id: string }).id, 'write');
    if (!sharingEnabled(db)) throw new HttpError(403, 'Le partage public n’est pas activé sur cette instance');
    if (!spaceAllows(page.space_id)) throw new HttpError(403, 'Le partage public est désactivé dans cet espace');
    // Base restreinte : confirmation demandée, sauf si le flux l'a déjà reçue pour exactement cette restriction (comme un partage).
    const key = restrictionKey(db, page.id);
    const confirmed = (req.body as z.output<typeof icalBody>)?.confirmRestricted === true;
    if (key !== null && !confirmed && feedOf(db, page.id)?.restricted_key !== key) {
      throw new HttpError(409, 'Cette base a des permissions restreintes : confirmez pour publier son calendrier', { code: 'restricted' });
    }
    const { token, rotated } = createOrRotateFeed(db, page.id, userId(req));
    audit(db, req, rotated ? 'base.ical.rotate' : 'base.ical.create', page.id);
    return reply.status(rotated ? 200 : 201).send({ url: icalUrl(token) });
  });

  app.delete('/bases/:id/ical', { ...icalLimit, schema: { tags, summary: 'Révoquer le flux iCalendar d’une base', params: idParams } }, async (req, reply) => {
    const page = openBase(req, (req.params as { id: string }).id, 'write');
    if (revokeFeed(db, page.id)) audit(db, req, 'base.ical.revoke', page.id);
    return reply.status(204).send();
  });

  // ----- Mes tâches -----
  app.get('/my-tasks', {
    preHandler: guard('read'),
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    schema: { tags, summary: `Mes tâches : lignes où une colonne Personne me désigne (${MAX_TASK_BASES} bases, ${MAX_TASKS} tâches au plus)`, querystring: tasksQuery },
  }, async (req) => {
    const q = req.query as z.output<typeof tasksQuery>;
    return myTasks(db, req.auth!, readableSpaceIds(db, req), q.done === 'true');
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
