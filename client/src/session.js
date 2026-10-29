// Session courante : identité, permissions et configuration publique de l'instance.
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
    this.permissions = me.permissions;
    setCsrf(me.csrf);
  },

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
