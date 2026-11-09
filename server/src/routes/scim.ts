// Serveur SCIM 2.0 (RFC 7643, RFC 7644) sous /scim/v2 : comptes (`Users`) et groupes (`Groups`) provisionnés par le
// fournisseur d'identité. Voir docs/SCIM.md et lib/scim.ts pour les règles de sécurité.
//
// Ordre des contrôles pour chaque requête :
//  1. SCIM désactivé : 404 identique à une adresse inconnue (rien n'indique que la fonction existe) ;
//  2. limitation de débit par adresse IP ;
//  3. jeton SCIM (Bearer), avant la lecture du corps. Ni la session ni un jeton d'API ne comptent (app.ts ne les résout pas ici).
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { audit } from '../lib/audit.js';
import { MAX_GROUP_MEMBERS, MAX_GROUPS } from '../lib/groups.js';
import { idSchema, newId } from '../lib/http.js';
import { pagesOnlyOpenTo } from '../lib/page-acl.js';
import {
  SCHEMA, SCIM_BODY_LIMIT, SCIM_MAX_RESULTS, ScimError, displayNameOf, displayNameSchema, emailSchema, excludes, externalIdSchema,
  groupExternalIdSchema, iso, listQuery, nameSchema, parseFilter, primaryEmail, scimError, scimSettings, stripUrn, userNameSchema,
  verifyScimToken, type Filter,
} from '../lib/scim.js';

const CONTENT_TYPE = 'application/scim+json; charset=utf-8';
const clients = new WeakMap<FastifyRequest, string>();

// ---- Schémas des corps -------------------------------------------------------------------------------
const userInput = z.object({
  userName: userNameSchema,
  externalId: externalIdSchema.nullish(),
  displayName: z.string().max(300).nullish(),
  name: nameSchema.nullish(),
  emails: z.array(z.object({ value: emailSchema, type: z.string().max(50).nullish(), primary: z.boolean().nullish() })).max(10).nullish(),
  active: z.boolean().default(true),
});
type UserInput = z.output<typeof userInput>;

const memberRef = z.object({ value: idSchema });
const groupInput = z.object({
  displayName: displayNameSchema,
  externalId: groupExternalIdSchema.nullish(),
  members: z.array(memberRef).max(MAX_GROUP_MEMBERS).nullish(),
});

const patchInput = z.object({
  Operations: z.array(z.object({
    op: z.string().max(20).transform((v) => v.toLowerCase()).pipe(z.enum(['add', 'replace', 'remove'])),
    path: z.string().trim().min(1).max(300).optional(),
    value: z.unknown().optional(),
  })).min(1).max(100),
});
type PatchOp = z.output<typeof patchInput>['Operations'][number];

const idParam = z.object({ id: z.string().max(100) });

// Validation : la première erreur, sans reprendre la valeur reçue.
function parse<T extends z.ZodType>(schema: T, data: unknown): z.output<T> {
  const r = schema.safeParse(data);
  if (r.success) return r.data;
  const issue = r.error.issues[0];
  throw new ScimError(400, 'invalidValue', `Valeur invalide${issue?.path.length ? ` : ${issue.path.join('.')}` : ''}${issue?.message ? ` (${issue.message})` : ''}`);
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

// Un mot de passe n'est jamais défini par SCIM : refus explicite plutôt qu'un champ ignoré en silence.
function rejectPassword(body: Record<string, unknown>) {
  if (Object.keys(body).some((k) => stripUrn(k).toLowerCase() === 'password')) throw new ScimError(400, 'invalidValue', 'Les mots de passe ne se définissent pas par SCIM');
}

function bodyObject(body: unknown): Record<string, unknown> {
  if (!isObject(body)) throw new ScimError(400, 'invalidSyntax', 'Corps JSON attendu');
  return body;
}

// Attributs du schéma User qu'on accepte sans les enregistrer (présents chez les fournisseurs courants). `roles` en fait partie :
// le rôle d'un compte ne vient jamais de SCIM.
const IGNORED_USER_ATTRS = new Set(['title', 'preferredlanguage', 'locale', 'timezone', 'nickname', 'profileurl', 'usertype', 'phonenumbers', 'addresses', 'photos', 'ims', 'roles', 'entitlements', 'x509certificates']);
const ignoredUserAttr = (path: string) => {
  const p = path.toLowerCase();
  if (p.startsWith('urn:ietf:params:scim:schemas:extension:')) return true;
  const end = [p.indexOf('['), p.indexOf('.')].filter((i) => i >= 0);
  return IGNORED_USER_ATTRS.has(end.length ? p.slice(0, Math.min(...end)) : p);
};

const toBool = (v: unknown) => {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string' && /^(true|false)$/i.test(v)) return v.toLowerCase() === 'true';
  throw new ScimError(400, 'invalidValue', 'Valeur booléenne attendue : active');
};

export default async function scimRoutes(app: FastifyInstance) {
  const { db, config } = app;
  const base = `${config.PUBLIC_URL}/scim/v2`;
  const enabled = () => scimSettings(db, config).enabled;

  // Corps JSON : application/scim+json et application/json, 1 Mo au plus, protection contre la pollution de prototype.
  const jsonParser = app.getDefaultJsonParser('error', 'error');
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser(['application/json', 'application/scim+json'], { parseAs: 'string', bodyLimit: SCIM_BODY_LIMIT }, (req, body, done) => {
    if (body === '') { done(null, undefined); return; }
    jsonParser(req, String(body), done);
  });

  const send = (reply: FastifyReply, status: number, body: unknown) => reply.code(status).type(CONTENT_TYPE).send(body);

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ScimError) {
      if (err.status === 401) reply.header('www-authenticate', 'Bearer realm="scim"');
      return send(reply, err.status, scimError(err.status, err.message, err.scimType));
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status === 429) return send(reply, 429, scimError(429, 'Trop de requêtes : réessayez plus tard'));
    if (status === 413) return send(reply, 413, scimError(413, 'Corps trop volumineux'));
    if (status === 415) return send(reply, 415, scimError(415, 'Type de contenu non pris en charge : application/scim+json attendu'));
    if (status && status >= 400 && status < 500) return send(reply, status, scimError(status, 'Requête invalide', status === 400 ? 'invalidSyntax' : null));
    req.log.error({ err }, 'erreur interne SCIM');
    return send(reply, 500, scimError(500, 'Erreur interne'));
  });

  // 1. Fonction coupée : même réponse qu'une adresse inconnue.
  app.addHook('onRequest', async (_req, reply) => {
    if (!enabled()) return reply.code(404).send({ error: 'not_found', message: 'Ressource introuvable' });
  });

  // 3. Jeton SCIM, avant la lecture du corps. Un échec est journalisé au plus une fois par minute et par adresse.
  const lastFailure = new Map<string, number>();
  const rejectToken = (req: FastifyRequest): never => {
    const now = Date.now();
    if ((lastFailure.get(req.ip) ?? 0) < now - 60_000) {
      if (lastFailure.size > 1000) lastFailure.clear();
      lastFailure.set(req.ip, now);
      audit(db, req, 'scim.auth.failed', null, { via: 'scim' });
    }
    throw new ScimError(401, null, 'Authentification requise : jeton SCIM invalide, expiré ou révoqué');
  };
  app.addHook('preParsing', async (req, _reply, payload) => {
    const m = /^Bearer\s+(\S+)$/.exec(req.headers.authorization ?? '');
    clients.set(req, (m && verifyScimToken(db, m[1]!)) || rejectToken(req));
    return payload;
  });

  // 2. Limitation de débit propre à SCIM (avant le contrôle du jeton : `onRequest`).
  const opts = {
    bodyLimit: SCIM_BODY_LIMIT,
    schema: { hide: true },
    config: { rateLimit: { max: config.SCIM_RATE_LIMIT_PER_MINUTE, timeWindow: '1 minute', hook: 'onRequest' as const, keyGenerator: (req: FastifyRequest) => `scim:${req.ip}` } },
  };

  // Journal d'audit : acteur SCIM (aucun compte), identifiant du jeton utilisé, jamais de valeur reçue.
  const log = (req: FastifyRequest, action: string, target: string | null, meta: Record<string, unknown> = {}) =>
    audit(db, req, action, target, { via: 'scim', client: clients.get(req) ?? null, ...meta });

  // Un changement de compte ou d'adhésion modifie des droits : flux temps réel et co-édition revérifiés.
  const accessChanged = () => { app.bus.publish({ type: 'space.changed' }); app.collab?.evictAll(); };
  // Désactivation : sessions fermées, jetons d'API révoqués (ils ne doivent pas revivre à une réactivation).
  const cutAccess = (userId: string) => {
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
    db.prepare('UPDATE api_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(Date.now(), userId);
  };

  const notFound = () => new ScimError(404, null, 'Ressource introuvable');
  // Message unique : ne dit jamais si le conflit vient d'un administrateur, d'un compte ou d'un groupe invisible par SCIM.
  const conflict = () => new ScimError(409, 'uniqueness', 'Conflit d’unicité : une ressource porte déjà ces attributs');
  const validId = (raw: string) => (idSchema.safeParse(raw).success ? raw : null);

  const paginate = <R>(q: z.output<typeof listQuery>, total: number, rows: R[]) => ({
    schemas: [SCHEMA.list], totalResults: total, startIndex: q.startIndex, itemsPerPage: rows.length, Resources: rows,
  });

  // ---- Users -----------------------------------------------------------------------------------------
  // Ressources visibles : comptes rattachés à SCIM (`scim_users`) qui ne sont pas administrateurs. Un administrateur est
  // invisible (404), même s'il a été créé par SCIM puis promu à la connexion.
  interface UserRow { id: string; email: string | null; name: string; disabled: number; created_at: number; user_name: string; external_id: string | null; disabled_by_scim: number; updated_at: number }
  const USER_FROM = `FROM scim_users s JOIN users u ON u.id = s.user_id WHERE u.role != 'admin' AND s.deleted_at IS NULL`;
  const USER_SELECT = `SELECT u.id, u.email, u.name, u.disabled, u.created_at, s.user_name, s.external_id, s.disabled_by_scim, s.updated_at ${USER_FROM}`;
  const findUser = (id: string) => db.prepare(`${USER_SELECT} AND u.id = ?`).get(id) as UserRow | undefined;

  const groupsOf = (userId: string) => db.prepare(
    'SELECT g.id, g.name FROM group_members m JOIN scim_groups sg ON sg.group_id = m.group_id JOIN groups g ON g.id = m.group_id WHERE m.user_id = ? ORDER BY g.name COLLATE NOCASE',
  ).all(userId) as { id: string; name: string }[];

  const toUser = (r: UserRow) => ({
    schemas: [SCHEMA.user],
    id: r.id,
    ...(r.external_id ? { externalId: r.external_id } : {}),
    userName: r.user_name,
    name: { formatted: r.name },
    displayName: r.name,
    emails: r.email ? [{ value: r.email, type: 'work', primary: true }] : [],
    active: !r.disabled,
    groups: groupsOf(r.id).map((g) => ({ value: g.id, display: g.name, $ref: `${base}/Groups/${g.id}` })),
    meta: { resourceType: 'User', created: iso(r.created_at), lastModified: iso(r.updated_at), location: `${base}/Users/${r.id}` },
  });

  const USER_FILTERS: Record<string, { sql: string; type: 'string' | 'boolean' }> = {
    username: { sql: 's.user_name = ?', type: 'string' },
    externalid: { sql: 's.external_id = ?', type: 'string' },
    id: { sql: 'u.id = ?', type: 'string' },
    emails: { sql: 'u.email = ? COLLATE NOCASE', type: 'string' },
    'emails.value': { sql: 'u.email = ? COLLATE NOCASE', type: 'string' },
    displayname: { sql: 'u.name = ?', type: 'string' },
    active: { sql: 'u.disabled = ?', type: 'boolean' },
  };
  const filterSql = (f: Filter | null, specs: Record<string, { sql: string; type: 'string' | 'boolean' }>) => {
    if (!f) return { sql: '', args: [] as unknown[] };
    const spec = specs[f.attr];
    if (!spec) throw new ScimError(400, 'invalidFilter', 'Attribut de filtre non pris en charge');
    if (typeof f.value !== spec.type) throw new ScimError(400, 'invalidFilter', 'Type de valeur de filtre invalide');
    // active eq true : compte non désactivé.
    return { sql: ` AND ${spec.sql}`, args: [spec.type === 'boolean' ? (f.value ? 0 : 1) : f.value] };
  };

  // État de désactivation après une demande SCIM. SCIM ne réactive que les comptes qu'il a lui-même désactivés : un compte
  // désactivé par ailleurs (avant le rattachement, par exemple) le reste, quel que soit `active`.
  const nextState = (disabled: boolean, byScim: boolean, active: boolean) =>
    (disabled && !byScim ? { disabled: 1, byScim: 0 } : active ? { disabled: 0, byScim: 0 } : { disabled: 1, byScim: 1 });

  // Enregistre un compte (création, rattachement ou mise à jour), dans une transaction. Renvoie l'identifiant et ce qui a changé.
  const saveUser = (existing: UserRow | null, m: UserInput) => {
    const email = primaryEmail(m.emails);
    const name = displayNameOf(m);
    const now = Date.now();
    const role = scimSettings(db, config).defaultRole; // reader ou editor, jamais admin (schéma du réglage)
    return db.transaction(() => {
      const selfId = existing?.id ?? '';
      // Identifiant externe immuable une fois posé : absent d'un PUT, il est conservé ; changé ou retiré, refusé.
      const externalId = m.externalId === undefined ? (existing?.external_id ?? null) : m.externalId;
      if (existing?.external_id && externalId !== existing.external_id) throw new ScimError(400, 'mutability', 'externalId ne se modifie plus une fois défini');
      if (db.prepare('SELECT 1 FROM scim_users WHERE user_name = ? AND user_id != ? AND deleted_at IS NULL').get(m.userName, selfId)) throw conflict();
      if (externalId && db.prepare('SELECT 1 FROM scim_users WHERE external_id = ? AND user_id != ? AND deleted_at IS NULL').get(externalId, selfId)) throw conflict();
      if (existing) {
        // Relu dans la transaction : un compte promu administrateur entre-temps n'est plus modifiable.
        const cur = db.prepare('SELECT u.role, u.disabled, s.disabled_by_scim FROM users u JOIN scim_users s ON s.user_id = u.id WHERE u.id = ? AND s.deleted_at IS NULL')
          .get(existing.id) as { role: string; disabled: number; disabled_by_scim: number } | undefined;
        if (!cur || cur.role === 'admin') throw notFound();
        const st = nextState(!!cur.disabled, !!cur.disabled_by_scim, m.active);
        db.prepare('UPDATE users SET email = ?, name = ?, disabled = ? WHERE id = ?').run(email, name, st.disabled, existing.id);
        db.prepare('UPDATE scim_users SET user_name = ?, external_id = ?, disabled_by_scim = ?, updated_at = ? WHERE user_id = ?').run(m.userName, externalId, st.byScim, now, existing.id);
        return { id: existing.id, adopted: false, deactivated: !cur.disabled && !!st.disabled, changed: cur.disabled !== st.disabled };
      }
      // Compte déjà connu (première connexion OIDC avant SCIM, ou supprimé par SCIM puis provisionné de nouveau) : rattaché
      // s'il porte cet identifiant OIDC, n'est pas administrateur et n'est pas déjà géré par SCIM. Les préfixes internes
      // (local:, ldap:, saml:) sont exclus par le schéma.
      const known = externalId ? db.prepare('SELECT id, role, disabled FROM users WHERE sub = ?').get(externalId) as { id: string; role: string; disabled: number } | undefined : undefined;
      let id: string;
      let st: { disabled: number; byScim: number };
      if (known) {
        const link = db.prepare('SELECT deleted_at, disabled_by_scim FROM scim_users WHERE user_id = ?').get(known.id) as { deleted_at: number | null; disabled_by_scim: number } | undefined;
        if (known.role === 'admin' || (link && link.deleted_at === null)) throw conflict();
        st = nextState(!!known.disabled, !!link?.disabled_by_scim, m.active);
        db.prepare('UPDATE users SET email = ?, name = ?, disabled = ? WHERE id = ?').run(email, name, st.disabled, known.id);
        db.prepare('DELETE FROM scim_users WHERE user_id = ?').run(known.id);
        id = known.id;
      } else {
        id = newId();
        st = nextState(false, false, m.active);
        // Sans identifiant externe, aucun identifiant OIDC ne correspondra : le compte reste inutilisable pour la connexion.
        db.prepare('INSERT INTO users (id, sub, email, name, role, created_at, disabled) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(id, externalId ?? `scim:${id}`, email, name, role, now, st.disabled);
      }
      db.prepare('INSERT INTO scim_users (user_id, user_name, external_id, disabled_by_scim, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, m.userName, externalId, st.byScim, now, now);
      return { id, adopted: !!known, deactivated: !!known && !known.disabled && !!st.disabled, changed: true };
    })();
  };

  const afterUserSave = (r: { id: string; deactivated: boolean; changed: boolean }) => {
    if (r.deactivated) { cutAccess(r.id); app.collab?.recheckAll(); }
    if (r.changed) app.bus.publish({ type: 'space.changed' });
  };

  // État modifiable d'un compte, point de départ d'un PATCH.
  const userDraft = (r: UserRow): Record<string, unknown> => ({
    userName: r.user_name, externalId: r.external_id, displayName: r.name, name: null,
    emails: r.email ? [{ value: r.email, type: 'work', primary: true }] : [], active: !r.disabled,
  });

  const str = (v: unknown, what: string) => {
    if (typeof v !== 'string') throw new ScimError(400, 'invalidValue', `Chaîne attendue : ${what}`);
    return v;
  };

  function patchUser(d: Record<string, unknown>, op: PatchOp['op'], rawPath: string, value: unknown) {
    const path = stripUrn(rawPath);
    const p = path.toLowerCase();
    const remove = op === 'remove';
    if (p === 'password') throw new ScimError(400, 'invalidValue', 'Les mots de passe ne se définissent pas par SCIM');
    if (p === 'groups' || p.startsWith('groups.') || p.startsWith('groups[')) throw new ScimError(400, 'mutability', 'Les groupes se modifient par la ressource Group');
    if (p === 'id' || p.startsWith('meta')) throw new ScimError(400, 'mutability', 'Attribut en lecture seule');
    if (ignoredUserAttr(path)) return;
    const name = { ...(isObject(d.name) ? d.name : {}) };
    const emailFilter = /^emails\[\s*(?:type\s+eq\s+"([^"\\]{1,50})"|primary\s+eq\s+true)\s*\]\.value$/i.exec(path);
    switch (true) {
      case p === 'active':
        if (remove) throw new ScimError(400, 'mutability', 'active ne peut pas être retiré');
        d.active = toBool(value); return;
      case p === 'username':
        if (remove) throw new ScimError(400, 'mutability', 'userName est obligatoire');
        d.userName = str(value, 'userName'); return;
      case p === 'externalid': d.externalId = remove ? null : str(value, 'externalId'); return;
      case p === 'displayname': d.displayName = remove ? null : str(value, 'displayName'); return;
      case p === 'name':
        if (remove) { d.name = null; return; }
        if (!isObject(value)) throw new ScimError(400, 'invalidValue', 'Objet attendu : name');
        d.name = op === 'add' ? { ...name, ...value } : value; return;
      case ['name.formatted', 'name.givenname', 'name.familyname', 'name.middlename'].includes(p): {
        const key = { 'name.formatted': 'formatted', 'name.givenname': 'givenName', 'name.familyname': 'familyName', 'name.middlename': 'middleName' }[p]!;
        d.name = { ...name, [key]: remove ? null : str(value, path) };
        return;
      }
      case p === 'emails': {
        if (remove) { d.emails = []; return; }
        const list = Array.isArray(value) ? value : [value];
        d.emails = op === 'add' ? [...(Array.isArray(d.emails) ? d.emails : []), ...list] : list;
        return;
      }
      case !!emailFilter: {
        const emails = (Array.isArray(d.emails) ? d.emails : []) as Record<string, unknown>[];
        const type = emailFilter![1];
        const matches = (e: Record<string, unknown>) => (type ? String(e.type ?? '').toLowerCase() === type.toLowerCase() : e.primary === true);
        if (remove) { d.emails = emails.filter((e) => !matches(e)); return; }
        const v = str(value, 'emails.value');
        const hit = emails.find(matches);
        d.emails = hit ? emails.map((e) => (e === hit ? { ...e, value: v } : e)) : [...emails, { value: v, type: type ?? 'work', primary: !type || emails.length === 0 }];
        return;
      }
      default:
        throw new ScimError(400, 'invalidPath', 'Attribut non pris en charge');
    }
  }

  function applyPatch(d: Record<string, unknown>, ops: PatchOp[], apply: (d: Record<string, unknown>, op: PatchOp['op'], path: string, value: unknown) => void) {
    for (const o of ops) {
      if (o.path) { apply(d, o.op, o.path, o.value); continue; }
      if (o.op === 'remove') throw new ScimError(400, 'noTarget', 'Chemin requis pour remove');
      if (!isObject(o.value)) throw new ScimError(400, 'invalidValue', 'Objet attendu sans chemin');
      for (const [k, v] of Object.entries(o.value)) {
        if (k === 'schemas') continue;
        apply(d, o.op, k, v);
      }
    }
  }

  const patchOps = (body: unknown) => {
    const b = bodyObject(body);
    // Certains fournisseurs écrivent « operations » en minuscules.
    return parse(patchInput, { Operations: b.Operations ?? b.operations }).Operations;
  };

  app.get('/Users', opts, async (req, reply) => {
    const q = parse(listQuery, req.query);
    const w = filterSql(parseFilter(q.filter), USER_FILTERS);
    const total = (db.prepare(`SELECT COUNT(*) AS n ${USER_FROM}${w.sql}`).get(...w.args) as { n: number }).n;
    const rows = q.count === 0 ? [] : db.prepare(`${USER_SELECT}${w.sql} ORDER BY s.created_at, s.rowid LIMIT ? OFFSET ?`).all(...w.args, q.count, q.startIndex - 1) as UserRow[];
    return send(reply, 200, paginate(q, total, rows.map(toUser)));
  });

  app.get('/Users/:id', opts, async (req, reply) => {
    const id = validId(parse(idParam, req.params).id);
    const row = id ? findUser(id) : undefined;
    if (!row) throw notFound();
    return send(reply, 200, toUser(row));
  });

  app.post('/Users', opts, async (req, reply) => {
    const body = bodyObject(req.body);
    rejectPassword(body);
    const r = saveUser(null, parse(userInput, body));
    afterUserSave(r);
    log(req, 'scim.user.create', r.id, { adopted: r.adopted });
    const row = findUser(r.id)!;
    return send(reply.header('location', `${base}/Users/${r.id}`), 201, toUser(row));
  });

  app.put('/Users/:id', opts, async (req, reply) => {
    const id = validId(parse(idParam, req.params).id);
    const cur = id ? findUser(id) : undefined;
    if (!cur) throw notFound();
    const body = bodyObject(req.body);
    rejectPassword(body);
    const r = saveUser(cur, parse(userInput, body));
    afterUserSave(r);
    log(req, r.deactivated ? 'scim.user.deactivate' : 'scim.user.update', r.id, { active: !findUser(r.id)!.disabled });
    return send(reply, 200, toUser(findUser(r.id)!));
  });

  app.patch('/Users/:id', opts, async (req, reply) => {
    const id = validId(parse(idParam, req.params).id);
    const cur = id ? findUser(id) : undefined;
    if (!cur) throw notFound();
    const d = userDraft(cur);
    applyPatch(d, patchOps(req.body), patchUser);
    const r = saveUser(cur, parse(userInput, d));
    afterUserSave(r);
    log(req, r.deactivated ? 'scim.user.deactivate' : 'scim.user.update', r.id, { active: !findUser(r.id)!.disabled });
    return send(reply, 200, toUser(findUser(r.id)!));
  });

  // Suppression = désactivation (aucun contenu supprimé) : sessions fermées, jetons révoqués, retrait des groupes SCIM, fin du
  // rattachement à SCIM. Le compte et ses contributions restent ; un administrateur peut l'effacer (RGPD) depuis Notabene.
  app.delete('/Users/:id', opts, async (req, reply) => {
    const id = validId(parse(idParam, req.params).id);
    const cur = id ? findUser(id) : undefined;
    if (!cur) throw notFound();
    db.transaction(() => {
      const role = (db.prepare('SELECT role FROM users WHERE id = ?').get(cur.id) as { role: string } | undefined)?.role;
      if (role !== 'reader' && role !== 'editor') throw notFound();
      const st = nextState(!!cur.disabled, !!cur.disabled_by_scim, false);
      db.prepare('UPDATE users SET disabled = 1 WHERE id = ?').run(cur.id);
      db.prepare('DELETE FROM group_members WHERE user_id = ? AND group_id IN (SELECT group_id FROM scim_groups)').run(cur.id);
      db.prepare('UPDATE scim_users SET deleted_at = ?, disabled_by_scim = ?, updated_at = ? WHERE user_id = ?').run(Date.now(), st.byScim, Date.now(), cur.id);
      cutAccess(cur.id);
    })();
    app.collab?.recheckAll();
    accessChanged();
    log(req, 'scim.user.delete', cur.id);
    return reply.code(204).send();
  });

  // ---- Groups ----------------------------------------------------------------------------------------
  // Ressources visibles : groupes créés par SCIM (`scim_groups`). Les groupes locaux, système et liés à un fournisseur ne sont
  // ni visibles ni modifiables ici ; à l'inverse, routes/groups.ts refuse de modifier un groupe géré par SCIM.
  interface GroupRow { id: string; name: string; external_id: string | null; created_at: number; updated_at: number }
  const GROUP_FROM = 'FROM scim_groups sg JOIN groups g ON g.id = sg.group_id WHERE 1';
  const GROUP_SELECT = `SELECT g.id, g.name, sg.external_id, sg.created_at, sg.updated_at ${GROUP_FROM}`;
  const findGroup = (id: string) => db.prepare(`${GROUP_SELECT} AND g.id = ?`).get(id) as GroupRow | undefined;
  // Membres visibles par SCIM seulement (comptes rattachés, non administrateurs).
  const membersOf = (groupId: string) => db.prepare(
    `SELECT u.id, u.name FROM group_members m JOIN scim_users s ON s.user_id = m.user_id JOIN users u ON u.id = m.user_id
     WHERE m.group_id = ? AND u.role != 'admin' AND s.deleted_at IS NULL ORDER BY u.name COLLATE NOCASE, u.id LIMIT ?`,
  ).all(groupId, MAX_GROUP_MEMBERS) as { id: string; name: string }[];

  const toGroup = (g: GroupRow, withMembers = true) => ({
    schemas: [SCHEMA.group],
    id: g.id,
    ...(g.external_id ? { externalId: g.external_id } : {}),
    displayName: g.name,
    ...(withMembers ? { members: membersOf(g.id).map((u) => ({ value: u.id, display: u.name, type: 'User', $ref: `${base}/Users/${u.id}` })) } : {}),
    meta: { resourceType: 'Group', created: iso(g.created_at), lastModified: iso(g.updated_at), location: `${base}/Groups/${g.id}` },
  });

  const GROUP_FILTERS: Record<string, { sql: string; type: 'string' | 'boolean' }> = {
    displayname: { sql: 'g.name = ? COLLATE NOCASE', type: 'string' },
    externalid: { sql: 'sg.external_id = ?', type: 'string' },
    id: { sql: 'g.id = ?', type: 'string' },
    'members.value': { sql: "EXISTS (SELECT 1 FROM group_members m JOIN scim_users s ON s.user_id = m.user_id AND s.deleted_at IS NULL JOIN users u ON u.id = m.user_id AND u.role != 'admin' WHERE m.group_id = g.id AND m.user_id = ?)", type: 'string' },
  };

  const memberIds = (value: unknown): string[] => {
    const list = value === undefined || value === null ? [] : Array.isArray(value) ? value : [value];
    return parse(z.array(memberRef).max(MAX_GROUP_MEMBERS), list).map((m) => m.value);
  };

  interface GroupDraft { displayName: unknown; externalId: unknown; members: Set<string> }

  function patchGroup(dd: Record<string, unknown>, op: PatchOp['op'], rawPath: string, value: unknown) {
    const d = dd as unknown as GroupDraft;
    const path = stripUrn(rawPath);
    const p = path.toLowerCase();
    const remove = op === 'remove';
    const one = /^members\[\s*value\s+eq\s+"([^"\\]{1,64})"\s*\]$/i.exec(path);
    if (p === 'displayname') {
      if (remove) throw new ScimError(400, 'mutability', 'displayName est obligatoire');
      d.displayName = str(value, 'displayName'); return;
    }
    if (p === 'externalid') { d.externalId = remove ? null : str(value, 'externalId'); return; }
    if (p === 'members') {
      if (remove) {
        if (value === undefined) d.members.clear();
        else for (const id of memberIds(value)) d.members.delete(id);
        return;
      }
      const ids = memberIds(value);
      if (op === 'replace') d.members.clear();
      for (const id of ids) d.members.add(id);
      return;
    }
    if (one) {
      if (!remove) throw new ScimError(400, 'invalidPath', 'Chemin filtré accepté seulement pour remove');
      d.members.delete(one[1]!); return;
    }
    if (p === 'id' || p.startsWith('meta')) throw new ScimError(400, 'mutability', 'Attribut en lecture seule');
    throw new ScimError(400, 'invalidPath', 'Attribut non pris en charge');
  }

  // Unicité des noms sur TOUS les groupes (locaux compris), avec repli de casse en français comme routes/groups.ts.
  const nameTaken = (name: string, exceptId: string) => {
    const wanted = name.toLocaleLowerCase('fr');
    return (db.prepare('SELECT id, name FROM groups').all() as { id: string; name: string }[]).some((r) => r.id !== exceptId && r.name.toLocaleLowerCase('fr') === wanted);
  };

  // Enregistre un groupe et son adhésion (seuls les membres visibles par SCIM sont ajoutés ou retirés). Renvoie l'identifiant.
  const saveGroup = (existing: GroupRow | null, input: { displayName: string; externalId?: string | null; members: string[] | null }) => {
    const now = Date.now();
    return db.transaction(() => {
      const id = existing?.id ?? newId();
      if (nameTaken(input.displayName, id)) throw conflict();
      if (input.externalId && db.prepare('SELECT 1 FROM scim_groups WHERE external_id = ? AND group_id != ?').get(input.externalId, id)) throw conflict();
      if (existing) {
        db.prepare('UPDATE groups SET name = ? WHERE id = ?').run(input.displayName, id);
        db.prepare('UPDATE scim_groups SET external_id = ?, updated_at = ? WHERE group_id = ?').run(input.externalId ?? null, now, id);
      } else {
        if ((db.prepare('SELECT COUNT(*) AS n FROM groups').get() as { n: number }).n >= MAX_GROUPS) throw new ScimError(400, 'invalidValue', `Au plus ${MAX_GROUPS} groupes`);
        db.prepare("INSERT INTO groups (id, name, description, source, external_id, created_at) VALUES (?, ?, '', 'local', NULL, ?)").run(id, input.displayName, now);
        db.prepare('INSERT INTO scim_groups (group_id, external_id, created_at, updated_at) VALUES (?, ?, ?, ?)').run(id, input.externalId ?? null, now, now);
      }
      let changed = !existing;
      if (input.members) {
        const wanted = new Set(input.members);
        if (wanted.size > MAX_GROUP_MEMBERS) throw new ScimError(400, 'invalidValue', `Au plus ${MAX_GROUP_MEMBERS} membres par groupe`);
        // Un membre doit être un compte visible par SCIM : ni un administrateur, ni un compte non provisionné.
        const visible = new Set((db.prepare(
          `SELECT s.user_id AS id FROM json_each(?) j JOIN scim_users s ON s.user_id = j.value JOIN users u ON u.id = s.user_id WHERE u.role != 'admin' AND s.deleted_at IS NULL`,
        ).all(JSON.stringify([...wanted])) as { id: string }[]).map((r) => r.id));
        if (visible.size !== wanted.size) throw new ScimError(400, 'invalidValue', 'Membre inconnu');
        // Adhésion actuelle complète, membres invisibles compris : un compte promu administrateur, que le fournisseur ne voit
        // plus, est retiré du groupe à la prochaine écriture au lieu d'y rester sans que personne puisse l'en sortir.
        const current = new Set((db.prepare('SELECT user_id FROM group_members WHERE group_id = ?').all(id) as { user_id: string }[]).map((r) => r.user_id));
        const add = db.prepare('INSERT OR IGNORE INTO group_members (group_id, user_id) VALUES (?, ?)');
        const del = db.prepare('DELETE FROM group_members WHERE group_id = ? AND user_id = ?');
        for (const u of wanted) if (!current.has(u)) { add.run(id, u); changed = true; }
        for (const u of current) if (!wanted.has(u)) { del.run(id, u); changed = true; }
      }
      return { id, changed };
    })();
  };

  app.get('/Groups', opts, async (req, reply) => {
    const q = parse(listQuery, req.query);
    const w = filterSql(parseFilter(q.filter), GROUP_FILTERS);
    const total = (db.prepare(`SELECT COUNT(*) AS n ${GROUP_FROM}${w.sql}`).get(...w.args) as { n: number }).n;
    const rows = q.count === 0 ? [] : db.prepare(`${GROUP_SELECT}${w.sql} ORDER BY sg.created_at, sg.rowid LIMIT ? OFFSET ?`).all(...w.args, q.count, q.startIndex - 1) as GroupRow[];
    return send(reply, 200, paginate(q, total, rows.map((g) => toGroup(g, !excludes(q, 'members')))));
  });

  app.get('/Groups/:id', opts, async (req, reply) => {
    const id = validId(parse(idParam, req.params).id);
    const g = id ? findGroup(id) : undefined;
    if (!g) throw notFound();
    const q = parse(listQuery, req.query);
    return send(reply, 200, toGroup(g, !excludes(q, 'members')));
  });

  app.post('/Groups', opts, async (req, reply) => {
    const b = parse(groupInput, bodyObject(req.body));
    const r = saveGroup(null, { displayName: b.displayName, externalId: b.externalId, members: (b.members ?? []).map((m) => m.value) });
    accessChanged();
    log(req, 'scim.group.create', r.id, { members: b.members?.length ?? 0 });
    return send(reply.header('location', `${base}/Groups/${r.id}`), 201, toGroup(findGroup(r.id)!));
  });

  app.put('/Groups/:id', opts, async (req, reply) => {
    const id = validId(parse(idParam, req.params).id);
    const cur = id ? findGroup(id) : undefined;
    if (!cur) throw notFound();
    const b = parse(groupInput, bodyObject(req.body));
    // PUT remplace la ressource : sans `members`, le groupe est vidé.
    const r = saveGroup(cur, { displayName: b.displayName, externalId: b.externalId, members: (b.members ?? []).map((m) => m.value) });
    if (r.changed || cur.name !== b.displayName) accessChanged();
    log(req, 'scim.group.update', r.id, { members: b.members?.length ?? 0 });
    return send(reply, 200, toGroup(findGroup(r.id)!));
  });

  app.patch('/Groups/:id', opts, async (req, reply) => {
    const id = validId(parse(idParam, req.params).id);
    const cur = id ? findGroup(id) : undefined;
    if (!cur) throw notFound();
    const d: GroupDraft = { displayName: cur.name, externalId: cur.external_id, members: new Set(membersOf(cur.id).map((u) => u.id)) };
    applyPatch(d as unknown as Record<string, unknown>, patchOps(req.body), patchGroup);
    const v = parse(groupInput.omit({ members: true }), { displayName: d.displayName, externalId: d.externalId });
    const r = saveGroup(cur, { displayName: v.displayName, externalId: v.externalId, members: [...d.members] });
    if (r.changed) accessChanged();
    log(req, 'scim.group.update', r.id, { members: d.members.size });
    // RFC 7644 : 204 sans corps ou 200 avec la ressource. La ressource, sauf si le client exclut les membres.
    return send(reply, 200, toGroup(findGroup(r.id)!, !excludes(parse(listQuery, req.query), 'members')));
  });

  // Suppression : le groupe disparaît avec ses droits sur les espaces et les pages. Si des pages ne sont ouvertes qu'à lui, il
  // n'est pas supprimé mais détaché de SCIM et vidé : ces pages restent fermées (administrateurs seulement) au lieu de s'ouvrir.
  app.delete('/Groups/:id', opts, async (req, reply) => {
    const id = validId(parse(idParam, req.params).id);
    const cur = id ? findGroup(id) : undefined;
    if (!cur) throw notFound();
    // Calcul et suppression dans la même transaction : une restriction de page ajoutée entre-temps est prise en compte.
    const closed = db.transaction(() => {
      const pages = pagesOnlyOpenTo(db, { groupId: cur.id });
      if (pages.length) {
        db.prepare('DELETE FROM scim_groups WHERE group_id = ?').run(cur.id);
        db.prepare('DELETE FROM group_members WHERE group_id = ?').run(cur.id);
      } else {
        db.prepare('DELETE FROM groups WHERE id = ?').run(cur.id);
      }
      return pages;
    })();
    accessChanged();
    log(req, 'scim.group.delete', cur.id, { detached: closed.length > 0, pagesKeptClosed: closed.length });
    return reply.code(204).send();
  });

  // ---- Découverte (RFC 7644, section 4) ---------------------------------------------------------------
  const attr = (name: string, extra: Record<string, unknown> = {}) => ({
    name, type: 'string', multiValued: false, required: false, caseExact: false, mutability: 'readWrite', returned: 'default', uniqueness: 'none', ...extra,
  });
  const SCHEMAS = [
    {
      schemas: [SCHEMA.schema], id: SCHEMA.user, name: 'User', description: 'Compte Notabene',
      attributes: [
        attr('userName', { required: true, uniqueness: 'server' }),
        attr('externalId', { caseExact: true, description: 'Identifiant chez le fournisseur ; à la création, sert d’identifiant OIDC (sub) du compte' }),
        attr('name', { type: 'complex', subAttributes: [attr('formatted'), attr('givenName'), attr('familyName')] }),
        attr('displayName'),
        attr('emails', { type: 'complex', multiValued: true, subAttributes: [attr('value'), attr('type'), attr('primary', { type: 'boolean' })] }),
        attr('active', { type: 'boolean' }),
        attr('groups', { type: 'complex', multiValued: true, mutability: 'readOnly', subAttributes: [attr('value', { mutability: 'readOnly' }), attr('display', { mutability: 'readOnly' })] }),
      ],
      meta: { resourceType: 'Schema', location: `${base}/Schemas/${SCHEMA.user}` },
    },
    {
      schemas: [SCHEMA.schema], id: SCHEMA.group, name: 'Group', description: 'Groupe Notabene géré par SCIM',
      attributes: [
        attr('displayName', { required: true, uniqueness: 'server' }),
        attr('externalId', { caseExact: true }),
        attr('members', { type: 'complex', multiValued: true, subAttributes: [attr('value', { mutability: 'immutable' }), attr('display', { mutability: 'readOnly' })] }),
      ],
      meta: { resourceType: 'Schema', location: `${base}/Schemas/${SCHEMA.group}` },
    },
  ];
  const RESOURCE_TYPES = [
    { schemas: [SCHEMA.resourceType], id: 'User', name: 'User', endpoint: '/Users', schema: SCHEMA.user, meta: { resourceType: 'ResourceType', location: `${base}/ResourceTypes/User` } },
    { schemas: [SCHEMA.resourceType], id: 'Group', name: 'Group', endpoint: '/Groups', schema: SCHEMA.group, meta: { resourceType: 'ResourceType', location: `${base}/ResourceTypes/Group` } },
  ];
  const listOf = <T>(items: T[]) => ({ schemas: [SCHEMA.list], totalResults: items.length, startIndex: 1, itemsPerPage: items.length, Resources: items });

  app.get('/ServiceProviderConfig', opts, async (_req, reply) => send(reply, 200, {
    schemas: [SCHEMA.spc],
    documentationUri: 'https://github.com/LucasMolyn1/notabene/blob/main/docs/SCIM.md',
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: SCIM_MAX_RESULTS },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [{ type: 'oauthbearertoken', name: 'Jeton Bearer', description: 'Jeton SCIM créé par un administrateur dans Notabene (Paramètres, SCIM)', primary: true }],
    meta: { resourceType: 'ServiceProviderConfig', location: `${base}/ServiceProviderConfig` },
  }));
  app.get('/ResourceTypes', opts, async (_req, reply) => send(reply, 200, listOf(RESOURCE_TYPES)));
  app.get('/ResourceTypes/:id', opts, async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const t = RESOURCE_TYPES.find((r) => r.id === id);
    if (!t) throw notFound();
    return send(reply, 200, t);
  });
  app.get('/Schemas', opts, async (_req, reply) => send(reply, 200, listOf(SCHEMAS)));
  app.get('/Schemas/:id', opts, async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const s = SCHEMAS.find((r) => r.id === id);
    if (!s) throw notFound();
    return send(reply, 200, s);
  });

  // Adresse inconnue sous /scim/v2 (fonction active, jeton valide) : erreur SCIM.
  app.setNotFoundHandler(async (_req, reply) => send(reply, 404, scimError(404, 'Ressource introuvable')));
}
