// Configuration modifiable depuis l'interface (admin) : intégration portfolio, OIDC, LDAP, SAML, SMTP.
// Chaque écriture exige une nouvelle preuve d'identité, un test de connexion réussi (sauf intégration) et laisse une trace d'audit.
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { guard } from '../auth/context.js';
import { type ClientFactory, LdapDirectory } from '../auth/ldap.js';
import { probeOidc } from '../auth/oidc.js';
import { samlFor } from '../auth/saml.js';
import { audit } from '../lib/audit.js';
import { HttpError } from '../lib/http.js';
import { mails } from '../lib/mail.js';
import { reauthInput, requireReauth } from '../lib/reauth.js';
import { SECTION_NAMES, SettingsError, type SectionName } from '../lib/runtime-settings.js';

const strict = { rateLimit: { max: 10, timeWindow: '1 minute' } };
const TEST_TTL = 10 * 60_000;
const needsTest = (section: SectionName) => section !== 'embed';

const sectionParams = z.object({ section: z.enum(SECTION_NAMES as [SectionName, ...SectionName[]]) });
const writeBody = z.object({
  config: z.object({ enabled: z.boolean() }).passthrough(),
  // undefined : secret inchangé ; chaîne vide : secret supprimé.
  secrets: z.record(z.string(), z.string().max(4000)).default({}),
  reauth: reauthInput,
  testId: z.string().max(100).optional(),
});

const canonical = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as object).sort(([a], [b]) => a.localeCompare(b))) : x));

export default async function settingsRoutes(app: FastifyInstance, opts: { ldapFactory?: ClientFactory } = {}) {
  const { db, rt } = app;
  const tags = ['admin'];
  // Tests réussis : empreinte (utilisateur + section + contenu exact) -> expiration. Valable une fois.
  const passed = new Map<string, number>();
  const fingerprint = (userId: string, section: SectionName, body: z.output<typeof writeBody>) =>
    createHash('sha256').update(canonical([userId, section, body.config, body.secrets])).digest('hex');
  const sweep = () => { const now = Date.now(); for (const [k, exp] of passed) if (exp < now) passed.delete(k); };

  const adminSession = (req: Parameters<ReturnType<typeof guard>>[0]) => {
    if (req.auth?.via !== 'session') throw new HttpError(403, 'Disponible uniquement depuis l’interface web');
    return req.auth;
  };
  const wrap = <T>(fn: () => T): T => {
    try { return fn(); } catch (err) {
      if (err instanceof SettingsError) throw new HttpError(err.status, err.message);
      throw err;
    }
  };
  const secretsOf = (section: SectionName, input: Record<string, string>) => {
    const allowed = new Set(Object.keys(rt.view(section).secrets));
    for (const k of Object.keys(input)) if (!allowed.has(k)) throw new HttpError(400, `secret inconnu : ${k}`);
    return input as Record<string, string | undefined>;
  };

  app.get('/admin/settings', { preHandler: guard('admin'), schema: { hide: true } }, async (req) => {
    adminSession(req);
    return {
      locked: rt.locked,
      mailEnabled: app.mail.enabled,
      redirectUris: { oidc: `${app.config.PUBLIC_URL}/auth/callback`, samlAcs: `${app.config.PUBLIC_URL}/auth/saml/callback`, samlMetadata: `${app.config.PUBLIC_URL}/auth/saml/metadata` },
      sections: Object.fromEntries(SECTION_NAMES.map((s) => [s, rt.view(s)])),
    };
  });

  // Test de connexion avec la configuration saisie (non enregistrée).
  app.post('/admin/settings/:section/test', { preHandler: guard('admin'), config: strict, schema: { hide: true, params: sectionParams, body: writeBody } }, async (req) => {
    const auth = adminSession(req);
    const { section } = req.params as z.output<typeof sectionParams>;
    const body = req.body as z.output<typeof writeBody>;
    await requireReauth(app, req, body.reauth);
    if (!needsTest(section) || !body.config.enabled) return { ok: true, message: 'Aucun test nécessaire.', testId: null };
    const cfg = wrap(() => rt.candidate(section, body.config, secretsOf(section, body.secrets)));
    let message: string;
    try {
      if (section === 'oidc') {
        const r = await probeOidc(cfg);
        message = `Fournisseur joint (${r.issuer}). Points d’accès : ${r.endpoints.join(', ')}. La connexion complète sera vérifiée à la première authentification.`;
      } else if (section === 'ldap') {
        await new LdapDirectory(cfg, opts.ldapFactory).test();
        message = 'Liaison avec le compte de service réussie et racine de recherche lisible.';
      } else if (section === 'saml') {
        const saml = samlFor(cfg);
        saml.generateServiceProviderMetadata(null, null);
        const res = await fetch(cfg.SAML_ENTRY_POINT!, { redirect: 'manual', signal: AbortSignal.timeout(6000) });
        if (res.status >= 500) throw new Error(`le point d’entrée répond ${res.status}`);
        message = 'Certificat valide et point d’entrée joignable.';
      } else {
        await app.mail.verify(cfg);
        message = 'Connexion SMTP et authentification réussies (aucun message envoyé).';
      }
    } catch (err) {
      audit(db, req, 'settings.test.failed', section);
      return { ok: false, message: String((err as Error).message || 'échec').slice(0, 300), testId: null };
    }
    sweep();
    const id = fingerprint(auth.user.id, section, body);
    passed.set(id, Date.now() + TEST_TTL);
    audit(db, req, 'settings.test', section);
    return { ok: true, message, testId: id };
  });

  app.put('/admin/settings/:section', { preHandler: guard('admin'), config: strict, schema: { hide: true, params: sectionParams, body: writeBody } }, async (req) => {
    const auth = adminSession(req);
    const { section } = req.params as z.output<typeof sectionParams>;
    const body = req.body as z.output<typeof writeBody>;
    if (rt.locked) throw new HttpError(409, 'Configuration verrouillée par l’environnement (CONFIG_LOCKED).');
    await requireReauth(app, req, body.reauth);
    if (needsTest(section) && body.config.enabled) {
      const id = fingerprint(auth.user.id, section, body);
      const exp = passed.get(id);
      if (!exp || exp < Date.now() || body.testId !== id) throw new HttpError(409, 'Testez la connexion avec cette configuration avant de l’enregistrer.');
      passed.delete(id);
    }
    const view = wrap(() => rt.save(section, body.config, secretsOf(section, body.secrets), auth.user.id));
    audit(db, req, `settings.${section}`, section, { enabled: view.enabled, secretsChanged: Object.keys(body.secrets) });
    return view;
  });

  // Retour aux valeurs de l'environnement.
  app.post('/admin/settings/:section/reset', { preHandler: guard('admin'), config: strict, schema: { hide: true, params: sectionParams, body: z.object({ reauth: reauthInput }) } }, async (req) => {
    adminSession(req);
    const { section } = req.params as z.output<typeof sectionParams>;
    await requireReauth(app, req, (req.body as { reauth: z.output<typeof reauthInput> }).reauth);
    wrap(() => rt.reset(section));
    audit(db, req, 'settings.reset', section);
    return rt.view(section);
  });

  // Message de test envoyé à l'adresse de l'administrateur connecté.
  app.post('/admin/settings/smtp/send-test', { preHandler: guard('admin'), config: strict, schema: { hide: true, body: z.object({ reauth: reauthInput }) } }, async (req) => {
    const auth = adminSession(req);
    await requireReauth(app, req, (req.body as { reauth: z.output<typeof reauthInput> }).reauth);
    if (!app.mail.enabled) throw new HttpError(409, 'SMTP non configuré');
    if (!auth.user.email) throw new HttpError(400, 'Votre compte n’a pas d’adresse e-mail');
    try {
      await app.mail.send({ to: auth.user.email, ...mails.alert('Ceci est un message de test envoyé depuis les paramètres de Notabene.') });
    } catch (err) {
      throw new HttpError(502, `Envoi impossible : ${String((err as Error).message).slice(0, 200)}`);
    }
    audit(db, req, 'settings.smtp.test-mail', auth.user.id);
    return { ok: true };
  });
}
