import { describe, expect, it } from 'vitest';
import type { Auth } from '../src/auth/context.js';
import { openDb } from '../src/db.js';
import { filterReadable, pageLevel } from '../src/lib/page-acl.js';
import { listPages } from '../src/lib/pages.js';

const as = (id: string, role: 'admin' | 'editor' | 'reader' = 'editor'): Auth => ({ user: { id, name: id, email: null, role }, via: 'session', scopes: new Set(['read', 'write']) });

function tree() {
  const db = openDb(':memory:');
  const now = Date.now();
  db.prepare("INSERT INTO spaces (id, name, created_at, updated_at) VALUES ('s', 's', ?, ?)").run(now, now);
  for (const u of ['a', 'b', 'c']) db.prepare("INSERT INTO users (id, sub, name, role, created_at) VALUES (?, ?, ?, 'editor', ?)").run(u, `sub:${u}`, u, now);
  const page = (id: string, parent: string | null) =>
    db.prepare("INSERT INTO pages (id, space_id, parent_id, title, content, text, created_at, updated_at) VALUES (?, 's', ?, ?, '{}', ?, ?, ?)").run(id, parent, id, `texte de ${id} `.repeat(50), now, now);
  // libre -> racine -> enfant -> petit-enfant (avec ses propres entrées) -> arriere
  page('libre', null); page('racine', null); page('enfant', 'racine'); page('petit', 'enfant'); page('arriere', 'petit');
  const acl = (p: string, u: string, level = 'write') => db.prepare('INSERT INTO page_acl (page_id, user_id, level) VALUES (?, ?, ?)').run(p, u, level);
  acl('racine', 'a');
  acl('petit', 'b'); // la restriction la plus proche gouverne : a n'y accède plus, b oui
  return db;
}
const ids = ['libre', 'racine', 'enfant', 'petit', 'arriere'].map((id) => ({ id }));
const visible = (db: ReturnType<typeof tree>, auth: Auth | null) => filterReadable(db, auth, ids).map((i) => i.id);

describe('filtrage des pages par permissions', () => {
  it('applique la restriction la plus proche, et jamais plus large', () => {
    const db = tree();
    expect(visible(db, as('a'))).toEqual(['libre', 'racine', 'enfant']);
    expect(visible(db, as('b'))).toEqual(['libre', 'petit', 'arriere']);
    expect(visible(db, as('c'))).toEqual(['libre']);
    expect(visible(db, null)).toEqual(['libre']);
    expect(visible(db, as('x', 'admin'))).toEqual(['libre', 'racine', 'enfant', 'petit', 'arriere']);
  });

  it('donne le même résultat que le contrôle page par page', () => {
    const db = tree();
    for (const who of [as('a'), as('b'), as('c'), as('x', 'admin'), null]) {
      expect(visible(db, who)).toEqual(ids.filter((i) => pageLevel(db, who, i.id) !== 'none').map((i) => i.id));
    }
  });

  it('sans restriction, renvoie tout sans requête', () => {
    const db = openDb(':memory:');
    expect(filterReadable(db, null, ids)).toEqual(ids);
  });
});

describe('liste des pages', () => {
  it('ne lit que des métadonnées et un extrait de 200 caractères', () => {
    const db = tree();
    const list = listPages(db, ['s'], null);
    expect(list).toHaveLength(5);
    expect(list[0]).not.toHaveProperty('content');
    for (const p of list) expect(p.excerpt.length).toBeLessThanOrEqual(200);
    expect(list.find((p) => p.id === 'enfant')?.excerpt.startsWith('texte de enfant')).toBe(true);
  });
});
