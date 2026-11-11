// Formulaires des bases (règles de sécurité : lib/base-forms.ts). Trois familles de routes :
//  - gestion (droit d'écriture sur la base) : lister, créer, modifier, supprimer, créer ou renouveler le lien, le révoquer.
//    Créer, modifier et créer le lien : session web seulement (le lien est un secret, le mode anonyme ouvre une écriture sans
//    compte) ; supprimer et révoquer : aussi par jeton d'API de portée write (couper un accès ne doit jamais être plus difficile) ;
//  - administration : réglage d'instance (désactivé par défaut) ;
//  - lien public : GET et POST /public/forms/<jeton>, sans compte en mode anonyme, avec une session en mode comptes.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { can, guard, requireAuth } from '../auth/context.js';
import { loadWritablePage, readableSpaceIds } from '../lib/access.js';
import { audit } from '../lib/audit.js';
import {
  activeForm, checkAnswers, confirmRestriction, createOrRotateLink, FORM_MODES, formById, formsEnabled, formsOf, formText, formTitle,
  FormTickets, ipRateKey, MAX_ANSWER_CHARS, MAX_BASE_RESPONSES_PER_HOUR, opensToAnonymous, MAX_BODY_BYTES, MAX_FORM_TEXT, MAX_FORM_TITLE, MAX_FORMS, MAX_LABEL, MAX_QUESTIONS, MAX_RESPONSES_PER_HOUR,
  MAX_TICKET_AGE_MS, MIN_FILL_MS, presentForm, publicForm, questionsInput, revokeLink, saveForm, setFormsEnabled, SUBMIT_PER_MINUTE, writeResponse,
} from '../lib/base-forms.js';
import { reindexBase, touchBase, type Ctx } from '../lib/bases.js';
import { HttpError, idParams, idSchema } from '../lib/http.js';
import { inPersonalSpace } from '../lib/personal-spaces.js';
import type { PageRow } from '../lib/pages.js';
import { restrictionKey } from '../lib/shares.js';

const createBody = z.object({
  title: formTitle,
  description: formText.optional(),
  thanks: formText.optional(),
  mode: z.enum(FORM_MODES).optional(),
  notify: z.boolean().optional(),
  questions: questionsInput,
  confirmRestricted: z.boolean().optional(),
}).strict();
const patchBody = z.object({
  title: formTitle.optional(),
  description: formText.optional(),
  thanks: formText.optional(),
  mode: z.enum(FORM_MODES).optional(),
  notify: z.boolean().optional(),
  questions: questionsInput.optional(),
  confirmRestricted: z.boolean().optional(),
}).strict();
const linkBody = z.object({ confirmRestricted: z.boolean().optional() }).strict().nullish();
const formParams = z.object({ id: idSchema, fid: idSchema });
const tokenParams = z.object({ token: z.string().max(100) });
// Réponse : clés = identifiants de colonnes exposées ; `website` est le champ piège (laissé vide par une personne).
const submitBody = z.object({
  answers: z.record(idSchema, z.unknown()).refine((o) => Object.keys(o).length <= MAX_QUESTIONS, 'trop de réponses'),
  ticket: z.string().max(200),
  website: z.string().max(500).optional(),
}).strict();

export default async function baseFormRoutes(app: FastifyInstance) {
  const { db, bus, config, notifier } = app;
  const tags = ['bases'];
  const tickets = new FormTickets(config.ENCRYPTION_KEY);
  const urlOf = (token: string) => `${config.PUBLIC_URL}/form/${token}`;
  const limits = {
    forms: MAX_FORMS, questions: MAX_QUESTIONS, title: MAX_FORM_TITLE, text: MAX_FORM_TEXT, label: MAX_LABEL,
    responsesPerHour: MAX_RESPONSES_PER_HOUR, baseResponsesPerHour: MAX_BASE_RESPONSES_PER_HOUR, submitPerMinute: SUBMIT_PER_MINUTE, answerChars: MAX_ANSWER_CHARS,
  };

  const openBase = (req: FastifyRequest, id: string): PageRow => {
    if (!req.auth || !can(req.auth, 'read')) throw new HttpError(404, 'Base introuvable');
    const page = loadWritablePage(db, req, id);
    if (page.kind !== 'base') throw new HttpError(404, 'Base introuvable');
    return page;
  };
  const needSession = (req: FastifyRequest) => {
    if (requireAuth(req).via !== 'session') throw new HttpError(403, 'Les formulaires se règlent depuis la session web');
  };
  const spaceAllows = (spaceId: string) => !!db.prepare("SELECT 1 FROM spaces WHERE id = ? AND forms_enabled = 1 AND kind != 'personal'").get(spaceId);
  // Instance, espace, et jamais un espace personnel : 409 pour l'espace personnel (définitif), 403 sinon (réglage).
  const assertAvailable = (page: PageRow) => {
    if (inPersonalSpace(db, page.id)) throw new HttpError(409, 'Pas de formulaire dans un espace personnel', { reason: 'personal' });
    if (!formsEnabled(db)) throw new HttpError(403, 'Les formulaires ne sont pas activés sur cette instance', { reason: 'disabled' });
    if (!spaceAllows(page.space_id)) throw new HttpError(403, 'Les formulaires sont désactivés dans cet espace', { reason: 'disabled' });
  };
  const changed = (req: FastifyRequest, page: PageRow) =>
    bus.publish({ type: 'base.changed', spaceId: page.space_id, pageId: page.id, by: { id: req.auth!.user.id, name: req.auth!.user.name } });
  const write = { preHandler: guard('write'), config: { rateLimit: { max: 30, timeWindow: '1 minute' } } };

  // ---- Gestion ----------------------------------------------------------------------------
  app.get('/bases/:id/forms', {
    preHandler: guard('write'),
    schema: { tags, summary: 'Formulaires d’une base (droit d’écriture ; jamais les liens)', params: idParams },
  }, async (req) => {
    const page = openBase(req, (req.params as { id: string }).id);
    const personal = inPersonalSpace(db, page.id);
    return {
      available: !personal && formsEnabled(db) && spaceAllows(page.space_id),
      instanceEnabled: formsEnabled(db),
      spaceEnabled: spaceAllows(page.space_id),
      personal,
      restricted: restrictionKey(db, page.id) !== null,
      items: formsOf(db, page.id).map((f) => presentForm(db, f)),
      limits,
    };
  });

  app.post('/bases/:id/forms', {
    ...write,
    schema: { tags, summary: `Créer un formulaire (${MAX_FORMS} par base ; mode comptes par défaut)`, params: idParams, body: createBody },
  }, async (req, reply) => {
    needSession(req);
    const page = openBase(req, (req.params as { id: string }).id);
    assertAvailable(page);
    const b = req.body as z.output<typeof createBody>;
    const key = confirmRestriction(db, page.id, b.confirmRestricted, null);
    const form = saveForm(db, page.id, req.auth!.user.id, b, key, null);
    audit(db, req, 'base.form.create', page.id, { formId: form.id, mode: form.mode, questions: b.questions.length, restricted: key !== null });
    changed(req, page);
    return reply.status(201).send(presentForm(db, form));
  });

  app.patch('/bases/:id/forms/:fid', {
    ...write,
    schema: { tags, summary: 'Modifier un formulaire (vous en devenez l’auteur)', params: formParams, body: patchBody },
  }, async (req) => {
    needSession(req);
    const p = req.params as z.output<typeof formParams>;
    const page = openBase(req, p.id);
    if (inPersonalSpace(db, page.id)) throw new HttpError(409, 'Pas de formulaire dans un espace personnel', { reason: 'personal' });
    const cur = formById(db, page.id, p.fid);
    const b = req.body as z.output<typeof patchBody>;
    // Ouvrir à l'anonyme est une décision qui demande les réglages actifs ; le lien en cours est révoqué (saveForm).
    const opening = opensToAnonymous(b, cur);
    if (opening) assertAvailable(page);
    const key = confirmRestriction(db, page.id, b.confirmRestricted, cur);
    const form = saveForm(db, page.id, req.auth!.user.id, b, key, cur);
    audit(db, req, 'base.form.update', page.id, {
      formId: form.id, ...(b.mode !== undefined ? { mode: b.mode } : {}), ...(b.notify !== undefined ? { notify: b.notify } : {}), ...(b.questions ? { questions: b.questions.length } : {}),
    });
    if (opening && cur.token_hash !== null) audit(db, req, 'base.form.link.revoke', page.id, { formId: form.id, reason: 'anonymous' });
    changed(req, page);
    return presentForm(db, form);
  });

  app.delete('/bases/:id/forms/:fid', { ...write, schema: { tags, summary: 'Supprimer un formulaire (les réponses déjà reçues restent des lignes)', params: formParams } }, async (req, reply) => {
    const p = req.params as z.output<typeof formParams>;
    const page = openBase(req, p.id);
    formById(db, page.id, p.fid);
    db.prepare('DELETE FROM base_forms WHERE id = ?').run(p.fid);
    audit(db, req, 'base.form.delete', page.id, { formId: p.fid });
    changed(req, page);
    return reply.status(204).send();
  });

  app.post('/bases/:id/forms/:fid/link', {
    ...write,
    schema: { tags, summary: 'Créer le lien public d’un formulaire ou le renouveler (montré une seule fois)', params: formParams, body: linkBody },
  }, async (req, reply) => {
    needSession(req);
    const p = req.params as z.output<typeof formParams>;
    const page = openBase(req, p.id);
    assertAvailable(page);
    const form = formById(db, page.id, p.fid);
    const key = confirmRestriction(db, page.id, (req.body as z.output<typeof linkBody>)?.confirmRestricted, form);
    const { token, rotated } = createOrRotateLink(db, form, key, req.auth!.user.id);
    audit(db, req, rotated ? 'base.form.link.rotate' : 'base.form.link.create', page.id, { formId: form.id, mode: form.mode });
    changed(req, page);
    return reply.status(rotated ? 200 : 201).send({ url: urlOf(token) });
  });

  app.delete('/bases/:id/forms/:fid/link', { ...write, schema: { tags, summary: 'Révoquer le lien public d’un formulaire', params: formParams } }, async (req, reply) => {
    const p = req.params as z.output<typeof formParams>;
    const page = openBase(req, p.id);
    if (revokeLink(db, formById(db, page.id, p.fid))) {
      audit(db, req, 'base.form.link.revoke', page.id, { formId: p.fid });
      changed(req, page);
    }
    return reply.status(204).send();
  });

  // ---- Administration ----------------------------------------------------------------------
  app.get('/admin/forms', { preHandler: guard('admin'), schema: { tags: ['admin'], summary: 'Formulaires : réglage d’instance' } }, async () => ({
    enabled: formsEnabled(db),
    count: (db.prepare('SELECT COUNT(*) AS n FROM base_forms').get() as { n: number }).n,
    activeCount: (db.prepare('SELECT COUNT(*) AS n FROM base_forms WHERE token_hash IS NOT NULL').get() as { n: number }).n,
    anonymousCount: (db.prepare("SELECT COUNT(*) AS n FROM base_forms WHERE token_hash IS NOT NULL AND mode = 'anonymous'").get() as { n: number }).n,
  }));

  app.put('/admin/forms', {
    preHandler: guard('admin'),
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    schema: { tags: ['admin'], summary: 'Autoriser ou non les formulaires (désactivé par défaut ; désactiver révoque tous les liens)', body: z.object({ enabled: z.boolean() }).strict() },
  }, async (req) => {
    const { enabled } = req.body as { enabled: boolean };
    const revoked = setFormsEnabled(db, enabled, req.auth!.user.id);
    audit(db, req, 'settings.forms', null, { enabled, revoked });
    return { enabled, revoked };
  });

  // ---- Lien public -------------------------------------------------------------------------
  const hardened = (reply: FastifyReply) =>
    reply.header('cache-control', 'no-store').header('referrer-policy', 'no-referrer').header('x-robots-tag', 'noindex, nofollow');
  const notFound = (): never => { throw new HttpError(404, 'Formulaire introuvable ou fermé'); };
  // Mode comptes : une session web (un jeton d'API ne répond pas à un formulaire).
  const respondent = (req: FastifyRequest, mode: string) => {
    if (mode === 'anonymous') return null;
    if (!req.auth || req.auth.via !== 'session') throw new HttpError(401, 'Connectez-vous pour répondre à ce formulaire', { reason: 'login_required' });
    return req.auth;
  };
  const tokenOf = (req: FastifyRequest) => String((req.params as { token?: unknown }).token ?? '');

  app.get('/public/forms/:token', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute', keyGenerator: (req: FastifyRequest) => `form-view:${ipRateKey(req.ip)}` } },
    schema: { tags, summary: 'Formulaire public : configuration seulement (jamais de ligne)', params: tokenParams },
  }, async (req, reply) => {
    hardened(reply);
    const found = activeForm(db, tokenOf(req)) ?? notFound();
    respondent(req, found.form.mode);
    return { form: publicForm(found.form, found.questions), ticket: tickets.issue(found.form), minDelayMs: MIN_FILL_MS, ticketTtlMs: MAX_TICKET_AGE_MS };
  });

  app.post('/public/forms/:token', {
    bodyLimit: MAX_BODY_BYTES,
    // Par adresse IP seule (préfixe /64 en IPv6), tous formulaires confondus : changer de jeton ne donne pas de nouveau crédit.
    // Le plafond par formulaire et par base est tenu en base (writeResponse).
    config: { rateLimit: { max: SUBMIT_PER_MINUTE, timeWindow: '1 minute', keyGenerator: (req: FastifyRequest) => `form-submit:${ipRateKey(req.ip)}` } },
    schema: { tags, summary: 'Répondre à un formulaire (sans compte en mode anonyme)', params: tokenParams, body: submitBody },
  }, async (req, reply) => {
    hardened(reply);
    const found = activeForm(db, tokenOf(req)) ?? notFound();
    const { form, questions } = found;
    const who = respondent(req, form.mode);
    const b = req.body as z.output<typeof submitBody>;
    const thanks = { thanks: form.thanks };
    // Champ piège rempli : réponse identique à un succès, rien n'est écrit (un robot n'apprend rien).
    if (b.website !== undefined && b.website !== '') {
      const t = tickets.check(form, b.ticket);
      if (t.ok) tickets.consume(t.nonce);
      return reply.status(201).send(thanks);
    }
    const t = tickets.check(form, b.ticket);
    if (!t.ok) {
      throw t.reason === 'too_fast'
        ? new HttpError(400, 'Envoi trop rapide : patientez quelques secondes', { reason: 'too_fast', minDelayMs: MIN_FILL_MS })
        : new HttpError(400, 'Formulaire expiré : rechargez la page', { reason: 'ticket' });
    }
    const ctx: Ctx = { db, auth: who, spaces: new Set(who ? readableSpaceIds(db, req) : []), baseId: form.base_id, touched: new Set() };
    const vals = checkAnswers(ctx, form, questions, b.answers, who);
    const rowId = writeResponse(ctx, form, vals, who?.user.id ?? null);
    tickets.consume(t.nonce);
    const anonymous = who === null;
    reindexBase(db, form.base_id);
    touchBase(db, form.base_id, who?.user.id ?? null);
    bus.publish({ type: 'base.changed', spaceId: found.spaceId, pageId: form.base_id, by: who ? { id: who.user.id, name: who.user.name } : undefined });
    // Automatisations « ligne ajoutée » : toujours avec les droits de leur auteur (jamais ceux du répondant ni de l'anonyme).
    // Celui qui répond ne peut pas mettre une automatisation en pause (fromForm : plafonds sans pause, échecs non comptés).
    app.automations.rowWritten(form.base_id, rowId, null, who?.user.id ?? null, { anonymous, fromForm: true });
    // Notification regroupée au rédacteur (une non lue par base), sans contenu ; jamais le nom d'un répondant anonyme.
    if (form.notify && form.author_id) notifier.deliver(form.author_id, 'form', form.base_id, who?.user.id ?? null);
    // Audit : le volume, jamais le contenu ; une réponse anonyme ne garde ni compte ni adresse IP.
    audit(db, anonymous ? null : req, 'base.form.submit', form.base_id, { formId: form.id, anonymous });
    return reply.status(201).send(thanks);
  });
}
