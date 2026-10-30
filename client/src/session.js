// Session courante : identité, permissions et configuration publique de l'instance.
import { initNews, notifyNewsChange } from './news.js';
import { api, request, setCsrf } from './api.js';

export const session = {
  user: null,
  mfaSetupRequired: false,
  provider: null,
  permissions: { read: false, write: false, ai: false, admin: false },
  config: { auth: { oidc: false, devLogin: false, local: false, setupRequired: false, ldap: false, saml: false }, drawioUrl: null, ai: false },

  async load() {
    const [config, me] = await Promise.all([api.get('/config'), api.get('/me')]);
    this.config = config;
    this.user = me.user;
    this.mfaSetupRequired = !!me.mfaSetupRequired;
    this.provider = me.provider;
    this.version = me.version;
    this.reauthUntil = me.reauthUntil || 0;
    initNews(me.version);
    this.permissions = me.permissions;
    setCsrf(me.csrf);
    if (!this.permissions.admin) this.update = null;
    else if (this.update === undefined) this.refreshUpdate();
  },

  // Mise à jour disponible (administrateurs, si UPDATE_CHECK=true) : consultée une fois par chargement de la page, sans bloquer le démarrage.
  update: undefined,
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

  loginUrl(returnTo = `/${location.hash}`) {
    return `/auth/login?returnTo=${encodeURIComponent(returnTo)}`;
  },

  async devLogin(role) {
    const { redirect } = await request('POST', '/auth/dev-login', { role, returnTo: `/${location.hash}` });
    location.href = redirect;
  },

  async logout() {
    const { redirect } = await request('POST', '/auth/logout');
    location.href = redirect || '/';
  },
};
