// Envoi d'e-mails via SMTP (nodemailer) : TLS obligatoire (STARTTLS exigé ou TLS direct), texte brut uniquement.
import nodemailer from 'nodemailer';
import type { Config } from '../config.js';

export interface Mail { to: string; subject: string; text: string }

const oneLine = (v: string) => v.replace(/[\r\n]+/g, ' ').trim();

/**
 * Nom inséré dans un e-mail envoyé à une adresse extérieure (lien d'espace) : sans URL ni adresse e-mail (un nom d'espace ou de
 * personne ne doit pas servir à faire passer un lien d'hameçonnage), sur une ligne, sans caractère de contrôle, 60 caractères
 * au plus ; `fallback` s'il ne reste rien.
 */
export function cleanMailName(v: string, fallback: string): string {
  const out = v.slice(0, 500)
    .replace(/https?:\/\/\S*/gi, ' ')
    .replace(/www\.\S*/gi, ' ')
    .replace(/\S*@\S*/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
    .trim();
  return out || fallback;
}

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
    subject: 'BeNote : réinitialisation de votre mot de passe',
    text: `Une réinitialisation de mot de passe a été demandée pour votre compte BeNote.\n\nOuvrez ce lien (valable ${minutes} minutes, utilisable une seule fois) :\n${url}\n\nSi vous n'êtes pas à l'origine de cette demande, ignorez ce message : votre mot de passe reste inchangé.`,
  }),
  invite: (url: string, hours: number, name: string): Omit<Mail, 'to'> => ({
    subject: 'BeNote : invitation à rejoindre le wiki',
    text: `Bonjour ${oneLine(name)},\n\nUn compte BeNote a été créé pour vous. Choisissez votre mot de passe via ce lien (valable ${hours} heures, utilisable une seule fois) :\n${url}\n`,
  }),
  notification: (subject: string, text: string): Omit<Mail, 'to'> => ({
    subject,
    text: `${text}\n\nVous pouvez régler ces e-mails dans Paramètres > Profil > Notifications.`,
  }),
  // Lien de partage d'un espace : sujet fixe ; le corps ne contient que le nom de l'espace, celui de l'expéditeur, le lien et
  // l'expiration (jamais de contenu de page ni de texte libre saisi au moment de l'envoi).
  spaceShare: (url: string, spaceName: string, sender: string, expiresAt: number | null): Omit<Mail, 'to'> => ({
    subject: 'BeNote : un espace a été partagé avec vous',
    text: `${cleanMailName(sender, 'Un gestionnaire')} vous a partagé l'espace « ${cleanMailName(spaceName, 'un espace partagé')} » de BeNote, en lecture seule.\n\nOuvrir l'espace : ${url}\n`
      + (expiresAt !== null ? `\nCe lien expire le ${new Date(expiresAt).toLocaleDateString('fr-FR', { timeZone: 'UTC' })}.\n` : '')
      + `\nCe lien est personnel : ne le transférez pas. Si vous n'attendiez pas ce message, ignorez-le.`,
  }),
  alert: (what: string): Omit<Mail, 'to'> => ({
    subject: 'BeNote : alerte de sécurité sur votre compte',
    text: `${what}\n\nSi vous n'êtes pas à l'origine de cette action, contactez un administrateur sans attendre.`,
  }),
};
