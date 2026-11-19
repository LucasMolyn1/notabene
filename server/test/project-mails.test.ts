// E-mails de gestion de projet : tâche attribuée, tâche en retard, résumé hebdomadaire, lien d'espace envoyé par e-mail.
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { type DB, openDb } from '../src/db.js';
import { type Mail, Mailer } from '../src/lib/mail.js';
import { hashPassword } from '../src/lib/password.js';
import { SPACE_SHARE_MAILS_PER_HOUR } from '../src/lib/space-shares.js';
import { ASSIGN_DEBOUNCE_MS, ASSIGN_GROUP_MS, SUMMARY_HOUR, TASK_MAILS_PER_DAY, TaskMailer } from '../src/lib/task-mail.js';
import { seedDemo } from '../src/seed.js';

const env = { NODE_ENV: 'test', PUBLIC_URL: 'http://localhost:3000', ENCRYPTION_KEY: randomBytes(32).toString('base64'), AUTH_LOCAL: 'true', SEED_DEMO: 'false' };
const PASS = 'Sup3r-secret-pass';

class FakeMailer extends Mailer {
  sent: Mail[] = [];
  on = true;
  fail = false;
  constructor() { super(() => { throw new Error('inutilisé'); }); }
  override get enabled() { return this.on; }
  override async send(mail: Mail) {
    if (this.fail) throw new Error('550 destinataire refusé');
    this.sent.push(mail);
  }
}

let app: FastifyInstance;
let db: DB;
let mailer: FakeMailer;
let tasks: TaskMailer;
const sessions = new Map<string, S>();

beforeEach(async () => {
  sessions.clear();
  db = openDb(':memory:');
  seedDemo(db);
  mailer = new FakeMailer();
  const config = loadConfig(env);
  app = await buildApp({ config, db, clientDir: '/nonexistent', mailer });
  tasks = new TaskMailer(db, mailer, () => config);
  for (const [id, role] of [['admin', 'admin'], ['ed1', 'editor'], ['ed2', 'editor'], ['ed3', 'editor']] as const) {
    db.prepare('INSERT INTO users (id, sub, email, name, role, created_at, password_hash) VALUES (?,?,?,?,?,?,?)').run(id, `local:${id}@example.com`, `${id}@example.com`, `Nom ${id}`, role, Date.now(), await hashPassword(PASS));
  }
});
afterEach(async () => { await app.close(); db.close(); });

interface S { cookies: Record<string, string>; headers: Record<string, string> }
async function login(id: string): Promise<S> {
  if (!sessions.has(id)) {
    const res = await app.inject({ method: 'POST', url: '/auth/local/login', payload: { email: `${id}@example.com`, password: PASS } });
    const cookie = res.cookies.find((c) => c.name === 'nb_session')!.value;
    const me = (await app.inject({ method: 'GET', url: '/api/v3/me', cookies: { nb_session: cookie } })).json();
    sessions.set(id, { cookies: { nb_session: cookie }, headers: { 'x-csrf-token': me.csrf as string } });
  }
  return sessions.get(id)!;
}
const call = (s: S | null, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: object) =>
  app.inject({ method, url, payload, cookies: s?.cookies, headers: s?.headers });
const teamSpace = () => (db.prepare("SELECT id FROM spaces WHERE visibility = 'private'").get() as { id: string }).id;
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const fr = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const later = (ms = ASSIGN_DEBOUNCE_MS + 1000) => Date.now() + ms;

interface Prop { id: string; options: { id: string; name: string }[] }
/** Base « Projet » : Nom (titre), Note (texte privé), Échéance, Qui, Aide, Statut. */
async function project(title = 'Projet A') {
  const ed = await login('ed1');
  const res = await call(ed, 'POST', '/api/v3/bases', { spaceId: teamSpace(), title });
  expect(res.statusCode, res.body).toBe(201);
  const b = res.json() as { page: { id: string }; properties: Prop[] };
  const add = async (body: object) => {
    const r = await call(ed, 'POST', `/api/v3/bases/${b.page.id}/properties`, body);
    expect(r.statusCode, r.body).toBe(201);
    return r.json() as Prop;
  };
  const note = (await add({ name: 'Note', type: 'text' })).id;
  const fin = (await add({ name: 'Échéance', type: 'date' })).id;
  const qui = (await add({ name: 'Qui', type: 'person' })).id;
  const aide = (await add({ name: 'Aide', type: 'person' })).id;
  const statut = await add({ name: 'Statut', type: 'status' });
  return { ed, id: b.page.id, nom: b.properties[0]!.id, note, fin, qui, aide, statut, done: statut.options.at(-1)!.id };
}
const addRow = async (s: S, base: string, values: object) => {
  const res = await call(s, 'POST', `/api/v3/bases/${base}/rows`, { values });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { id: string };
};
const patchRow = async (s: S, base: string, row: string, values: object) => {
  const res = await call(s, 'PATCH', `/api/v3/bases/${base}/rows/${row}`, { values });
  expect(res.statusCode, res.body).toBe(200);
};
const to = (who: string) => mailer.sent.filter((m) => m.to === `${who}@example.com`);

describe('préférences', () => {
  it('emailTasks activé et emailSummary désactivé par défaut ; un PUT sans ces champs les garde', async () => {
    const ed = await login('ed2');
    expect((await call(ed, 'GET', '/api/v3/notifications/preferences')).json()).toEqual({ emailComments: true, emailChanges: false, emailTasks: true, emailSummary: false, emailAvailable: true });
    let r = await call(ed, 'PUT', '/api/v3/notifications/preferences', { emailComments: true, emailChanges: false, emailTasks: false, emailSummary: true });
    expect(r.json()).toMatchObject({ emailTasks: false, emailSummary: true });
    r = await call(ed, 'PUT', '/api/v3/notifications/preferences', { emailComments: false, emailChanges: true });
    expect(r.json()).toEqual({ emailComments: false, emailChanges: true, emailTasks: false, emailSummary: true, emailAvailable: true });
    expect((await call(ed, 'PUT', '/api/v3/notifications/preferences', { emailComments: true, emailChanges: true, emailTasks: 'oui' })).statusCode).toBe(400);
  });
});

describe('tâche attribuée', () => {
  it('un e-mail à la personne désignée : titre, base, échéance, lien ; jamais une autre cellule', async () => {
    const p = await project();
    const due = day(10);
    await addRow(p.ed, p.id, { [p.nom]: 'Rédiger le devis', [p.note]: 'texte confidentiel', [p.fin]: due, [p.qui]: 'ed2' });
    // Rien avant le délai de regroupement.
    expect(await tasks.processAssignments(Date.now())).toBe(0);
    expect(await tasks.processAssignments(later())).toBe(1);
    const [m] = to('ed2');
    expect(m!.subject).toBe('BeNote : tâche attribuée dans « Projet A »');
    expect(m!.text).toContain('Rédiger le devis');
    expect(m!.text).toContain(fr(due));
    expect(m!.text).toContain(`http://localhost:3000/p/${p.id}`);
    expect(m!.text).not.toContain('confidentiel');
    expect(m!.text).not.toContain('Nom ed1');
    // Une seule fois.
    expect(await tasks.processAssignments(later(ASSIGN_GROUP_MS * 2))).toBe(0);
    expect(mailer.sent).toHaveLength(1);
  });

  it('jamais à soi-même, ni pour un simple changement de colonne, ni sur une écriture sans changement de personne', async () => {
    const p = await project();
    const r = await addRow(p.ed, p.id, { [p.nom]: 'Moi', [p.qui]: 'ed1' });
    const r2 = await addRow(p.ed, p.id, { [p.nom]: 'Autre', [p.qui]: 'ed2' });
    expect(await tasks.processAssignments(later())).toBe(1);
    mailer.sent.length = 0;
    // ed2 passe de Qui à Aide : pas une nouvelle attribution. Modifier le titre non plus.
    await patchRow(p.ed, p.id, r2.id, { [p.qui]: null, [p.aide]: 'ed2' });
    await patchRow(p.ed, p.id, r2.id, { [p.nom]: 'Autre titre' });
    // ed2 s'attribue lui-même une tâche : rien non plus.
    await patchRow(await login('ed2'), p.id, r.id, { [p.aide]: 'ed2' });
    expect(await tasks.processAssignments(later(ASSIGN_GROUP_MS * 2))).toBe(0);
    expect(mailer.sent).toHaveLength(0);
  });

  it('regroupement : un e-mail par personne et par base et par heure', async () => {
    const p = await project();
    await addRow(p.ed, p.id, { [p.nom]: 'Un', [p.qui]: 'ed2' });
    await addRow(p.ed, p.id, { [p.nom]: 'Deux', [p.aide]: 'ed2' });
    await addRow(p.ed, p.id, { [p.nom]: 'Trois', [p.qui]: 'ed3' });
    expect(await tasks.processAssignments(later())).toBe(2);
    expect(to('ed2')).toHaveLength(1);
    expect(to('ed2')[0]!.subject).toBe('BeNote : 2 tâches attribuées dans « Projet A »');
    expect(to('ed2')[0]!.text).toMatch(/Un[\s\S]*Deux/);
    // Une nouvelle attribution dans l'heure attend la fin de l'heure, puis part seule.
    await addRow(p.ed, p.id, { [p.nom]: 'Quatre', [p.qui]: 'ed2' });
    expect(await tasks.processAssignments(later())).toBe(0);
    expect(await tasks.processAssignments(later(ASSIGN_GROUP_MS + ASSIGN_DEBOUNCE_MS + 5000))).toBe(1);
    expect(to('ed2')).toHaveLength(2);
    expect(to('ed2')[1]!.text).toContain('Quatre');
    expect(to('ed2')[1]!.text).not.toContain('Deux');
  });

  it('préférence coupée, accès retiré, compte désactivé, tâche terminée ou retirée entre-temps : rien', async () => {
    const p = await project();
    const ed2 = await login('ed2');
    await call(ed2, 'PUT', '/api/v3/notifications/preferences', { emailComments: true, emailChanges: false, emailTasks: false });
    await addRow(p.ed, p.id, { [p.nom]: 'Préférence', [p.qui]: 'ed2' });
    const fini = await addRow(p.ed, p.id, { [p.nom]: 'Fini', [p.qui]: 'ed3' });
    await patchRow(p.ed, p.id, fini.id, { [p.statut.id]: p.done });
    const retire = await addRow(p.ed, p.id, { [p.nom]: 'Retiré', [p.aide]: 'admin' });
    await patchRow(p.ed, p.id, retire.id, { [p.aide]: null });
    expect(await tasks.processAssignments(later())).toBe(0);

    // Accès retiré après l'attribution : la base devient restreinte à ed1.
    const q = await project('Projet B');
    await addRow(q.ed, q.id, { [q.nom]: 'Secret', [q.qui]: 'ed3' });
    expect((await call(await login('admin'), 'PUT', `/api/v3/pages/${q.id}/permissions`, { entries: [{ userId: 'ed1', level: 'write' }] })).statusCode).toBe(200);
    // Compte désactivé après l'attribution.
    const r = await project('Projet C');
    await addRow(r.ed, r.id, { [r.nom]: 'Désactivé', [r.qui]: 'ed2' });
    db.prepare("UPDATE users SET disabled = 1 WHERE id = 'ed2'").run();
    expect(await tasks.processAssignments(later())).toBe(0);
    expect(mailer.sent).toHaveLength(0);
  });

  it('SMTP désactivé : rien n’est envoyé ni gardé pour plus tard', async () => {
    const p = await project();
    await addRow(p.ed, p.id, { [p.nom]: 'Un', [p.qui]: 'ed2' });
    mailer.on = false;
    expect(await tasks.processAssignments(later())).toBe(0);
    mailer.on = true;
    expect(await tasks.processAssignments(later())).toBe(0);
    expect(mailer.sent).toHaveLength(0);
  });

  it('plafond quotidien d’e-mails de tâches par personne', async () => {
    const p = await project();
    await addRow(p.ed, p.id, { [p.nom]: 'Un', [p.qui]: 'ed2' });
    db.prepare('INSERT INTO task_mail_daily (user_id, day, n) VALUES (?, ?, ?)').run('ed2', new Date(later()).toISOString().slice(0, 10), TASK_MAILS_PER_DAY);
    expect(await tasks.processAssignments(later())).toBe(0);
  });

  it('réponse anonyme à un formulaire ou écriture sans auteur : aucune attribution notée', async () => {
    const p = await project();
    const { recordAssignments } = await import('../src/lib/task-assign.js');
    const { propertiesOf } = await import('../src/lib/bases.js');
    const r = await addRow(p.ed, p.id, { [p.nom]: 'Un' });
    recordAssignments(db, p.id, r.id, propertiesOf(db, p.id), {}, { [p.qui]: 'ed2' }, null);
    expect(db.prepare('SELECT COUNT(*) AS n FROM task_assign_events').get()).toEqual({ n: 0 });
  });
});

describe('tâche en retard', () => {
  it('un seul e-mail par tâche et par échéance ; une nouvelle échéance rouvre l’envoi', async () => {
    const p = await project();
    const r = await addRow(p.ed, p.id, { [p.nom]: 'En retard', [p.note]: 'confidentiel', [p.fin]: day(-1), [p.qui]: 'ed2', [p.aide]: 'ed1' });
    await addRow(p.ed, p.id, { [p.nom]: 'Fini', [p.fin]: day(-1), [p.qui]: 'ed2', [p.statut.id]: p.done });
    await addRow(p.ed, p.id, { [p.nom]: 'Ancien', [p.fin]: day(-30), [p.qui]: 'ed2' });
    await addRow(p.ed, p.id, { [p.nom]: 'Futur', [p.fin]: day(5), [p.qui]: 'ed2' });
    // ed1 se l'est attribuée lui-même (Aide) : il reçoit aussi le retard, qui n'a pas d'auteur.
    expect(await tasks.processOverdue()).toBe(2);
    const [m] = to('ed2');
    expect(m!.subject).toBe('BeNote : une tâche est en retard');
    expect(m!.text).toContain('En retard');
    expect(m!.text).toContain(fr(day(-1)));
    expect(m!.text).toContain(`http://localhost:3000/p/${p.id}`);
    expect(m!.text).not.toMatch(/Fini|Ancien|Futur|confidentiel/);
    // Redémarrage ou second passage : rien de plus.
    expect(await tasks.processOverdue()).toBe(0);
    expect(await new TaskMailer(db, mailer, () => loadConfig(env)).processOverdue()).toBe(0);
    // Échéance repoussée dans le futur : plus de retard ; puis une autre échéance dépassée : un nouvel e-mail.
    await patchRow(p.ed, p.id, r.id, { [p.fin]: day(3) });
    expect(await tasks.processOverdue()).toBe(0);
    await patchRow(p.ed, p.id, r.id, { [p.fin]: day(-2) });
    expect(await tasks.processOverdue()).toBe(2);
    expect(to('ed2')).toHaveLength(2);
  });

  it('accès retiré, préférence coupée ou SMTP désactivé : rien, et la tâche reste à signaler', async () => {
    const p = await project();
    await addRow(p.ed, p.id, { [p.nom]: 'Retard', [p.fin]: day(-1), [p.qui]: 'ed2' });
    expect((await call(await login('admin'), 'PUT', `/api/v3/pages/${p.id}/permissions`, { entries: [{ userId: 'ed1', level: 'write' }] })).statusCode).toBe(200);
    expect(await tasks.processOverdue()).toBe(0);
    expect((await call(await login('admin'), 'PUT', `/api/v3/pages/${p.id}/permissions`, { entries: [] })).statusCode).toBe(200);
    mailer.on = false;
    expect(await tasks.processOverdue()).toBe(0);
    mailer.on = true;
    await call(await login('ed2'), 'PUT', '/api/v3/notifications/preferences', { emailComments: true, emailChanges: false, emailTasks: false });
    expect(await tasks.processOverdue()).toBe(0);
    await call(await login('ed2'), 'PUT', '/api/v3/notifications/preferences', { emailComments: true, emailChanges: false, emailTasks: true });
    expect(await tasks.processOverdue()).toBe(1);
  });

  it('plafond quotidien : la tâche n’est pas marquée et part le lendemain', async () => {
    const p = await project();
    await addRow(p.ed, p.id, { [p.nom]: 'Retard', [p.fin]: day(-1), [p.qui]: 'ed2' });
    db.prepare('INSERT INTO task_mail_daily (user_id, day, n) VALUES (?, ?, ?)').run('ed2', day(0), TASK_MAILS_PER_DAY);
    expect(await tasks.processOverdue()).toBe(0);
    expect(await tasks.processOverdue(Date.now() + 86_400_000)).toBe(1);
  });

  it('balayage par tranches avec curseur : toutes les bases servies, puis le balayage s’arrête', async () => {
    for (const title of ['B1', 'B2', 'B3']) {
      const p = await project(title);
      await addRow(p.ed, p.id, { [p.nom]: `Retard ${title}`, [p.fin]: day(-1), [p.qui]: 'ed2' });
    }
    const counts: number[] = [];
    do counts.push(await tasks.processOverdue(Date.now(), 1)); while (tasks.overduePending && counts.length < 10);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(3);
    expect(counts.length).toBeLessThanOrEqual(4);
    expect(tasks.overduePending).toBe(false);
    expect(to('ed2').map((m) => /Retard (B\d)/.exec(m.text)![1]).sort()).toEqual(['B1', 'B2', 'B3']);
  });

  it('rend la main à la boucle d’événements pendant le balayage', async () => {
    const p = await project();
    await addRow(p.ed, p.id, { [p.nom]: 'Retard', [p.fin]: day(-1), [p.qui]: 'ed2' });
    const order: string[] = [];
    setImmediate(() => order.push('immediate'));
    await tasks.processOverdue();
    order.push('fin');
    expect(order).toEqual(['immediate', 'fin']);
  });
});

describe('résumé hebdomadaire', () => {
  /** Prochain lundi, à SUMMARY_HOUR + 1 (heure locale du serveur). */
  const monday = (offsetDays = 0) => {
    const d = new Date();
    d.setHours(SUMMARY_HOUR + 1, 0, 0, 0);
    while (d.getDay() !== 1) d.setDate(d.getDate() + 1);
    d.setDate(d.getDate() + offsetDays);
    return d.getTime();
  };
  const optIn = async (who: string) => {
    const r = await call(await login(who), 'PUT', '/api/v3/notifications/preferences', { emailComments: true, emailChanges: false, emailSummary: true });
    expect(r.statusCode).toBe(200);
  };

  it('le lundi matin, une fois par semaine, seulement pour qui l’a demandé et a des tâches', async () => {
    const p = await project();
    await addRow(p.ed, p.id, { [p.nom]: 'À faire', [p.note]: 'confidentiel', [p.fin]: '2999-01-01', [p.qui]: 'ed2' });
    await addRow(p.ed, p.id, { [p.nom]: 'Vieille', [p.fin]: '2001-01-01', [p.aide]: 'ed2' });
    await addRow(p.ed, p.id, { [p.nom]: 'Terminée', [p.qui]: 'ed2', [p.statut.id]: p.done });
    await addRow(p.ed, p.id, { [p.nom]: 'Pour ed3', [p.qui]: 'ed3' });
    const q = await project('Projet secret');
    await addRow(q.ed, q.id, { [q.nom]: 'Cachée', [q.qui]: 'ed2' });
    expect((await call(await login('admin'), 'PUT', `/api/v3/pages/${q.id}/permissions`, { entries: [{ userId: 'ed1', level: 'write' }] })).statusCode).toBe(200);
    await optIn('ed2');
    await optIn('ed1'); // aucune tâche : aucun e-mail
    // ed3 a une tâche mais n'a pas demandé le résumé.

    expect(await tasks.processSummary(monday(1))).toBe(0); // mardi
    const early = new Date(monday()); early.setHours(SUMMARY_HOUR - 1);
    expect(await tasks.processSummary(early.getTime())).toBe(0); // trop tôt
    expect(await tasks.processSummary(monday())).toBe(1);
    const [m] = to('ed2');
    expect(m!.subject).toBe('BeNote : vos tâches de la semaine');
    expect(m!.text).toContain('2 tâche(s) à faire, dont 1 en retard');
    expect(m!.text).toContain('À faire (base « Projet A ») : échéance 01/01/2999, à faire');
    expect(m!.text).toContain('Vieille (base « Projet A ») : échéance 01/01/2001, en retard');
    expect(m!.text).toContain('http://localhost:3000/tasks');
    expect(m!.text).not.toMatch(/Terminée|Pour ed3|Cachée|secret|confidentiel/);
    // Idempotent dans la semaine (redémarrage compris), de nouveau la semaine suivante.
    expect(await tasks.processSummary(monday() + 3_600_000)).toBe(0);
    expect(await new TaskMailer(db, mailer, () => loadConfig(env)).processSummary(monday())).toBe(0);
    expect(await tasks.processSummary(monday(7))).toBe(1);
    expect(mailer.sent).toHaveLength(2);
  });

  it('par tranches reprises d’un passage à l’autre ; une fois la semaine traitée, plus rien jusqu’au lundi suivant', async () => {
    const p = await project();
    for (const who of ['ed1', 'ed2', 'ed3']) {
      await addRow(p.ed, p.id, { [p.nom]: `Pour ${who}`, [p.aide]: who });
      await optIn(who);
    }
    const order: string[] = [];
    setImmediate(() => order.push('immediate'));
    expect(await tasks.processSummary(monday(), 2)).toBe(2);
    order.push('fin');
    expect(order).toEqual(['immediate', 'fin']);
    // Redémarrage entre deux tranches : l'état est en base, la personne restante est servie, et elle seule.
    const fresh = new TaskMailer(db, mailer, () => loadConfig(env));
    expect(await fresh.processSummary(monday() + 60_000, 2)).toBe(1);
    expect(new Set(mailer.sent.map((m) => m.to)).size).toBe(3);
    // Semaine close : une personne qui s'inscrit après coup attend le lundi suivant (aucune nouvelle lecture cette semaine).
    await optIn('admin');
    await addRow(p.ed, p.id, { [p.nom]: 'Pour admin', [p.qui]: 'admin' });
    expect(await fresh.processSummary(monday() + 120_000, 2)).toBe(0);
    expect(mailer.sent).toHaveLength(3);
    expect(await fresh.processSummary(monday(7), 10)).toBe(4);
  });

  it('désactivé par défaut ; SMTP désactivé : rien', async () => {
    const p = await project();
    await addRow(p.ed, p.id, { [p.nom]: 'À faire', [p.qui]: 'ed2' });
    expect(await tasks.processSummary(monday())).toBe(0);
    await optIn('ed2');
    mailer.on = false;
    expect(await tasks.processSummary(monday())).toBe(0);
    expect(mailer.sent).toHaveLength(0);
  });
});

describe('lien d’espace envoyé par e-mail', () => {
  const space = 'prive';
  beforeEach(async () => {
    db.prepare("INSERT INTO spaces (id, name, icon, created_at, updated_at) VALUES (?, 'Client X', 'folder', 0, 0)").run(space);
    db.prepare("INSERT INTO space_members (space_id, user_id, role) VALUES (?, 'ed1', 'full'), (?, 'ed2', 'edit')").run(space, space);
    const admin = await login('admin');
    expect((await call(admin, 'PUT', '/api/v3/admin/sharing', { enabled: true })).statusCode).toBe(200);
    expect((await call(admin, 'PUT', '/api/v3/admin/sharing/spaces', { enabled: true })).statusCode).toBe(200);
  });
  const enableMail = async (enabled = true) => {
    const r = await call(await login('admin'), 'PUT', '/api/v3/admin/sharing/spaces/mail', { enabled });
    expect(r.statusCode, r.body).toBe(200);
    return r.json() as { enabled: boolean; effective: boolean };
  };
  const create = (body: object, who = 'ed1') => call(sessions.get(who) ?? null, 'POST', `/api/v3/spaces/${space}/shares`, body);
  const links = () => (db.prepare('SELECT COUNT(*) AS n FROM space_shares').get() as { n: number }).n;

  it('option d’instance désactivée par défaut, réglée par un administrateur seulement, avec audit', async () => {
    await login('ed1');
    expect((await call(await login('admin'), 'GET', '/api/v3/admin/sharing')).json().spaces).toMatchObject({ mail: false, smtp: true });
    expect((await call(await login('ed1'), 'GET', `/api/v3/spaces/${space}/shares`)).json()).toMatchObject({ mailAvailable: false });
    const r = await create({ notifyEmail: 'client@example.org' });
    expect(r.statusCode).toBe(403);
    expect(links()).toBe(0);
    expect((await call(await login('ed1'), 'PUT', '/api/v3/admin/sharing/spaces/mail', { enabled: true })).statusCode).toBe(403);
    expect(await enableMail()).toEqual({ enabled: true, effective: true });
    expect((await call(await login('ed1'), 'GET', `/api/v3/spaces/${space}/shares`)).json()).toMatchObject({ mailAvailable: true });
    const audit = db.prepare("SELECT meta FROM audit_log WHERE action = 'settings.space_share_mail'").get() as { meta: string };
    expect(JSON.parse(audit.meta)).toEqual({ enabled: true });
    // Sans adresse : comportement inchangé, aucun indicateur d'envoi.
    const plain = await create({ label: 'Sans e-mail' });
    expect(plain.statusCode).toBe(201);
    expect(plain.json()).not.toHaveProperty('mailSent');
    expect(mailer.sent).toHaveLength(0);
  });

  it('envoie un e-mail fixe au seul destinataire ; l’adresse n’est ni stockée ni journalisée ; le lien ne ressort pas de la liste', async () => {
    await enableMail();
    await login('ed1');
    const r = await create({ label: 'Client', expiresInDays: 30, notifyEmail: 'client@example.org' });
    expect(r.statusCode, r.body).toBe(201);
    const j = r.json() as { url: string; mailSent: boolean; expiresAt: number };
    expect(j.mailSent).toBe(true);
    expect(mailer.sent).toHaveLength(1);
    const [m] = mailer.sent;
    expect(m!.to).toBe('client@example.org');
    expect(m!.subject).toBe('BeNote : un espace a été partagé avec vous');
    expect(m!.text).toContain(j.url);
    expect(j.url.startsWith('http://localhost:3000/share/')).toBe(true);
    expect(m!.text).toContain('« Client X »');
    expect(m!.text).toContain('Nom ed1');
    expect(m!.text).toContain(new Date(j.expiresAt).toLocaleDateString('fr-FR', { timeZone: 'UTC' }));
    const audit = db.prepare("SELECT meta FROM audit_log WHERE action = 'space.share.mail'").get() as { meta: string };
    expect(JSON.parse(audit.meta)).toMatchObject({ sent: true });
    const everything = JSON.stringify([db.prepare('SELECT * FROM audit_log').all(), db.prepare('SELECT * FROM space_shares').all(), db.prepare('SELECT * FROM space_share_mails').all()]);
    expect(everything).not.toContain('client@example.org');
    expect(everything).not.toContain(j.url.split('/share/')[1]);
    const list = await call(await login('ed1'), 'GET', `/api/v3/spaces/${space}/shares`);
    expect(list.body).not.toContain(j.url.split('/share/')[1]);
  });

  it('noms nettoyés dans l’e-mail : ni URL ni adresse, une ligne, 60 caractères, repli si vide', async () => {
    await enableMail();
    db.prepare("UPDATE users SET name = ? WHERE id = 'ed1'").run('Alice https://evil.test/x www.piege.test bob@evil.test\tDupont');
    db.prepare('UPDATE spaces SET name = ? WHERE id = ?').run('https://evil.test/login', space);
    await login('ed1');
    const r = await create({ notifyEmail: 'client@example.org' });
    expect(r.statusCode, r.body).toBe(201);
    const text = mailer.sent[0]!.text;
    expect(text).toContain('Alice Dupont vous a partagé l’espace « un espace partagé »'.replace('’', "'"));
    expect(text).not.toMatch(/evil|piege/);
    const { cleanMailName } = await import('../src/lib/mail.js');
    expect(cleanMailName('x'.repeat(200), 'repli')).toHaveLength(60);
    expect(cleanMailName('  \r\n http://a.b  ', 'Un gestionnaire')).toBe('Un gestionnaire');
    expect(cleanMailName('Équipe\r\nBcc: x', 'repli')).toBe('Équipe Bcc: x');
  });

  it('SMTP absent : 409 et aucun lien ; SMTP en échec : lien créé, mailSent false, message générique', async () => {
    await enableMail();
    await login('ed1');
    mailer.on = false;
    expect((await create({ notifyEmail: 'client@example.org' })).statusCode).toBe(409);
    expect(links()).toBe(0);
    mailer.on = true;
    mailer.fail = true;
    const r = await create({ notifyEmail: 'client@example.org' });
    expect(r.statusCode).toBe(201);
    const j = r.json() as { url: string; mailSent: boolean; mailError: string };
    expect(j.mailSent).toBe(false);
    expect(j.mailError).not.toContain('550');
    expect(j.url).toContain('/share/');
    expect(links()).toBe(1);
    expect(JSON.parse((db.prepare("SELECT meta FROM audit_log WHERE action = 'space.share.mail'").get() as { meta: string }).meta)).toMatchObject({ sent: false });
  });

  it('adresse validée strictement : aucune injection d’en-tête, un seul destinataire', async () => {
    await enableMail();
    await login('ed1');
    for (const bad of [
      'client@example.org\r\nBcc: x@evil.test', 'client@example.org\nBcc: x@evil.test', 'client@example.org, x@evil.test', 'client@example.org;x@evil.test',
      ' client@example.org', 'client@example.org ', 'Client <client@example.org>', '"a b"@example.org', 'client@', '@example.org', 'client@example',
      'client@@example.org', `${'a'.repeat(250)}@example.org`, ['client@example.org'],
    ]) {
      const r = await create({ notifyEmail: bad });
      expect(r.statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect(links()).toBe(0);
    expect(mailer.sent).toHaveLength(0);
  });

  it('réservé aux gestionnaires de l’espace en session web ; plafond par espace et par heure', async () => {
    await enableMail();
    await login('ed2');
    expect((await create({ notifyEmail: 'client@example.org' }, 'ed2')).statusCode).toBe(403);
    await login('ed1');
    for (let i = 0; i < SPACE_SHARE_MAILS_PER_HOUR; i++) {
      const r = await create({ notifyEmail: `c${i}@example.org` });
      expect(r.statusCode, r.body).toBe(201);
      // Révoqués au fur et à mesure : le plafond de liens actifs ne joue pas ici.
      expect((await call(sessions.get('ed1')!, 'DELETE', `/api/v3/spaces/${space}/shares/${(r.json() as { id: string }).id}`)).statusCode).toBe(204);
    }
    const r = await create({ notifyEmail: 'encore@example.org' });
    expect(r.statusCode).toBe(429);
    expect(links()).toBe(0);
    // Sans e-mail, la création reste possible.
    expect((await create({})).statusCode).toBe(201);
  });

  it('option coupée après coup : plus d’envoi', async () => {
    await enableMail();
    await enableMail(false);
    await login('ed1');
    expect((await create({ notifyEmail: 'client@example.org' })).statusCode).toBe(403);
  });
});
