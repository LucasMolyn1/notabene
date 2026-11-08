# Déploiement isolé (sans accès à Internet)

BeNote peut tourner sur un réseau sans aucune route vers l'extérieur. Cette page décrit la marche à suivre et ce que la CI prouve, et ce qu'elle ne prouve pas.

## Ce qui est vérifié

À chaque modification, le job `isole` de la CI :

1. lance l'image sur un réseau Docker `--internal` (aucune route vers l'extérieur) ;
2. exécute un parcours (connexion, création d'un espace et d'une page, recherche, configuration) depuis un autre conteneur du même réseau ;
3. charge dans l'application une sonde (`scripts/isolated/egress-probe.cjs`) qui signale toute connexion ou résolution DNS vers une adresse qui n'est ni locale ni privée, et échoue s'il y en a une ;
4. vérifie la sonde elle-même avec un témoin positif : une tentative volontaire vers `example.com` doit être signalée et échouer.

**Limites** : le test couvre le serveur avec ses réglages par défaut et ce parcours. Il ne couvre pas les fonctions qui ont besoin d'un service extérieur par nature (fournisseur d'IA distant, SMTP, SSO, webhooks) : voir plus bas. Il ne teste pas le navigateur ; le code du client ne contient aucune adresse extérieure.

## Installer sans Internet

1. **Sur une machine connectée**, récupérer l'image à la version voulue (idéalement épinglée par digest) et l'exporter :
   ```bash
   docker pull ghcr.io/lucasmolyn1/notabene:3.13.1
   docker save ghcr.io/lucasmolyn1/notabene:3.13.1 -o notabene-3.13.1.tar
   sha256sum notabene-3.13.1.tar
   ```
   Si vous utilisez Draw.io, exportez aussi son image (celle de `docker-compose.yml`).
2. **Transférer** le fichier (média amovible, passerelle contrôlée) et **vérifier l'empreinte** à l'arrivée.
3. **Sur le réseau isolé** :
   ```bash
   docker load -i notabene-3.13.1.tar
   ```
4. Copier `docker-compose.isole.yml` et `.env.example` en `.env`, renseigner `NOTABENE_IMAGE=ghcr.io/lucasmolyn1/notabene:3.13.1`, `PUBLIC_URL`, `ENCRYPTION_KEY`, puis `docker compose -f docker-compose.isole.yml up -d`. L'installation se poursuit comme dans [INSTALLATION.md](INSTALLATION.md).

## Réglages à connaître

- **Vérification de mise à jour** : désactivée par défaut (`UPDATE_CHECK=false`). Le service de mise à jour de l'hôte interroge GitHub : ne l'installez pas sur un réseau isolé. Mettez à jour en transférant la nouvelle image, en lisant d'abord le CHANGELOG et [MISE-A-JOUR.md](MISE-A-JOUR.md) (sauvegarde avant, migrations irréversibles).
- **IA** : un fournisseur distant est impossible. Utilisez un modèle local (Ollama sur le même réseau interne), avec `AI_ALLOW_PRIVATE=true` ; voir [IA.md](IA.md). Sans fournisseur, les fonctions IA restent simplement inactives.
- **SSO (OIDC, SAML, LDAP)** : le fournisseur d'identité doit être joignable depuis le réseau isolé (par exemple Authentik interne).
- **E-mail** : un relais SMTP interne ; sinon les notifications par e-mail et la réinitialisation de mot de passe par e-mail ne fonctionnent pas.
- **Webhooks et SIEM** : uniquement vers des adresses internes, avec `WEBHOOK_ALLOW_PRIVATE=true`.
- **Draw.io** : l'image auto-hébergée convient ; ne laissez pas de profil qui irait chercher des services de stockage en ligne (le compose du dépôt les désactive).
- **Imports et intégrations** : un contenu intégré (vidéo, site) ou une image distante référencée dans une page est chargé **par le navigateur** : sur un réseau isolé il ne s'affichera pas.

## Vérifier chez vous

```bash
docker network create --internal test-iso
docker run --rm --network test-iso --entrypoint node ghcr.io/lucasmolyn1/notabene:3.13.1 \
  -e "fetch('http://example.com').then(() => console.log('SORTIE POSSIBLE'), () => console.log('pas de sortie'))"
```

Le résultat attendu est `pas de sortie`. Le même contrôle dans le dépôt : `.github/workflows/ci.yml`, job `isole`.
