// Groupes et droits par espace (lot 6) : matrice rôle × espace × groupe × restriction de page, API, synchronisation et migration.
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Auth } from '../src/auth/context.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { type DB, openDb } from '../src/db.js';
import { syncGroups } from '../src/lib/groups.js';
import { hashPassword } from '../src/lib/password.js';
import { filterReadable, pageLevel } from '../src/lib/page-acl.js';
import { spaceRole, spaceRoles } from '../src/lib/space-access.js';
import { oldDb } from './migrations.js';

const env = { NODE_ENV: 'test', PUBLIC_URL: 'http://localhost:3000', ENCRYPTION_KEY: randomBytes(32).toString('base64'), AUTH_LOCAL: 'true', SEED_DEMO: 'false' };
const PASS = 'Sup3r-secret-pass';
let app: FastifyInstance;
let db: DB;

const as = (id: string, role: 'admin' | 'editor' | 'reader' = 'editor'): Auth => ({ user: { id, name: id, email: null, role }, via: 'session', scopes: new Set(['read', 'write']) });
const member = (space: string, who: { user?: string; group?: string }, role: 'view' | 'edit' | 'full') =>
  db.prepare('INSERT INTO space_members (space_id, user_id, group_id, role) VALUES (?, ?, ?, ?)').run(space, who.user ?? null, who.group ?? null, role);
const group = (id: string, ...users: string[]) => {
  db.prepare("INSERT INTO groups (id, name, created_at) VALUES (?, ?, 0)").run(id, id);
  for (const u of users) db.prepare('INSERT INTO group_members (group_id, user_id) VALUES (?, ?)').run(id, u);
};

beforeEach(async () => {
  db = openDb(':memory:');
  app = await buildApp({ config: loadConfig(env), db, clientDir: '/nonexistent' });
  for (const [id, role] of [['admin', 'admin'], ['ed1', 'editor'], ['ed2', 'editor'], ['ed3', 'editor'], ['rd', 'reader']] as const) {
    db.prepare('INSERT INTO users (id, sub, email, name, role, created_at, password_hash) VALUES (?,?,?,?,?,?,?)').run(id, `local:${id}@example.com`, `${id}@example.com`, `Nom ${id}`, role, Date.now(), await hashPassword(PASS));
  }
  const space = (id: string, visibility: 'private' | 'public') => db.prepare('INSERT INTO spaces (id, name, visibility, created_at, updated_at) VALUES (?, ?, ?, 0, 0)').run(id, id, visibility);
  space('sA', 'private'); space('sB', 'private'); space('sP', 'public');
  for (const [id, sp] of [['pA', 'sA'], ['pB', 'sB'], ['pP', 'sP']]) {
    db.prepare("INSERT INTO pages (id, space_id, title, content, text, created_at, updated_at) VALUES (?, ?, ?, '{\"type\":\"doc\",\"content\":[{\"type\":\"paragraph\"}]}', 'texte', 1, 1)").run(id, sp, `Page ${id}`);
  }
});
afterEach(async () => { await app.close(); db.close(); });

async function login(id: string) {
  const res = await app.inject({ method: 'POST', url: '/auth/local/login', payload: { email: `${id}@example.com`, password: PASS } });
  const cookie = res.cookies.find((c) => c.name === 'nb_session')!.value;
  const me = (await app.inject({ method: 'GET', url: '/api/v3/me', cookies: { nb_session: cookie } })).json();
  return { cookies: { nb_session: cookie }, headers: { 'x-csrf-token': me.csrf as string } };
}
type S = Awaited<ReturnType<typeof login>>;
const call = (s: S | null, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: object) =>
  app.inject({ method, url, payload, cookies: s?.cookies, headers: s?.headers });
const spacesOf = async (s: S | null) => ((await call(s, 'GET', '/api/v3/spaces')).json() as { id: string; role: string }[]).map((x) => `${x.id}:${x.role}`).sort();

describe('droit sur un espace : matrice', () => {
  it('refuse par défaut : sans adhésion, un espace privé est invisible, un espace public se lit', () => {
    expect([...spaceRoles(db, as('ed1')).entries()]).toEqual([['sP', 'view']]);
    expect([...spaceRoles(db, as('rd', 'reader')).entries()]).toEqual([['sP', 'view']]);
    expect([...spaceRoles(db, null).entries()]).toEqual([['sP', 'view']]);
  });

  it('administrateur : full partout, sans adhésion', () => {
    expect([...spaceRoles(db, as('admin', 'admin')).entries()].sort()).toEqual([['sA', 'full'], ['sB', 'full'], ['sP', 'full']]);
  });

  it('adhésion directe, par groupe, par « tout le monde » : le plus haut des chemins l’emporte', () => {
    group('g1', 'ed1'); group('g2', 'ed1');
    member('sA', { user: 'ed1' }, 'view');
    member('sA', { group: 'g1' }, 'edit');
    member('sA', { group: 'g2' }, 'view');
    expect(spaceRole(db, as('ed1'), 'sA')).toBe('edit');
    member('sB', { group: 'everyone' }, 'edit');
    expect(spaceRole(db, as('ed2'), 'sB')).toBe('edit');
    expect(spaceRole(db, as('ed2'), 'sA')).toBe('none'); // ni adhésion directe ni groupe
  });

  it('le rôle global est un plafond : un lecteur ne dépasse jamais view', () => {
    member('sA', { user: 'rd' }, 'full');
    member('sB', { group: 'everyone' }, 'edit');
    expect(spaceRole(db, as('rd', 'reader'), 'sA')).toBe('view');
    expect(spaceRole(db, as('rd', 'reader'), 'sB')).toBe('view');
  });

  it('un espace public ne retire rien : un membre en édition garde l’édition, un visiteur lit', () => {
    member('sP', { user: 'ed1' }, 'edit');
    expect(spaceRole(db, as('ed1'), 'sP')).toBe('edit');
    expect(spaceRole(db, as('ed2'), 'sP')).toBe('view');
    expect(spaceRole(db, null, 'sP')).toBe('view');
  });

  it('supprimer un groupe ou une adhésion retire le droit', () => {
    group('g1', 'ed1');
    member('sA', { group: 'g1' }, 'edit');
    expect(spaceRole(db, as('ed1'), 'sA')).toBe('edit');
    db.prepare('DELETE FROM group_members WHERE group_id = ?').run('g1');
    expect(spaceRole(db, as('ed1'), 'sA')).toBe('none');
    db.prepare("INSERT INTO group_members VALUES ('g1', 'ed1')").run();
    db.prepare('DELETE FROM groups WHERE id = ?').run('g1');
    expect(spaceRole(db, as('ed1'), 'sA')).toBe('none');
    expect(db.prepare('SELECT COUNT(*) AS n FROM space_members').get()).toEqual({ n: 0 });
  });
});

describe('niveau d’une page : espace croisé avec la restriction de page', () => {
  it('la restriction ne fait que restreindre : jamais plus que le droit sur l’espace', () => {
    member('sA', { user: 'ed1' }, 'view');
    member('sA', { user: 'ed2' }, 'edit');
    db.prepare("INSERT INTO page_acl (page_id, user_id, level) VALUES ('pA', 'ed1', 'write'), ('pA', 'ed2', 'read')").run();
    expect(pageLevel(db, as('ed1'), 'pA')).toBe('read'); // ACL écriture, espace lecture
    expect(pageLevel(db, as('ed2'), 'pA')).toBe('read'); // espace édition, ACL lecture
    expect(pageLevel(db, as('ed3'), 'pA')).toBe('none'); // hors ACL et hors espace
  });

  it('une restriction visant un groupe donne le plus haut niveau parmi les chemins de la personne', () => {
    group('g1', 'ed1'); group('g2', 'ed1');
    member('sA', { group: 'everyone' }, 'edit');
    db.prepare("INSERT INTO page_acl_groups (page_id, group_id, level) VALUES ('pA', 'g1', 'read'), ('pA', 'g2', 'write')").run();
    expect(pageLevel(db, as('ed1'), 'pA')).toBe('write');
    expect(pageLevel(db, as('ed2'), 'pA')).toBe('none');
    expect(pageLevel(db, as('admin', 'admin'), 'pA')).toBe('write');
    expect(pageLevel(db, null, 'pA')).toBe('none');
  });

  it('la restriction par groupe gouverne les sous-pages et filterReadable est cohérent avec pageLevel', () => {
    group('g1', 'ed1');
    member('sA', { group: 'everyone' }, 'edit');
    db.prepare("INSERT INTO pages (id, space_id, parent_id, title, content, text, created_at, updated_at) VALUES ('pA2', 'sA', 'pA', 'Enfant', '{}', '', 1, 1)").run();
    db.prepare("INSERT INTO page_acl_groups (page_id, group_id, level) VALUES ('pA', 'g1', 'write')").run();
    const ids = ['pA', 'pA2', 'pB', 'pP', 'inconnue'].map((id) => ({ id }));
    for (const who of [as('ed1'), as('ed2'), as('rd', 'reader'), as('admin', 'admin'), null]) {
      expect(filterReadable(db, who, ids).map((i) => i.id), who?.user.id ?? 'anonyme')
        .toEqual(ids.filter((i) => pageLevel(db, who, i.id) !== 'none').map((i) => i.id));
    }
    expect(filterReadable(db, as('ed2'), ids).map((i) => i.id)).toEqual(['pP']);
  });

  it('filterReadable écarte les pages des espaces non lisibles même sans aucune restriction de page', () => {
    member('sA', { user: 'ed1' }, 'view');
    expect(filterReadable(db, as('ed1'), [{ id: 'pA' }, { id: 'pB' }, { id: 'pP' }]).map((i) => i.id)).toEqual(['pA', 'pP']);
  });
});

describe('API : lecture et écriture selon le rôle sur l’espace', () => {
  it('la liste des espaces ne montre que ceux auxquels on a accès, avec son rôle', async () => {
    member('sA', { user: 'ed1' }, 'edit');
    member('sB', { user: 'ed1' }, 'view');
    expect(await spacesOf(await login('ed1'))).toEqual(['sA:edit', 'sB:view', 'sP:view']);
    expect(await spacesOf(await login('ed2'))).toEqual(['sP:view']);
    expect(await spacesOf(await login('admin'))).toEqual(['sA:full', 'sB:full', 'sP:full']);
    expect(await spacesOf(null)).toEqual(['sP:view']);
  });

  it('un espace sans adhésion est introuvable : lecture, liste, recherche, écriture', async () => {
    member('sA', { user: 'ed1' }, 'edit');
    const ed2 = await login('ed2');
    expect((await call(ed2, 'GET', '/api/v3/pages/pA')).statusCode).toBe(404);
    expect((await call(ed2, 'PATCH', '/api/v3/pages/pA', { title: 'X' })).statusCode).toBe(404);
    expect((await call(ed2, 'POST', '/api/v3/pages', { spaceId: 'sA', title: 'X' })).statusCode).toBe(404);
    const listed = (await call(ed2, 'GET', '/api/v3/pages?limit=100')).json() as { items: { id: string }[] };
    expect(listed.items.map((p) => p.id)).toEqual(['pP']);
    const found = (await call(ed2, 'GET', '/api/v3/search?q=texte')).json() as { items: { id: string }[] };
    expect(found.items.map((p) => p.id)).toEqual(['pP']);
    expect((await call(await login('ed1'), 'GET', '/api/v3/pages/pA')).statusCode).toBe(200);
  });

  it('un membre en lecture seule ne peut ni créer, ni modifier, ni déplacer vers, ni copier vers l’espace', async () => {
    member('sA', { user: 'ed1' }, 'view');
    member('sB', { user: 'ed1' }, 'edit');
    const ed1 = await login('ed1');
    expect((await call(ed1, 'GET', '/api/v3/pages/pA')).statusCode).toBe(200);
    expect((await call(ed1, 'POST', '/api/v3/pages', { spaceId: 'sA', title: 'X' })).statusCode).toBe(403);
    expect((await call(ed1, 'PATCH', '/api/v3/pages/pA', { title: 'X' })).statusCode).toBe(403);
    expect((await call(ed1, 'POST', '/api/v3/pages/pB/move', { parentId: null, spaceId: 'sA' })).statusCode).toBe(403);
    expect((await call(ed1, 'POST', '/api/v3/pages/pB/copy', { spaceId: 'sA' })).statusCode).toBe(403);
    expect((await call(ed1, 'POST', '/api/v3/pages/pA/comments', { body: 'Salut' })).statusCode).toBe(403);
    expect((await call(ed1, 'POST', '/api/v3/pages', { spaceId: 'sB', title: 'Ok' })).statusCode).toBe(201);
    expect((await call(ed1, 'POST', '/api/v3/pages/pA/copy', { spaceId: 'sB' })).statusCode).toBe(201);
  });

  it('retirer le groupe « tout le monde » ferme l’espace sans toucher aux autres', async () => {
    member('sA', { group: 'everyone' }, 'edit');
    const ed2 = await login('ed2');
    expect((await call(ed2, 'GET', '/api/v3/pages/pA')).statusCode).toBe(200);
    const admin = await login('admin');
    expect((await call(admin, 'DELETE', '/api/v3/spaces/sA/members/group/everyone')).statusCode).toBe(204);
    expect((await call(ed2, 'GET', '/api/v3/pages/pA')).statusCode).toBe(404);
  });

  it('les notifications et la boîte de réception ne révèlent plus une page dont on a perdu l’espace', async () => {
    member('sA', { user: 'ed1' }, 'edit');
    db.prepare("INSERT INTO notifications (id, user_id, type, page_id, created_at) VALUES ('n1', 'ed1', 'comment', 'pA', 5)").run();
    const ed1 = await login('ed1');
    expect(((await call(ed1, 'GET', '/api/v3/notifications')).json() as { items: unknown[] }).items).toHaveLength(1);
    db.prepare('DELETE FROM space_members').run();
    expect(((await call(ed1, 'GET', '/api/v3/notifications')).json() as { items: unknown[] }).items).toHaveLength(0);
  });

  it('les mentions ne proposent que des personnes qui peuvent lire la page', async () => {
    member('sA', { user: 'ed1' }, 'edit');
    group('g1', 'ed3'); member('sA', { group: 'g1' }, 'view');
    const found = async (q: string) => ((await call(await login('ed1'), 'GET', `/api/v3/pages/pA/mentionable?q=${q}`)).json() as { items: { id: string }[] }).items.map((u) => u.id).sort();
    expect(await found('Nom')).toEqual(['admin', 'ed1', 'ed3']); // ed2 n'a pas accès à l'espace
  });
});

describe('API : gestion des membres d’un espace', () => {
  it('un gestionnaire (full) gère les membres et renomme, mais ne change ni la visibilité ni la suppression', async () => {
    member('sA', { user: 'ed1' }, 'full');
    const ed1 = await login('ed1');
    expect((await call(ed1, 'PUT', '/api/v3/spaces/sA/members', { userId: 'ed2', role: 'edit' })).statusCode).toBe(204);
    expect(await spacesOf(await login('ed2'))).toEqual(['sA:edit', 'sP:view']);
    expect((await call(ed1, 'PATCH', '/api/v3/spaces/sA', { name: 'Renommé' })).statusCode).toBe(200);
    expect((await call(ed1, 'PATCH', '/api/v3/spaces/sA', { visibility: 'public' })).statusCode).toBe(403);
    expect((await call(ed1, 'DELETE', '/api/v3/spaces/sA')).statusCode).toBe(403);
    const list = (await call(ed1, 'GET', '/api/v3/spaces/sA/members')).json() as { items: { id: string; role: string; email?: string }[] };
    expect(list.items.map((m) => `${m.id}:${m.role}`).sort()).toEqual(['ed1:full', 'ed2:edit']);
    expect(list.items.every((m) => m.email === undefined)).toBe(true); // adresses réservées aux administrateurs
    expect((await call(ed1, 'DELETE', '/api/v3/spaces/sA/members/user/ed2')).statusCode).toBe(204);
    expect(await spacesOf(await login('ed2'))).toEqual(['sP:view']);
  });

  it('un membre en édition, un lecteur, ou le gestionnaire d’un autre espace ne gèrent rien', async () => {
    member('sA', { user: 'ed1' }, 'edit');
    member('sB', { user: 'ed2' }, 'full');
    member('sA', { user: 'rd' }, 'full'); // plafonné à view
    const body = { userId: 'ed3', role: 'view' };
    expect((await call(await login('ed1'), 'PUT', '/api/v3/spaces/sA/members', body)).statusCode).toBe(403);
    expect((await call(await login('rd'), 'PUT', '/api/v3/spaces/sA/members', body)).statusCode).toBe(403);
    expect((await call(await login('ed2'), 'PUT', '/api/v3/spaces/sA/members', body)).statusCode).toBe(404); // invisible pour lui
    expect((await call(await login('ed2'), 'GET', '/api/v3/spaces/sA/members')).statusCode).toBe(404);
    expect((await call(await login('ed2'), 'GET', '/api/v3/spaces/sA/member-candidates?q=Nom')).statusCode).toBe(404);
    expect((await call(null, 'PUT', '/api/v3/spaces/sA/members', body)).statusCode).toBe(401);
    expect(db.prepare("SELECT COUNT(*) AS n FROM space_members WHERE user_id = 'ed3'").get()).toEqual({ n: 0 });
  });

  it('valide les cibles : utilisateur inconnu ou désactivé, groupe inconnu, deux cibles à la fois', async () => {
    const admin = await login('admin');
    db.prepare("UPDATE users SET disabled = 1 WHERE id = 'ed3'").run();
    expect((await call(admin, 'PUT', '/api/v3/spaces/sA/members', { userId: 'ed3', role: 'view' })).statusCode).toBe(404);
    expect((await call(admin, 'PUT', '/api/v3/spaces/sA/members', { userId: 'fantome', role: 'view' })).statusCode).toBe(404);
    expect((await call(admin, 'PUT', '/api/v3/spaces/sA/members', { groupId: 'fantome', role: 'view' })).statusCode).toBe(404);
    expect((await call(admin, 'PUT', '/api/v3/spaces/sA/members', { userId: 'ed1', groupId: 'everyone', role: 'view' })).statusCode).toBe(400);
    expect((await call(admin, 'PUT', '/api/v3/spaces/sA/members', { role: 'view' })).statusCode).toBe(400);
    expect((await call(admin, 'PUT', '/api/v3/spaces/sA/members', { userId: 'ed1', role: 'root' })).statusCode).toBe(400);
  });

  it('la recherche de candidats est réservée aux gestionnaires et ne donne pas les adresses', async () => {
    member('sA', { user: 'ed1' }, 'full');
    group('equipe');
    const r = (await call(await login('ed1'), 'GET', '/api/v3/spaces/sA/member-candidates?q=nom')).json() as { users: { id: string; email?: string }[]; groups: unknown[] };
    expect(r.users.map((u) => u.id)).not.toContain('ed1'); // déjà membre
    expect(r.users.length).toBeGreaterThan(0);
    expect(r.users.every((u) => u.email === undefined)).toBe(true);
    const g = (await call(await login('ed1'), 'GET', '/api/v3/spaces/sA/member-candidates?q=equ')).json() as { groups: { id: string }[] };
    expect(g.groups.map((x) => x.id)).toEqual(['equipe']);
    expect((await call(await login('ed1'), 'GET', '/api/v3/spaces/sA/member-candidates?q=a')).statusCode).toBe(400); // deux caractères au moins
    const admin = (await call(await login('admin'), 'GET', '/api/v3/spaces/sA/member-candidates?q=nom ed2')).json() as { users: { email?: string }[] };
    expect(admin.users[0]?.email).toBe('ed2@example.com');
  });

  it('renommer un espace ne touche ni sa visibilité, ni son icône, ni sa description', async () => {
    db.prepare("UPDATE spaces SET icon = 'star', description = 'Notes' WHERE id = 'sP'").run();
    const res = await call(await login('admin'), 'PATCH', '/api/v3/spaces/sP', { name: 'Renommé' });
    expect(res.statusCode).toBe(200);
    expect(db.prepare("SELECT name, visibility, icon, description FROM spaces WHERE id = 'sP'").get()).toEqual({ name: 'Renommé', visibility: 'public', icon: 'star', description: 'Notes' });
  });

  it('la recherche trouve les noms accentués, majuscule comprise (« équipe » trouve « Équipe »)', async () => {
    member('sA', { user: 'ed1' }, 'full');
    group('eq', 'ed1'); db.prepare("UPDATE groups SET name = 'Équipe réseau' WHERE id = 'eq'").run();
    db.prepare("UPDATE users SET name = 'Élodie Martin' WHERE id = 'ed2'").run();
    const ed1 = await login('ed1');
    const g = (await call(ed1, 'GET', '/api/v3/spaces/sA/member-candidates?q=%C3%A9q')).json() as { groups: { id: string }[] };
    expect(g.groups.map((x) => x.id)).toEqual(['eq']);
    const u = (await call(ed1, 'GET', '/api/v3/spaces/sA/member-candidates?q=%C3%A9lo')).json() as { users: { id: string }[] };
    expect(u.users.map((x) => x.id)).toEqual(['ed2']);
    const m = (await call(await login('ed1'), 'GET', '/api/v3/pages/pA/mentionable?q=%C3%A9lo')).json() as { items: { id: string }[] };
    expect(m.items.map((u) => u.id)).toEqual([]); // ed2 n'a pas accès à l'espace : jamais proposé
  });

  it('un espace créé reste fermé par défaut ; « tout le monde » ouvre l’édition', async () => {
    const admin = await login('admin');
    const closed = (await call(admin, 'POST', '/api/v3/spaces', { name: 'Fermé' })).json() as { id: string };
    const open = (await call(admin, 'POST', '/api/v3/spaces', { name: 'Ouvert', access: 'everyone' })).json() as { id: string };
    expect(await spacesOf(await login('ed1'))).toEqual([`${open.id}:edit`, 'sP:view'].sort());
    expect(await spacesOf(admin)).toContain(`${closed.id}:full`);
    expect((await call(await login('ed1'), 'POST', '/api/v3/spaces', { name: 'X' })).statusCode).toBe(403);
  });
});

describe('API : groupes', () => {
  it('réservés aux administrateurs ; la liste est lisible (noms seuls) par un gestionnaire d’espace', async () => {
    const admin = await login('admin');
    const created = await call(admin, 'POST', '/api/v3/groups', { name: 'Équipe infra' });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;
    expect((await call(await login('ed1'), 'POST', '/api/v3/groups', { name: 'Pirate' })).statusCode).toBe(403);
    expect((await call(await login('ed1'), 'GET', '/api/v3/groups')).statusCode).toBe(403);
    member('sA', { user: 'ed1' }, 'full');
    const seen = (await call(await login('ed1'), 'GET', '/api/v3/groups')).json() as { id: string; memberCount?: number }[];
    expect(seen.map((g) => g.id)).toEqual(['everyone', id]);
    expect(seen.every((g) => g.memberCount === undefined)).toBe(true);
    expect((await call(await login('ed1'), 'GET', `/api/v3/groups/${id}/members`)).statusCode).toBe(403);
    expect((await call(null, 'GET', '/api/v3/groups')).statusCode).toBe(401);
  });

  it('« Tout le monde » ne se modifie pas ; un nom est unique sans tenir compte de la casse', async () => {
    const admin = await login('admin');
    expect((await call(admin, 'PATCH', '/api/v3/groups/everyone', { name: 'Autre' })).statusCode).toBe(403);
    expect((await call(admin, 'DELETE', '/api/v3/groups/everyone')).statusCode).toBe(403);
    expect((await call(admin, 'PUT', '/api/v3/groups/everyone/members/ed1')).statusCode).toBe(403);
    await call(admin, 'POST', '/api/v3/groups', { name: 'Équipe' });
    expect((await call(admin, 'POST', '/api/v3/groups', { name: 'équipe' })).statusCode).toBe(409);
    expect((await call(admin, 'POST', '/api/v3/groups', { name: 'Tout le monde' })).statusCode).toBe(409);
    expect((await call(admin, 'POST', '/api/v3/groups', { name: 'a<b>' })).statusCode).toBe(400);
  });

  it('ajouter ou retirer un membre change son accès tout de suite ; supprimer le groupe retire ses droits', async () => {
    const admin = await login('admin');
    const id = (await call(admin, 'POST', '/api/v3/groups', { name: 'Équipe' })).json().id as string;
    expect((await call(admin, 'PUT', '/api/v3/spaces/sA/members', { groupId: id, role: 'edit' })).statusCode).toBe(204);
    const ed2 = await login('ed2');
    expect(await spacesOf(ed2)).toEqual(['sP:view']);
    expect((await call(admin, 'PUT', `/api/v3/groups/${id}/members/ed2`)).statusCode).toBe(204);
    expect(await spacesOf(ed2)).toEqual(['sA:edit', 'sP:view']);
    expect((await call(admin, 'DELETE', `/api/v3/groups/${id}/members/ed2`)).statusCode).toBe(204);
    expect(await spacesOf(ed2)).toEqual(['sP:view']);
    await call(admin, 'PUT', `/api/v3/groups/${id}/members/ed2`);
    expect((await call(admin, 'DELETE', `/api/v3/groups/${id}`)).statusCode).toBe(204);
    expect(await spacesOf(ed2)).toEqual(['sP:view']);
    expect(db.prepare('SELECT COUNT(*) AS n FROM space_members').get()).toEqual({ n: 0 });
  });

  it('une permission de page peut viser un groupe, lue et écrite par les administrateurs', async () => {
    member('sA', { group: 'everyone' }, 'edit');
    const admin = await login('admin');
    const id = (await call(admin, 'POST', '/api/v3/groups', { name: 'Équipe' })).json().id as string;
    await call(admin, 'PUT', `/api/v3/groups/${id}/members/ed1`);
    const put = await call(admin, 'PUT', '/api/v3/pages/pA/permissions', { entries: [{ groupId: id, level: 'write' }, { userId: 'ed3', level: 'read' }] });
    expect(put.statusCode).toBe(200);
    expect((await call(await login('ed1'), 'GET', '/api/v3/pages/pA')).statusCode).toBe(200);
    expect((await call(await login('ed3'), 'GET', '/api/v3/pages/pA')).statusCode).toBe(200);
    expect((await call(await login('ed3'), 'PATCH', '/api/v3/pages/pA', { title: 'X' })).statusCode).toBe(403);
    expect((await call(await login('ed2'), 'GET', '/api/v3/pages/pA')).statusCode).toBe(404);
    const shown = (await call(admin, 'GET', '/api/v3/pages/pA/permissions')).json() as { entries: { groupId?: string; userId?: string; name: string }[] };
    expect(shown.entries.map((e) => `${e.groupId ?? e.userId}:${e.name}`).sort()).toEqual([`${id}:Équipe`, 'ed3:Nom ed3'].sort());
    expect((await call(admin, 'PUT', '/api/v3/pages/pA/permissions', { entries: [{ groupId: 'fantome', level: 'read' }] })).statusCode).toBe(400);
    expect((await call(admin, 'PUT', '/api/v3/pages/pA/permissions', { entries: [{ groupId: id, userId: 'ed1', level: 'read' }] })).statusCode).toBe(400);
    expect((await call(admin, 'PUT', '/api/v3/pages/pA/permissions', { entries: [{ groupId: id, level: 'read' }, { groupId: id, level: 'write' }] })).statusCode).toBe(400);
  });

  it('la copie d’une page restreinte par un groupe garde la restriction', async () => {
    member('sA', { group: 'everyone' }, 'edit');
    member('sB', { group: 'everyone' }, 'edit');
    group('g1', 'ed1');
    db.prepare("INSERT INTO page_acl_groups (page_id, group_id, level) VALUES ('pA', 'g1', 'write')").run();
    const copy = await call(await login('ed1'), 'POST', '/api/v3/pages/pA/copy', { spaceId: 'sB' });
    expect(copy.statusCode).toBe(201);
    const newId = (copy.json() as { page: { id: string } }).page.id;
    expect((await call(await login('ed2'), 'GET', `/api/v3/pages/${newId}`)).statusCode).toBe(404);
    expect((await call(await login('ed1'), 'GET', `/api/v3/pages/${newId}`)).statusCode).toBe(200);
  });
});

describe('données personnelles', () => {
  it('l’export contient les groupes et les rôles d’espace de la personne, pas ceux des autres', async () => {
    group('g1', 'ed1'); group('g2', 'ed2');
    member('sA', { user: 'ed1' }, 'edit');
    member('sB', { user: 'ed2' }, 'full');
    const res = await call(await login('ed1'), 'GET', '/api/v3/me/export');
    expect(res.statusCode).toBe(200);
    const data = res.json() as { groups: { name: string }[]; spaceMemberships: { name: string; role: string }[] };
    expect(data.groups.map((g) => g.name)).toEqual(['g1']);
    expect(data.spaceMemberships).toEqual([{ name: 'sA', role: 'edit' }]);
  });
});

describe('défauts relevés par la relecture', () => {
  const tokenFor = async (id: string, scopes: string[]) => {
    const s = await login(id);
    const t = await call(s, 'POST', '/api/v3/tokens', { name: 'essai', scopes, expiresInDays: 7 });
    expect(t.statusCode).toBe(201);
    return { authorization: `Bearer ${t.json().token}` };
  };
  const bearer = (headers: Record<string, string>, method: 'GET' | 'PUT' | 'DELETE' | 'PATCH', url: string, payload?: object) => app.inject({ method, url, payload, headers });

  it('supprimer le seul groupe d’une page restreinte ne l’ouvre pas à l’espace : elle reste fermée', async () => {
    member('sA', { group: 'everyone' }, 'edit');
    const admin = await login('admin');
    const rh = (await call(admin, 'POST', '/api/v3/groups', { name: 'RH' })).json().id as string;
    await call(admin, 'PUT', `/api/v3/groups/${rh}/members/ed1`);
    await call(admin, 'PUT', '/api/v3/pages/pA/permissions', { entries: [{ groupId: rh, level: 'read' }] });
    expect((await call(await login('ed2'), 'GET', '/api/v3/pages/pA')).statusCode).toBe(404);
    expect((await call(admin, 'DELETE', `/api/v3/groups/${rh}`)).statusCode).toBe(204);
    expect((await call(await login('ed1'), 'GET', '/api/v3/pages/pA')).statusCode).toBe(404);
    expect((await call(await login('ed2'), 'GET', '/api/v3/pages/pA')).statusCode).toBe(404);
    expect((await call(admin, 'GET', '/api/v3/pages/pA')).statusCode).toBe(200);
    // Un groupe qui n'est pas la seule entrée ne laisse pas d'entrée d'administrateur derrière lui.
    const g2 = (await call(admin, 'POST', '/api/v3/groups', { name: 'Autre' })).json().id as string;
    await call(admin, 'PUT', '/api/v3/pages/pA/permissions', { entries: [{ groupId: g2, level: 'read' }, { userId: 'ed3', level: 'read' }] });
    await call(admin, 'DELETE', `/api/v3/groups/${g2}`);
    expect(db.prepare("SELECT user_id FROM page_acl WHERE page_id = 'pA'").all()).toEqual([{ user_id: 'ed3' }]);
  });

  it('effacer le seul compte d’une page restreinte ne l’ouvre pas non plus', async () => {
    member('sA', { group: 'everyone' }, 'edit');
    db.prepare("INSERT INTO page_acl (page_id, user_id, level) VALUES ('pA', 'ed1', 'write')").run();
    const admin = await login('admin');
    const res = await call(admin, 'POST', '/api/v3/admin/users/ed1/erase', { reauth: { password: PASS } });
    expect(res.statusCode).toBe(200);
    expect((await call(await login('ed2'), 'GET', '/api/v3/pages/pA')).statusCode).toBe(404);
  });

  it('eraseUser garde fermée la page dont la personne était la seule entrée', async () => {
    const { eraseUser } = await import('../src/lib/personal-data.js');
    member('sA', { group: 'everyone' }, 'edit');
    db.prepare("INSERT INTO page_acl (page_id, user_id, level) VALUES ('pA', 'ed1', 'write')").run();
    db.prepare("INSERT INTO page_acl (page_id, user_id, level) VALUES ('pB', 'ed1', 'write'), ('pB', 'ed3', 'read')").run();
    expect(eraseUser(db, 'ed1', 'admin')).toBe(true);
    expect(db.prepare("SELECT user_id FROM page_acl WHERE page_id = 'pA'").all()).toEqual([{ user_id: 'admin' }]);
    expect(db.prepare("SELECT user_id FROM page_acl WHERE page_id = 'pB'").all()).toEqual([{ user_id: 'ed3' }]);
    expect(pageLevel(db, as('ed2'), 'pA')).toBe('none');
  });

  it('un jeton sans la portée admin ne gère pas les membres, même celui d’un administrateur ; avec la portée admin si', async () => {
    const light = await tokenFor('admin', ['read', 'write']);
    const body = { groupId: 'everyone', role: 'full' };
    expect((await bearer(light, 'PUT', '/api/v3/spaces/sA/members', body)).statusCode).toBe(403);
    expect((await bearer(light, 'GET', '/api/v3/spaces/sA/members')).statusCode).toBe(403);
    expect((await bearer(light, 'DELETE', '/api/v3/spaces/sA/members/group/everyone')).statusCode).toBe(403);
    expect((await bearer(light, 'PATCH', '/api/v3/spaces/sA', { name: 'Pirate' })).statusCode).toBe(403);
    member('sA', { user: 'ed1' }, 'full');
    const managerToken = await tokenFor('ed1', ['read', 'write']);
    expect((await bearer(managerToken, 'PUT', '/api/v3/spaces/sA/members', { userId: 'ed2', role: 'view' })).statusCode).toBe(403);
    expect(db.prepare("SELECT COUNT(*) AS n FROM space_members WHERE space_id = 'sA' AND (group_id = 'everyone' OR user_id = 'ed2')").get()).toEqual({ n: 0 });
    const full = await tokenFor('admin', ['read', 'write', 'admin']);
    expect((await bearer(full, 'PUT', '/api/v3/spaces/sA/members', { userId: 'ed2', role: 'view' })).statusCode).toBe(204);
  });

  it('un gestionnaire ne peut pas régler l’accès de « Tout le monde » ; un administrateur si', async () => {
    member('sA', { user: 'ed1' }, 'full');
    const ed1 = await login('ed1');
    expect((await call(ed1, 'PUT', '/api/v3/spaces/sA/members', { groupId: 'everyone', role: 'full' })).statusCode).toBe(403);
    expect((await call(ed1, 'PUT', '/api/v3/spaces/sA/members', { groupId: 'everyone', role: 'view' })).statusCode).toBe(403);
    expect(db.prepare("SELECT COUNT(*) AS n FROM space_members WHERE group_id = 'everyone'").get()).toEqual({ n: 0 });
    expect((await call(await login('admin'), 'PUT', '/api/v3/spaces/sA/members', { groupId: 'everyone', role: 'view' })).statusCode).toBe(204);
  });

  it('un flux temps réel ouvert cesse de recevoir les événements d’un espace dont l’accès est retiré', async () => {
    member('sA', { group: 'everyone' }, 'edit');
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as { port: number }).port;
    const ed2 = await login('ed2');
    const controller = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/api/v3/events`, { headers: { cookie: `nb_session=${ed2.cookies.nb_session}` }, signal: controller.signal });
    let received = '';
    void (async () => { const r = res.body!.getReader(); const d = new TextDecoder(); for (;;) { const { value, done } = await r.read(); if (done) break; received += d.decode(value); } })().catch(() => undefined);
    const emit = (version: number) => app.bus.publish({ type: 'page.updated', spaceId: 'sA', pageId: 'pA', version });
    const pause = () => new Promise((r) => setTimeout(r, 250));
    await pause();
    emit(11);
    await pause();
    expect(received).toContain('"version":11');
    await call(await login('admin'), 'DELETE', '/api/v3/spaces/sA/members/group/everyone');
    await pause();
    emit(12);
    await pause();
    expect(received).not.toContain('"version":12');
    controller.abort();
  });

  it('la présence ne révèle pas les pages que l’on ne peut pas lire', async () => {
    const ed1 = await login('ed1');
    member('sA', { user: 'ed1' }, 'edit');
    await call(ed1, 'POST', '/api/v3/presence', { tabId: 'tab-ed1-0001', pageId: 'pA', editing: true });
    const ed2 = await login('ed2');
    const seen = (await call(ed2, 'POST', '/api/v3/presence', { tabId: 'tab-ed2-0001', pageId: 'pA', editing: false })).json() as { peers: { userId: string; pageId: string | null }[] };
    expect(seen.peers.some((p) => p.pageId === 'pA')).toBe(false);
    expect(seen.peers.some((p) => p.userId === 'ed2' && p.pageId === null)).toBe(true); // sa propre page illisible n'est pas signalée
    const mine = (await call(ed1, 'POST', '/api/v3/presence', { tabId: 'tab-ed1-0001', pageId: 'pA', editing: true })).json() as { peers: { pageId: string | null }[] };
    expect(mine.peers.some((p) => p.pageId === 'pA')).toBe(true);
  });
});

describe('synchronisation avec le fournisseur d’identité', () => {
  const link = (id: string, source: 'oidc' | 'ldap' | 'saml', external: string) =>
    db.prepare('INSERT INTO groups (id, name, source, external_id, created_at) VALUES (?, ?, ?, ?, 0)').run(id, id, source, external);
  const members = (id: string) => (db.prepare('SELECT user_id FROM group_members WHERE group_id = ? ORDER BY user_id').all(id) as { user_id: string }[]).map((r) => r.user_id);

  it('recopie l’adhésion à la connexion : ajoute, retire, ne touche jamais aux groupes locaux ni aux autres fournisseurs', () => {
    link('infra', 'oidc', 'infra'); link('ldapinfra', 'ldap', 'cn=infra'); group('local', 'ed1');
    expect(syncGroups(db, 'ed1', 'oidc', ['infra', 'inconnu'])).toBe(true);
    expect(members('infra')).toEqual(['ed1']);
    expect(syncGroups(db, 'ed1', 'oidc', ['infra'])).toBe(false);
    expect(syncGroups(db, 'ed1', 'oidc', [])).toBe(true);
    expect(members('infra')).toEqual([]);
    expect(members('local')).toEqual(['ed1']);
    syncGroups(db, 'ed1', 'ldap', ['CN=Infra']);
    syncGroups(db, 'ed1', 'oidc', []);
    expect(members('ldapinfra')).toEqual(['ed1']); // LDAP : casse ignorée ; une connexion OIDC n'enlève pas l'adhésion LDAP
  });

  it('OIDC et SAML comparent les noms exactement, et ignorent les valeurs invalides', () => {
    link('admins', 'oidc', 'Admins');
    syncGroups(db, 'ed1', 'oidc', ['admins', 'ADMINS']);
    expect(members('admins')).toEqual([]);
    syncGroups(db, 'ed1', 'oidc', [42, null, { x: 1 }, 'x'.repeat(600), 'Admins']);
    expect(members('admins')).toEqual(['ed1']);
    syncGroups(db, 'ed1', 'oidc', 'pas une liste');
    expect(members('admins')).toEqual([]);
  });

  it('l’API : lier un groupe du fournisseur, adhésion manuelle refusée, relier vide l’adhésion recopiée', async () => {
    const admin = await login('admin');
    expect((await call(admin, 'POST', '/api/v3/groups', { name: 'Sans nom externe', source: 'oidc' })).statusCode).toBe(400);
    expect((await call(admin, 'POST', '/api/v3/groups', { name: 'Local piégé', externalId: 'x' })).statusCode).toBe(400);
    const g = await call(admin, 'POST', '/api/v3/groups', { name: 'Infra', source: 'oidc', externalId: 'infra' });
    expect(g.statusCode).toBe(201);
    const id = g.json().id as string;
    expect((await call(admin, 'POST', '/api/v3/groups', { name: 'Doublon', source: 'oidc', externalId: 'infra' })).statusCode).toBe(409);
    expect((await call(admin, 'PUT', `/api/v3/groups/${id}/members/ed1`)).statusCode).toBe(409);
    syncGroups(db, 'ed1', 'oidc', ['infra']);
    expect(members(id)).toEqual(['ed1']);
    expect((await call(admin, 'PATCH', `/api/v3/groups/${id}`, { externalId: 'autre' })).statusCode).toBe(200);
    expect(members(id)).toEqual([]);
  });
});

describe('migration v14 : personne ne gagne ni ne perd d’accès', () => {
  it('donne le droit d’édition à « tout le monde » sur chaque espace existant et garde les restrictions de page', () => {
    const file = oldDb(13, (old) => {
      old.prepare("INSERT INTO spaces (id, name, visibility, created_at, updated_at) VALUES ('s2', 'Public', 'public', 0, 0)").run();
      old.prepare("INSERT INTO users (id, sub, name, role, created_at) VALUES ('r1', 'sub:r1', 'R', 'reader', 0), ('a1', 'sub:a1', 'A', 'admin', 0)").run();
      old.prepare("INSERT INTO page_acl (page_id, user_id, level) VALUES ('p1', 'u1', 'write')").run();
    });
    const up = openDb(file);
    expect(up.prepare('SELECT space_id, group_id, role FROM space_members ORDER BY space_id').all())
      .toEqual([{ space_id: 's1', group_id: 'everyone', role: 'edit' }, { space_id: 's2', group_id: 'everyone', role: 'edit' }]);
    expect(up.prepare("SELECT id, source FROM groups").all()).toEqual([{ id: 'everyone', source: 'system' }]);
    // Mêmes droits qu'avant : l'éditeur écrit partout, le lecteur lit partout, la restriction de page s'applique toujours.
    const who = (id: string, role: 'admin' | 'editor' | 'reader') => as(id, role);
    expect([...spaceRoles(up, who('u1', 'editor')).entries()].sort()).toEqual([['s1', 'edit'], ['s2', 'edit']]);
    expect([...spaceRoles(up, who('r1', 'reader')).entries()].sort()).toEqual([['s1', 'view'], ['s2', 'view']]);
    expect([...spaceRoles(up, who('a1', 'admin')).entries()].sort()).toEqual([['s1', 'full'], ['s2', 'full']]);
    expect(pageLevel(up, who('u1', 'editor'), 'p1')).toBe('write');
    expect(pageLevel(up, who('r1', 'reader'), 'p1')).toBe('none');
    expect(pageLevel(up, null, 'p1')).toBe('none');
    up.close();
  });
});
