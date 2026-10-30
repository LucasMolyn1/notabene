// Versionnement de l'API : seule la v3 est servie. v1 et v2 ont été retirées (historique conservé pour la découverte).
import type { FastifyInstance } from 'fastify';

export type VersionStatus = 'stable' | 'removed';

export interface ApiVersion {
  id: string;
  status: VersionStatus;
  basePath: string;
  notes: string;
}

export const API_VERSIONS: ApiVersion[] = [
  { id: 'v1', status: 'removed', basePath: '/api/v1', notes: 'Retirée : remplacée par la v3.' },
  { id: 'v2', status: 'removed', basePath: '/api/v2', notes: 'Retirée : pagination par curseur, ETag/If-Match et erreurs RFC 9457 sont dans la v3.' },
  { id: 'v3', status: 'stable', basePath: '/api/v3', notes: 'Pagination par curseur, ETag/If-Match, erreurs RFC 9457, commentaires, permissions par page, notifications. GraphQL non fourni.' },
];

export default async function versionRoutes(app: FastifyInstance) {
  app.get('/api/versions', { schema: { tags: ['meta'], summary: 'Versions de l’API et leur état' } }, async () => ({
    current: API_VERSIONS.find((v) => v.status === 'stable')?.id,
    versions: API_VERSIONS,
  }));
}
