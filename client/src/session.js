// Session courante : identité, permissions et configuration publique de l'instance.
import { initNews, notifyNewsChange } from './news.js';
import { api, request, setCsrf } from './api.js';

export const session = {
  user: null,
  mfaSetupRequired: false,
  provider: null,
  permissions: { read: false, write: false, ai: false, admin: false },
  aiProvider: null,
  config: { auth: { oidc: false, devLogin: false, local: false, setupRequired: false, ldap: false, saml: false, providers: [] }, drawioUrl: null, embedHosts: [], ai: false },

  async load() {
    const [config, me] = await Promise.all([api.get('/config'), api.get('/me')]);
    this.config = config;
    this.user = me.user;
    this.mfaSetupRequired = !!me.mfaSetupRequired;
    this.provider = me.provider;
    this.version = me.version;
    this.avatars = me.user ? await api.get('/users/avatars').catch(() => ({})) : {}; // qui a une photo (identifiant → date)
    this.reauthUntil = me.reauthUntil || 0;
    initNews(me.version);
    this.permissions = me.permissions;
    this.aiProvider = me.aiProvider || null; // destinataire du texte envoyé à l'assistant de rédaction
    setCsrf(me.csrf);
    if (!this.permissions.admin) this.update = null;
    else if (this.update === undefined) this.refreshUpdate();
  },

  // Mise à jour disponible (administrateurs, si UPDATE_CHECK=true) : consultée une fois par chargement de la page, sans bloquer le démarrage.
  update: undefined,
  avatars: {},
  async refreshUpdate() {
    this.update = null;
    try {
      this.update = await api.get('/admin/update-check');
    } catch { /* GitHub injoignable ou droits insuffisants : pas d'alerte */ }
    notifyNewsChange();
  },
  get updateAvailable() { return !!this.update?.updateAvailable; },
  reauthUntil: 0,

  can(permission) {
    return !!this.permissions[permission];
  },

  loginUrl(returnTo = location.pathname) {
    return `/auth/login?returnTo=${encodeURIComponent(returnTo)}`;
  },

  // Fournisseurs OIDC secondaires (Google…) annoncés par le serveur. Seules les adresses relatives sous /auth/ sont retenues.
  extraProviders() {
    const list = Array.isArray(this.config.auth?.providers) ? this.config.auth.providers : [];
    return list.filter((p) => p && p.id !== 'principal' && typeof p.label === 'string' && typeof p.loginUrl === 'string' && /^\/auth\/[a-z0-9/_-]+$/i.test(p.loginUrl));
  },

  providerLoginUrl(p, returnTo = location.pathname) {
    return `${p.loginUrl}?returnTo=${encodeURIComponent(returnTo)}`;
  },

  // Vrai si au moins une méthode de connexion est proposée.
  hasLogin() {
    const { oidc, devLogin, local, ldap, saml } = this.config.auth;
    return !!(oidc || devLogin || local || ldap || saml || this.extraProviders().length);
  },

  // Lien « Se connecter » : un seul fournisseur (le principal) et aucune autre méthode : on y va directement ; sinon l'écran de
  // connexion propose les méthodes (SSO, Google, compte local…).
  loginEntry(returnTo = location.pathname) {
    const { oidc, devLogin, local, ldap, saml } = this.config.auth;
    const several = [oidc, devLogin, local, ldap, saml].filter(Boolean).length + this.extraProviders().length > 1;
    return oidc && !several ? this.loginUrl(returnTo) : `/?login&returnTo=${encodeURIComponent(returnTo)}`;
  },

  // Adresse de reconnexion (action sensible) pour un compte fédéré OIDC ; null pour les autres comptes.
  reauthUrl(returnTo = location.pathname) {
    const q = `reauth=1&returnTo=${encodeURIComponent(returnTo)}`;
    if (this.provider === 'oidc') return `/auth/login?${q}`;
    if (this.provider === 'google') return `/auth/oidc/google/login?${q}`;
    return null;
  },

  async devLogin(role) {
    const { redirect } = await request('POST', '/auth/dev-login', { role, returnTo: location.pathname });
    location.href = redirect;
  },

  async logout() {
    const { redirect } = await request('POST', '/auth/logout');
    location.href = redirect || '/';
  },
};
