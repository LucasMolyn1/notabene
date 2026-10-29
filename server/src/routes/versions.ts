// Versionnement de l'API : seule v1 est servie ; v2 et v3 sont déclarées pour la découverte.
// Une version « deprecated » reçoit les en-têtes Deprecation/Sunset (RFC 9745 / RFC 8594).
import type { FastifyInstance } from 'fastify';

export type VersionStatus = 'stable' | 'deprecated' | 'planned';

export interface ApiVersion {
  id: string;
  status: VersionStatus;
  basePath: string;
  sunset?: string; // date HTTP (IMF-fixdate), seulement pour « deprecated »
  notes: string;
}

export const API_VERSIONS: ApiVersion[] = [
  { id: 'v1', status: 'stable', basePath: '/api/v1', notes: 'Pages, espaces, recherche, jetons, IA, administration, webhooks.' },
  { id: 'v2', status: 'planned', basePath: '/api/v2', notes: 'Prévue : pagination par curseur, filtres, ETag/If-Match sur les pages, évènements et webhooks étendus.' },
  { id: 'v3', status: 'planned', basePath: '/api/v3', notes: 'Prévue : ressources collaboratives (commentaires, permissions fines par page), GraphQL optionnel.' },
];

export default async function versionRoutes(app: FastifyInstance) {
  app.get('/api/versions', { schema: { tags: ['meta'], summary: 'Versions de l’API et leur état' } }, async () => ({
    current: API_VERSIONS.find((v) => v.status === 'stable')?.id,
    versions: API_VERSIONS,
  }));

  app.addHook('onSend', async (req, reply, payload) => {
    const version = API_VERSIONS.find((v) => req.url.startsWith(`${v.basePath}/`));
    if (version?.status === 'deprecated') {
      reply.header('deprecation', 'true');
      if (version.sunset) reply.header('sunset', version.sunset);
      reply.header('link', '</api/versions>; rel="deprecation"');
    }
    return payload;
  });
}
