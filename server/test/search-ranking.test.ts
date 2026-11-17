// Recherche : un titre exactement égal à la requête (sans casse ni accents) passe en tête, puis les titres qui la contiennent,
// puis le reste ; le classement reste le même d'un lot de résultats à l'autre.
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { type DB, foldText, openDb } from '../src/db.js';
import { hashPassword } from '../src/lib/password.js';

const env = { NODE_ENV: 'test', PUBLIC_URL: 'http://localhost:3000', ENCRYPTION_KEY: randomBytes(32).toString('base64'), AUTH_LOCAL: 'true', SEED_DEMO: 'false' };
const PASS = 'Sup3r-secret-pass';
let app: FastifyInstance;
let db: DB;
let n = 0;
let cookies: Record<string, string>;

const page = (title: string, text: string) => {
  n++;
  db.prepare("INSERT INTO pages (id, space_id, title, content, text, created_at, updated_at) VALUES (?, 's1', ?, '{\"type\":\"doc\",\"content\":[]}', ?, ?, ?)")
    .run(`p${String(n).padStart(3, '0')}`, title, text, n, n);
};
const search = async (q: string, extra = '') => {
  const res = await app.inject({ method: 'GET', url: `/api/v3/search?q=${encodeURIComponent(q)}${extra}`, cookies });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as { items: { id: string; title: string }[]; nextCursor: string | null };
};

beforeEach(async () => {
  n = 0;
  db = openDb(':memory:');
  app = await buildApp({ config: loadConfig(env), db, clientDir: '/nonexistent' });
  db.prepare('INSERT INTO users (id, sub, email, name, role, created_at, password_hash) VALUES (?,?,?,?,?,?,?)')
    .run('u1', 'local:u1@example.com', 'u1@example.com', 'U', 'admin', Date.now(), await hashPassword(PASS));
  db.prepare("INSERT INTO spaces (id, name, created_at, updated_at) VALUES ('s1', 'Espace', 0, 0)").run();
  const res = await app.inject({ method: 'POST', url: '/auth/local/login', payload: { email: 'u1@example.com', password: PASS } });
  cookies = { nb_session: res.cookies.find((c) => c.name === 'nb_session')!.value };
});
afterEach(async () => { await app.close(); db.close(); });

describe('recherche : titre exact en premier', () => {
  it('« Doc camille 2 » en tête devant des pages plus pertinentes pour bm25', async () => {
    // Les autres pages répètent les termes dans leur texte : sans le classement par titre, elles passaient devant.
    for (const i of [9, 14, 8, 1, 3, 4, 5, 6, 7, 10, 11, 12, 13]) page(`Doc camille ${i}`, 'doc camille 2 doc camille 2 doc camille 2 rapport');
    page('Doc camille 2', 'court');
    page('Autre', 'doc camille 2 doc camille 2 doc camille 2');
    const res = await search('Doc camille 2');
    expect(res.items[0]!.title).toBe('Doc camille 2');
    // Puis les titres qui contiennent la requête, avant le reste.
    expect(res.items.slice(1).map((i) => i.title)).toContain('Doc camille 12');
    expect(res.items.at(-1)!.title).toBe('Autre');
  });

  it('insensible à la casse, aux accents et aux espaces multiples', async () => {
    page('Réunion équipe hebdomadaire', 'réunion équipe réunion équipe réunion équipe');
    page('Notes', 'réunion équipe réunion équipe réunion équipe réunion équipe');
    page('  RÉUNION   Équipe ', 'x');
    const res = await search('reunion EQUIPE');
    expect(res.items.map((i) => i.title)).toEqual(['  RÉUNION   Équipe ', 'Réunion équipe hebdomadaire', 'Notes']);
    expect(foldText('  RÉUNION   Équipe ')).toBe('reunion equipe');
  });

  it('pagination : la suite des lots reproduit exactement la liste complète', async () => {
    for (let i = 0; i < 25; i++) page(`Fiche ${i}`, `fiche ${'fiche '.repeat(i % 5)} contenu`);
    page('Fiche', 'fiche');
    const full = (await search('fiche', '&limit=100')).items.map((i) => i.id);
    expect(full).toHaveLength(26);
    expect(full[0]).toBe(`p${String(26).padStart(3, '0')}`);
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 20; guard++) {
      const lot: { items: { id: string }[]; nextCursor: string | null } = await search('fiche', `&limit=4${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      seen.push(...lot.items.map((i) => i.id));
      cursor = lot.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toEqual(full);
  });
});
