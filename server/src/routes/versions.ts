// Versionnement de l'API : v1 (dépréciée), v2 et v3 (stables) sont servies côte à côte.
// Une version « deprecated » reçoit les en-têtes Deprecation/Sunset (RFC 9745 / RFC 8594).
import type { FastifyInstance } from 'fastify';

export type VersionStatus = 'stable' | 'deprecated' | 'disabled';

export interface ApiVersion {
  id: string;
  status: VersionStatus;
  basePath: string;
  sunset?: string; // date HTTP (IMF-fixdate), seulement pour « deprecated »
  notes: string;
}

export const API_VERSIONS: ApiVersion[] = [
  { id: 'v1', status: 'deprecated', basePath: '/api/v1', sunset: 'Sat, 01 May 2027 00:00:00 GMT', notes: 'Dépréciée : désactivée par défaut (API_LEGACY_VERSIONS=v1 pour la réactiver).' },
  { id: 'v2', status: 'deprecated', basePath: '/api/v2', sunset: 'Sat, 01 May 2027 00:00:00 GMT', notes: 'Dépréciée : désactivée par défaut (API_LEGACY_VERSIONS=v2). Tout est repris par la v3.' },
  { id: 'v3', status: 'stable', basePath: '/api/v3', notes: 'Tout v2, plus commentaires de page et permissions fines par page. GraphQL non fourni.' },
];

// En-têtes de dépréciation d'après l'URL : appelé par le hook racine de l'application (un hook de plugin
// n'atteindrait pas les routes des autres plugins).
export function deprecationHeaders(url: string): Record<string, string> {
  const version = API_VERSIONS.find((v) => url.startsWith(`${v.basePath}/`));
  if (version?.status !== 'deprecated') return {};
  return { deprecation: 'true', ...(version.sunset ? { sunset: version.sunset } : {}), link: '</api/versions>; rel="deprecation"' };
}

export default async function versionRoutes(app: FastifyInstance) {
  // Une version héritée non activée (API_LEGACY_VERSIONS) est annoncée « disabled ».
  app.get('/api/versions', { schema: { tags: ['meta'], summary: 'Versions de l’API et leur état' } }, async () => ({
    current: [...API_VERSIONS].reverse().find((v) => v.status === 'stable')?.id,
    versions: API_VERSIONS.map((v) => (v.status === 'deprecated' && !app.config.API_LEGACY_VERSIONS.includes(v.id as 'v1' | 'v2') ? { ...v, status: 'disabled' as VersionStatus, sunset: undefined } : v)),
  }));
}
