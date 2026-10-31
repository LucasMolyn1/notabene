import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { guard } from '../auth/context.js';
import { requireSpaceRole } from '../lib/access.js';
import { audit } from '../lib/audit.js';
import { idSchema } from '../lib/http.js';
import { IMPORT_LIMITS, importMarkdown } from '../lib/markdown-import.js';

const body = z.object({
  spaceId: idSchema,
  files: z.array(z.object({ path: z.string().min(1).max(500), content: z.string() })).min(1).max(IMPORT_LIMITS.files),
});

export default async function importRoutes(app: FastifyInstance) {
  app.post('/admin/import/markdown', {
    preHandler: guard('admin'),
    bodyLimit: 32 * 1024 * 1024,
    config: { rateLimit: { max: 10, timeWindow: '1 hour' } },
    schema: { tags: ['admin'], summary: 'Importer des fichiers Markdown (export Wiki.js, dossier de notes) dans un espace', body },
  }, async (req) => {
    const { spaceId, files } = req.body as z.output<typeof body>;
    requireSpaceRole(app.db, req, spaceId, 'edit'); // jamais dans l'espace personnel de quelqu'un d'autre
    const result = importMarkdown(app.db, { spaceId, files, userId: req.auth?.user.id ?? null });
    audit(app.db, req, 'import.markdown', spaceId, { files: files.length, ...result });
    app.bus.publish({ type: 'space.changed', spaceId });
    return result;
  });
}
