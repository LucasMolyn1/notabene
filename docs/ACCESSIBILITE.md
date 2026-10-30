# Accessibilité

Objectif : WCAG 2.1 niveau AA.

## Ce qui est vérifié automatiquement

`e2e/a11y.spec.ts` passe axe-core (règles WCAG 2.1 A et AA) sur la connexion, une page, la palette de recherche, le menu de page et les 17 sections des paramètres, en thème clair et sombre. Il tourne dans la CI : une régression de contraste, un libellé manquant ou un rôle ARIA invalide fait échouer la build.

Ce contrôle ne remplace pas un test humain : il ne détecte qu'une partie des problèmes (ordre de lecture, annonces incohérentes, pièges de focus).

## Test au lecteur d'écran (à faire à la main)

Ce test n'a pas été réalisé : il demande un lecteur d'écran réel. À faire avant une version majeure, avec **VoiceOver** (macOS, Cmd+F5) ou **NVDA** (Windows, gratuit), clavier seul.

| Parcours | À vérifier |
| --- | --- |
| Connexion | Les champs sont annoncés avec leur nom ; une erreur est lue sans chercher à l'écran. |
| Navigation | « Aller au contenu » est le premier arrêt ; l'arborescence s'annonce comme un arbre (niveau, déplié ou replié) et se parcourt aux flèches. |
| Recherche (Ctrl/Cmd+K) | Le focus arrive dans le champ ; les résultats sont annoncés pendant les flèches ; Échap rend le focus. Les espaces repliables annoncent leur état. |
| Lecture d'une page | Titres hiérarchisés, tableaux lus cellule par cellule, images avec texte alternatif. |
| Édition | L'éditeur est annoncé comme « Contenu de la page, zone de texte » ; le menu `/` et les menus de format sont atteignables au clavier. |
| Blocs redimensionnables | La poignée est annoncée « Largeur : … » ; les flèches gauche et droite modifient la largeur. |
| Dialogues et menus | Le focus entre dans le dialogue, y reste, et revient au déclencheur à la fermeture. |
| Notifications | La cloche annonce le nombre de nouveautés ; une action (enregistrement, erreur) est annoncée. |
| Paramètres | Chaque section est atteignable ; les interrupteurs et listes ont un nom. |

Consigner pour chaque ligne : lecteur et version, navigateur, résultat, anomalie. Une anomalie confirmée se corrige, puis se couvre par un contrôle dans `e2e/a11y.spec.ts` si axe peut le détecter.

## Autres vérifications à la main

- Zoom à 200 % : rien ne se chevauche ni ne sort de l'écran.
- Mode « réduire les animations » du système : aucune animation essentielle.
- Navigation au clavier seul, sans souris, sur chaque écran modifié.
