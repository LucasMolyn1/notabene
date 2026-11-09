// Blocs synchronisés : lecture du contenu d'une source pour l'afficher dans une copie (lib/synced-blocks.ts).
// Mêmes droits que GET /pages/:id sur la page source : espace visible (adhésion, groupe, espace public), permissions de page y
// compris héritées, page hors corbeille, portée « read » d'un jeton (sinon, droits d'un visiteur anonyme). Tout refus, comme un
// bloc inconnu ou retiré, donne la même réponse 404 : le corps ne révèle ni l'existence du bloc, ni sa page, son titre ou son
// espace. La durée peut différer légèrement (voir readSyncedSource). La réponse ne contient ni titre ni identifiant de page.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { readableSpaceIds } from '../lib/access.js';
import { HttpError } from '../lib/http.js';
import { canReadPage } from '../lib/page-acl.js';
import { readSyncedSource } from '../lib/synced-blocks.js';

// Format vérifié dans le gestionnaire (et non par le schéma) : un identifiant mal formé reçoit le même 404 qu'un bloc inconnu.
const params = z.object({ id: z.string().max(64) });

export default async function syncedBlockRoutes(app: FastifyInstance) {
  const { db } = app;

  app.get('/synced-blocks/:id', {
    schema: {
      tags: ['synced-blocks'],
      summary: 'Contenu d’un bloc synchronisé (source), pour l’afficher dans une copie : { id, content } si la page source est lisible, 404 sinon',
      params,
    },
  }, async (req) => {
    const { id } = req.params as z.output<typeof params>;
    const spaces = new Set(readableSpaceIds(db, req));
    const page = db.prepare('SELECT space_id, deleted_at FROM pages WHERE id = ?');
    const canRead = (pageId: string) => {
      const row = page.get(pageId) as { space_id: string; deleted_at: number | null } | undefined;
      // Toujours évalué, même pour un bloc inconnu (sur un identifiant qui ne désigne aucune page) : la réponse ne dépend que du
      // résultat ; la durée reste un peu plus longue pour une page existante (requêtes d'espace et de restrictions).
      const acl = canReadPage(db, req.auth, pageId);
      return !!row && !row.deleted_at && spaces.has(row.space_id) && acl;
    };
    const content = readSyncedSource(db, id, canRead);
    if (!content) throw new HttpError(404, 'Bloc introuvable');
    return { id, content };
  });
}
