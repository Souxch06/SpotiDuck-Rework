# Interface d'origine — code d'origine, repris tel quel

`spotiduck-original.js` est **le script de l'application d'origine**, pas une
réécriture. C'est l'interface que SpotiDuck utilisait au départ, récupérée telle
quelle dans la source publique déobfusquée `lyssadev/Spotifuck_src`.

## D'où vient ce fichier

L'application d'origine injecte son interface dans la page Spotify depuis
`onPageFinished` (`p000/C1356q3.java`). Cette méthode empile des morceaux de
chaîne, certains déchiffrés à l'exécution : le dépôt `Spotifuck_src` les a
décodés et reconstruits dans `FILES/js_deobfuscated/`.

Ce que nous assemblons, dans cet ordre, **sans réécrire une ligne** :

| Bloc | Source | Rôle |
| --- | --- | --- |
| 1 | `_player_full_classic.js` | Le script complet, **réglages d'origine** (`settings: classic`). C'est lui qui produit l'affichage d'origine : page Spotify *bureau* habillée pour le téléphone, barre du haut (accueil · bibliothèque · recherche), mini-lecteur rouge en bas, listes resserrées, accueil limité aux six premières rangées, bibliothèque qui s'ouvre en plein écran. |
| 2 | `C1356q3__04__….deobfuscated.js` (début) | `window.updMedia`, le rapporteur d'état que l'application d'origine injectait à part : c'est lui qui prévient Android du morceau en cours (notification, écran verrouillé). |
| 3 | ajout SpotiDuck | Un adaptateur `window.SpotiDuckUI` d'une quarantaine de lignes (balisé en clair dans le fichier) : les commandes de la notification appellent les fonctions d'origine (`actPlayPause`, `actSkipForward`…) au lieu de cliquer les boutons de Spotify. |

## L'identité de la coque (`spotiduck-identity.js`)

Le même `onPageStarted` porte une seconde chose : l'**identité** que la page lit
dans `navigator`. `spotiduck-identity.js` en reprend les valeurs telles
quelles — agent Chrome Windows, `platform` `Win32`, client hints (`brands`,
`mobile: false`, `platform: "Windows"`, x86 / 64 bits / Windows 10.0.0),
greffons, types MIME, chaînes GPU — **sans la géométrie** (ni `screen`, ni
`innerWidth`/`innerHeight`, ni `devicePixelRatio`) : la coque maison met la page
en page sur la largeur réelle du téléphone, alors que l'interface d'origine a
besoin, elle, de croire à un écran 1920×1080.

Sans ce script, la WebView annonce un agent Chrome Windows mais `navigator`
répond encore « Android » : c'est ce mélange que Spotify appelle « navigateur
non compatible », et il accompagne le message de lecture désactivée. Le script
est injecté avant la page, dans le mode livré par défaut ; `npm run build` et
`npm run sync:android` refusent de livrer si les valeurs d'identité manquent ou
si la géométrie y apparaît.

Les empreintes des blocs 1 et 2 sont écrites en tête du fichier, et
`tools/build-original.mjs` (`npm run build:original`) refuse de livrer si l'un
d'eux a changé, si la feuille de style d'origine n'est plus intacte
(6 001 caractères, md5 `13de5546d0…`) ou si une méthode du pont appelée par le
script manque côté Kotlin.

## Ce qui a été vérifié

- `npm run smoke` charge le script livré sur une page qui imite la page bureau
  de Spotify et vérifie l'affichage d'origine : feuille intacte, bouton de
  lecture d'origine posé dans la barre, bibliothèque plein écran, appels au
  pont (`cssInjected`, veille, arrêt auto), et l'adaptateur du service de
  lecture.
- `npm run audit` vérifie que l'asset livré vient bien de ce dossier et que
  l'application l'injecte en mode « original », avec l'agent bureau (c'est la
  page bureau de Spotify que ce script habille).

## Réglages de la WebView

Le mode « original » reprend les réglages de l'application d'origine
(`AppSingleton.m5774d()`) : agent Chrome bureau, `useWideViewPort`,
`loadWithOverviewMode`, `setInitialScale(100)`, zoom autorisé, et **aucun
`<meta name="viewport">` ajouté** — c'est la page qui décide de sa mise en page.
C'est la seule différence de configuration entre les trois interfaces :

| Mode | Agent | Script injecté | Viewport |
| --- | --- | --- | --- |
| `inject` (**défaut**) | Chrome bureau | `spotiduck-ui.js` (coque) + `spotiduck-identity.js` | posé par le script (couche en dp) |
| `original` | Chrome bureau | ce dossier | laissé à la page |
| `native` | Chrome Android | `native-mode.js` | posé par le script |

Le défaut est la page **bureau** — celle que le code d'origine reçoit — parce
que la page web **mobile** de Spotify (`mobile-web-player`) ne lit rien pour un
compte gratuit : elle répond « Lecture désactivée » (mesuré, §24 de
`docs/UI-REWORK.md`). C'est la seule différence de fond entre les trois
interfaces.
