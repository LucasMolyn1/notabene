// Envoi d'e-mails via SMTP (nodemailer) : TLS obligatoire (STARTTLS exigé ou TLS direct), texte brut uniquement.
import nodemailer from 'nodemailer';
import type { Config } from '../config.js';

export interface Mail { to: string; subject: string; text: string }

const oneLine = (v: string) => v.replace(/[\r\n]+/g, ' ').trim();

export class Mailer {
  constructor(private readonly getCfg: () => Config) {}

  get enabled() {
    const c = this.getCfg();
    return !!(c.SMTP_HOST && c.SMTP_FROM);
  }

  #transport(c: Config) {
    return nodemailer.createTransport({
      host: c.SMTP_HOST,
      port: c.SMTP_PORT,
      secure: c.SMTP_MODE === 'tls',
      requireTLS: c.SMTP_MODE === 'starttls',
      auth: c.SMTP_USER ? { user: c.SMTP_USER, pass: c.SMTP_PASSWORD ?? '' } : undefined,
      tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
      connectionTimeout: 8000,
      greetingTimeout: 8000,
      socketTimeout: 15_000,
      disableFileAccess: true,
      disableUrlAccess: true,
    });
  }

  // Vérifie la connexion et l'authentification sans envoyer de message.
  async verify(cfg: Config = this.getCfg()): Promise<void> {
    if (!cfg.SMTP_HOST) throw new Error('SMTP non configuré');
    await this.#transport(cfg).verify();
  }

  async send(mail: Mail, cfg: Config = this.getCfg()): Promise<void> {
    if (!cfg.SMTP_HOST || !cfg.SMTP_FROM) throw new Error('SMTP non configuré');
    await this.#transport(cfg).sendMail({ from: cfg.SMTP_FROM, to: oneLine(mail.to), subject: oneLine(mail.subject), text: mail.text });
  }
}

// Modèles de messages (texte brut, aucun contenu fourni par un tiers hors prénom/nom déjà validé).
export const mails = {
  reset: (url: string, minutes: number): Omit<Mail, 'to'> => ({
    subject: 'Notabene : réinitialisation de votre mot de passe',
    text: `Une réinitialisation de mot de passe a été demandée pour votre compte Notabene.\n\nOuvrez ce lien (valable ${minutes} minutes, utilisable une seule fois) :\n${url}\n\nSi vous n'êtes pas à l'origine de cette demande, ignorez ce message : votre mot de passe reste inchangé.`,
  }),
  invite: (url: string, hours: number, name: string): Omit<Mail, 'to'> => ({
    subject: 'Notabene : invitation à rejoindre le wiki',
    text: `Bonjour ${oneLine(name)},\n\nUn compte Notabene a été créé pour vous. Choisissez votre mot de passe via ce lien (valable ${hours} heures, utilisable une seule fois) :\n${url}\n`,
  }),
  notification: (subject: string, text: string): Omit<Mail, 'to'> => ({
    subject,
    text: `${text}\n\nVous pouvez régler ces e-mails dans Paramètres > Profil > Notifications.`,
  }),
  alert: (what: string): Omit<Mail, 'to'> => ({
    subject: 'Notabene : alerte de sécurité sur votre compte',
    text: `${what}\n\nSi vous n'êtes pas à l'origine de cette action, contactez un administrateur sans attendre.`,
  }),
};
