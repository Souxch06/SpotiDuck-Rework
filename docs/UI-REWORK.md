# Refonte de l'interface mobile — SpotiDuck UI v2.3

Ce document décrit la nouvelle **couche d'interface** injectée dans la WebView
Spotify : ce qu'elle remplace, les bugs qu'elle corrige, comment l'intégrer à
l'application Android et comment la tester.

> Périmètre : **l'interface, complète et fonctionnelle**. La v2.0 livrait la
> coque visuelle ; la v2.1 y ajoute les fonctionnalités de l'ancienne couche
> (prise de contrôle de la lecture, connexion, déblocage, veille) et les écrans
> qui manquaient (menu d'options, paramètres, retour matériel). La **v2.3**
> livre l'application installable : wrapper Android (`android/`) + APK signé
> produit par la CI, et une passe de durcissement issue de l'audit
> d'interface (section 8). Voir « Ce qui reste à réintégrer » pour les deux
> seuls blocs volontairement hors périmètre.

---

## 1. Ce qui a été construit

| Fichier | Rôle |
| --- | --- |
| `src/inject/10-base.css` | Variables de design, réglages de viewport, **reprise en main du web player desktop** (top bar, sidebar, main view, pages, tracklists). |
| `src/inject/20-shell.css` | Le chrome SpotiDuck : barre d'onglets, mini-player, lecteur plein écran, feuille de file d'attente, paysage, accessibilité. |
| `src/inject/30-sheets.css` | Feuilles basses (options + paramètres), page de connexion, bandeau hors ligne, retours tactiles, animations réduites. |
| `src/inject/spotiduck-ui.js` | Le runtime : construit le chrome, lit l'état du web player, pilote la lecture, gère les gestes, les panneaux, la connexion, et parle à `AndBridge`. |
| `tools/build.mjs` | Concatène CSS + runtime → **`dist/spotiduck-ui.js`**, un seul fichier à injecter. |
| `demo/` | Banc d'essai : un faux web player Spotify (mêmes `data-testid`), cadre téléphone et **scénarios** (transfert, connexion, hors ligne). |
| `src/inject/40-audit.css` | Durcissement de l'interface : cibles tactiles ≥ 44 px, débordements, en-têtes collants, modales natives, clavier, contraste, focus, mouvement réduit (section 8). |
| `tools/smoke.mjs` | 34 tests de comportement (jsdom) sur le bundle réel. |
| `tools/screenshots.mjs` | Capture d'écran des écrans clés (nécessite Chrome/Chromium). |

```bash
npm run build            # génère dist/spotiduck-ui.js
npm run smoke            # lance les 34 tests
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
Menu « … »          : feuille .sd-sheet-menu (file d'attente, paroles, appareils,
                      artiste, album, partager, paramètres)
Paramètres          : feuille .sd-sheet-settings (thème, animations, prise de
                      contrôle, reprise, barre d'onglets, haptique, rechargement)
Bibliothèque        : la sidebar de Spotify passée en plein écran (classe d'état)
File d'attente      : le panneau « Now playing view » de Spotify en feuille basse
Connexion           : page de login mobile + bouton e-mail / mot de passe
```

### Fonctionnalités

| Fonction | Comment |
| --- | --- |
| Navigation | Onglets Accueil / Rechercher / Bibliothèque, sous-pages avec en-tête (retour, titre, engrenage), retour matériel |
| Lecture | Play/pause, précédent/suivant, aléatoire, répétition (off → contexte → titre, badge « 1 »), seek au doigt, like |
| Prise de contrôle | Le bouton « Écouter sur cet appareil » est détecté par observateur (sans polling) et cliqué **uniquement quand l'utilisateur demande la lecture** depuis l'UI → clic + sélection de l'appareil, puis démarrage. Sans demande, la couche ne touche pas à la lecture d'un autre appareil |
| Déblocage | Si la lecture demandée ne démarre pas en 10 s : `deferMessage('unlock')`, saut de piste, notification à l'écran (comme l'ancienne couche, en deux tentatives maxi) |
| Reprise automatique | Option « Relancer la lecture automatiquement » (désactivée par défaut) — l'« autoplay permanent » de l'ancienne couche |
| Connexion | Page de connexion mise au format mobile, bouton `?allow_password=1`, appel `loginDetected()` quand Spotify propose « ouvrir le lecteur web » |
| Veille | `wakeUp()` / `wakeOff()` pour la lecture vidéo en arrière-plan, `manageTShut` / `manageTSleep` suivant l'état de lecture |
| File d'attente | Panneau Spotify en feuille basse (au-dessus du lecteur quand il est ouvert) |
| Paroles / Appareils / Partager | Boutons de Spotify (masqués si indisponibles), partage du **vrai lien de piste** + copie dans le presse-papiers |
| Paramètres | Thème Auto/Sombre/Clair, couleur tirée de la pochette, réduire les animations, prise de contrôle, reprise auto, barre d'onglets, retour haptique, rechargement du lecteur, réinitialisation — persistés dans `localStorage` |
| Hors ligne | Bandeau rouge animé + toast dès que le WebView perd la connexion |
| Réparation | `Api` observe le trafic Spotify (id de l'appareil, jetons) et transforme une session morte (404 `connect-state`) en **un seul** rechargement, avec garde anti-boucle |

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
| 23 | Le bouton **retour** quittait l'application alors qu'un panneau était ouvert | Aucune gestion de l'historique | Chaque panneau pousse **une** entrée d'historique ; `SpotiDuckUI.back()` ferme d'abord la feuille, puis le lecteur, puis rend la main à l'app |
| 24 | Lecture qui **ne démarre jamais** (« écouter sur cet appareil » ignoré) | Boucle de 5 s qui cliquait un bouton vert sans vérifier ce que c'était | Observateur ciblé + bouton identifié par `data-testid` ou par libellé, puis clic de la ligne d'appareil ; déclenché aussi après un appui sur play |
| 25 | Page de connexion **inutilisable** dans la WebView (OAuth) | Lien « classic login » inséré dans l'arbre React | Bouton « e-mail + mot de passe » **dans notre couche** (`?allow_password=1`) + formulaire mis au format mobile (champs 48 px, police 16 px) |
| 26 | Rechargement en **boucle** quand la session connect meurt | `location.reload()` sur chaque 404 | `Api` compte les rechargements (3 maxi, 5 min d'écart) et n'agit que si l'utilisateur a demandé la lecture |
| 27 | Aucun retour visuel quand le WebView est **hors ligne** | Rien | Bandeau + toast, `html.sd-offline` |
| 28 | Partage du **mauvais lien** (`open.spotify.com` au lieu du titre) | URL codée en dur | Lien réel du titre lu dans le DOM, partage natif, sinon copie dans le presse-papiers |

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
| `wakeUp()` / `wakeOff()` / `isWoke()` | lecture vidéo (podcast) en arrière-plan | appelé uniquement si `isWoke` existe |
| `loginDetected()` | quand Spotify propose « ouvrir le lecteur web » | signale à l'app que la session est valide |
| `deferMessage(str)` | `unlock` (lecture bloquée), `reload` | mêmes messages que l'ancienne couche, donc mêmes chaînes localisées côté natif |

Tout le reste (notification, media session, widgets, Android Auto) reste côté
natif : **rien à modifier côté Kotlin/Java** pour cette refonte.

Réglages exposés à chaud (persistés dans `localStorage['sd.ui.settings']`) :

```js
window.SpotiDuckUI.set("theme", "auto" | "dark" | "light");
window.SpotiDuckUI.set("accentFromArt", true | false);
window.SpotiDuckUI.set("reduceMotion", true | false);
window.SpotiDuckUI.set("takeControl", true | false);
window.SpotiDuckUI.set("resume", true | false);
window.SpotiDuckUI.set("tabbar", true | false);
window.SpotiDuckUI.set("haptics", true | false);
SpotiDuckUI.openPlayer(); SpotiDuckUI.closePlayer(); SpotiDuckUI.openQueue();
SpotiDuckUI.openMenu();   SpotiDuckUI.openSettings(); SpotiDuckUI.close();
SpotiDuckUI.state;        // { title, artist, playing, position, duration, … }
```

**Retour matériel** — à appeler depuis `onBackPressed` :

```kotlin
webView.evaluateJavascript("window.SpotiDuckUI && SpotiDuckUI.back()") { value ->
    if (value != "true") super.onBackPressed()  // l'UI n'a rien fermé → comportement normal
}
```

`back()` ferme dans l'ordre : feuille d'options/paramètres → file d'attente →
lecteur plein écran → sous-page → retour à l'onglet Accueil, et renvoie `false`
quand l'application doit reprendre la main.

---

## 5. Ce qui reste à réintégrer

La v2.1 a absorbé l'autoplay / prise de contrôle, la détection de connexion, le
flux « unlock », la veille vidéo, la gestion du 404 de session et la
surveillance du trafic (`Api`). Il reste deux blocs, volontairement laissés de
côté :

1. **`playFromUri()` côté Android** — `Api` capture déjà l'identifiant de
   l'appareil (`devId`) et les jetons (`Client-Token`, `Authorization`)
   nécessaires ; il manque l'appel `POST /connect-state/v1/player/command/
   from/<dev>/to/<dev>` pour lancer un URI demandé par le natif (widget,
   Android Auto, assistant). À faire quand l'app en aura besoin : c'est un
   appel réseau, pas de l'interface.
2. **Crawl de la bibliothèque** (`fetchAllLibrary` / `parseLibrary` /
   `mediaLib`) — l'onglet Bibliothèque affiche aujourd'hui la page réelle de
   Spotify, paginée et synchronisée. Le crawl ne servirait qu'à une liste
   « hors ligne » côté natif.

Règle à conserver : ces ajouts vont dans un module du runtime (comme `Api`),
jamais en variables globales et jamais dans `document.body` directement.

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

## 7. Passe d'audit de l'interface (v2.3)

Le rapport d'audit automatique liste 163 constats. Ils se ramènent à onze
familles de défauts ; chacune est traitée par une règle systématique de
`src/inject/40-audit.css`, plus un état géré par le runtime. Corriger la classe
plutôt que l'occurrence est le seul moyen de tenir sur une interface dont le DOM
change tous les mois.

| Famille du rapport | Correctif | Où |
| --- | --- | --- |
| Cibles tactiles trop petites (chevrons « 16 px », `+`, `…`, actions de ligne) | tout contrôle de notre couche fait ≥ `--sd-tap` (44 px) ; les boutons-icônes de Spotify passent à 44 px (`:has(> svg:only-child)`), et tout contrôle mesuré sous 40 px reçoit `data-sd-hit` (boîte réelle, jamais un `::after` qui volerait le tap du voisin) | §1 + `Polish.labelPass()` |
| Titres tronqués, textes qui débordent, lignes qui s'élargissent | `min-width: 0`, `overflow-wrap: anywhere`, ellipsis sur les titres de cartes et de pistes, `overflow-x: clip` sur les pages, images sans `src` masquées | §2 |
| Texte illisible (métadonnées 10–11 px) | plancher de 12 px sur les métadonnées du web player, chiffres tabulaires pour les durées, `line-height` qui ne coupe plus les accents | §3 |
| Contraste insuffisant, thème clair cassé | jetons clairs complets sous `html.sd-theme-light`, `--sd-sub` à 4,6:1, fond opaque sous les barres | §4 |
| Focus invisible / anneau persistant au doigt | `:focus-visible` → anneau accent sur **tous** les contrôles (nôtres et ceux de Spotify), `:focus:not(:focus-visible)` → aucun anneau | §5 |
| Infobulles collées après un tap | `@media (hover: none)` masque les infobulles (`tippy`, `[role=tooltip]`), largeur bornée et `z-index` sous nos feuilles | §6 |
| En-têtes collants qui recouvrent les lignes | `position: sticky` recollé sous l'encoche, fond opaque, `overscroll-behavior: contain` sur les conteneurs | §7 |
| Modales/menus natifs cachés derrière notre chrome | état `html.sd-native-modal` : mini-player, barre d'onglets et top bar s'effacent, notre calque passe sous la modale | §8 + `Polish.watchOverlays()` |
| Clavier logiciel qui masque le champ de recherche | état `html.sd-keyboard` : barres masquées, `--sd-bottom` réduit, `scroll-margin` sur le champ | §9 + `Polish.watchKeyboard()` |
| Boutons sans retour visuel, contrôles désactivés indistinguables | fond `--sd-bg-tint` au `:active`, opacité 0,45 sur `[disabled]` | §10 |
| Animations pénibles / sélection accidentelle | `prefers-reduced-motion` coupe aussi les animations native, `user-select: none` sur la coque (texte des paroles conservé), fin du halo de tap | §11 + `sd-reduce-motion` |

Deux points de méthode : aucune règle ne cible `*`, `div` ou `button` sans
qualification (c'est ce qui cassait les mises en page non testées de l'ancienne
couche), et tout ce qui touche au DOM de Spotify est **scopé sur `.sd-root`**,
classe posée par le runtime sur `<body>`, donc jamais sur notre propre couche.

---

## 8. Tests

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

Depuis la v2.3, il couvre aussi le durcissement : une **modale native** fait
reculer notre chrome (`html.sd-native-modal`), le **clavier logiciel** masque
barre d'onglets et mini-player (`html.sd-keyboard`), et les **contrôles natifs
trop petits** reçoivent `data-sd-hit` + un `title` repris de leur `aria-label`.

Depuis la v2.1, il couvre aussi : le menu d'options (file d'attente, paroles,
appareils, artiste, album, partager, paramètres), les paramètres (segmented
control du thème, interrupteurs, persistance dans `localStorage`, classe
`sd-reduce-motion`), la **prise de contrôle** (le mock insère le bouton
« Écouter sur cet appareil » : la couche doit cliquer le bouton *puis* la ligne
d'appareil), le **retour matériel** (feuille → lecteur → app), l'entrée
d'historique unique par panneau (navigation arrière réelle), la **page de
connexion** (`?allow_password=1` + `loginDetected()`), le bandeau **hors ligne**
et le **partage du vrai lien de piste**.

`tools/screenshots.mjs` produit en plus 13 captures (`shots/`) : accueil avant /
après, mini-player, lecteur, file d'attente, bibliothèque, recherche, page de
playlist, encoches simulées, paysage, petit écran. Il nécessite Chrome ou
Chromium (`npm i -D puppeteer-core @sparticuz/chromium`) : cet environnement
d'exécution ne permet pas de lancer un navigateur, les captures restent donc à
générer sur une machine avec Chrome.
