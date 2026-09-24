# Refonte de l'interface mobile — SpotiDuck UI v2.5

Ce document décrit la nouvelle **couche d'interface** injectée dans la WebView
Spotify : ce qu'elle remplace, les bugs qu'elle corrige, comment l'intégrer à
l'application Android et comment la tester.

> **Depuis la v2.5, l'application propose deux interfaces** (section 10).
> Depuis la v2.6.1, celle décrite ici est **celle livrée par défaut** : c'est la
> seule où la connexion e-mail/mot de passe fonctionne et où l'écran ressemble à
> l'application mobile. L'autre mode sert la page web mobile de Spotify — ni la
> disposition de l'application, ni la connexion classique — et reste proposé en
> bêta à un appui long d'écart (ou dans *Paramètres → Interface*).

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
| `src/inject/50-android.css` | Passe **Android / Material 3** : Roboto, échelle typographique, cibles 48 dp, formes et surfaces Material, courbes de mouvement, barres système, écran d'accueil (voir §9). |
| `src/inject/60-metrics.css` | **Métriques de l'application mobile** : le web player est remis à l'échelle mobile (2 tuiles par ligne, 56 dp de ligne, titres 20 px, hero 200 dp, marges 16 dp) au lieu de garder ses dimensions desktop. |
| `src/inject/40-audit.css` | Durcissement de l'interface : cibles tactiles ≥ 44 px, débordements, en-têtes collants, modales natives, clavier, contraste, focus, mouvement réduit (section 8). |
| `android/app/src/main/assets/native-mode.js` | Le **mode natif** (v2.5, par défaut) : masque les bandeaux navigateur de Spotify et branche les boutons de la notification Android sur les vrais contrôles de la page Spotify (section 10). |
| `tools/smoke.mjs` | 47 tests de comportement (jsdom) sur le bundle réel et sur le script du mode natif. |
| `tools/screenshots.mjs` | Capture d'écran des écrans clés (nécessite Chrome/Chromium). |

```bash
npm run build            # génère dist/spotiduck-ui.js
npm run smoke            # lance les 39 tests
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

## 8. Adaptation Android (v2.4)

Le premier jet était une page web restylée : la version 2.4 en fait une
application Android, dans `src/inject/50-android.css` (chargée en dernier, donc
prioritaire) plus deux changements de comportement.

| Sujet | Avant | Maintenant |
| --- | --- | --- |
| Police | police web de Spotify, mélangée à la nôtre | **Roboto** partout (coque + DOM Spotify), `text-size-adjust` neutralisé pour bloquer le *font boosting* |
| Échelle | tailles desktop (10–14 px) | échelle Material 11 / 12 / 14 / 16 / 22 / 28 px, interlettrage des grands titres |
| Cibles | 44 px | **48 px** (minimum Android), icônes 24 px |
| Barres | 56 px | barre de navigation 64 px, mini-lecteur 64 px, app bar 56 px, gouttière 16 px |
| Formes | 8 px partout | cartes 8, pochettes 6, grandes surfaces 16, **feuilles 28** (M3), boutons en pastille |
| Surfaces | noir plat | `#121212` / `#1e1e1e` / `#282828`, contour 14 %, ombres portées, thème clair complet |
| Mouvement | durées ad hoc | courbes Material `cubic-bezier(0.2,0,0,1)`, durées 120 / 220 / 400 ms, fondu entre onglets |
| Retour au doigt | rien | *state layer* Material sur chaque appui, pas de `:hover` en tactile, contrôles révélés au survol rendus visibles |
| Barres système | `env(safe-area-inset-*)` seuls | insets réels transmis par l'application via `--sd-safe-*-override`, contenu sous la barre d'état, 8 px minimum sous la zone gestuelle |
| WebView | barres de défilement, rebond | barres masquées, `overscroll-behavior: none`, appui long neutralisé sur la coque |
| Interrupteurs / segments | dessin maison | interrupteur 52×32 (M3), segments à contour 1 px et sélection teintée |
| Contrôles natifs | chevrons 16 px | boîte 48 px sur tous les boutons-icônes de Spotify |
| Contenu du player | dimensions desktop (tuiles ~330 px sur une colonne, titres 24-32 px, hero plein écran) | **métriques de l'app mobile** : 2 colonnes de ~160 dp, ligne 56 dp, pochette 40 dp, titre de section 20 px, hero 200 dp, gouttière 16 dp (§ `60-metrics.css`) |
| Diagnostic | aucun | ligne **Affichage** dans les paramètres (`360×640 · 2,75× · 100 %`), copiable — sert à expliquer un rendu qui diffère d'un appareil à l'autre |
| Viewport de mise en page | non déclaré → la WebView met en page sur **980 px** | **`<meta name="viewport" content="width=device-width…">` forcé** (couche injectée, mode bêta et `MainActivity`), plus `loadWithOverviewMode = true`. Sans ce meta, media queries, unités `vw` et tailles de police visent un écran deux à trois fois plus large que le téléphone : interface énorme, coupée à droite, à faire glisser. La ligne **Affichage** prévient explicitement (`⚠ mise en page 980px pour un écran de 393px`) |
| Taille globale | fixe | réglage **Taille de l'interface** : `--sd-u` = 0,80 / 1 / 1,12 multiplie l'échelle typographique, les cibles tactiles, la hauteur des barres et les gouttières |

Deux comportements changent en plus :

1. **La coque ne dépend plus du lecteur.** Avant, rien n'était construit tant que
   la barre « lecture en cours » n'existait pas : sur un premier lancement (ou
   une session expirée) l'utilisateur voyait la page web desktop de Spotify.
   Le démarrage est maintenant scindé en `startShell()` (toujours : onglets,
   barres, feuilles, écran d'accueil) et `startPlayer()` (dès que la lecture est
   possible — la barre est guettée par un `MutationObserver`).
2. **Taille réglable** : la WebView d'Android ne rend pas la même chose sur tous
   les appareils (densité d'écran, zoom texte). Plutôt que de deviner, l'échelle
   de toute l'interface est un réglage — `--sd-u` (0,86 / 1 / 1,12) multiplie la
   typographie, les cibles, les barres et les marges, et le choix est conservé
   dans `localStorage`.
3. **Le contenu du web player est remis aux métriques mobiles**
   (`src/inject/60-metrics.css`). C'était la cause principale du « tout est
   trop gros » : le site desktop garde ses tuiles de ~330 px en une seule
   colonne, ses titres de 24-32 px et son en-tête de playlist plein écran,
   donc l'écran ne montre que deux éléments et il faut tout chercher. Les
   métriques sont maintenant celles de l'application Android — 2 colonnes,
   tuile ~160 dp, ligne 56 dp, pochette 40 dp, hero 200 dp, marges 16 dp —
   toutes exprimées en `calc(... * var(--sd-u))` pour rester réglables.
4. **Écran d'accueil maison** (`.sd-welcome`) : quand la session est déconnectée,
   la page marketing est remplacée par un écran SpotiDuck (logo, une phrase,
   bouton « Se connecter ») qui pointe vers la connexion e-mail/mot de passe.

---

## 9. Tests

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

Depuis la v2.5, un **troisième banc** monte une fausse page mobile de Spotify
(bandeau « Ouvrir dans l'application », widget lecture en cours, contrôles,
barre de progression) et y charge `native-mode.js` : le calque SpotiDuck ne doit
**pas** être injecté, les bandeaux doivent être masqués en CSS (et non retirés du
DOM), les commandes de la notification doivent cliquer les vraies commandes
Spotify (play/pause, suivant, précédent, j'aime), `play()` / `pause()` doivent
comprendre les libellés français (« Lecture » = en pause, donc il faut cliquer),
le seek doit écrire des **secondes** dans la barre et envoyer des
**millisecondes** au pont, la position ne doit être publiée qu'au-delà de 4 s de
dérive, l'appui long de 3 s doit appeler `showUiChooser`, et le clic relâché
juste après cet appui long doit être avalé (sinon l'appui long lance le morceau
touché). Le script est chargé deux fois de suite pour vérifier son idempotence
(Android peut réinjecter la page).

Depuis la v2.4, deux bancs supplémentaires vérifient le premier lancement :
**sans web player** (session déconnectée) la coque est quand même construite
(calque, trois onglets, feuilles), et la page marketing de Spotify est
remplacée par l'**écran d'accueil** SpotiDuck avec son bouton de connexion.

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

---

## 10. Deux interfaces (v2.5)

Retour utilisateur après la v2.4.2 : « *fais un copier-coller de l'interface de
Spotify… là c'est vraiment pas beau* ». Conclusion tirée : imiter Spotify, même
avec les bonnes métriques, ne donne jamais Spotify. La v2.5 arrête donc de
redessiner — **elle affiche la page mobile de Spotify**.

| | Interface **SpotiDuck** (couche injectée, défaut) | Interface **« native »** (bêta) |
| --- | --- | --- |
| User-agent | desktop | Chrome Android (Pixel 7) |
| Qui dessine | notre couche + le web player reflowé | Spotify (`open.spotify.com` en version **web mobile**) |
| Navigation | onglets Accueil / Rechercher / Bibliothèque | celle de Spotify |
| Écrans maison | file d'attente, paramètres, hors ligne, accueil | aucun |
| Réglages | + thème, densité, taille de l'interface | ceux de Spotify |
| Connexion | formulaire e-mail/mot de passe (CTA « Se connecter ») | boutons sociaux de Spotify, qui échouent souvent dans une WebView |

### Pourquoi l'interface injectée est le défaut

Essayer la page web mobile a montré ses limites, toutes mesurables :

* ce n'est **pas** l'application mobile (pas de barre d'onglets, pas de file
  d'attente) — Spotify sert une page web simplifiée ;
* Spotify décide de sa mise en page au chargement d'après l'agent utilisateur,
  et une WebView n'est pas détectée comme Chrome : la page peut rester en
  disposition « bureau » dans un écran de téléphone ;
* la connexion y passe par les boutons Google/Apple/Facebook, refusés dans une
  WebView ; le formulaire e-mail/mot de passe n'est pas proposé par défaut ;
* les liens « ouvrir dans l'application » (`spotify:…`) n'ont pas d'application
  vers laquelle aller.

L'interface injectée, elle, pilote le web player **bureau** (connexion
e-mail/mot de passe, lecture complète) et l'habille aux métriques mobiles. Le
mode bêta reste accessible pour comparer.

### Comment on bascule

* **Appui long de 3 secondes** n'importe où dans la page → `showUiChooser()`,
  une fenêtre `AlertDialog` propose les deux interfaces. C'est le seul chemin
  possible depuis le mode natif, puisque notre feuille de paramètres n'est plus
  là où se trouve le bouton.
* **Paramètres → Interface → « Utiliser l'interface Spotify »** depuis la couche
  SpotiDuck (première ligne du groupe *Interface*).
* Le choix est enregistré dans `SharedPreferences` (`spotiduck` / `ui_mode`) et
  appliqué par un rechargement avec le bon user-agent (`switchUiMode()`), donc
  il survit au redémarrage de l'application.

### Ce que fait `native-mode.js` (et rien de plus)

1. **Masque les bandeaux navigateur** que Spotify réserve aux visiteurs mobiles
   (`div[data-testid='banner']`, liens `/download`, `play.google.com`,
   `apps.apple.com`, `open-in-app-button`, `install-app-banner`, infobulles).
   Ils restent dans le DOM — le CSS suffit et n'entre pas en conflit avec React.
2. **Expose un `window.SpotiDuckUI` minimal**, avec les mêmes noms que la couche
   (`play`, `pause`, `playPause`, `next`, `previous`, `like`, `seek`, `sync`,
   `back`), pour que `PlaybackService` n'ait rien à savoir du mode choisi : ces
   méthodes **cliquent les vrais boutons de Spotify** (ou écrivent dans sa barre
   de progression via le setter natif du `<input type=range>`).
3. **Alimente la notification** : titre, artiste, pochette, durée et position
   sont publiés au pont `AndBridge` (`recMediaStatus`, puis `recMediaPosition`
   seulement au-delà de 4 secondes de dérive) — sinon l'écran de verrouillage
   reste vide.
4. **Installe l'appui long** de 3 secondes décrit ci-dessus, et **avale le clic**
   relâché juste après, pour ne pas lancer le morceau touché.

### Limites assumées

* Le mode natif dépend du DOM de Spotify (`data-testid`, libellés d'accessibilité
  français **et** anglais). Si Spotify renomme ses contrôles, seule la
  notification cesse de fonctionner : l'interface, elle, reste intacte.
* Les écrans maison de SpotiDuck (file d'attente, paramètres, densité, hors
  ligne) n'existent pas dans ce mode — c'est le prix de l'interface de Spotify.
  Le premier lancement, lui, passe par la même connexion Spotify.
* Les deux modes partagent la même clé de signature et la même clé de
  préférences : passer de l'un à l'autre ne coûte qu'un rechargement.

### Zéro pop-up

Trois familles de fenêtres parasites encombraient l'application, elles sont
toutes traitées (`native-mode.js`, plus `Polish.purgePopups()` côté couche
injectée) :

| Pop-up | Traitement |
| --- | --- |
| Bandeaux « Ouvrir dans l'application », « Télécharger l'application », promos plein écran | masqués en CSS (`display:none !important`) ; ils reviennent à chaque rendu, donc la règle reste appliquée |
| Bannière de consentement aux cookies (OneTrust) | **retirée du DOM** (elle n'est pas gérée par React) et le `overflow:hidden` qu'elle pose sur `<body>` est relâché — sinon la page ne défile plus du tout |
| Menus du navigateur : appui long → « Copier », « Enregistrer l'image », sélection de texte, bulles d'aide, barres de défilement | appui long avalé par la WebView (`setOnLongClickListener { true }`), `-webkit-touch-callout` / `user-select` neutralisés hors champs de saisie, infobulles masquées, barres de défilement supprimées |
| Fenêtres « Ouvrir avec… » du système (liens `spotify:`, `intent:`, `market:`) | la WebView ne laisse passer que `http(s)` : plus de page d'erreur Chrome ni de sélecteur d'application |

Le script réagit aussi aux apparitions tardives : un `MutationObserver` ne
relance le balayage que si le nœud ajouté ressemble à un pop-up (sinon Spotify
redessine trop souvent pour le supporter).

### Le viewport, en clair

Trois causes d'un affichage « pas adapté au téléphone », toutes mesurables :

1. **Le web player est un site bureau** : il ne déclare aucun
   `<meta name="viewport">`. Une WebView qui n'en trouve pas se donne une
   largeur de mise en page de **980 px**. Toutes nos tailles (unités `vw`,
   `clamp()`, media queries) étaient donc calculées pour un écran de 980 px
   affiché sur un écran de ~390 px : d'où le « c'est trop gros » et les boutons
   à aller chercher en faisant glisser la page. Le meta est maintenant posé par
   la couche (avant les styles), par `MainActivity` (dès le début du chargement,
   puis revérifié dix fois pendant que la page se construit) et par le mode bêta.
2. **La largeur de mise en page n'est pas `window.innerWidth`** : le mode bêta
   redéfinit cette dernière pour que Spotify se croie sur bureau. Le diagnostic
   mesure `document.documentElement.clientWidth`, et le compare à la taille de
   l'écran en pixels CSS (`screen.width / devicePixelRatio`).
3. **Quand ça ne concorde pas, c'est écrit.** La ligne *Affichage* affiche
   `⚠ mise en page 980px pour un écran de 393px` : un appui la copie, donc un
   rapport de bug tient en une ligne.

### Tests et garde-fous

* `tools/smoke.mjs` — **53 tests**, dont les dix du banc « native mode » (voir §9).
* `tools/audit-links.mjs` (`npm run audit`, exécuté par la CI) — vérifie que
  chaque méthode du pont appelée par la couche existe dans `Bridge.kt`, que
  chaque classe `sd-…` posée par le runtime est stylée quelque part, que chaque
  `R.string.*` et chaque `assets/…` existent, et que les feuilles CSS ont des
  accolades équilibrées (une accolade orpheline fait disparaître tout ce qui
  suit, sans le moindre message d'erreur).
* Icônes de l'application régénérées (canard à lunettes sur disque vert, fond
  noir) : plus de visuel orange d'origine sur l'écran d'accueil.
* `tools/sync-android.mjs` vérifie désormais que `native-mode.js` contient bien
  `window.SpotiDuckUI`, les `data-testid` des contrôles, `showUiChooser` et
  `recMediaStatus` : un fichier tronqué ne peut plus partir dans l'APK.
