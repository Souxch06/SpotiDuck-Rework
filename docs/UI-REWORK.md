# Refonte de l'interface mobile — SpotiDuck UI v2

Ce document décrit la nouvelle **couche d'interface** injectée dans la WebView
Spotify : ce qu'elle remplace, les bugs qu'elle corrige, comment l'intégrer à
l'application Android et comment la tester.

> Périmètre de cette étape : **uniquement l'interface**. L'autoplay, la
> détection de login, le crawl de la bibliothèque et le patch de `window.fetch`
> (voir « Ce qui reste à réintégrer » en fin de document) ne font pas partie de
> cette livraison.

---

## 1. Ce qui a été construit

| Fichier | Rôle |
| --- | --- |
| `src/inject/10-base.css` | Variables de design, réglages de viewport, **reprise en main du web player desktop** (top bar, sidebar, main view, pages, tracklists). |
| `src/inject/20-shell.css` | Le chrome SpotiDuck : barre d'onglets, mini-player, lecteur plein écran, feuille de file d'attente, paysage, accessibilité. |
| `src/inject/spotiduck-ui.js` | Le runtime : construit le chrome, lit l'état du web player, pilote la lecture, gère les gestes, parle à `AndBridge`. |
| `tools/build.mjs` | Concatène CSS + runtime → **`dist/spotiduck-ui.js`**, un seul fichier à injecter. |
| `demo/` | Banc d'essai : un faux web player Spotify (mêmes `data-testid`) + cadre téléphone. |
| `tools/smoke.mjs` | 22 tests de comportement (jsdom) sur le bundle réel. |
| `tools/screenshots.mjs` | Capture d'écran des écrans clés (nécessite Chrome/Chromium). |

```bash
npm run build            # génère dist/spotiduck-ui.js
npm run smoke            # lance les 20 tests
npm run demo             # http://localhost:5173 → aperçu dans un cadre téléphone
```

### Vue d'ensemble

```
┌──────────────────────────────┐
│  contenu de la page          │  #main-view (DOM de Spotify, restylé)
│                              │
├──────────────────────────────┤
│  mini-player                 │  .sd-mini      (pochette, titre, like,
│  ──────────────── 2px        │                 play/pause, suivant,
├──────────────────────────────┤                 ligne de progression)
│  Accueil · Rechercher · Biblio│ .sd-tabbar
└──────────────────────────────┘

Lecteur plein écran : feuille .sd-player (glisser vers le bas pour fermer)
Bibliothèque        : la sidebar de Spotify passée en plein écran (classe d'état)
File d'attente      : le panneau « Now playing view » de Spotify en feuille basse
```

---

## 2. Bugs d'interface corrigés

Chaque ligne est vérifiable : soit dans `demo/` (case « Désactiver la couche
SpotiDuck » pour comparer avant/après), soit en lisant le code de l'ancienne
couche (`_player_full_all_on.js` de Spotifuck, conservé comme référence).

| # | Bug constaté | Cause dans l'ancienne couche | Correctif |
| --- | --- | --- | --- |
| 1 | La barre système Android (gestes, navigation) **recouvre** la barre de lecture et le mini-player | Aucune gestion de `env(safe-area-inset-*)` | Variables `--sd-safe-*` + `padding` du viewport, testable via `?top=44&bottom=24` dans la démo |
| 2 | Le contenu passe **sous** les barres basses | Trois hauteurs magiques différentes (92 %, 88 %, 48 px) écrites en `cssText` | Une seule source : `--sd-bottom = mini + tabbar + safe-area`, appliquée en `padding-bottom` du `body` |
| 3 | Des **sections de l'accueil disparaissent** | `section:nth-child(n+7){display:none}` + `replaceChildren()` à chaque tick | Supprimé : plus aucune destruction de contenu |
| 4 | **Trou vertical ~350 px** dans l'accueil | Sections masquées mais toujours présentes dans la grille | Plus de sections fantômes ; espacement géré par le shell |
| 5 | Colonnes de tracklist **coupées à droite** (« Best trending South Indian… ») | `grid-template-columns` figées en `px` (`minmax(120px,…)`, colonne index de 46 px) | Grille fluide `44px · 1fr · auto`, colonnes secondaires masquées comme sur mobile |
| 6 | Champ de **recherche tronqué**, collé au logo | `form[role=search]{margin-left:48px;max-width:88%}` | Barre de recherche pleine largeur en flex, `:has()` pour débloquer un éventuel conteneur |
| 7 | Bibliothèque **désynchronisée**, bloquée à 92 %, en-tête `#666` | `switchLs()` réécrivait tout `style.cssText` + test `classList.length == 2` | Une classe d'état (`html.sd-tab-library`) + en-tête maison « Bibliothèque » |
| 8 | Sous-titres cassés « Playlist · 中 · OV32LO2D · 中 » | Un séparateur conservé pour chaque nœud de métadonnées | Un seul séparateur visible |
| 9 | **Halo/dégradé rouge** sur le lecteur (visible sur `fullscreen_player.png`) | `box-shadow:0 0 6px #440000` + `linear-gradient(#770000,#330000)` codés en dur | Dégradé dérivé de la pochette (Canvas), sobre, réinitialisé si l'extraction échoue |
| 10 | Interface « robotique », plus aucune animation | `*{transition:none!important}` global | Transitions ciblées + `prefers-reduced-motion` respecté |
| 11 | Boutons qui **ne répondent pas** pendant 5 s après le chargement | 4 boucles `setInterval(…, 2000/5000)` qui branchaient les écouteurs | `MutationObserver` + un seul `requestAnimationFrame` (10 fps) |
| 12 | État des boutons **désynchronisé** (like, répétition) | L'ancienne couche écrivait `isfav = true` / `repmode = 'mixed'` sans vérifier | Action optimiste **puis** relecture du DOM (0,5–1,2 s) → l'UI revient en arrière si Spotify refuse |
| 13 | Le bouton play/pause **ne bascule jamais** en français | Test `aria-label === 'Play'` | Listes de mots localisées + détection de forme du glyphe + `<video>` |
| 14 | **Seek ignoré** une fois sur deux, décalage d'1 s | `input.value = pos + 1` puis un seul `change` (React 18 peut l'ignorer) | Setter natif `HTMLInputElement.value` + `input` **et** `change`, avec clamp |
| 15 | Progression du mini-player **figée par sauts de 2 s** | État ré-extrait toutes les 2 s, jamais interpolé | Interpolation locale (`anchorPos` + `anchorAt`) et rafraîchissement à 10 fps |
| 16 | Position sur l'**écran verrouillé** en retard | `recMediaPosition` envoyé seulement si dérive > 4 s | Envoi périodique (15 s) pendant la lecture + à chaque action |
| 17 | Zones tactiles **trop petites** (taps manqués) | `transform: scale(1.3)` agrandit le dessin, pas la zone cliquable | Vraies cibles de 44–48 px (`--sd-tap`) |
| 18 | Tooltips **collés / coupés** | `[data-tippy-root]{overflow:hidden}` + `transform:none!important` | Tooltips désactivés au toucher (pas de survol sur mobile) |
| 19 | Thème clair illisible, fonds de pochette perdus | `--background-*` forcés à `#000` | Seules nos variables sont surchargées ; `sd-theme-light` géré |
| 20 | **Paysage** : la barre de lecture recouvre les icônes système | Aucune media query, largeurs en `vw` fixes | Media query paysage : chrome compact, lecteur en deux colonnes |
| 21 | Variables globales implicites (`playing`, `track`, `artist`, `pfint`…) | Affectations sans déclaration (mode non strict) | Portée module + un seul global `window.SpotiDuckUI` |
| 22 | Nœuds injectés **dans l'arbre React** de Spotify (supprimés au re-render) | `insertBefore` / `appendChild` dans des conteneurs gérés par React | Tout vit dans un seul `.sd-layer` ajouté à `document.body` |

---

## 3. Décisions de conception

**Le viewport, pas les scroll-containers.** Réserver la place des barres en
poussant un `padding` dans chaque conteneur scrollable de Spotify casse à chaque
redesign. Ici on rétrécit la zone applicative (`body { padding-bottom }`) :
tout l'interne de Spotify, qui est en `height:100%`, se réorganise seul.

**Aucune écriture dans le DOM de Spotify.** Le web player est une app React :
tout nœud inséré dans son arbre finit par être supprimé au render suivant. La
couche construit son propre arbre et ne fait que *lire* le DOM de Spotify.

**Sélecteurs candidats.** Chaque cible est une liste ordonnée
(`'aside button[data-testid="control-button-playpause"]'` → `'button[data-testid=…]'`),
donc une évolution du web player dégrade l'UI au lieu de la casser. Les
capacités optionnelles (paroles, appareils, file d'attente) sont **masquées**
quand Spotify ne les expose pas, au lieu d'afficher un bouton mort.

**Le pont Android est optionnel.** `Bridge.call()` vérifie
`typeof window.AndBridge[name] === 'function'` avant chaque appel : le même
bundle tourne dans un navigateur classique (c'est ce que fait la démo).

**Attention au viewport simulé.** Le wrapper force `window.innerWidth/Height`
à 1920×1080 pour obtenir la mise en page desktop. Le runtime ne lit donc
**jamais** `window.innerWidth` : il utilise
`document.documentElement.clientWidth/Height` (helpers `viewW()` / `viewH()`).
L'ancienne couche mélangeait les deux, d'où des mesures fausses sur tablette.

---

## 4. Contrat avec l'application Android

Le bundle est un seul fichier, à évaluer comme aujourd'hui après le chargement
de la page :

```kotlin
// MainActivity / WebViewClient.onPageFinished
val bundle = assets.open("spotiduck-ui.js").bufferedReader().use { it.readText() }
webView.evaluateJavascript(bundle, null)
```

Méthodes `@JavascriptInterface` appelées (toutes optionnelles) :

| Méthode | Quand | Remarque |
| --- | --- | --- |
| `recMediaStatus(json)` | à chaque changement de titre / lecture / like / répétition | **Clés inchangées** : `track`, `artist`, `playing`, `repeat` (`"false"` / `"true"` / `"mixed"`), `fav`, `duration`, `position`, `cover` |
| `recMediaPosition(ms)` | toutes les 15 s en lecture + à chaque action | alimente la progression de l'écran verrouillé |
| `playLoaded()` | quand le premier état de lecture est connu | équivalent à l'ancien appel |
| `cssInjected()` | une fois l'UI montée | l'app s'en sert comme signal « prêt » |
| `manageTShut(bool)` / `manageTSleep(bool)` | lecture / pause | veille et arrêt automatique |
| `wakeUp()` / `wakeOff()` / `isWoke()` | disponible pour la lecture en arrière-plan | non appelé par défaut |
| `deferMessage(str)` | disponible | utilisé par l'ancienne couche pour `reload` / `unlock` |

Tout le reste (notification, media session, widgets, Android Auto) reste côté
natif : **rien à modifier côté Kotlin/Java** pour cette refonte.

Réglages exposés à chaud (persistés dans `localStorage['sd.ui.settings']`) :

```js
window.SpotiDuckUI.set("theme", "auto" | "dark" | "light");
window.SpotiDuckUI.set("accentFromArt", true | false);
window.SpotiDuckUI.set("haptics", true | false);
window.SpotiDuckUI.set("tabbar", true | false);
SpotiDuckUI.openPlayer(); SpotiDuckUI.closePlayer(); SpotiDuckUI.openQueue();
SpotiDuckUI.state;        // { title, artist, playing, position, duration, … }
```

---

## 5. Ce qui reste à réintégrer (hors périmètre « interface »)

Ces blocs existaient dans l'ancien script injecté et ne sont **pas** dans cette
livraison :

1. **Autoplay / « Take Control »** — la boucle qui clique sur « Take Control »
   puis relance la lecture après une pause subie.
2. **Détection de login** — le lien `?allow_password=1` et l'appel
   `loginDetected()`.
3. **Patch de `window.fetch`** — capture de `spotDevId`, `spotCliToken`,
   `spotAuthToken`, `playFromUri()` (lecture d'un URI depuis Android) et la
   gestion du 404 `connect-state` (déverrouillage par `reload`).
4. **Crawl de la bibliothèque** (`fetchAllLibrary` / `parseLibrary` /
   `mediaLib`) — utile si l'app veut une liste de bibliothèque native un jour.
5. **Flux « unlock »** (pause maintenue → skip + `deferMessage('unlock')`).

Ils doivent être remis dans un module séparé (`src/inject/…`), sans repasser
par des variables globales ni par `document.body` directement.

---

## 6. Limites connues

- Le DOM réel du web player n'a pas pu être testé depuis cet environnement :
  les sélecteurs sont des **listes de candidats** issues du code de Spotifuck
  (`_player_full_all_on.js`) et reproduites à l'identique dans
  `demo/mock/spotify.js`. Un passage sur appareil est nécessaire pour figer les
  derniers détails (notamment les nœuds du hero de page et la grille d'accueil).
- L'extraction de la couleur dominante dépend de l'en-tête CORS de
  `i.scdn.co` ; en cas d'échec la teinte est dérivée du nom du titre
  (aucune image bloquée, aucun fond noir).
- La file d'attente et les paroles ne sont pas réimplémentées : on ouvre les
  panneaux de Spotify, donc ils restent fonctionnels même si leur style évolue.
- Les vidéos (podcasts) gardent le lecteur vidéo du web player.

---

## 7. Tests

```
npm run smoke
```

Couvre, sur le bundle réellement livré : namespace unique, absence de fuites de
variables globales, construction hors de l'arbre React, les trois onglets, la
navigation, la synchro du mini-player, play/pause, like, répétition, aléatoire,
le seek (setter natif), le swipe, l'ouverture/fermeture du lecteur par
glissement, la file d'attente, le suivi `manageTShut`/`manageTSleep` quand la
lecture démarre ou s'arrête, l'extinction possible de la barre d'onglets,
l'absence de `setInterval`, et le **payload `AndBridge` figé**
(clés `artist,cover,duration,fav,playing,position,repeat,track`).

`tools/screenshots.mjs` produit en plus 13 captures (`shots/`) : accueil avant /
après, mini-player, lecteur, file d'attente, bibliothèque, recherche, page de
playlist, encoches simulées, paysage, petit écran. Il nécessite Chrome ou
Chromium (`npm i -D puppeteer-core @sparticuz/chromium`) : cet environnement
d'exécution ne permet pas de lancer un navigateur, les captures restent donc à
générer sur une machine avec Chrome.
