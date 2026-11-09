# Démonstration filmée

Script rejouable qui filme un parcours de Notabene (BeNote) et produit deux fichiers : un MP4 complet et un GIF court. Il n'est pas dans le `testDir` des e2e : ni la CI ni `npx playwright test` ne le lancent.

## Lancer

```sh
npm run demo:gif              # sans IA
DEMO_IA_CLE=... npm run demo:gif -- --avec-ia   # avec les étapes IA
```

Prérequis : `ffmpeg` dans le `PATH`, Chromium de Playwright installé (`npx playwright install chromium`).

Variables des étapes IA (fournisseur compatible OpenAI) : `DEMO_IA_CLE` (obligatoire avec `--avec-ia`, jamais écrite dans un fichier), `DEMO_IA_URL` (défaut `https://ollama.com/v1`), `DEMO_IA_MODELE` (défaut `beam` ; `gemma4:31b` répond plus vite et sans résidu de format).

## Ce que fait le script

1. `npm run build`, puis un serveur local sur le port 3200 avec une base neuve dans le dossier temporaire du système (`notabene-demo-gif/data`, effacé à chaque lancement).
2. Environnement minimal transmis au serveur : aucune variable du poste. `ENCRYPTION_KEY` et le mot de passe administrateur sont tirés au hasard à chaque lancement ; `SEED_DEMO=false`.
3. Comptes fictifs sur le domaine réservé `demo.test` (Camille Durand, administratrice ; Léa Bernard, éditrice) et contenu créé par l'API : espace « Équipe Produit », arborescence, base « Feuille de route ». Avec `--avec-ia`, le fournisseur est réglé par l'API d'administration.
4. Parcours filmé en Chromium, 1440 x 810, thème clair, `fr-FR`, avec une flèche de souris et une légende par étape : arborescence, recherche `Ctrl+K`, menu `/` (callout, Mermaid, code), co-édition à deux curseurs, commentaire ancré avec mention, assistant de rédaction (IA), `/kanban` et déplacement d'une carte, question à la documentation (IA), lien public, puis la même page à 375 px.
5. Conversion `ffmpeg` : les attentes du modèle sont accélérées.

## Sorties

`tools/demo-gif/out/` (ignoré par git) : `notabene-demo.mp4` (complet, 1440 px), `notabene-demo.gif` (scènes clés, 960 px) et les deux vidéos sources. Le GIF du README est une copie dans `docs/images/` ; le MP4 du README est une copie dans `docs/images/` (GitHub l'ouvre avec un lecteur vidéo).
