// Serveur MCP (Model Context Protocol) en HTTP « sans état » : JSON-RPC 2.0 sur POST /mcp.
// Chaque outil rappelle l'API REST avec le jeton de l'appelant : portées, rôle et visibilité
// des espaces sont donc appliqués par le même code que le reste de l'application.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { can, type Scope } from '../auth/context.js';
import { idSchema } from '../lib/http.js';

const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const rpc = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string().max(100),
  params: z.record(z.string(), z.unknown()).optional(),
});

interface Tool {
  name: string;
  description: string;
  scope: Scope;
  readOnly: boolean;
  schema: z.ZodObject;
  run: (args: never, call: Call) => Promise<string>;
}
type Call = (method: 'GET' | 'POST', url: string, payload?: unknown) => Promise<{ status: number; body: string }>;

const ok = (r: { status: number; body: string }) => {
  if (r.status >= 400) {
    let message = r.body;
    try { message = (JSON.parse(r.body) as { message?: string }).message ?? r.body; } catch { /* corps brut */ }
    throw new Error(`HTTP ${r.status} : ${message}`);
  }
  return r.body;
};

// Texte brut -> document TipTap : « # » = titre, lignes vides = paragraphes.
function textToDoc(text: string) {
  const content = text.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean).map((block) => {
    const h = /^(#{1,3})\s+(.+)$/.exec(block);
    const t = (s: string) => ({ type: 'text', text: s });
    return h ? { type: 'heading', attrs: { level: h[1]!.length }, content: [t(h[2]!)] } : { type: 'paragraph', content: [t(block)] };
  });
  return { type: 'doc', content: content.length ? content : [{ type: 'paragraph' }] };
}

const TOOLS: Tool[] = [
  {
    name: 'list_spaces', description: 'Liste les espaces accessibles (id, nom, visibilité).', scope: 'read', readOnly: true,
    schema: z.object({}),
    run: async (_a, call) => ok(await call('GET', '/api/v3/spaces')),
  },
  {
    name: 'list_pages', description: 'Liste les pages (titres et hiérarchie, sans contenu), éventuellement d’un seul espace.', scope: 'read', readOnly: true,
    schema: z.object({ spaceId: idSchema.optional().describe('Identifiant de l’espace') }),
    run: async (a: { spaceId?: string }, call) => {
      // v3 : liste paginée par curseur ; on suit les pages (borné) et on renvoie un tableau.
      const items: unknown[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < 20 && (i === 0 || cursor); i++) {
        const page = JSON.parse(ok(await call('GET', `/api/v3/pages?limit=200${a.spaceId ? `&spaceId=${a.spaceId}` : ''}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`))) as { items: unknown[]; nextCursor: string | null };
        items.push(...page.items);
        cursor = page.nextCursor;
      }
      return JSON.stringify(items);
    },
  },
  {
    name: 'search_pages', description: 'Recherche plein texte dans les pages accessibles ; renvoie id, titre et extrait.', scope: 'read', readOnly: true,
    schema: z.object({ query: z.string().trim().min(1).max(200), limit: z.number().int().min(1).max(50).default(10) }),
    run: async (a: { query: string; limit: number }, call) => JSON.stringify((JSON.parse(ok(await call('GET', `/api/v3/search?q=${encodeURIComponent(a.query)}&limit=${a.limit}`))) as { items: unknown[] }).items),
  },
  {
    name: 'get_page', description: 'Lit le contenu d’une page au format Markdown.', scope: 'read', readOnly: true,
    schema: z.object({ id: idSchema }),
    run: async (a: { id: string }, call) => ok(await call('GET', `/api/v3/pages/${a.id}/export?format=markdown`)),
  },
  {
    name: 'create_page', description: 'Crée une page (texte simple : « # Titre » pour un titre, ligne vide entre paragraphes). Nécessite la portée write.', scope: 'write', readOnly: false,
    schema: z.object({ spaceId: idSchema, title: z.string().trim().min(1).max(300), text: z.string().max(100_000).default(''), parentId: idSchema.optional() }),
    run: async (a: { spaceId: string; title: string; text: string; parentId?: string }, call) => {
      const page = JSON.parse(ok(await call('POST', '/api/v3/pages', { spaceId: a.spaceId, parentId: a.parentId, title: a.title, content: textToDoc(a.text) }))) as { id: string };
      return JSON.stringify({ id: page.id, url: `/#/p/${page.id}` });
    },
  },
];

export default async function mcpRoutes(app: FastifyInstance) {
  const publicOrigin = new URL(app.config.PUBLIC_URL).origin;

  app.get('/mcp', { schema: { hide: true } }, async (_req, reply) => reply.code(405).header('allow', 'POST').send({ message: 'Utilisez POST' }));

  app.post('/mcp', { schema: { tags: ['mcp'], summary: 'Serveur MCP (JSON-RPC 2.0, jeton d’API Bearer obligatoire)' } }, async (req, reply) => {
    // Protection contre le DNS rebinding : un navigateur ne doit pas pouvoir piloter ce point d'accès.
    const origin = req.headers.origin;
    if (origin && origin !== publicOrigin) return reply.code(403).send({ message: 'Origine non autorisée' });
    const auth = req.auth;
    if (!auth || auth.via !== 'token') return reply.code(401).header('www-authenticate', 'Bearer').send({ message: 'Jeton d’API Bearer requis' });

    const parsed = rpc.safeParse(req.body);
    const error = (id: unknown, code: number, message: string) => reply.send({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
    if (!parsed.success) return error(null, -32600, 'Requête JSON-RPC invalide (les lots ne sont pas pris en charge)');
    const { id, method, params } = parsed.data;
    const result = (value: unknown) => reply.send({ jsonrpc: '2.0', id, result: value });

    if (id === undefined) return reply.code(202).send(); // notification

    switch (method) {
      case 'initialize': {
        const wanted = params?.protocolVersion;
        return result({
          protocolVersion: typeof wanted === 'string' && PROTOCOLS.includes(wanted) ? wanted : PROTOCOLS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'notabene', version: '1.0.0' },
          instructions: 'Wiki Notabene : recherchez, lisez et créez des pages. Les droits sont ceux du jeton utilisé.',
        });
      }
      case 'ping':
        return result({});
      case 'tools/list':
        return result({
          tools: TOOLS.filter((t) => can(auth, t.scope)).map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: z.toJSONSchema(t.schema, { io: 'input' }),
            annotations: { readOnlyHint: t.readOnly, openWorldHint: false },
          })),
        });
      case 'tools/call': {
        const tool = TOOLS.find((t) => t.name === params?.name);
        if (!tool || !can(auth, tool.scope)) return error(id, -32602, 'Outil inconnu');
        const args = tool.schema.safeParse(params?.arguments ?? {});
        if (!args.success) return result({ isError: true, content: [{ type: 'text', text: `Arguments invalides : ${args.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join(' ; ')}` }] });
        const call: Call = async (m, url, payload) => {
          const res = await app.inject({ method: m, url, payload: payload as object | undefined, headers: { authorization: req.headers.authorization! } });
          return { status: res.statusCode, body: res.body };
        };
        try {
          return result({ content: [{ type: 'text', text: await tool.run(args.data as never, call) }] });
        } catch (err) {
          return result({ isError: true, content: [{ type: 'text', text: (err as Error).message }] });
        }
      }
      default:
        return error(id, -32601, 'Méthode inconnue');
    }
  });
}
