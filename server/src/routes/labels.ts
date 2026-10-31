// Libellés de page : lecture, ajout, retrait et liste des libellés utilisés.
// Les droits sont ceux de la page : on lit un libellé comme la page, on le pose comme on la modifie.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { guard } from '../auth/context.js';
import { loadReadablePage, loadWritablePage, readableSpaceIds } from '../lib/access.js';
import { audit } from '../lib/audit.js';
import { inPersonalSpace } from '../lib/personal-spaces.js';
import { idParams, idSchema } from '../lib/http.js';
import { addLabel, labelCounts, labelsOf, normalizeLabel, removeLabel } from '../lib/labels.js';
import { filterReadable } from '../lib/page-acl.js';
import { listPages } from '../lib/pages.js';

const nameBody = z.object({ name: z.string().min(1).max(80) });
const nameParams = z.object({ id: idSchema, name: z.string().min(1).max(80) });

export default async function labelRoutes(app: FastifyInstance) {
  const { db, bus } = app;
  const tags = ['labels'];
  const announce = (req: { auth: { user: { id: string; name: string } } | null }, spaceId: string, pageId: string) =>
    bus.publish({ type: 'page.labels', spaceId, pageId, by: req.auth ? { id: req.auth.user.id, name: req.auth.user.name } : undefined });

  app.get('/pages/:id/labels', { schema: { tags, summary: 'Libellés d’une page', params: idParams } }, async (req) => {
    const page = loadReadablePage(db, req, (req.params as { id: string }).id);
    return { items: labelsOf(db, page.id) };
  });

  app.post('/pages/:id/labels', {
    preHandler: guard('write'),
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    schema: { tags, summary: 'Ajouter un libellé à une page (sans effet s’il y est déjà)', params: idParams, body: nameBody },
  }, async (req) => {
    const page = loadWritablePage(db, req, (req.params as { id: string }).id);
    const name = normalizeLabel((req.body as z.output<typeof nameBody>).name);
    if (addLabel(db, page.id, name, req.auth?.user.id ?? null)) {
      audit(db, req, 'page.label.add', page.id, inPersonalSpace(db, page.id) ? undefined : { name });
      announce(req, page.space_id, page.id);
    }
    return { items: labelsOf(db, page.id) };
  });

  app.delete('/pages/:id/labels/:name', {
    preHandler: guard('write'),
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    schema: { tags, summary: 'Retirer un libellé d’une page', params: nameParams },
  }, async (req) => {
    const p = req.params as z.output<typeof nameParams>;
    const page = loadWritablePage(db, req, p.id);
    const name = normalizeLabel(p.name);
    if (removeLabel(db, page.id, name)) {
      audit(db, req, 'page.label.remove', page.id, inPersonalSpace(db, page.id) ? undefined : { name });
      announce(req, page.space_id, page.id);
    }
    return { items: labelsOf(db, page.id) };
  });

  // Seuls comptent les libellés des pages que l'appelant peut lire : un libellé d'une page restreinte n'apparaît ni ici ni dans les totaux.
  app.get('/labels', {
    schema: {
      tags,
      summary: 'Libellés utilisés (avec le nombre de pages lisibles qui les portent)',
      querystring: z.object({ q: z.string().trim().max(40).default(''), spaceId: idSchema.optional() }),
    },
  }, async (req) => {
    const { q, spaceId } = req.query as { q: string; spaceId?: string };
    const spaces = readableSpaceIds(db, req).filter((s) => !spaceId || s === spaceId);
    const pages = filterReadable(db, req.auth, listPages(db, spaces, null));
    return { items: labelCounts(db, pages.map((p) => p.id), q.toLocaleLowerCase('fr').normalize('NFC')) };
  });
}
