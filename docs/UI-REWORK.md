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
| `android/app/src/main/assets/native-mode.js` | L'**affichage mobile** (v2.5 ; **défaut depuis la 2.7.3**) : masque les bandeaux navigateur de Spotify et branche les boutons de la notification Android sur les vrais contrôles de la page Spotify (sections 10 et 15). |
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
| Contenu du player | dimensions desktop (tuiles ~330 px sur une colonne, titres 24-32 px, hero plein écran) | **métriques de l'app mobile** : tuiles ~148 dp, ligne 56 dp (64 en bibliothèque), pochette 40 dp (48 en bibliothèque), titre de section 20 px, hero 200 dp, gouttière 16 dp (§ `60-metrics.css`) |
| Disposition des sections | grille verticale : tout s'empile, on descend pour voir la suite | **rangées qui défilent horizontalement** (une par section, ~2 tuiles visibles, accroche au doigt), comme l'application ; la grille à 2 colonnes ne reste que pour les pages de résultats |
| Détails de liste | ligne d'en-tête de colonnes « # Titre Album Ajouté le Durée », lignes hautes | en-tête retiré (l'application n'en a pas), index aligné à droite, durée en chiffres de largeur fixe, lignes à 56/64 dp |
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

| | Interface **SpotiDuck** (couche injectée) | Interface **« native »** (bêta) |
| --- | --- | --- |
| User-agent | desktop | Chrome Android (Pixel 7) |
| Qui dessine | notre couche + le web player reflowé | Spotify (`open.spotify.com` en version **web mobile**) |
| Navigation | onglets Accueil / Rechercher / Bibliothèque | celle de Spotify |
| Écrans maison | file d'attente, paramètres, hors ligne, accueil | aucun |
| Réglages | + thème, densité, taille de l'interface | ceux de Spotify |
| Connexion | formulaire e-mail/mot de passe (CTA « Se connecter ») | la page de connexion de Spotify (voir la mesure ci-dessous) |

### §10, suite : ce que valaient les objections (mesuré en v2.7.3)

L'interface injectée avait été mise par défaut, à l'époque, à cause de quatre
objections. Trois ont été vérifiées depuis, et **deux étaient fausses** :

* ce n'est **pas** l'application mobile — vrai, et sans remède : Spotify sert
  une page web mobile (barre basse, listes compactes, lecteur plein écran), pas
  la navigation de son application. C'est la limite du procédé, elle est
  assumée : c'est la page mobile de Spotify, pas une imitation.
* « la page peut rester en disposition bureau dans un écran de téléphone » —
  **faux** : l'application annonce explicitement Chrome Android (c'est tout le
  mécanisme du mode), et la page servie en CI à cet agent fait 306 465 octets
  contre 162 688 pour l'agent bureau, avec des repères différents (0 trace de la
  coquille bureau dans les deux cas : tout est monté par le JS).
* « la connexion passe par les boutons sociaux, le formulaire e-mail n'est pas
  proposé » — **non mesuré** : en CI, `accounts.spotify.com/fr/login` est servi
  **au même octet** à un agent bureau et à un agent Android (28 012 octets,
  2 occurrences du bouton Google, aucun `type="password"` dans le document
  livré). Le formulaire est donc rendu par le JS de la page, pas décidé par
  l'agent — autrement dit, ce que voit le mode mobile est la même page de
  connexion que le mode bureau. Reste ce qui est vrai de toute WebView : Google
  refuse d'y dérouler son OAuth (« disallowed_useragent »). Si la page refuse le
  chemin e-mail/mot de passe, la sortie est écrite plus bas.
* les liens « ouvrir dans l'application » (`spotify:…`) : c'est `native-mode.js`
  qui les masque, pas un manque d'application cible.

L'interface injectée, elle, pilote le web player **bureau** (connexion
e-mail/mot de passe, lecture complète) et l'habille aux métriques mobiles — elle
reste accessible, comme l'affichage d'origine.

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

---

## 11. Retour à la disposition d'origine (v2.6.4)

Après plusieurs essais d'imitation, la référence retenue est celle des
**captures de la première version du projet** : la disposition d'origine de
SpotiDuck, servie par `src/inject/70-original.css` (partie 7/7, chargée en
dernier).

| Élément | Avant | Maintenant |
| --- | --- | --- |
| Navigation | barre d'onglets **en bas** (Accueil · Rechercher · Bibliothèque) | barre **en haut** : maison · bibliothèque · recherche · **logo** · notifications · amis · profil. Les onglets du bas restent disponibles en réglage, désactivés par défaut |
| Mini-lecteur | pochette + titre + j'aime/lecture/suivant, une barre fine de progression | **lecteur complet** : pochette + titre + artiste + j'aime, puis aléatoire · précédent · lecture · suivant · répétition, puis temps écoulé · barre de progression glissable · durée. Hauteur `--sd-mini-h` = 120 dp × `--sd-u` |
| Raccourcis de l'accueil | grandes tuiles | **deux colonnes** de cartes compactes (pochette 48 dp + titre), comme la capture |
| Contenu sous la barre | — | `body { padding-top: safe + nav }` pour que la barre ne recouvre jamais la page ; la barre de titre des sous-pages (retour) passe **sous** la nav, et la sidebar Bibliothèque redescend d'autant |

### Les boutons du bas qui disparaissaient

`html.sd-keyboard` était posée dès que la zone visible rétrécissait de plus de
120 px — sans vérifier qu'un clavier était ouvert. Un redimensionnement, une
rotation, l'apparition de la barre système ou un changement d'onglet suffisaient :
la barre et le mini-lecteur s'effaçaient alors que rien ne gênait. La classe n'est
plus posée que si `document.activeElement` est un champ de saisie (ou
`contenteditable`), et elle est retirée au `focusout`.

### Tests

`npm run smoke` — **58 tests** (53 → 58) : navigation en haut (ordre des trois
vues, logo, trois boutons d'écrans Spotify, libellés d'accessibilité), barre du
bas désactivée par défaut mais toujours présente dans le DOM, mini-lecteur
complet (six contrôles + deux temps + rail `role="slider"`), commandes du
mini-lecteur réellement transmises au web player (lecture, aléatoire,
répétition), et **le cas inverse** du clavier : une zone visible qui rétrécit
sans champ focalisé ne masque plus rien.

---

## 12. L'affichage d'origine, repris tel quel (v2.7.0)

Les sections 4 à 11 décrivent une couche d'habillage **réécrite** en CSS/JS.
Elle est restée insuffisante : la référence n'était pas d'imiter l'affichage
d'origine, mais **de le reprendre**. La v2.7.0 livre donc, par défaut, le script
injecté de l'application d'origine lui-même — reconstruit depuis les chaînes
déchiffrées de `p000/C1356q3.onPageFinished` dans la source publique
déobfusquée `lyssadev/Spotifuck_src` — sans y toucher (voir
`src/original/README.md`).

### Ce que fait ce script

C'est lui qui donnait à SpotiDuck son affichage : la page **bureau** de Spotify,
habillée par une feuille de 6 001 caractères chargée au même moment.

| Élément | Comment |
| --- | --- |
| Barre du haut | celle de Spotify (accueil · bibliothèque · recherche · logo · notifications · amis · profil), restylée par la feuille d'origine |
| Accueil | rangées compactes : `grid-container` sans gouttières, accueil limité aux **six premières** rangées, `contentSpacing` à zéro |
| Bibliothèque | bouton de l'en-tête détourné : elle s'ouvre **en plein écran** (`position:fixed;width:100%;height:92%`) et se referme |
| Mini-lecteur | `aside[data-testid=now-playing-bar]` passé en colonne, avec le dégradé rouge (`#770000 → #330000`), plus un bouton de lecture maison (`.npbtn`) collé à celui des paroles |
| Listes | lignes de 40 px, grilles de pistes recalculées selon `aria-colcount` (2 à 5 colonnes) |
| Bandeaux | pub, « Installer l'application », plein écran, pied de page : masqués |

### Comment c'est branché

* `src/original/spotiduck-original.js` — le code d'origine + le rapporteur
  `updMedia` (lui aussi d'origine, injecté à part par l'application) + un
  adaptateur `window.SpotiDuckUI` balisé, seule ligne ajoutée, pour que la
  notification Android commande les fonctions d'origine.
* `npm run build` construit les deux interfaces ; `npm run sync:android` copie
  `dist/spotiduck-original.js` dans `assets/` comme l'autre.
* `MainActivity` sert le script du mode choisi. Le mode **`original` devient le
  défaut**, avec les réglages WebView de l'application d'origine
  (`useWideViewPort`, `loadWithOverviewMode`, `setInitialScale(100)`, zoom
  autorisé, **aucun** `<meta name="viewport">` forcé : la page décide).
* Le pont expose maintenant `nFetch` : le script d'origine fait ses requêtes de
  lecture lui-même (l'implémentation est reprise de `WebService.nFetch`, mêmes
  en-têtes, mêmes cookies).
* L'interface choisie avant cette version n'était pas un choix (le défaut a
  changé deux fois) : un compteur de révision (`ui_mode_rev`) la remet une fois
  sur le mode d'origine, puis respecte les choix explicites.
* Le mode d'origine n'ayant pas d'écran de réglages, l'**appui long** sur la
  page ouvre le choix de l'interface.

### Tests

`npm run smoke` — **67 tests** (58 → 67). Les neuf nouveaux chargent le script
d'origine sur une page qui imite la page bureau de Spotify :

1. le script est complet (21 fonctions d'origine) et démarre sans erreur ;
2. la feuille d'origine est posée **telle quelle** (6 001 caractères, dégradé
   rouge du lecteur, barre de navigation, accueil limité à six rangées) ;
3. le bouton de lecture d'origine (`.npbtn`) est inséré dans la barre, à côté
   des paroles ;
4. la bibliothèque s'ouvre en plein écran ;
5. le script prévient Android (`cssInjected`, veille, arrêt auto) ;
6. toutes les méthodes de `AndBridge` qu'il appelle existent dans `Bridge.kt` ;
7. l'adaptateur du service relaie les fonctions d'origine, en convertissant les
   millisecondes en secondes pour le déplacement ;
8. l'état de lecture (titre, artiste) part vers la notification ;
9. aucune erreur d'exécution.

`npm run audit` surveille désormais : le mode livré par défaut, la révision du
choix, l'origine de l'asset (`src/original/`), la feuille d'origine
(md5 `13de5546d0`), l'agent bureau du mode d'origine et les scripts chargés par
`readAsset`.

---

## 13. Play Protect : installation sans interruption (v2.7.1)

Play Protect analyse tout APK installé hors du Play Store. C'est un service de
Google, pas une permission Android : **aucune application ne peut le désactiver
pour elle-même**, et rien dans l'APK ne peut supprimer cet écran (demander
`REQUEST_INSTALL_PACKAGES` ou embarquer un installateur rendrait au contraire
l'analyse plus méfiante).

Ce qui a été ajouté, en revanche, c'est le chemin le plus court vers le réglage
qui l'arrête :

* `MainActivity.openPlayProtect()` essaie dans l'ordre l'écran Play Protect des
  services Google, celui du Play Store, le lien `market://playprotect`, les
  réglages de sécurité du téléphone, puis l'ouverture du Play Store ; il répond
  `true` si un écran a été ouvert.
* `Bridge.openPlayProtect()` l'expose à la page.
* L'interface injectée a une ligne **Vérification Play Protect** (Paramètres →
  À propos) qui appelle ce réglage, avec la consigne affichée si l'ouverture
  échoue.
* Le **mode d'origine n'a pas d'écran de réglages** : le sélecteur d'interface
  (appui long) a un bouton **Play Protect** qui mène au même endroit.

Le pas-à-pas, à donner tel quel : *Play Store → icône de profil → Play Protect →
⚙️ → décocher « Analyser les applis avec Play Protect »*. Sur l'écran d'alerte
lui-même, **⋮ → Plus de détails → Installer quand même** passe lorsque
l'installation est seulement déconseillée ; l'écran « Application non sécurisée
bloquée » ne propose, lui, que l'abandon — il faut alors le réglage ci-dessus.
Installer par `adb install -r` évite l'interface d'installation (et donc
l'interruption), sans désactiver quoi que ce soit.

Le README détaille les deux écrans, les trois contournements et la seule voie
vers un verdict de confiance (publication Play, ou recours Play Protect).

## 14. L'empreinte du navigateur d'origine (v2.7.2)

### Le constat

« L'affichage est moche. » Le pass 13 avait pourtant repris l'interface
d'origine *verbatim*. Il manquait une pièce, et une seule : **le navigateur que
la page voit**.

En mode d'origine, la WebView se présente comme une WebView Android. Spotify
sert alors une page mise en page **pour un téléphone** — et cette mise en page
n'est pas établie dans le HTML : les repères de la page bureau
(`Desktop_LeftSidebar_Id`, `now-playing-bar`, `global-nav-bar`, `grid-container`,
`tracklist-row`) sont absents du document servi, mesuré en CI. Tout est monté
par le JavaScript de Spotify, **d'après ce que le navigateur lui raconte**.

La feuille d'origine (`_player_full_classic.js`, 6 001 caractères, md5
`13de5546d0`), elle, a été écrite pour la page **bureau**. Elle habille des
sélecteurs qui, sur une page mobile, n'existent pas — et là où ils existent, la
disposition n'est pas celle sur laquelle elle s'appuie. Aucun réglage de la
couche ne pouvait le résoudre : la page n'était pas seulement mal habillée,
elle était *l'autre page*.

### La pièce manquante

`C1356q3.java` l'appelle dans `onPageStarted` — donc avant que la page n'ait
exécuté quoi que ce soit. Son JS (`C1356q3__01__0ed798ac.deobfuscated.js`) fait
passer le navigateur pour un Chrome de bureau sur un écran 1920×1080 :

| Ce qui est remplacé | Valeur annoncée |
| --- | --- |
| `screen.width` / `screen.height` / `screen.availHeight` | 1920 / 1080 / 1040 |
| `window.innerHeight` | 978 |
| `window.devicePixelRatio` | 1 |
| `navigator.userAgent` | Chrome 150, Windows |
| `navigator.vendor` / `platform` | Google Inc. / Win32 |
| `navigator.plugins` / `mimeTypes` | les cinq greffons PDF de Chrome |
| `navigator.userAgentData` + `getHighEntropyValues` | client hints Windows |
| WebGL `UNMASKED_VENDOR/RENDERER_WEBGL` | ANGLE, Intel |

C'est `src/original/spotiduck-fingerprint.js` : le corps du script d'origine
**verbatim** (aucune ligne réécrite), avec un en-tête de provenance et son
empreinte SHA-256. `tools/build-original.mjs` le copie vers
`dist/original-fingerprint.js` et vers l'asset, `tools/sync-android.mjs` refuse
un fichier qui ne contient plus 1920, 1080 et 978, et `tools/audit-links.mjs`
vérifie que `MainActivity` l'injecte bien dans `onPageStarted` — jamais plus
tard, comme dans l'application d'origine : une page qui s'est déjà mise en page
pour un téléphone ne se recompose pas parce qu'on ment sur `screen.width` après
coup.

### Le diagnostic embarqué

Un affichage ne se corrige pas à l'aveugle, et l'aperçu navigateur n'est pas le
téléphone. Le sélecteur d'interface (appui long) a un bouton **Diagnostic** qui
affiche, sur place :

* la largeur et la hauteur de mise en page en pixels CSS, la fenêtre, la
  densité, l'écran — la comparaison entre ces trois lignes dit immédiatement si
  l'empreinte est passée ;
* le nombre de feuilles de style posées ;
* la présence de la barre haute, du lecteur bas, de l'accueil, des rangées, des
  lignes de piste et de la navigation ;
* si l'interface d'origine est chargée (`window.firstFuck`) ;
* le chemin de la page.

Sept lignes, un bouton **Copier**. C'est le seul instrument qui regarde le
téléphone : tant que l'affichage est en cause, c'est ce que je demande en
retour.

### Ce qui n'était pas la cause

Le pass 8 avait forcé un `<meta name="viewport" content="width=device-width…">`
en supposant que le web player n'en déclarait aucun. `inspect-page.yml`
(nouveau workflow de diagnostic, `curl` avec agent bureau puis agent Android)
montre le contraire : la page actuelle déclare bien `width=device-width,
initial-scale=1, maximum-scale=1` pour l'agent bureau, et `width=device-width,
initial-scale=1` pour l'agent Android. Le commentaire de `MainActivity` qui
affirmait l'inverse a été corrigé ; le meta forcé reste, comme filet, hors du
mode d'origine.

## 15. L'affichage mobile par défaut (v2.7.3)

Demande, telle quelle : « *fais en sorte que l'affichage mobile soit par défaut
sur le projet* ». C'est ce qui est livré.

### Ce qui change

* `MODE_DEFAULT = MODE_NATIVE` (`MainActivity`) : l'application s'ouvre sur la
  page web mobile de Spotify — navigation basse, listes compactes, lecteur plein
  écran, rien de redessiné.
* `UI_MODE_REV` passe à 4 : un mode enregistré par une version dont le défaut
  était autre n'est **pas** un choix, il est oublié une fois. Au-delà de cette
  révision, un choix explicite est respecté.
* Le sélecteur d'interface liste le défaut en tête : *affichage mobile*,
  *interface d'origine*, *habillage SpotiDuck*.
* `npm run audit` surveille les deux côtés de la décision : le défaut doit être
  l'affichage mobile (et **jamais** notre habillage, c'est précisément ce que
  l'utilisateur avait refusé), et le mode livré doit rester quittable **depuis
  lui-même** — `native-mode.js` doit toujours pouvoir ouvrir le sélecteur.

### Pourquoi ce mode avait été retiré, et pourquoi il peut revenir

La 2.6.0 l'avait livré par défaut **sans aucun moyen d'en sortir** : les
installations mises à jour restaient dessus, et il a fallu deux versions pour
revenir en arrière. Les deux raisons de ce retrait sont traitées :

* **la sortie** : l'appui long de 3 secondes est installé par `native-mode.js`
  lui-même (au niveau du document, 12 px de tolérance pour ne pas se déclencher
  pendant un défilement), donc le sélecteur est joignable dans les trois modes ;
* **la connexion** : mesurée, elle vaut celle du mode bureau (voir §10, suite).
  Et si un jour elle échoue — page de connexion refusée, région, panne — la
  sortie est le sélecteur : *interface d'origine* → se connecter → revenir à
  l'affichage mobile. Les cookies appartiennent à la WebView, pas au mode : la
  session suit le changement d'interface.

### Ce que l'affichage mobile fait de plus

`native-mode.js` (17 629 caractères, vérifié par `sync:android`) :

1. pose le `<meta name="viewport">` (`width=device-width`, zoom verrouillé) —
   filet, la page servie en déclare un ;
2. masque les bandeaux que Spotify réserve aux navigateurs mobiles ;
3. expose un `window.SpotiDuckUI` minimal qui **clique les vrais boutons de
   Spotify** (notification Android, écran verrouillé, boutons d'écouteurs) ;
4. alimente la notification par le pont `AndBridge` (titre, artiste, pochette,
   position) ;
5. ouvre le sélecteur d'interface sur appui long.

## 16. Le haut de la page mobile (v2.7.4)

Constat utilisateur, sur l'affichage mobile livré en 2.7.3 : « *Le bandeau tous
en haut est trop haut, c'est difficile d'appuyer dessus. Enlève aussi la partie
« ouvrir dans l'application » qui sert à rien.* » Deux problèmes, deux causes
distinctes.

### 1. La page dessinait sous la barre d'état

L'activité est en plein écran (`setDecorFitsSystemWindows(window, false)`) et
`native-mode.js` demandait `viewport-fit=cover` : la page, elle, est écrite pour
un **navigateur** — c'est-à-dire pour un cadre où le navigateur réserve déjà la
place des barres système. Résultat : sa barre du haut se retrouvait à moitié
sous la barre d'état. Elle paraît trop haute, et ses boutons tombent dans la
zone où l'appui ne part pas (il fait descendre la barre d'état).

Ce qui change :

* en mode mobile, l'application donne à la WebView une zone de rendu **à
  l'intérieur** des barres système : c'est le **conteneur** qui reçoit la marge,
  pas la WebView — réduire la WebView elle-même rognait le haut de la page sur
  certaines versions ;
* les insets sont **consommés** après ça, pour que la page ne réserve pas la
  barre d'état une seconde fois (`env(safe-area-inset-top)` vaut alors 0) ;
* `viewport-fit=cover` est retiré du viewport de la page : c'est précisément lui
  qui l'invitait à dessiner dessous ;
* les deux autres interfaces ne bougent pas : elles restent plein écran et
  réservent la place elles-mêmes (`env(safe-area-inset-*)` et
  `--sd-safe-*-override`), l'application se contentant de leur transmettre les
  valeurs mesurées. Le sélecteur réapplique les marges au changement de mode.

### 2. « Ouvrir dans l'application » : traqué par son texte

Ce bandeau renvoie vers `spotify:` ou vers une fiche de magasin d'applications.
Dans cette application il ne mène nulle part — il n'y a pas d'« application
Spotify » à ouvrir, c'est l'application elle-même. Les sélecteurs par attributs
de `native-mode.js` ne l'attrapaient pas : Spotify les renomme d'une version à
l'autre, alors que le texte, lui, ne change pas. D'où un second balayage, par
**texte** (`APP_PROMPT_TEXT`) et par **destination** des liens (`spotify:`,
`market:`, `intent:`, Play Store, App Store, `/download`).

Ce qu'il masque est borné, parce qu'enlever trop serait pire que laisser :

* un bandeau qui ne porte **que** l'invite (au plus un élément cliquable à
  l'intérieur) part en entier ;
* une barre qui porte aussi les commandes de la page n'en perd **que** l'invite
  — le logo, la recherche et le profil restent ;
* un conteneur qui porte plus d'un élément cliquable n'est jamais pris pour un
  bandeau d'invite ;
* un lien vers le magasin sans texte d'invite et sans bandeau autour n'est pas
  touché : ça peut être un simple lien de la page.

Le balayage est relancé au chargement, puis à 0,4 s / 1,5 s / 4 s et toutes les
2 s (900 éléments au plus, un motif court) : Spotify repose ce bandeau à chaque
changement d'écran. `npm run audit` refuse un `native-mode.js` qui n'aurait plus
ce balayage — c'est-à-dire un bandeau d'invitation qui reviendrait sans que rien
ne le signale.

### 3. Ce que la sonde dit maintenant

`Diagnostic` (sélecteur d'interface) gagne trois mesures qui portent exactement
sur ces deux points :

* **ce qu'il y a sous les six premiers pixels** de la page — si c'est le bandeau
  du haut, il est bien à l'écran ; s'il est absent, la page commence ailleurs ;
* **la place que la page réserve elle-même pour la barre d'état** (mesurée en
  posant un élément de la hauteur de `env(safe-area-inset-top)`) : 0 = la page
  est bien à l'intérieur des barres ;
* **le nombre d'invitations « ouvrir dans l'application »** présentes puis
  retirées.

Tests : 70/70 (`npm run smoke`), dont deux nouveaux cas — un bandeau dédié, aux
attributs inconnus, doit disparaître ; la barre du haut d'une page, qui porte
aussi ses commandes, doit survivre.

## 17. Le bouton Bibliothèque, et les invitations à l'abonnement (v2.7.5)

Deux constats, arrivés ensemble après la 2.7.4 : « *le bouton bibliothèque ne
fait rien* » et « *enlève tous les popups pour l'abonnement ainsi que le bouton
en bas pour l'abonnement* ».

### Le bouton Bibliothèque : une règle trop large de la 2.7.4

Le balayage « ouvrir dans l'application » introduit en 2.7.4 traitait **tout**
lien `spotify:` comme une invitation. Or la barre du bas de la page mobile en est
pleine : Spotify s'en sert pour ses propres onglets (`spotify:collection` **est**
l'onglet Bibliothèque). Deux dégâts possibles, selon la façon dont la barre est
construite :

* l'onglet lui-même était masqué (`display:none !important`) : l'icône reste
  parfois visible, mais il n'y a plus rien à toucher — « le bouton ne fait
  rien » ;
* ou, s'il n'était pas masqué, le tap partait sur un lien que **la WebView ne
  sait pas ouvrir** : `shouldOverrideUrlLoading` avalait le `spotify:` pour
  éviter une page d'erreur, et il ne se passait donc rien.

Les deux sont corrigés, et de façon vérifiable :

1. **Un lien `spotify:` n'est plus une preuve.** Il ne compte comme invitation
   que si le texte de ce qui l'entoure (cinq niveaux, 160 caractères au plus) dit
   explicitement « ouvrir dans l'application ». Un onglet de navigation survit
   donc toujours. `tools/audit-links.mjs` refuse désormais un `native-mode.js`
   où `spotify:` suffirait de nouveau à masquer un élément.
2. **Les onglets `spotify:` sont convertis en adresses web** au lieu d'être
   avalés : `spotify:collection` → `/collection`, `spotify:library` →
   `/collection`, `spotify:search:mot` → `/search/mot`, `spotify:user:ID` →
   `/user/ID`. Le garde-fou reste en place pour tout le reste — mais il **note**
   ce qu'il avale, et la sonde l'affiche (« dernier lien : converti … -> … » ou
   « ignore … »).
3. Les barres de navigation (`<nav>`, `role="navigation"`, ou barre collée
   portant au moins trois commandes) sont protégées explicitement : on ne masque
   jamais que l'élément lui-même, et seulement s'il dit lui-même ce qu'il est.

### Les invitations à l'abonnement

Même mécanisme que le bandeau, avec ses propres motifs — des phrases, parce que
le texte ne change pas d'une version à l'autre : *passer à Premium*, *essai
gratuit*, *s'abonner*, *souscrire*, *découvrez Premium*, *musique en aléatoire*,
*interruptions publicitaires*, *sans publicité*… et les liens vers `/premium`.

Ce que ça enlève :

* les **fenêtres** d'abonnement : ce qui les entoure est masqué en entier ;
* le **bouton de la barre du bas** (`Premium`, ou tout élément qui mène aux
  offres) : dans une barre, seul l'onglet disparaît, la barre reste ;
* les encarts déjà couverts par attribut (`premium-upsell`,
  `premium-upsell-dialog`, `upgrade-to-premium`, `upsell-dialog`…).

Ce que ça ne touche pas : un lien ordinaire de la page, un onglet Accueil /
Rechercher / Bibliothèque, une étiquette « Premium » qui ne mène nulle part,
et toute barre de navigation en tant que telle.

### Ce que la sonde dit maintenant

`Diagnostic` (sélecteur d'interface) gagne trois lignes de plus :

* **navigation** — les entrées des barres, leur `href`, et `(masque)` si l'une
  d'elles n'est plus visible : c'est ce qui distingue « onglet masqué » de
  « lien avalé » ;
* **invitations premium** — présentes, puis retirées ;
* **dernier lien** — ce que l'application a fait du dernier lien non-web :
  converti (avec la conversion) ou ignoré. C'est la seule trace d'un tap qui
  n'aurait rien déclenché.

## 18. L'offre du démarrage, et les onglets qui ne répondaient pas (v2.7.7)

### 1. La fenêtre « Premium à 0 € » survivait au balayage

Elle a exactement les caractéristiques qui la rendaient invisible pour la
2.7.5 : une **croix de fermeture**, **deux boutons** et un **prix** — donc trois
éléments cliquables (le filtre refusait d'aller plus loin au-delà de deux), son
texte ne ressemblait à aucun des motifs élevés (« passer à Premium », « essai
gratuit »…), et elle ne portait aucun identifiant technique connu.

Trois corrections :

* **Un troisième niveau de motifs : le prix.** `MONEY_TEXT` reconnaît
  `0 €`, `0,00 €`, `€ 0`, `gratuit pendant`, `3 mois offerts`, `% de
  réduction`, `économisez`, `profitez de`… Un prix, à lui seul, ne prouve rien :
  la page en parle aussi dans ses conditions. Mais **dans une fenêtre posée
  par-dessus la page**, c'en est une preuve — c'est précisément ce que fait
  cette offre.
* **La fenêtre est reconnue comme telle** : `overlayAncestor` remonte six
  niveaux à la recherche de `role="dialog"`, `aria-modal="true"`, d'un nom qui
  parle de fenêtre (`modal`, `dialog`, `overlay`, `pop-up`, `upsell`, `sheet`) —
  ou, à défaut, d'un bloc en position `fixed`/`absolute` qui couvre au moins 60 %
  de la largeur et 35 % de la hauteur de l'écran. Une barre de navigation ne peut
  pas y répondre : elle est large mais basse.
* **Ce qui est masqué, c'est la fenêtre entière**, marquée
  `data-sd-premium-dialog` : la croix, les deux boutons, le fond assombri — pas
  seulement le texte. Le garde-fou qui comptait les éléments cliquables ne
  s'applique plus à ce chemin-là, précisément parce que les fenêtres en ont
  plusieurs.
* Les identifiants techniques qui contiennent `premium`, `upsell` ou `upgrade`
  sont masqués d'office (`[data-testid*='premium' i]`…), en plus des noms fixes.

### 2. Le bouton Bibliothèque, deuxième round

La 2.7.5 avait corrigé une erreur réelle (un lien `spotify:` ne suffit plus à
faire disparaître un onglet) et converti les onglets `spotify:` en adresses web.
Ce n'était pas suffisant : l'appui ne produit toujours rien. Trois causes
possibles restent, et aucune n'est visible depuis la page :

* **a.** le script de Spotify intercepte le clic avant que la WebView ne voie la
  navigation — notre conversion ne sert alors à rien ;
* **b.** l'onglet est un **bouton**, sans lien, et le routeur de Spotify ne fait
  rien dans une WebView ;
* **c.** la navigation aboutit, mais la page ne peint rien.

Une seule méthode couvre les trois : **si l'appui ne produit rien, c'est
l'application qui navigue.** C'est ce qu'ajoute la section 2-ter de
`native-mode.js` :

* au clic, on note l'onglet touché, ce qu'il désignait et l'adresse avant
  (`window.__sdNavTap`) ;
* au bout de **1,2 s**, si l'adresse n'a pas bougé et si l'onglet désigne une
  autre adresse, l'application fait la navigation elle-même
  (`location.assign`) — dans le cas (c), la page est simplement rechargée sur la
  bonne adresse ;
* l'onglet peut être un lien **ou** un bouton : `routeForNav` lit d'abord le
  lien (`spotify:collection`, `spotify:library` → `/collection` ;
  `spotify:search` → `/search`; `spotify:home` → `/`), et à défaut **ce que
  l'onglet raconte** (« Bibliothèque », « Library », « Ma musique » →
  `/collection` ; « Rechercher » → `/search` ; « Accueil » → `/`).

C'est vérifié par le banc d'essai : un onglet sans lien, libellé
« Bibliothèque », reçoit bien `/collection`, et la navigation est reprise par
l'application quand la page ne bouge pas.

### 3. Ce que la sonde dit de plus

* **fenêtres d'offre** encore présentes ;
* **dernier onglet** : libellé, lien, adresse visée, adresse avant et après, et
  `-> force /collection` si l'application a dû reprendre la navigation. C'est la
  ligne qui tranche entre les cas (a), (b) et (c).

### 4. L'agent mobile passe à Chrome 150

Le mode mobile annonçait Chrome **124** (2024) tout en étant mesuré en CI avec
Chrome 150. C'était un reste du passé : la page mobile est servie à un agent
récent, et un agent périmé n'obtient pas forcément les mêmes ressources. L'agent
du mode mobile suit maintenant la version avec laquelle la page a été mesurée.
L'agent de bureau, lui, ne bouge pas : l'interface d'origine et l'empreinte
1920×1080 s'appuient dessus.

## 19. Les annonces audio, passées en silence (v2.7.8)

Un utilisateur demande pourquoi l'application d'origine « avait des fonctions
Premium ». Elle n'en avait pas : elle avait un **bloqueur**, et il était
meilleur que le nôtre sur un point.

### Ce que faisait l'application d'origine

Sa documentation est explicite (`DOCS.md`, bloc `classic mode`) :

* régies et traqueurs (`doubleclick.net`, `googlesyndication.com`,
  `fastly-insights.com`, `sentry.io`…) → **réponse vide** ;
* annonces **audio** (`akamaized.net/audio/`, `scdn.co/audio`,
  `mp3ad.scdn.co`, `spotifycdn.com/audio/`, `amillionads.com`, `2mdn.net`,
  `adxcel.com`, `adstudio-assets.scdn.co`) → le type de contenu est regardé, et
  si c'est de l'audio (`audio/mpeg`), la réponse est remplacée par
  **`assets/silent.mp3`** — le fichier de silence embarqué dans son APK ;
* `podz-content` et `gew4-spclient` ne sont **jamais** bloqués : ce sont les
  serveurs de lecture.

Le détail qui compte : la musique n'est pas servie en `audio/mpeg`. Ce
content-type est celui des annonces, et c'est lui qui distingue les deux — pas
l'adresse.

### Ce qui change ici

Jusqu'ici, une annonce audio se voyait répondre « rien ». Le lecteur attendait
un fichier : il pouvait rester en attente, réessayer, ou sauter. Maintenant :

1. `AdBlocker.isAdAudio(url)` reconnaît les adresses d'annonces (et **exclut
   toujours** `podz-content` / `gew4-spclient`) ;
2. `sniffContentType()` va voir le type de contenu — la réponse est jetée, la
   WebView refait la sienne, exactement comme l'original ;
3. si c'est de l'audio, `silentResponse()` sert `assets/silent.mp3` : 22 secondes
   de silence, 90 396 octets, 22,05 kHz mono 24 kbit/s, fabriqué par
   `tools/make-silence.mjs` (lamejs, dev uniquement) ;
4. sinon — et si la vérification n'a pas pu aboutir (réseau, délai) — on bloque
   comme avant. **Rien n'est remplacé sur une incertitude.**

Les réponses vides portent désormais `Access-Control-Allow-Origin: *`, comme
celles de l'original : sans cet en-tête, la page laisse une erreur dans la
console à chaque requête bloquée.

`tools/sync-android.mjs` refuse un `silent.mp3` qui n'est pas un MP3 ou qui
sort de 8–400 ko ; `tools/audit-links.mjs` refuse un `AdBlocker` qui ne sert
plus le silence, qui ne distingue plus `audio/mpeg`, ou qui a perdu l'exclusion
des serveurs de lecture (les bloquer, c'est faire taire toutes les musiques).

### Ce que la sonde en dit

`Diagnostic` (sélecteur d'interface) affiche maintenant, à la fin :

* **publicités muettes** — le nombre d'annonces réellement remplacées ;
* **hôtes bloqués** — la taille de la liste chargée ;
* **blocage** — le dernier remplacement, avec son type de contenu et son
  adresse.

C'est la trace qui permet de voir si le blocage touche autre chose que de la
publicité : si une musique se taisait, elle apparaîtrait ici.

## 20. La session qui survit à la mise à jour, et la connexion qui marche (v2.7.9)

Deux demandes, une seule cause commune : **la WebView garde ses cookies en
mémoire et les écrit quand elle veut.**

### 1. « Quand je fais la mise à jour, mon compte reste connecté »

Une mise à jour d'application **tue le processus** avant de le relancer. Tout ce
que la WebView n'avait pas encore écrit sur le disque est perdu — y compris les
cookies de session que Spotify vient de poser. Rien n'était effacé par
l'application (elle n'appelle jamais `removeAllCookies`) : c'est l'écriture qui
arrivait trop tard.

Trois mesures, dans `MainActivity` :

* **écrire au bon moment** — `flushCookies()` à la fin de chaque page du lecteur,
  à la connexion détectée, à la mise en pause et à l'arrêt. Avec un garde-fou de
  trois secondes pour ne pas écrire trois fois la même seconde ;
* **garder une copie de secours** — `saveCookies()` range l'en-tête `Cookie` des
  trois hôtes (`open.`, `accounts.`, `api.spotify.com`) dans les préférences
  privées de l'application, **seulement** s'il contient `sp_dc=` (le cookie qui
  porte la session) ;
* **la remettre si la WebView n'a plus rien** — `restoreCookies()`, appelée avant
  le chargement de la page : si `sp_dc` manque, chaque cookie est réécrit avec son
  domaine (`Domain=.spotify.com`), sa durée et `Secure; SameSite=None`. Une
  session déjà présente n'est **jamais** écrasée : au pire, Spotify vient de la
  rafraîchir.

La copie vit dans le dossier privé de l'application et n'est pas exportée :
c'est le même compromis qu'un profil de navigateur, pour la session de la
personne qui l'a ouverte, sur son propre téléphone.

`tools/audit-links.mjs` refuse désormais : un `removeAllCookies`, la disparition
d'un des trois mécanismes, la restauration qui n'aurait plus lieu avant le
chargement, ou l'écriture qui ne serait plus faite à la pause et à l'arrêt.

### 2. « Fais en sorte que le système de connexion fonctionne »

Le problème de fond de la page de connexion de Spotify dans une WebView : elle
met en avant **Google, Apple, Facebook**… et Google refuse d'ouvrir son OAuth
depuis un navigateur embarqué (`disallowed_useragent`). Sans rien, on arrive donc
sur une page où **aucun** des boutons proposés ne peut aboutir.

C'est exactement ce que l'application d'origine avait réglé, et de la façon la
plus simple : un bouton « Email + Password Classic Login » inséré dans la page,
pointant vers `?allow_password=1` — le paramètre qui force Spotify à afficher son
formulaire. Repris ici, en français, avec trois différences :

* le bandeau n'apparaît **que** si aucun champ de mot de passe n'est déjà à
  l'écran (dès que le formulaire est là, il disparaît) ;
* il ne s'affiche que sur `accounts.spotify.com` et sur les chemins de connexion ;
* il est **masquable** (« Masquer ») et ne revient plus de la session — c'est
  notre bandeau, pas celui de Spotify, et personne n'a à le subir.

Ajouté aussi : le consentement **Facebook**. Quand on passe par Facebook,
Facebook affiche d'abord son propre écran de consentement ; l'application
d'origine cliquait le premier bouton de cette page (et seulement de celle-là).
Même chose ici.

Tests : 78/78, dont trois sur la connexion (bandeau sur une page sans formulaire,
disparition dès que le champ apparaît, rien sur la page du lecteur). Audit
0 erreur.

### 3. Ce que la sonde en dit

`Diagnostic` finit maintenant par l'état de la session : **`sp_dc` présent ou
absent**, et **copie de secours oui ou non**. C'est la réponse directe à « est-ce
que je vais devoir me reconnecter après la prochaine mise à jour ? ».

## 21. Les fonctionnalités de SpotiDuck : widget et Android Auto (v2.8.0)

Demande : « reprends toutes les fonctionnalités de SpotiDuck ». Sa propre page
en annonce cinq, plus deux réglages. Voici où chacune en est, sans arrondir.

| Fonctionnalité annoncée | État |
| --- | --- |
| Blocage de publicité intégré | déjà là : 1 314 hôtes au niveau réseau, et les annonces **audio** remplacées par du silence (§19) |
| Contrôles média | déjà là : notification (précédent, lecture/pause, suivant) et mini-lecteur dans l'habillage |
| Session média sur l'écran verrouillé | déjà là : `MediaSessionCompat` (pochette, titre, artiste, avance) |
| Service d'arrière-plan | déjà là : service de premier plan + verrous d'éveil, démarrés par la page |
| **Widget** | **ajouté** : `PlayerWidget` |
| **Android Auto** | **ajouté** : `PlaybackService` est un `MediaBrowserServiceCompat` |
| Réglages de compatibilité / échelle de l'agent | le sélecteur d'interface **est** ce réglage : chaque mode est un agent et une mise en page |
| Liste de blocage personnalisée | **ajouté** : `custom_blocklist.txt` dans les fichiers privés |

### Le widget

`res/layout/widget_player.xml` : pochette, titre, artiste, et trois boutons
(précédent, lecture/pause, suivant). Le quatrième quart du travail est ailleurs :

* **une seule route** — les boutons du widget envoient les **mêmes actions** que
  la notification, au même service (`ACTION_PLAY`, `ACTION_PAUSE`…). Deux chemins
  différents seraient deux endroits où ça casse ;
* **le service redessine** — `PlaybackService.render()` appelle
  `PlayerWidget.refresh()`, au même moment qu'il met à jour la notification. Le
  widget ne se réveille donc jamais tout seul (`updatePeriodMillis = 0`) ;
* **l'état vient de la page** — la musique est décodée par le lecteur web : ni le
  widget ni le service ne lisent quoi que ce soit ;
* la pochette n'est affichée que si elle est **déjà en mémoire** (elle est chargée
  pour la notification) : pas de téléchargement déclenché par un widget.

### Android Auto

Auto ne cherche pas une application : il cherche un **service de navigation
média**. `PlaybackService` étend donc `MediaBrowserServiceCompat`, publie le
jeton de sa session (`sessionToken = session.sessionToken`) — la même session que
l'écran verrouillé — et répond « rien » à la navigation (`onGetRoot` /
`onLoadChildren`) : la file d'attente appartient à la page, pas au service.
Le manifeste déclare l'action `android.media.browse.MediaBrowserService` et le
`automotive_app_desc.xml` (`<uses name="media" />`).

Ce qui n'est pas vérifiable ici : Auto n'existe pas dans un émulateur sans son
application. Ce qui est vérifié : le service, la session publiée, la déclaration
au manifeste, et le fait que le build passe.

### La liste de blocage personnalisée

Un fichier `custom_blocklist.txt` déposé dans le dossier privé de
l'application (même format que la liste publiée : un hôte par ligne, `#` pour
les commentaires) **ajoute** des hôtes. Deux garde-fous :

* une liste ne peut **pas retirer** un hôte de la liste publiée — elle ajoute,
  c'est tout ;
* `podz-content` et `gew4-spclient` sont exclus dans le code (`isBlocked`), pas
  dans le fichier : **aucune** liste, même la plus agressive, ne peut couper la
  musique. C'est exactement l'avertissement que SpotiDuck donne à ses
  utilisateurs (« des filtres trop agressifs peuvent bloquer des adresses
  essentielles ») — ici, c'est impossible par construction.

### La connexion, encore

Le raccourci « e-mail et mot de passe » (§20) vaut maintenant pour **les deux**
portes d'entrée de Spotify : `accounts.spotify.com/fr/login`, et
`open.spotify.com/login` — plus la page d'accueil déconnectée de
`open.spotify.com`, qui n'affiche qu'un bouton « Se connecter ». Il s'efface dès
qu'un champ de mot de passe ou la barre de navigation apparaît. La session est
enregistrée sur les deux domaines (c'est `accounts.spotify.com` qui pose le
cookie, `open.spotify.com` qui s'en sert).

## 22. « Le système de connexion Google fonctionne ? » — mesuré, puis corrigé (v2.8.1)

Question posée telle quelle. Réponse en deux temps : ce qui se mesure, et ce qui
manquait **de notre côté**.

### Ce qui se mesure

Google refuse son OAuth aux navigateurs embarqués — c'est une politique, pas un
bug. Sa décision se prend sur l'**agent annoncé**. Le workflow
`inspect-page.yml` compare donc trois agents sur la page de connexion de Google :
un vrai agent de WebView (`; wv`), l'agent du mode mobile (Chrome Android, sans
`wv` — c'est celui de l'application), et un agent de bureau. Résultat :

| Agent | Réponse de Google |
| --- | --- |
| vrai agent de WebView (`; wv`) | page de connexion normale · **aucun blocage** |
| agent du mode mobile (celui de l'application) | page de connexion normale · **aucun blocage** |
| agent de bureau | page de connexion normale · **aucun blocage** |

Autrement dit : la page d'entrée n'est pas refusée. Cela ne garantit pas que
**toute** la suite du parcours passe (Google vérifie peut-être plus loin, et
certaines étapes dépendent du compte), mais le refus systématique qu'on lit
partout n'apparaît pas ici.

### Ce qui manquait de notre côté, en revanche

`setSupportMultipleWindows(false)` était réglé pour garder les `target="_blank"`
dans l'application. Conséquence non voulue : **`window.open` ne faisait rien du
tout**. Or « Continuer avec Google » passe souvent par là chez Spotify — d'où un
bouton qui semblait mort, indépendamment de Google.

Deux corrections, qui se complètent :

* `MainActivity` : `setSupportMultipleWindows(true)` et un `onCreateWindow` qui
  charge la destination **dans la vue courante**. L'utilisateur ne quitte pas
  l'application, la session et les cookies restent les mêmes, et le retour de
  connexion retombe au bon endroit ;
* `native-mode.js` : `window.open(url)` ramène l'adresse dans la page
  (`__sdNavigate`), `about:blank` excepté. Vérifié par un test.

### Ce qui reste vrai

* **e-mail / mot de passe** : c'est le chemin fiable, et il est maintenant
  affiché partout où il manque (§20) ;
* **si votre compte a été créé avec Google**, il n'a peut-être pas de mot de
  passe : passez par « Mot de passe oublié » sur la page de connexion pour en
  définir un — ensuite tout passe par l'application ;
* **une seule connexion suffit** : la session est écrite sur le disque et gardée
  en secours (§20), donc les mises à jour suivantes ne redemandent rien.

## 23. La connexion refaite : ce qui la cassait, et ce qui la tient (v2.9.0)

Constat utilisateur : « le système de connexion est vraiment bancal », avec deux
symptômes précis — **déconnecté à chaque mise à jour**, et **« e-mail ou mot de
passe incorrect »** avec une connexion qui rame.

Rien de tout cela ne se répare à l'aveugle, alors les deux pages de connexion de
Spotify ont d'abord été **mesurées** : un vrai Chrome sans tête, lancé en CI avec
l'agent exact de l'application, qui remplit les formulaires, clique les boutons et
lit la réponse HTTP du serveur.

### Ce que la mesure a établi

| Page | Ce qu'elle sert avec l'agent de l'application |
| --- | --- |
| `accounts.spotify.com/fr/login` | **pas de champ mot de passe** — l'e-mail seul, puis les boutons Google / Facebook / Apple, et l'encart « Ce site est protégé par reCAPTCHA » |
| `accounts.spotify.com/fr/login?allow_password=1` | **les deux champs** (e-mail **et** mot de passe) |
| `open.spotify.com/login` | **404** — l'adresse utilisée jusqu'ici par l'habillage maison menait à une page d'erreur |
| Clic « Continuer avec Google » | ouvre `accounts.google.com/v3/signin/identifier?client_id=1046568431490-…&redirect_uri=https://accounts.spotify.com/login/google/redirect` |
| `accounts.google.com/signin/v2/identifier`, agent de WebView | page de connexion **normale** (aucun `disallowed_useragent` sur cette page-là) |

### Les quatre défauts trouvés dans le code

1. **La copie de secours fabriquait des doublons.** Les cookies étaient
   sauvegardés en **une seule chaîne** puis réinjectés sur chacune des trois
   adresses avec `Domain=.spotify.com` : un cookie déjà présent sous une autre
   portée (hôte seul d'un côté, `.spotify.com` de l'autre) devenait **deux
   cookies du même nom** — et le serveur en lit un au hasard. C'est exactement le
   mécanisme qui fait répondre « e-mail ou mot de passe incorrect » à une
   connexion par ailleurs valable, et il explique le côté erratique
   (« des erreurs à des moments »).
2. **La copie était écrite avec `apply()`** — « plus tard ». Une mise à jour tue
   le processus : le « plus tard » n'arrive jamais. La session est maintenant
   écrite **par adresse**, en une fois, avec `commit()` (synchrone).
3. **Une copie qui ne ramenait rien était gardée.** Réinjectée à chaque
   lancement, elle rendait la panne permanente. Désormais : une copie qui ne
   ramène pas la session est **jetée** — et une déconnexion demandée par
   l'utilisateur jette la copie aussi, pour ne pas le reconnecter d'office.
4. **`window.open` était remplacé** (le correctif 2.8.1). La mesure a montré que
   la connexion Google passe par une **vraie fenêtre** : la page appelle
   `window.open(...)` et attend que cette fenêtre lui rende la main par
   `window.opener`. En chargeant l'adresse dans la vue courante, le lien entre
   les deux pages était rompu, et le retour de connexion n'arrivait jamais.

### La connexion telle qu'elle se comporte maintenant

* **Une vraie fenêtre** pour Google, Apple et Facebook : une seconde WebView
  posée par-dessus la première, même profil (donc mêmes cookies), même agent,
  tiers cookies acceptés, refermée par la page elle-même (`onCloseWindow`), et
  bouton *Fermer* + bouton retour matériel en secours ;
* **le retour de connexion est repris** : dès qu'une fenêtre revient sur
  `open.spotify.com`, la session est rangée, la fenêtre fermée et la vue
  principale rechargée ;
* **un refus de Google est expliqué en français**, avec la seule porte qui
  reste — « Utiliser mon e-mail et mon mot de passe » — au lieu d'une page
  d'erreur anglaise ;
* **la page est juge de l'état de connexion** : `native-mode.js` annonce `in`,
  `out` ou `login` à l'application (`AndBridge.loginState`). Le cookie dit qu'une
  session a existé, la page dit si elle vaut encore quelque chose ;
* **récupération automatique, une seule fois**, dans les 45 premières secondes
  d'un lancement : si le pot a perdu la session et qu'une copie valable existe,
  elle est remise et la page rechargée ;
* **erreur du formulaire** : le bandeau propose « Réessayer proprement », qui
  expire **uniquement** les cookies CSRF d'`accounts.spotify.com` (jamais `sp_dc`
  ni `sp_key`) puis recharge — parce qu'un jeton de page périmé produit lui aussi
  « e-mail ou mot de passe incorrect » ;
* **les boîtes de la page** (`alert`, `confirm`, `prompt`) sont affichées : sans
  client pour y répondre, une page qui en utilise une reste bloquée pour
  toujours, sans rien dire à l'écran.

### Et ce qui faisait « ramer »

* **reCAPTCHA ne doit jamais pouvoir être bloqué.** La page de connexion s'en
  sert (25 occurrences dans ses scripts) : une liste de filtres qui le coupe
  transforme le formulaire en « e-mail ou mot de passe incorrect ». `NEVER_BLOCK`
  couvre désormais reCAPTCHA, `gstatic.com/recaptcha` et `accounts.spotify.com` —
  un garde-fou de l'audit le vérifie ;
* **le reniflage de type des publicités audio** attendait jusqu'à 7 s et
  recommençait à chaque passage. 1,2 s, et le résultat est mémorisé ;
* **le balayage des encarts** tournait toutes les deux secondes quoi qu'il
  arrive. Il ne tourne plus que si la page a bougé (au pire toutes les 12 s), et
  jamais écran éteint — le contrôle de connexion non plus.

### Vérifications

84/84 tests (dont : le verdict de connexion sur les trois sortes de page, le
nettoyage ciblé après une erreur de formulaire, `window.open` laissé intact),
audit 0 erreur / 0 avertissement, et les nouveaux garde-fous : écriture
synchrone, absence de doublons, copie jetée quand elle ne ramène rien,
`window.open` jamais remplacé, refus de Google expliqué.

Deux outils gagnés au passage, parce que les deux erreurs de cette passe ont été
payées en CI avant d'être comprises :

* **aapt2 en local** (`npm i --no-save aaptjs3`, le binaire est dans le paquet :
  `bin/x64/linux/aapt2`) : `aapt2 compile --dir android/app/src/main/res -o /tmp/res.zip`
  dit en une seconde ce que la CI disait en trois minutes. C'est lui qui a montré
  la vraie faute : `unescaped apostrophe in string` — dans ce fichier, une
  apostrophe doit s'écrire `\'`, sinon le fichier ne compile plus du tout ;
* **un garde-fou d'audit** qui refuse désormais une apostrophe non échappée dans
  `strings.xml`, pour ne plus jamais l'apprendre par un échec de build.

## 24. « Lecture désactivée » : la page mobile, et rien d'autre (v2.9.1)

Le message vu au lancement était celui-ci, mot pour mot :

> **Lecture désactivée** — Spotify ne fonctionnera pas si vous bloquez le
> contenu protégé, si votre navigateur n'est pas compatible ou si vous utilisez
> un mode de navigation privée ou incognito. Ajustez vos paramètres de
> navigateur ou téléchargez plutôt notre appli gratuite pour mobile.

Trois causes possibles, une seule vraie. La sonde `probe-playback`
(`tools/probe-playback.mjs`, run `36028586893`) les a séparées en récupérant la
page **et tous ses scripts** pour deux agents.

### Ce que la mesure a établi

* le texte est un **libellé du lecteur web mobile** de Spotify :
  `mwp.playback.error.protected.content`, dans
  `mobile-web-player/fr.<hash>.json`, servi avec le paquet
  `mobile-web-player.<hash>.js` — donc **uniquement** à un agent de téléphone ;
* le lecteur web **bureau** (`web-player.<hash>.js`) ne contient ni ce libellé
  ni sa version anglaise : servi à un agent de bureau, il n'a rien à afficher de
  tel — c'est la page que le code d'origine recevait ;
* rien, dans nos filtres, ne bloque de serveur de lecture : les seuls hôtes
  `spotify.com` de la liste sont publicitaires (`audio-ads.spotify.com`), et
  `podz-content` / `gew4-spclient` sont explicitement intouchables (garde-fou
  d'audit) ;
* le libellé apparaît **après connexion** — la musique ne joue pas du tout, sur
  un compte gratuit, dans le lecteur mobile.

Autrement dit : l'application livrait par défaut la page web **mobile** de
Spotify (agent Android), et cette page-là ne lit rien. Le code d'origine, lui,
annonce un Chrome de bureau et reçoit la page bureau — d'où « je n'avais pas ce
message sur la version d'origine ».

### Ce qui change

* **le défaut est la page bureau, habillée par notre coque** (`MODE_INJECT`) :
  c'est la page que le code d'origine recevait, avec notre interface par-dessus
  (barre du bas, mini-lecteur, lecteur plein écran, feuilles). La page mobile
  reste proposée dans le sélecteur, avec un libellé honnête (« pas de lecture
  sans Premium ») ;
* **l'identité redevient cohérente** : `src/original/spotiduck-identity.js`
  reprend, **valeurs pour valeurs**, l'identité du script d'origine — agent
  Chrome Windows, `navigator.platform` `Win32`, client hints
  (`brands`, `mobile: false`, `platform: "Windows"`, x86 / 64 bits / Windows
  10.0.0), greffons, types MIME, chaînes GPU — **sans la géométrie** : la coque
  met la page en page sur la largeur réelle du téléphone, une fenêtre de
  1920 px la casserait. C'est ce mélange « agent Windows + `navigator` Android »
  que Spotify appelle « navigateur non compatible » ;
* la révision du mode par défaut (`UI_MODE_REV = 5`) fait oublier **une fois**
  l'ancien choix, pour que les installations mises à jour repartent sur le
  nouveau défaut, sans jamais toucher à un choix fait ensuite ;
* les libellés du sélecteur disent la vérité mesurée, et le sélecteur place le
  défaut en tête.

### Les garde-fous

* l'audit **exige** désormais `MODE_DEFAULT = MODE_INJECT` et **refuse**
  `MODE_DEFAULT = MODE_NATIVE`, avec la raison (le lecteur mobile bloque la
  lecture d'un compte gratuit) écrite à côté du test ;
* l'audit et `npm run sync:android` vérifient que l'identité livrée vient bien
  de `src/original/spotiduck-identity.js`, qu'elle porte les valeurs de
  l'original… et qu'elle **ne touche pas à la géométrie** — le contrôle lit le
  code **sans ses commentaires**, sinon une explication qui cite `innerWidth`
  le ferait échouer (erreur commise, puis corrigée, dans cette passe).

### Ce que la sonde a fini par dire, en quatre annotations

Deux exécutions de suite, GitHub a **coupé la fin** de la liste d'annotations :
le relevé navigateur, la moitié utile, n'arrivait jamais. La sonde ne publie donc
plus que quatre annotations (`Page servie`, `Où vit le message`, `Repères
techniques`, `Relevé navigateur`) — leçon à garder pour tout diagnostic futur
qui publie beaucoup.

| Constat | Mobile (agent téléphone) | Bureau (agent du code d'origine) |
| --- | --- | --- |
| Paquet servi | `mobile-web-player/mobile-web-player.6883d1fd.js` (6 scripts, 3 270 Ko) | `web-player/web-player.eb2d94d5.js` (8 scripts, 6 549 Ko) |
| « Lecture désactivée » | présent (`mwp.header.playback.error`) | **absent** |
| « …bloquez le contenu protégé… » | présent (`mwp.playback.error.protected.content`) | **absent** |
| Mise en page | aucun repère bureau | barre latérale + barre de lecture + accueil |
| `requestMediaKeySystemAccess('com.widevine.alpha')` | `ok` (Chrome du runner) | `ok` (Chrome du runner) |
| Bandeau à l'écran (sans connexion) | aucun | aucun |

Deux précisions qui comptent : le relevé « widevine = ok » est celui du **Chrome
de bureau du runner**, pas de la WebView du téléphone (qui, elle, n'expose pas
Widevine) — raison de plus pour faire lire la page **bureau**, dont la lecture
ne dépend pas de l'EME ; et le code EME existe dans les **deux** paquets, donc
sa seule présence ne dit rien de la lecture : c'est le *paquet* servi qui décide,
et c'est lui qui change avec l'agent.

### Vérifications

audit 0 erreur / 0 avertissement, smoke 84/84, ressources compilées par `aapt2`
en local avant le push (`187 266 o`), `npm run build` + `npm run sync:android`
avant le commit.

## 25. La page de connexion : l'écran d'accueil la recouvrait (v2.9.2)

Deux défauts, tous deux dans la coque, et tous deux invisibles tant que la
**page mobile** était le mode par défaut — c'est le passage à la coque (§24) qui
les a mis sous les yeux de l'utilisateur, sous la forme « l'interface de
connexion ne fait rien, je suis bloqué là ».

### 1. L'écran d'accueil se posait sur le formulaire

La coque s'injecte sur **toutes** les pages, `accounts.spotify.com` compris —
c'est voulu : c'est là qu'elle habille le formulaire et qu'elle propose la
connexion e-mail + mot de passe quand Spotify ne montre que les boutons sociaux.
Mais `Welcome.apply()` montrait l'écran d'accueil sur toute page reconnue comme
« page de connexion » :

```js
var show = !app && (login || marketing);   // avant : `login` = page de connexion
```

Sur `accounts.spotify.com`, `sd-login` est vrai, donc l'écran d'accueil (logo,
titre, bouton) **recouvrait le formulaire**, et son bouton menait à la page
déjà affichée : un appui ne changeait rien. L'utilisateur était bloqué sur cet
écran, sans autre issue que la touche retour.

Correction : l'écran d'accueil n'a de sens que sur la **page marketing du
lecteur**, quand personne n'est connecté et qu'il n'y a rien à remplir.

```js
var show = !app && !login && !LoginState.isLoginPage() && marketing;
```

Et son bouton ne se contente plus d'être un lien : il passe par la partie
native (`AndBridge.openLogin`, la même adresse chargée par la WebView), comme
celui de la page de connexion. Un appui qui n'aboutit pas ne laisse plus
l'utilisateur sur place.

### 2. La coque ne rapportait pas la session

Le contrat de session (passe 22) tient à ce que la page dise à Android dans quel
état elle est : `in` (connecté → la session est confirmée et rangée), `out`,
`login`. Le mode mobile le faisait ; **la coque, non** — elle n'envoyait que
`loginDetected`. Tant que le défaut était la page mobile, personne ne le voyait.
Depuis que la coque est livrée par défaut, l'application ne recevait plus
« connecté » : la session n'était donc ni confirmée ni rangée au moment de la
connexion, et une déconnexion volontaire n'était plus distinguée d'un lancement
sans session.

La coque tient maintenant **exactement** le contrat du mode mobile, mêmes trois
états et même silence quand elle ne sait pas (`login` sur la page de connexion,
`in` quand le lecteur est là, `out` sur la seule page marketing — jamais
`out` sur la page de connexion, où être déconnecté est normal).

### Les garde-fous

* audit : le bundle doit rapporter `loginState`, distinguer la page de connexion,
  et la condition de l'écran d'accueil être **tenue à l'écart** de cette page —
  le test lit la condition telle qu'elle est écrite (`var show = …`), pas une
  approximation ;
* smoke : trois tests neufs, dont un banc complet de la coque **sur
  `accounts.spotify.com/fr/login?allow_password=1`** — le formulaire est là, il
  n'est pas recouvert, la page rapporte `login` et jamais `out` ; plus l'appui du
  bouton d'accueil qui doit appeler `AndBridge.openLogin` (89/89).

### Vérifications

audit 0 erreur / 0 avertissement, smoke 89/89, ressources compilées par `aapt2`
avant le push, `npm run build` + `npm run sync:android` avant le commit.

## 26. La coque sur la vraie page : ce que la mesure a montré (v2.9.3)

Deux plaintes d'affilée — « le bouton ne fait rien, je suis bloqué à la
connexion » puis « les boutons ne sont pas comme notre version, rien n'est relié
à aucune action » — avaient la même racine : la coque n'a jamais été mesurée sur
la **vraie** page. Le smoke la vérifie sur une page **factice**
(`demo/mock/spotify.js`) : il valide sa logique, pas son habillage, et il ne
pouvait pas voir ce que l'utilisateur voyait.

D'où `tools/probe-coop.mjs` (+ `probe-coop.yml`) : la coque est chargée sur la
vraie page dans un vrai Chrome, exactement comme l'application le fait
(identité au début du chargement, coque à la fin), et **l'écran est renvoyé en
image**.

### Ce que la sonde a mesuré

| | Coque maison | Interface d'origine |
| --- | --- | --- |
| Script exécuté | oui (`window.SpotiDuckUI`, 78 160 car. de styles) | oui (`firstFuck`, `actPlayPause` = fonctions, 110 233 car. de styles) |
| Barre du haut | visible (412×56) | — (la sienne, `.npbtn`) |
| Onglets du bas | **masqués** (0×0 : `tabbar: false` par défaut) | — |
| Mini-lecteur | **masqué** (0×0, aucun morceau au lancement) | posé par son propre script |
| En-tête (`.sd-topbar`) | **masqué** (0×0) | — |
| Habillage du contenu Spotify | **non** : les cartes, la barre latérale et la barre de lecture restent ceux de Spotify (masqués ou bruts, jamais mis à l'échelle « téléphone ») | son propre habillage, mesuré complet |

Autrement dit : sur la vraie page, la coque ne laisse voir qu'une **fine rangée
d'icônes** au-dessus du contenu bureau de Spotify. C'est exactement ce que
l'utilisateur a décrit. Ses appuis, eux, fonctionnent (l'onglet Bibliothèque
ouvre bien la barre latérale en 412×675) — mais rien de visible ne le montre.

### La décision

Le défaut redevient **l'interface d'origine** (`MODE_ORIGINAL`, `UI_MODE_REV = 6`),
celle que l'utilisateur connaît et sur laquelle la lecture fonctionne : mesurée
complète sur la vraie page. La coque reste sélectionnable (appui long) et son
libellé dit la vérité — « habillage à finir » —, parce qu'elle demande une
reprise de ses styles **contre le DOM réel** de Spotify, pas un abandon.

### Ce que la sonde a appris sur l'outillage (à garder)

* **une annotation GitHub est coupée à 1 800 caractères** et le job n'en garde
  qu'une poignée (~15) : un diagnostic bavard perd sa fin, silencieusement ;
* **`gh run download` et `gh api …/jobs/<id>/logs` ne répondent pas** dans cet
  environnement (EOF) : le seul canal qui marche partout, ce sont les
  annotations — y compris pour une image, envoyée en **décimal**, morceau par
  morceau (`SHOT:<nom>:<i>/<n>:<octets>`), parce que `page.screenshot()` de
  Puppeteer rend un `Uint8Array` et non un `Buffer` (l'encodage base64 donnait
  une chaîne hostile aux annotations) ;
* **un appui peut naviguer** : toute mesure doit être protégée, sinon le contexte
  est détruit et c'est justement le résultat intéressant qui disparaît.

## 27. « Réutilise exactement notre UI » — la coque était cachée par son propre écran d'accueil (v2.9.4)

### Le reproche

> « Fais un ui propre là c'est le bordel. Réutilise exactement notre ui qui était
> sur notre projet. »

La 2.9.3 venait de livrer l'**interface d'origine** par défaut, sur la foi d'une
mesure de sonde (§26). L'utilisateur la refuse : il veut **notre** interface,
celle du projet — barre du haut (accueil · bibliothèque · recherche, logo au
centre, notifications · amis · profil), mini-lecteur complet à trois rangées,
raccourcis en deux colonnes, exactement comme `screenshots/` et `70-original.css`.

### La cause : ce n'est pas la mise en page, c'est l'écran d'accueil

Le §26 concluait « la coque ne laisse voir qu'une barre du haut ». C'était vrai,
mais la conclusion qu'on en a tirée était fausse. La mesure relevait en réalité
trois choses : l'écran d'accueil de la coque était **posé**, la classe
`sd-welcome-on` était présente, et cette classe — par conception — masque la
barre du bas, le mini-lecteur et l'en-tête :

```css
html.sd-mobile.sd-welcome-on .sd-layer .sd-mini,
html.sd-mobile.sd-welcome-on .sd-layer .sd-tabbar,
html.sd-mobile.sd-welcome-on .sd-layer > .sd-topbar { display: none; }
```

Autrement dit : la sonde mesurait la coque **recouverte par son propre écran
d'accueil**, et non une coque incapable de s'habiller. Pourquoi l'écran d'accueil
ne se retirait-il pas ? Parce qu'il n'était réévalué que sur les mutations du
**`<body>`** :

```js
welcomeObs.observe(document.body, { childList: true, subtree: false });
```

Or Spotify (comme le banc de démonstration) construit son lecteur **dans un
conteneur déjà en place**. Aucune mutation n'atteint alors les enfants directs de
`<body>` : l'observateur ne se réveille jamais, `Welcome.apply()` n'est plus
appelé, et l'écran d'accueil reste posé indéfiniment — par-dessus le lecteur. Le
même défaut frappait déjà la page de connexion en 2.9.2 (§25), il restait une
seconde moitié du problème.

### Le correctif

1. **Surveillance de toute la page** (`documentElement`, `subtree: true`) au lieu
   du seul `<body>` — un lecteur qui se construit dans un conteneur existant est
   désormais vu ;
2. **filet de sécurité borné** : dix réévaluations sur les vingt premières
   secondes, en chaîne de `setTimeout` (jamais un intervalle perpétuel — le banc
   refuse les boucles de sondage, et il a raison : elles vidaient la batterie
   dans les versions précédentes) ;
3. **appui d'onglet vérifié** : après un appui sur Accueil ou Recherche, si ni le
   chemin ni la route n'ont bougé au bout de 900 ms, la coque navigue elle-même
   (`location.assign("/search")` ou `"/"`), comme le fait déjà `native-mode.js`.
   C'est la réponse directe à « rien n'est relié » : un appui qui ne produit
   **rien** est traité comme une panne, plus comme un cas particulier.

Deux tests et deux garde-fous d'audit sont ajoutés, parce que leur absence est
exactement ce qui a laissé passer le défaut :

* `smoke` — le banc monte la coque **avant** le lecteur, dans un conteneur : la
  classe `sd-welcome-on` doit disparaître dès que le lecteur apparaît (90/90) ;
* `audit-links` — refuse que l'écran d'accueil cesse d'être surveillé sur toute
  la page, et qu'un appui d'onglet cesse d'être vérifié.

### La décision

Le défaut redevient **notre coque** : `MODE_DEFAULT = MODE_INJECT`,
`UI_MODE_REV = 7` — le passage à 7 fait que les installations existantes
retrouvent le défaut sans rien réinstaller (le mode mémorisé est ignoré tant que
sa révision est plus ancienne). Le sélecteur place la coque en tête, et son
libellé ne dit plus « habillage à finir » mais « (défaut) ». L'interface
d'origine et la page mobile restent sélectionnables.

La lecture ne change pas : `MODE_INJECT` s'appuie sur le **moteur d'origine**
(empreinte navigateur « bureau » + page bureau, voir §24) — c'est le même moteur
qui lit la musique, avec notre couche d'interface par-dessus.

### Deuxième couche : l'écran d'accueil se rendait vrai tout seul

Le banc a permis de voir, dans la coque elle-même, ce que la vraie page montrait
déjà : l'écran d'accueil restait posé. La cause n'était pas la surveillance, mais
le **critère** :

```js
var marketing = !!$('a[href^="/login"], a[href*="/login"]');
```

L'écran d'accueil de la coque contient lui-même des liens `/login` (son bouton
« Se connecter »), et la barre du haut aussi. Sur toute page **sans lecteur**, la
coque se « prouvait » donc à elle-même qu'elle était sur la page marketing de
Spotify : `show` devenait vrai, et l'écran d'accueil — qui masque la barre du
bas, le mini-lecteur et l'en-tête — recouvrait la coque définitivement. Mesuré au
laboratoire, en local, sur une page nue : `.sd-layer` construit, classe
`sd-welcome-on`, `haut/bas/mini/en-tête = MASQUÉ 0×0`. C'est exactement la
photographie que la sonde avait prise.

Le calcul passe désormais par `spotifyLoginLink()`, qui écarte les liens
appartenant à `.sd-layer` : seuls les liens **de Spotify** comptent. Le même
correctif vaut pour l'état de session (`LoginState.signedOut()`), où un faux
« déconnecté » pendant un chargement pouvait faire jeter une session valable —
ce que la 2.7.9 s'interdit.

### Et une erreur de mesure, corrigée

La sonde visait `http://127.0.0.1:5173/player.html` : ce chemin **n'existe pas**
(le banc est `demo/player.html`). Elle mesurait donc une page **404**, où — faute
de lecteur — l'écran d'accueil restait posé ; la conclusion du §26 (« la coque ne
laisse voir qu'une barre du haut ») portait ainsi, en partie, sur une page
d'erreur. Le banc du §26 n'était pas mesuré : il était inventé.

Leçon pour la suite, du même genre que celles du §26 : **une sonde doit vérifier
qu'elle mesure bien la page voulue** — un chemin faux, une redirection ou une
page d'erreur rendent des chiffres plausibles et une conclusion fausse.

## 28. « L'affichage n'est plus adapté à Android » : la page débordait de 388 px (v2.9.5)

### Le reproche

> « Y a rien qui va, l'affichage n'est plus adapté à Android etc. Reprend le code
> source de l'appli SpotiDuck pour la logique etc mais pour l'UI utilise notre code
> ptn c'est moche. »

### Ce que les versions précédentes n'avaient jamais mesuré

Toutes les mesures de la coque se faisaient dans **un navigateur de bureau à
412 px** : un Chrome desktop, où la page se met en page sur la largeur qu'on lui
donne, sans histoire. Une WebView, elle, est en `useWideViewPort` : tant qu'aucun
`<meta name="viewport">` n'est posé, elle se donne une largeur de mise en page de
**980 px** et dézoome pour la faire tenir. Ce n'est pas un détail de configuration
— c'est toute la différence entre « ça ressemble à une application » et « c'est un
site de bureau ».

La sonde mesure maintenant cette page-là (`telephone`, cible ajoutée) : mêmes
conditions que la WebView (mise en page large, densité réelle, écran tactile,
chaîne d'injection de l'application : identité puis meta en attente de
`document.head` à `onPageStarted`, meta et coque à `onPageFinished`).

Premier résultat, et il est net :

    mise en page=412px · contenu=800×731 · débordement=388
    débordants: div=800, div[data-testid=root].Root.global-nav=800, div.zXqm…=800,
                aside[now-playing-bar]=620, div[signup-bar]=620

La page fait **800 px de large dans un écran de 412** : deux fois plus large que
le téléphone. Le texte est rogné à droite, la page se fait glisser de côté. C'est
exactement ce que l'utilisateur décrit — et ce n'était pas la mise en page de la
coque (mesurée juste : barre du haut 412×56, mini-lecteur 412×132), mais **la page
de Spotify, que la coque n'adaptait pas**.

### La correction : reprendre la feuille de l'application d'origine

L'application d'origine fait tenir cette page bureau sur un téléphone avec une
feuille compacte — cinq règles décisives parmi une soixantaine, posées juste avant
`document.head.appendChild(st)` dans `C1356q3` :

```css
body{min-width:100%!important;min-height:100%!important}
div[data-testid=root]{--panel-gap:0!important}
#main-view+div,#main-view+div>div{overflow:hidden!important;width:auto}
#main-view+div>div>div>div:nth-child(2)>div{width:100vw!important}
div[data-testid=grid-container]{margin-inline:0!important;column-gap:0!important;overflow:hidden!important}
```

Notre coque ne les avait pas. C'est **du code de SpotiDuck pour la mise en page,
et notre coque pour l'interface** — mot pour mot ce que l'utilisateur demandait.

C'est donc un artefact **généré**, comme l'interface d'origine :

* `tools/build-original-fit.mjs` — extrait la feuille de
  `src/original/spotiduck-original.js`, la porte sous `html.sd-mobile .sd-root`
  (pour que nos propres feuilles gardent la main) et écarte la seule règle qui
  n'est pas de la mise en page (`*{transition:none}`, qui éteindrait aussi les
  transitions de la coque) ;
* `src/inject/05-original-fit.css` — 59 règles, chargées en premier ;
* `npm run build` refuse un écart entre la source et le fichier généré ;
* un test du banc et un garde-fou d'audit vérifient que les règles décisives sont
  là **et** qu'elles restent portées sous notre coque ;
* `75-fit.css` ajoute les filets de sécurité (rien de plus large que l'écran,
  enfants de grille ou de flex autorisés à rétrécir — `min-width: auto` est la
  cause classique d'un débordement dans une grille) et ramène dans l'écran les
  conteneurs de la page marketing, nommés par la mesure (800 px).

### Après

    telephone → débordement=0 · contenu=412×731
    accueil   → débordement=0 · contenu=412×731
    connexion → débordement=0 · contenu=412×915
    banc      → débordement=0 · contenu=396×799 (barre 412×56, mini 412×132)

### Leçon d'outillage, du même genre que celles du §26 et du §27

Le workflow de la sonde se déclenchait sur les changements de l'**outil**
(`tools/probe-coop.mjs`) mais jamais sur ceux de l'**interface** (`src/inject/**`) :
on relisait donc une annotation périmée en croyant mesurer la version qu'on venait
d'écrire. Il suit désormais `src/inject/**` et `dist/spotiduck-ui.js`.

**Une mesure ne vaut que si l'on sait sur quelle version elle a été prise.**

## 29. « La lecture de contenus protégés est désactivée » : la permission que la WebView n'accordait pas (v2.9.6)

### Le constat, sur le téléphone

Capture du 24/09 : la coque s'affiche correctement (barre du haut complète, logo
centré) — « Tous est bon sur la disposition » — mais le contenu du lecteur est
remplacé par l'écran de Spotify :

> **La lecture de contenus protégés est désactivée** — Consultez le site d'aide
> Spotify pour savoir comment activer la lecture dans votre navigateur.
> [Service D'assistance Spotify]

Ce n'est pas un pop-up décoratif : c'est le **moteur de lecture** qui refuse de
démarrer. Et ça n'avait rien à voir avec l'affichage.

### La cause : une permission refusée par défaut

Une WebView ne sait déchiffrer un flux protégé que si l'application le lui
**accorde explicitement** : Chromium demande la permission
`RESOURCE_PROTECTED_MEDIA_ID` (« contenu protégé ») au `WebChromeClient`, et
**refuse par défaut** quand la méthode `onPermissionRequest` n'est pas
implémentée — sans erreur, sans trace, sans message. Notre `SpotiChrome` gérait
les fenêtres (`onCreateWindow`), les boîtes de dialogue (`onJsAlert`…) et la barre
de progression, mais pas cette permission-là. Android refusait donc Widevine, et
Spotify concluait que le navigateur ne sait pas lire le contenu protégé.

Le silence de la WebView était la panne. Rien dans la page, dans les feuilles de
style ou dans la couche d'interface ne pouvait le réparer — c'est ce qui a rendu
le diagnostic long : le symptôme (un écran de Spotify) désignait la page, alors
que la cause était côté application.

### Le correctif

```kotlin
override fun onPermissionRequest(request: PermissionRequest) {
    val resources = request.resources ?: emptyArray()
    val granted = resources.filter { it == PermissionRequest.RESOURCE_PROTECTED_MEDIA_ID }
    if (granted.isEmpty()) {
        request.deny()
        return
    }
    request.grant(granted.toTypedArray())
}
```

On accorde **exactement** le contenu protégé (et on refuse le reste : caméra,
microphone, géolocalisation — la page n'en a pas besoin). Deux garde-fous sont
posés pour que ça ne se reperde pas : un test du banc (la permission est
implémentée, la bonne ressource est demandée, le reste est refusé) et un
garde-fou d'audit.

### Ce que ça change

* le lecteur ne se remplace plus par l'écran « contenus protégés » ;
* la lecture redevient possible sur les flux chiffrés — c'est-à-dire la musique.

La leçon rejoint celle des §26-28 : **avant de corriger l'interface, il faut
savoir qui parle**. Ici, l'écran venait de Spotify, mais la décision venait de
notre `WebChromeClient`.

---

## §30 — L'affichage suit l'appareil, et rien ne reste invisible (v2.9.7)

Deux reproches, une seule passe :

> « L'affichage général de l'application est pas encore adapté à l'appareil. »
> « Il y a aussi plein de bugs d'affichage : des trucs qui n'apparaissent pas. »

### 1. L'unité d'interface était figée

`--sd-u` dimensionne **tout** : hauteurs de barres, typographie, pochette du
mini-lecteur, feuilles, lecteur plein écran. Elle valait `1` — la même interface
pour un téléphone de 360 px et une tablette de 800 px, avec un réglage manuel
(compact / normal / large) pour compenser les écarts entre appareils.

Elle est maintenant **mesurée** à chaque démarrage :

    --sd-u = --sd-u-base × --sd-density
    base   = clamp(0,92 ; min(largeur / 412 ; hauteur / 915) ; 1,15)

| appareil          | base |
| ----------------- | ---- |
| 360×800           | 0,92 |
| 412×915           | 1,00 (référence du projet) |
| 480×1040          | 1,14 |
| 800×1280          | 1,15 |
| 915×412 (paysage) | 0,92 |

La **hauteur** compte autant que la largeur : sans elle, un téléphone en paysage
aurait des barres plus hautes que le tiers de son écran. Le plancher (0,92)
existe pour la même raison : sur un petit écran on resserre la mise en page, on
ne rétrécit pas le texte sous les cibles Material.

Trois paliers, posés par la coque (mesurés, jamais devinés en CSS) et consommés
par `src/inject/76-device.css` :

* `sd-size-compact` (< 380 px) — barres plus fines, texte intact ;
* `sd-size-wide` (≥ 600 px) — barres qui respirent, gouttières plus larges ;
* `sd-orient-landscape` — barres amincies, mini-lecteur resserré (mais **rien ne
  disparaît** : « les boutons en bas de l'écran disparaissent » a déjà été le
  reproche d'une version précédente).

`Device.apply()` est appelé au démarrage (`boot`), au redimensionnement
(débounce 200 ms) et à la rotation. Le réglage manuel « Taille de l'interface »
reste disponible : il est devenu un **facteur** de cette base.

### 2. Ce qui n'apparaissait jamais

* **Le mini-lecteur n'existait qu'avec une piste en cours.** Sur un compte qui
  n'avait rien lancé, tout le bas de l'écran restait vide — alors que le contenu
  réservait déjà la hauteur (`--sd-bottom`). Désormais il suit le **lecteur** :
  présent dès qu'un lecteur existe, avec son état vide (« Aucun titre en
  lecture », pochette neutre, commandes de transport **désactivées** — on voit
  ce que l'application sait faire).
* **Sa quatrième rangée manquait.** L'application d'origine met sous la
  progression : paroles · karaoké · file d'attente · appareils · volume. C'est
  ajouté, et chaque commande pilote celle de Spotify (`lyrics-button`,
  `karaoke-button`, `devices-button`) ; celles que la page n'expose pas ne
  s'affichent pas du tout (plutôt qu'un bouton mort). Le volume est un vrai
  curseur, branché sur celui de Spotify — **un seul** volume, pas deux.
* **La barre de navigation recouvrait la barre de titre.** Toutes deux collées en
  haut, fixes, à un pixel près : sur la bibliothèque et les sous-pages, la barre
  de titre (retour + nom de la page) était *derrière* la barre de navigation —
  donc invisible. Une seule des deux maintenant, comme dans l'application
  d'origine : navigation sur l'accueil et la recherche, barre de titre (avec
  « Fermer »/retour) sur la bibliothèque et les sous-pages.
* **L'écran d'accueil SpotiDuck restait par-dessus la coque** quand le lecteur
  arrivait après coup : il était décidé une seule fois, à un moment où `body`
  pouvait déjà contenir l'application. `Welcome.apply()` est ré-évalué après le
  montage du lecteur, et sur redimensionnement. C'est aussi ce qui masquait la
  barre du haut, le mini-lecteur et la barre d'onglets sur le banc de mesure.

### 3. Garde-fous

* banc : « l'unité d'interface suit l'appareil » (0,92 → 1,00 → 0,92 en paysage
  → 1,15, à chaque redimensionnement) ; « le mini-lecteur existe avant même
  qu'un titre joue » ; « la quatrième rangée de l'application d'origine » ;
  « la barre de navigation et la barre de titre ne se recouvrent jamais » ;
* audit : l'unité doit rester le produit de la base mesurée et du réglage, les
  trois paliers doivent exister **dans la feuille et dans la coque**, la coque
  doit continuer de mesurer l'appareil, et aucune classe du runtime ne reste
  sans style ;
* sonde : sur le banc en conditions de WebView (`banc-tel`), cinq profils
  d'appareils sont mesurés (unité calculée, barres, débordement, plus petite
  cible tactile) — « adapté à l'appareil » est une mesure, pas une impression.

### §30-bis — Ce que la première sonde a rattrapé (v2.9.8)

La sonde a mesuré cinq profils d'appareils **avant** la livraison, et deux
choses ne collaient pas :

* **L'unité plafonnait mal.** Sur une tablette 800×1280 elle valait `1,399` au
  lieu de `1,15` : les arguments de `clamp` étaient dans le mauvais ordre
  (`clamp(0,92, mesure, 1,15)` — la mesure devenait le *minimum*). Corrigé en
  `clamp(mesure, 0,92, 1,15)`, et le banc le vérifie sur l'appareil large ;
* **Six commandes sur vingt-neuf passaient sous la cible tactile de 44 px**
  (barre du haut et mini-lecteur, 40 px et 32 px × unité). Toutes les commandes
  de la coque se dimensionnent maintenant sur `--sd-tap` (48 dp × unité, donc
  44,2 px au minimum, l'unité plancher étant 0,92) — y compris la rangée bonus
  et le curseur de volume, dont la zone tactile fait 44 px. L'icône de volume
  n'est plus un bouton (c'est une icône) : elle ne se compte plus comme une
  cible.

Un garde-fou d'audit lit les règles une par une et refuse toute commande qui
reviendrait à une taille figée.

Mesure de la sonde après correction :

| appareil   | unité | barre du haut | mini-lecteur | débordement | plus petite cible |
| ---------- | ----- | ------------- | ------------ | ----------- | ----------------- |
| 360×800    | 0,92  | 360×48        | 360×155      | 0           | ≥ 44 px           |
| 412×915    | 1,00  | 412×56        | 412×168      | 0           | ≥ 44 px           |
| 480×1040   | 1,14  | 480×64        | 480×191      | 0           | ≥ 44 px           |
| 915×412    | 0,92  | 915×42        | 640×138      | 0           | ≥ 44 px           |
| 800×1280   | 1,15  | 800×69        | 640×211      | 0           | ≥ 44 px           |

---

## §31 — L'écran noir de l'accueil, et sa cause (v2.9.9)

La capture du téléphone, le 24/09 à 21 h 16, est sans ambiguïté : **notre barre
du haut s'affiche** (maison · bibliothèque · recherche · logo · notifications ·
amis · profil) et **tout le reste est noir**. Pas de contenu, pas de mini-lecteur.

### La cause

Notre feuille masque les barres de bureau de Spotify — c'est voulu, la nôtre les
remplace :

```css
html.sd-mobile.sd-tab-home #global-nav-bar, … { display: none !important; }
html.sd-mobile #Desktop_LeftSidebar_Id             { display: none !important; }
```

Or, dans la disposition actuelle de la page, **`#global-nav-bar` est l'ancêtre
du contenu** : masquer la barre masquait la page entière. La coque, elle, vit
dans son propre calque (`.sd-layer`, ajouté à `body`) — donc la coque restait
visible et le contenu, non. C'est exactement la capture : du chrome, et du noir.

La leçon : une règle qui masque un élément de Spotify peut masquer **le contenu**,
et rien dans le code ne le disait. Deviner lequel des conteneurs est l'ancêtre
aujourd'hui serait à refaire à chaque refonte de Spotify.

### Le garde-fou (`Content.apply`)

À partir de l'élément de contenu (`[data-testid="home-page"]`, `#main-view`,
`main[data-testid]`, `.Root__main-view`, `main`), la coque **remonte la chaîne
des ancêtres** et rétablit celui que la feuille a masqué : `display` et
`visibility` en style en ligne (prioritaires sur nos règles, mais appliqués à
**ces seuls** éléments), avec le marqueur `data-sd-unhidden`.

Ce qui reste masqué : la barre latérale de bureau, la barre du haut de Spotify,
le panneau de droite — ils ne sont pas des ancêtres du contenu. La mesure décide,
la règle ne décide plus.

Appelé au démarrage, 0,6 s / 2 s / 5 s plus tard (le contenu arrive après la
coque), à chaque changement de vue et à chaque redimensionnement.

### Vérifications

* banc : « la coque ne peut pas vider la page qu'elle habille » — un DOM où
  `#main-view` vit **à l'intérieur** de `#global-nav-bar`, masqué par une règle
  identique à la nôtre : l'ancêtre doit être rétabli, la classe d'état posée ;
* audit : le marqueur `data-sd-unhidden`, l'appel `Content.apply()` et les trois
  ancêtres de contenu sont exigés — s'ils disparaissent, l'écran peut redevenir
  noir sans que rien ne le signale ;
* sonde : `Structure` (quels conteneurs contiennent le contenu, lesquels ont été
  rétablis) et `Contenu` (taille du contenu, chaîne des ancêtres masqués).

---

## §32 — Un écran noir n'est plus muet (v2.9.10)

La capture du 24/09 à 21 h 16 montre notre barre du haut et, en dessous, du
noir. Ce que la sonde mesure sur la page réelle (conditions de WebView, cinq
profils d'appareils) :

    Contenu - accueil : contenu=412x667 flex . aucun ancetre masque
    Structure - accueil : #main-view=412x667 flex/visible CONTIENT-LE-CONTENU
                          #global-nav-bar=0x0 none/visible (masquée par nous, ne contient pas le contenu)
                          [data-testid=home-page]=412x958 block/visible

Autrement dit : **le contenu est là, et notre feuille ne le masque pas** (le
garde-fou du §31 n'a même rien eu à rétablir). Un écran noir vient donc d'ailleurs
— un chargement de page qui n'a pas abouti, ou un état de la WebView — et, jusqu'ici,
rien ne le distinguait d'un défaut de notre côté : la coque affichait son chrome
et se taisait.

### Ce qui change

`Content.alertIfBlank()`, appelé neuf secondes après le démarrage : si l'élément
de contenu est **absent ou vide** (ni texte, ni contrôle), la coque affiche un
panneau qui dit ce qu'elle mesure :

* « La page n'a rien affiché » + l'état mesuré (« aucun élément de contenu »,
  « contenu 0×0 », « contenu vide ») ;
* **Recharger** — le geste utile quand c'est un chargement qui n'a pas abouti ;
* **Copier le diagnostic** — une ligne à coller : version de la coque, mode
  d'interface, taille de vue et d'écran, unité calculée, état du contenu, ancêtres
  rétablie, chemin de la page, état du lecteur. C'est ce qui remplace « je ne peux
  pas savoir ce qui se passe sur un téléphone que je n'ai pas » ;
* **Fermer**, et l'effacement automatique dès que le contenu revient (revérifié
  toutes les 2 s pendant 20 s, sans boucle serrée).

Le panneau n'apparaît **que** si l'écran serait de toute façon vide : un contenu
lent qui arrive après le panneau l'efface de lui-même.

### Vérifications

* banc : « un écran vide le dit au lieu de rester muet » — page sans contenu :
  panneau affiché, trois commandes présentes, diagnostic complet ; contenu
  revenu : panneau masqué, état retiré (99/99) ;
* audit : le panneau, son marqueur d'état et le garde-fou de contenu sont exigés
  (0/0).

---

## §33 — Une page qui n'affiche rien ramène à notre coque (v2.9.11)

« C'est pareil » après la capture d'un écran noir, sous une barre du haut qui
ressemble **aux deux interfaces** (la nôtre a été dessinée d'après celle du
projet : accueil · bibliothèque · recherche, logo au centre, notifications ·
amis · profil). Impossible, dans ces conditions, de savoir laquelle tourne — et
c'est précisément le problème.

### Ce qui change, côté application

1. **`UI_MODE_REV` : 7 → 8.** Un mode enregistré avant cette révision est oublié
   **une fois** : l'application repart de la coque SpotiDuck (le défaut). Un
   choix explicite fait *après* cette révision reste respecté.
2. **Filet de sécurité (`checkContentUsable`).** Douze secondes après la fin du
   chargement, l'application mesure le contenu de la page :

       absent · etroit 132x709 · vide · ok 412x667

   — c'est le relevé de la sonde (`origine` tombait à 132 px de large, `notre` à
   412×667). Si la réponse n'est pas « ok » :

   * une autre interface était active → **retour automatique à la coque
     SpotiDuck** (le seul mode dont on sait qu'il affiche la page), annoncé par
     un message ;
   * c'était déjà la coque → message qui dit quoi faire (recharger ; le
     sélecteur est juste là).

   Une seule tentative par chargement : une rechargement en boucle serait pire
   que l'écran vide.
3. **Le sélecteur est joignable partout.** L'appui long est déjà avalé dans les
   trois modes (pas de menu de navigateur) : il ouvre désormais le choix de
   l'interface **dans tous les modes**, au lieu du seul mode d'origine. Dans la
   coque, le même écran reste accessible par l'engrenage de la barre de titre
   (onglet Bibliothèque) → « Interface ».

### Vérifications

* audit : `checkContentUsable`, `CONTENT_PROBE_JS` et `showUiChooser()` sont
  exigés dans `MainActivity` — si le filet de sécurité disparaît, un écran vide
  redeviendrait sans issue ;
* la compilation Kotlin est faite par la CI (gradle) à chaque envoi, et le
  contrôle des ressources (`aapt2 compile`) est passé ici.

---

## §34 — L'accueil ne ressemble plus à un bureau (v2.9.12)

La capture du 24/09 à 21 h 47 montre enfin la page **affichée** — et son défaut
n'est plus l'affichage mais la **mise en page du contenu** : pochettes de ~59 px
en **quatre colonnes**, ~36 px de vide entre elles, ~85 px entre deux rangées,
des titres de la taille d'un paragraphe. Autrement dit : la feuille de
l'application d'origine fait *tenir* la page dans l'écran (§28) ; elle ne la met
pas en page pour un téléphone.

### Ce que la sonde a nommé, sur la vraie page

    #1 360×130  cont=carousel-scroller flex gap=12px  carte=3862×66  image=122×122
    #2 360×130  cont=carousel-scroller flex gap=12px  carte=1965×66  image=122×122
    …
    #5 197×286  cont=carousel-scroller flex gap=12px  carte=32×222    image=0×0

Deux enseignements :

* les carrousels sont sains (pochettes de 122 px pour une rangée de 360), donc
  la capture ne vient **pas** d'eux ;
* la capture vient des rangées en **grille** (`div[data-testid=grid-container]`),
  dont le nombre de colonnes est calculé pour un bureau : quatre colonnes, où la
  pochette (59 px) flotte au milieu d'une case de 95 px.

### La passe `77-content.css`

Elle est **appliquée à tous les appareils** — la leçon est payée : la première
version était réservée aux écrans étroits, donc elle ne faisait rien sur
l'appareil de la capture.

| ce qui décide          | avant (bureau)      | après (téléphone) |
| ---------------------- | ------------------- | ----------------- |
| nombre de colonnes     | 4 fixes             | `repeat(auto-fill, minmax(150px × unité, 1fr))` ⇒ 2 sur un 412, 3 sur un 480 |
| pochette dans sa case  | 59 px au milieu     | toute la largeur de la case, carrée |
| gouttières             | ~36 px (grille), 12 px (carrousel) | 12 px × unité partout |
| espacement des rangées | ~85 px              | 14 px × unité |
| titres de rangée       | taille d'un paragraphe | 17 px × unité |
| « Tout afficher »      | titre               | lien (12 px) |
| hauteurs réservées     | `25vh` par rangée   | `auto` |

Sur un écran large, la densité suit la place (`minmax(170px × unité, 1fr)`), mais
les pochettes ne redeviennent jamais des timbres : c'est la largeur de carte qui
décide, pas un nombre fixe.

### Vérifications

* banc : « le contenu est mis en page pour un téléphone, pas pour un bureau »
  (passe présente, appliquée à tous les appareils, densité réglée par la largeur
  de carte, aucun nombre de colonnes en dur, aucune forme écrasée) ;
* audit : mêmes exigences, plus le garde-fou qui refuse un nombre de colonnes
  fixe ;
* sonde : `Rangées` (conteneur, mode d'affichage, colonnes, gouttières, carte,
  pochette) pour chaque rangée de l'accueil, et `Contenu-te tailles` pour la
  première — c'est ce relevé qui a nommé la cause, et il reste dans le rapport.

---

## §35 — « C'est encore coupé » : le rognage, mesuré pour de vrai (v2.9.13)

### L'angle mort était dans la mesure

`debordement` se calculait avec `scrollWidth - clientWidth`. Or notre feuille
met `overflow-x: hidden` (sans quoi la page de bureau déborde de partout) : un
débordement rogné n'augmente **pas** `scrollWidth`. La sonde annonçait donc
« débordement 0 » pendant que l'utilisateur voyait « c'est encore coupé » — et
la quatrième colonne rognée de sa capture n'était expliquée par aucune mesure.

Ce que la sonde relève maintenant :

    Rognage — accueil :
      conteneurs-trop-larges: carousel-scroller 440px (+28) · div 440px (+28)
      hors-ecran: … div 3830px depasse=3404 · div 3862px depasse=3420 (la piste)
      coupes-par-un-parent: …

C'est écrit noir sur blanc : **le conteneur d'une rangée mesurait 440 px dans une
mise en page de 412** — 28 px rognés net par notre `overflow-x: hidden`. La piste
de 3 830 px, elle, est normale : un carrousel défile.

### Le correctif

On ne rogne plus, on **borne** :

* `section[data-testid="component-shelf"]`, ses enfants directs,
  `[data-testid="carousel-scroller"]` et `div[data-testid="grid-container"]` :
  `max-width: 100%` + `min-width: 0` + `box-sizing: border-box` ;
* `[data-testid="carousel-scroller"]` prend la largeur de la page
  (`width: 100%`) : la piste coulisse **à l'intérieur**, au lieu de dépasser ;
* la page d'accueil, son premier enfant, `#main-view` et `main` sont bornés de
  la même façon — un conteneur à `100 %` dans un parent rembourré dépasse
  exactement du rembourrage, c'est le défaut classique des 28 px manquants.

Aucune largeur en dur, aucun nombre de colonnes en dur : que des bornes, donc
valables sur tous les appareils.

### Comment on saura

La sonde affiche désormais, pour chaque page, `conteneurs-trop-larges` — la
réponse doit être `aucun`. Un `+28` veut dire qu'il reste du rognage, et le nom
du conteneur dit lequel. C'est la mesure qui manquait pour arrêter de deviner.

---

## §36 — L'accueil de l'application (v2.10.0)

Trois reprises de l'accueil du web player, trois constats : mise en page de
bureau (quatre colonnes de pochettes de 59 px), conteneurs rognés (440 px dans
une page de 412), et finalement la demande de l'utilisateur :

> « Sinon vu que t'y arrives pas, fais une page d'accueil stylé pour
> l'application. »

C'est la bonne décision, et elle est prise **ensemble** : on ne recopie plus
l'accueil de Spotify, on lit la page et on l'affiche avec **notre** mise en page.

### Le principe

`Home` (module 11e-ter) :

1. **lit la page** — pour chaque `section[data-testid="component-shelf"]` (et
   `div[data-testid="grid-container"]` en repli) : le titre, le lien « Tout
   afficher » (texte, `aria-label` ou destination `/section/…`), puis chaque lien
   qui porte une pochette — titre (ou `aria-label`, ou l'alternative de l'image,
   ou le slug de l'adresse), sous-titre, image, type ;
2. **classe** chaque carte en musique / podcast / autre, d'après l'adresse et les
   mots du titre ;
3. **rend** l'accueil : salutation (Bonjour/Bonsoir), trois filtres
   (Tout · Musique · Podcasts), quatre raccourcis, puis les rangées — grille
   `repeat(auto-fill, minmax(140px × unité, 1fr))`, pochette qui remplit sa case,
   gouttière 12 px, rangées espacées de 16 px ;
4. **se retire** quand il n'a rien à montrer : pas d'interrupteur, session
   fermée, page de connexion, **sous-page ouverte** (l'onglet reste « accueil »
   quand on ouvre une playlist), ou aucune rangée lisible. La page reprend alors
   la main : jamais d'écran maison vide par-dessus un écran vide.

### Ce qui est relié (le reproche du pass 26)

| commande | ce qu'elle fait |
| --- | --- |
| carte | vrai `<a href>` de la page → navigation réelle (playlist, album, artiste, podcast) |
| « Tout afficher » | vrai lien de la page, vers la section |
| filtres | filtrent les rangées affichées ; si la catégorie est vide, l'application le dit |
| Rechercher · Bibliothèque · Paramètres | routeur et feuille existants |
| Titres likés | lien `/collection/tracks` de la page, repli sur la bibliothèque |

Le réglage **Accueil SpotiDuck** (interrupteur, groupe « Interface ») rend
l'accueil de Spotify à qui le préfère : le défaut reste le nôtre, mais rien
n'est imposé.

### Vérifications

* banc : « l'application a son propre accueil, construit avec les données de la
  page » — 4 cartes reprises, chacune un vrai lien, pochettes reprises, titres de
  rangées repris, lien « Tout afficher » repris, filtre podcasts qui ne garde que
  le podcast, filtre « Tout » qui restaure tout, 4 raccourcis boutons, aucune
  largeur ni nombre de colonnes en dur ;
* banc : « l'accueil ne recouvre jamais une page sans contenu » — page de
  connexion : accueil masqué, aucune donnée ; et l'exclusion des sous-pages ;
* audit : `78-home.css`, le module `Home`, ses filtres, son interrupteur, sa
  vérification de la page de connexion et son exposition sont exigés ;
* sonde : `Accueil maison` relève l'état (affiché/masqué), la zone, la position
  par rapport aux barres, les rangées, les cartes, les filtres, les raccourcis et
  la taille d'une pochette.

---

## §37 — L'accueil montre enfin quelque chose, et il parle de vous (v2.11.0)

Le défaut signalé — « rien n'a changé, c'est le même écran d'accueil » — n'était
pas un défaut d'affichage mais de **lecture** de la page. L'accueil maison se
construit avec les rangées de Spotify ; or il ne cherchait les cartes que parmi
les liens (`a[href]`) alors que les cartes réelles sont des `div[role=button]`.
Résultat : zéro carte, donc « aucune donnée », donc accueil masqué — et
l'utilisateur revoyait l'accueil de Spotify exactement comme avant.

Trois corrections de fond :

1. **Les cartes sont lues telles qu'elles sont** : `a[href]`,
   `[role=button]`, `[data-testid=card-clickable]`, `[data-encore-id=card]`,
   `[data-testid=shortcut-card]`. Une carte qui n'est pas un lien reçoit un
   bouton, et `Home.openOriginal()` va **cliquer la carte d'origine** dans la
   page : la navigation passe par le lecteur web, pas par une URL devinée.
   Les doublons sont écartés par lien *et* par libellé.
2. **La visibilité ne dépend plus de l'état du DOM de Spotify** (qui pouvait
   nous croire « ailleurs ») : c'est le **chemin de l'URL** qui fait foi
   (`isHomePath()` — racine, `/home`, avec la langue).
3. **L'accueil vit avec ses seules statistiques** : si la page ne publie
   aucune rangée, mais que l'application a des écoutes à raconter, l'écran
   s'affiche quand même. Plus de masquage silencieux.

### Les statistiques d'écoute

Nouveau module `Stats`, centième pour cent local (rien ne sort du téléphone,
aucun compte requis). Chaque écoute est datée et additionnée ; l'import
facultatif de l'historique (`GET /me/player/recently-played?limit=50`) se fait
avec le jeton déjà présent dans la page, au plus une fois toutes les trente
minutes, et reste muet sans jeton.

Ce que l'accueil raconte :

| Bloc | Contenu |
| --- | --- |
| Six tuiles | Temps d'écoute total, cette semaine, aujourd'hui, titres différents, artistes différents, écoutes |
| Sept jours | graphique en colonnes, du plus ancien à aujourd'hui, avec le compte au-dessus |
| Top 6 artistes | classement avec nombre d'écoutes et **part en pourcentage** |
| Top 5 titres | classement avec leur artiste |
| Moments | nuit, matin (5–12), après-midi (12–18), soirée (18–24) + jour préféré, série de jours d'affilée, moyenne par jour |
| Découvertes | artistes écoutés cette semaine pour la première fois (au moins deux écoutes, pour éviter le hasard) |
| Réglage | « Statistiques d'écoute » (interrupteur, défaut activé) et « Effacer mes statistiques » |

Jamais d'écran vide : sans aucune donnée, le bloc affiche une phrase d'attente
au lieu de tuiles à zéro. Une reprise du même titre en moins de trois minutes
n'est pas comptée deux fois ; le stockage est plafonné à 1 500 écoutes, les plus
anciennes sortant d'abord.

### Vérifications

* banc : « les statistiques d'écoute sont calculées, et elles sont justes » —
  historique écrit à la main (6 écoutes, 3 artistes, 3 jours) et comparaison de
  **chaque chiffre** : total, titres, artistes, temps, écoutes du jour, premier
  artiste et sa part, les sept jours, série, soirée, moment préféré, découverte,
  format « 22 min » et « 3 h 20 », persistance, reprise non comptée deux fois,
  interrupteur qui coupe l'enregistrement, remise à zéro qui vide le stockage ;
* banc : « l'accueil montre les statistiques, et vit sans les rangées de
  Spotify » — page vide : six tuiles, temps d'écoute, graphique, classement,
  moments, et **accueil non masqué** ;
* audit : exposition `stats: Stats`, clé `sd.stats.v1` intouchée, interrupteur
  respecté, classes du bloc présentes dans le code **et** la feuille, mesures du
  résumé et de la série ;
* sonde : `Accueil maison` relève l'état (affiché/masqué) et les compteurs,
  `Rognage` vérifie qu'aucun conteneur ne dépasse.

---

## §38 — Le diagnostic ne ment plus, et une page pleine n'est plus « vide » (v2.11.1)

La capture du 25/09 au matin montre le panneau **« La page n'a rien affiché »**,
avec, dans son propre diagnostic, `contenu 29×2756`. Deux défauts de mesure, et
un troisième caché dessous.

1. **Un seuil de largeur décidait si la page était vide.** L'état de contenu
   exigeait une largeur ≥ 40 px (le seuil avait été écrit pour une autre
   disposition de la page). La page du téléphone était **haute de 2 756 px** mais
   l'élément mesuré ne faisait que 29 px de large : la page était pleine et
   déclarée vide. On mesure désormais **ce qui est rendu** — le texte réellement
   affiché (`innerText`, qui ignore ce qui est caché) et le nombre d'éléments
   dont la boîte n'est pas vide — et l'alarme ne se déclenche plus que quand
   *rien* n'est rendu, c'est-à-dire le noir du 24/09, le seul cas pour lequel
   elle a été écrite. La même erreur existait côté Android : la sonde
   `CONTENT_PROBE_JS` refusait toute page de moins de 200 px de large.
2. **Le diagnostic annonçait « SpotiDuck 2.9.0 ».** La coque portait un numéro
   de version écrit à la main, jamais mis à jour depuis : impossible, avec ça, de
   savoir quelle version tournait sur un téléphone. La coque est maintenant
   **estampillée à la compilation** (`window.__SD_VERSION__`, la version de
   `package.json`, donc celle de l'APK) et le pont expose la version de l'APK
   lui-même ; quand les deux diffèrent, le diagnostic dit les deux.
3. **`/intl-fr/` n'était pas reconnu comme l'accueil.** C'est le chemin que
   Spotify sert en France — celui de la capture. L'accueil maison ne s'affichait
   donc pas là où l'utilisateur arrive. Le test de chemin accepte désormais
   `/intl-xx`, `/xx` et `/xx-XX` (casse comprise), et refuse toujours les
   sous-pages (playlist, album, artiste, section), qui ne doivent jamais être
   recouvertes. La page marketing, elle, est reconnue par ses **boutons** de
   connexion autant que par ses liens : l'écran d'accueil maison (session
   fermée) s'affiche donc aussi là.

### Vérifications

* banc : « une page haute et étroite n'est pas “rien affiché” » — page
  `/intl-fr/` de 29×2756 avec du texte et des liens : état *affiché*, panneau non
  déclenché, aucune classe `sd-content-blank`, diagnostic portant la version de
  l'application, et **page vraiment vide ⇒ alarme** (le seul cas légitime) ;
* banc : la garde des chemins est mesurée sur neuf URL (racine, `/home`, `/fr`,
  `/en-US`, `/intl-fr`, `/intl-en`, playlist, album, section) — l'ancien test
  citait `State.route === "page"`, une ligne de `back()` sans rapport avec
  l'accueil : il passait sans rien vérifier ;
* audit : version estampillée au build (et interdiction de la constante en dur),
  `appVersion()` côté application, mesure du *rendu* dans la coque et dans
  `CONTENT_PROBE_JS`, **interdiction des seuils de largeur** qui ont causé la
  fausse alarme, reconnaissance de `/intl-fr`, scénario de sonde `page-fr` ;
* sonde : nouveau scénario **`page-fr`** — `https://open.spotify.com/intl-fr/`,
  dans les conditions de la WebView (métavueposée par la chaîne d'injection,
  densité, écran tactile) — qui relève l'ancre choisie, sa boîte, ce qu'elle
  rend, le verdict de la coque, le chemin d'accueil et l'état de session ; le
  résumé s'affiche en annotation.

### Le diagnostic doit suffire à lui seul

Une capture d'écran est la seule chose que l'utilisateur peut envoyer ; elle
doit donc porter **tout** ce qu'il faut pour trancher. La ligne de diagnostic
contient désormais, en plus de l'état du contenu :

* **l'extrait** des mots de la page (`extrait "Choisissez votre langue"`), donc
  on sait quelle page il avait sous les yeux sans le deviner ;
* **la session réelle** (`session oui/non`), lue sur le cookie du lecteur par le
  pont : Spotify sert un accueil complet aux visiteurs **sans compte**, donc
  « la page montre un accueil » ne veut pas dire « un compte est connecté » — et
  c'est justement ce qui départage « il faut se connecter » de « il y a quelque
  chose à afficher » ;
* **la raison de l'absence de l'accueil** (`accueil masqué (aucune donnée)`,
  `(hors accueil)`, `(session fermée)`, `désactivé (réglage)`, ou `affiché 5
  rangées/46 cartes`) : « rien n'a changé » a coûté deux versions parce qu'il
  fallait deviner laquelle de ces causes s'appliquait.

La sonde Android (`CONTENT_PROBE_JS`) joint le même extrait à son verdict, pour
que les journaux d'un téléphone disent aussi ce que la page racontait.

### Deux mesures fausses de plus, corrigées

Le diagnostic du 25/09 annonçait `vue 384×832 px (écran 137)` : `screen.width`
vaut 385 sur ce téléphone, déjà en **pixels CSS**, et le calcul le divisait quand
même par la densité (2,81). L'avertissement « mise en page 384px pour un écran
de 137px » se déclenchait donc pour rien. La division n'a lieu que si la valeur
est manifestement physique (au-delà de 1 000 px).

Et comme une ancre unique ne permet pas de trancher, le diagnostic mesure
**toutes** les ancres candidates : `ancres home-page absent · main-view absent ·
main 29×2756 block`. On distingue ainsi « la page n'est pas l'accueil du
lecteur » (aucune ancre de contenu) de « **notre** feuille a écrasé la page »
(ancre présente, taille absurde) — les deux hypothèses que `contenu 29×2756`
laissait ouvertes.

---

## §39 — La bibliothèque du compte, affichée par nous (v2.11.4)

Signalé le 25/09 : « sur l'onglet bibliothèque, je ne vois aucune de mes
playlists enregistrées sur mon compte ».

L'onglet ne faisait qu'**afficher la barre latérale de Spotify**
(`#Desktop_LeftSidebar_Id`, `.YourLibraryX`) en plein écran, avec notre feuille
posée dessus. Si son rendu ne suit pas — liste vide, conteneur replié, classe
renommée par Spotify — il ne reste rien à voir, et on ne peut pas réparer depuis
ici une liste qu'on ne lit pas. C'est la même erreur que l'accueil maison en
2.10.0 : dépendre du rendu de quelqu'un d'autre pour notre propre écran.

### Ce que fait la page maintenant

Elle lit la bibliothèque **à la source** : l'API du lecteur, avec le jeton que la
page utilise déjà (`Api.authToken` — celui que la coque capte sur ses requêtes,
le même que les statistiques d'écoute).

| Source | Ce qui est affiché |
| --- | --- |
| `/me/playlists` | vos playlists (créées et suivies), avec leur propriétaire |
| `/me/tracks` | « Titres likés » et leur nombre, vers `/collection/tracks` |
| `/me/albums` | albums enregistrés, avec l'artiste |
| `/me/artists` | artistes suivis, avec un genre |
| `/me/shows` | podcasts enregistrés, avec l'éditeur |

Chaque ligne fait 64 px de haut, avec une pochette de 56 px (les artistes en
rond), un titre et un sous-titre sur une ligne chacun, et une **adresse réelle**
(`/playlist/…`, `/album/…`) que le routeur de Spotify ouvre comme n'importe quel
lien. Cinq filtres (Tout · Playlists · Albums · Artistes · Podcasts), un résumé
du compte en haut (« Playlists 12 · Albums 3 · … ») et une phrase quand un filtre
ne montre rien. Un interrupteur **« Bibliothèque SpotiDuck »** rend la main à
celle de Spotify.

### La prudence qui compte

**Rien ne s'affiche tant qu'il n'y a rien à montrer**, et la barre latérale de
Spotify n'est masquée que lorsqu'on a de quoi la remplacer : sans jeton (session
fermée), ou si l'API ne répond pas, la page d'avant reste visible — on ne peut
pas perdre l'accès à sa musique en installant cette version. Le jeton arrivant
parfois après la première lecture, la page retente cinq fois, espacées de 4 s (en
`setTimeout` chaîné, jamais en `setInterval` : un intervalle qui survit à un
changement de vue est exactement ce que l'ancienne couche faisait).

### Vérifications

* banc : « la bibliothèque montre les playlists, albums, artistes et podcasts du
  compte » — 6 lignes lues à la source (dont les titres likés), totaux de l'API
  (128 titres likés), plus grande pochette choisie plutôt que l'icône 64 px,
  adresses réelles sur chaque ligne, résumé du compte, cinq filtres nommés qui
  filtrent vraiment, `sd-lib-on` posée (barre latérale remplacée) puis retirée en
  quittant l'onglet, et le diagnostic qui dit `biblio 6 éléments` ;
* banc : « sans jeton, la bibliothèque laisse la barre latérale de Spotify » —
  état `no-token`, page masquée, `sd-lib-on` **absente** (rien n'est perdu), et
  une source en panne n'empêche pas les autres de s'afficher ;
* audit : module et méthodes, les cinq sources de l'API, l'interrupteur, et
  l'interdiction de masquer la barre latérale sans condition ;
* sonde : `Bibliothèque` relève l'état, la zone, le nombre de lignes et de
  filtres, et si la barre latérale de Spotify est remplacée ou laissée en place.

---

## §40 — Les durées d'écoute, et le bas de l'écran (v2.11.5)

Capture du 25/09 au matin : « Les statistiques sont buguées » — un seul titre
écouté, et **56095 h 50** de temps d'écoute — plus « l'écran est bugué vers le
bas ».

### 56 095 heures pour un titre de trois minutes

`State.duration` valait `max × 1000`, en supposant que le curseur de Spotify est
gradué en secondes. Sur cette page-là, il est gradué en **millisecondes** : une
piste de 3 min 22 s annonçait 201 945, la durée conservée devenait 201 945 000 —
et l'affichage, qui la lisait comme des secondes, écrivait 56 095 h 50. Le
raccourci « on multiplie par 1000 » a tenu tant que personne n'écoutait un
titre ; il est faux dès qu'on regarde le chiffre.

L'unité n'est plus supposée, elle est **mesurée** : pendant la lecture, la valeur
du curseur avance de 1 par seconde s'il compte en secondes, de 1000 s'il compte
en millisecondes — la vitesse observée tranche (`Spotify.calibrate`). Le repli
(audit de grandeur : au-delà de 10 000 de course, c'est des millisecondes) ne
sert qu'entre deux mesures. La conversion de la position passe par le même
facteur, donc le progresseur de la notification et les durées affichées sont
justes aussi.

Deux protections de plus, parce qu'une unité peut encore se cacher :

* **toute durée enregistrée est contrôlée** (`Stats.plausible`) : une seule
  écoute ne dure pas plus de douze heures ; au-delà, la valeur redescend par
  paliers de mille (millisecondes, microsecondes, nanosecondes), et si elle reste
  absurde elle ne compte pas plutôt que d'inventer seize minutes ;
* **les écoutes déjà écrites sont réparées au chargement** : sans cette passe,
  le seul titre écouté avant ce correctif aurait continué d'afficher 56 095 h, et
  il aurait fallu **effacer ses statistiques** pour s'en débarrasser. La
  réparation s'écrit une fois, et seulement si quelque chose a changé.

### La bande noire sous la page

`--sd-bottom` réserve la place du mini-lecteur — sauf que cette place était
réservée **en toutes circonstances**, même quand le mini-lecteur n'était pas
affiché (page ouverte avant que le lecteur soit prêt). L'écran montrait donc la
page coupée, avec une soixantaine de pixels de noir en dessous. L'espace suit
maintenant l'affichage : `--sd-mini-h-current` vaut 0 par défaut et prend la
hauteur du mini **quand il est réellement là** (mêmes classes que sa mise en
page, `sd-mini-on` / `sd-has-track`) — la réserve ne peut plus contredire l'écran.

Deux détails de la même capture : la **barre de défilement** que la WebView
dessine en surimpression (le bloc gris en haut à droite) est masquée sur nos pages
(`scrollbar-width: none` + `::-webkit-scrollbar`), et le bas de l'accueil garde
une respiration (`padding-bottom`), pour que la dernière carte ne soit jamais
collée au bord.

### Vérifications

* banc : « une durée annoncée en millisecondes ne devient jamais des milliers
  d'heures » — curseur en millisecondes (202 000 → 202 000 ms), curseur en
  secondes (202 → 202 000 ms), **mesure qui l'emporte** sur le repli, contrôles
  de plausibilité (201 945 000 → 202, 202 000 → 202, 210 → 210, 1e15 → écartée),
  et la **réparation** de l'écoute de la capture : 201 945 000 enregistrée dans le
  stockage ⇒ 1 écoute, 202 s, « 3 min », et la valeur corrigée réécrite ;
* audit : unité mesurée (`unitFactor`, `calibrate`), conversion de la position,
  `plausible()` et son plafond, contrôle à l'enregistrement, conversion des
  millisecondes à la source, `--sd-mini-h-current: 0px` par défaut et sa mise en
  relation avec l'affichage du mini, barres de défilement masquées sur les deux
  pages ;
* sonde : `Bas de page` relève l'espace réservé, l'état du mini-lecteur et de la
  barre d'onglets, et la **marge** entre la page et le bas de l'écran.

---

## §41 — L'onglet Bibliothèque ne bloque plus l'écran (v2.11.6)

Signalé le 25/09 : « quand on clique sur l'onglet bibliothèque, la barre en haut
disparaît et rien d'autre n'apparaît ; je reste bloqué sur l'écran d'accueil ».

### L'accueil se croyait toujours chez lui

`Home.shouldShow()` ne jugeait sa place que sur le **chemin de l'URL** — or un
appui sur l'onglet Bibliothèque **ne navigue pas** (c'est la barre latérale de
Spotify qui est montrée). L'accueil, dont le chemin était encore celui de
l'accueil, restait donc posé par-dessus la page de bibliothèque : l'écran ne
changeait pas. L'onglet fait désormais foi (`State.tab !== "home"` ⇒ l'accueil se
retire), et une règle CSS indépendante le garantit de toute façon
(`html.sd-tab-library .sd-home { display: none }`) : même si le script manquait un
battement, l'accueil ne peut plus couvrir un autre onglet.

### La navigation disparaissait — donc plus aucun moyen de revenir

`navOn = !isSubPage && !isLibrary` masquait la barre de navigation sur la
bibliothèque, où la barre de titre prenait sa place (retour + « Fermer »). Cet
arbitrage datait du temps où la barre d'onglets du bas était active : avec le
défaut actuel (pas de barre d'onglets), la barre du haut est **la seule
navigation**, et la masquer enferme l'utilisateur. La séparation est donc :

* **barre de navigation** : accueil, recherche **et bibliothèque** ;
* **barre de titre** (retour + nom de la page) : sous-pages seulement — deux
  barres au même bord ne peuvent pas cohabiter, et c'est la navigation qui gagne.

La page de bibliothèque commence sous la barre de navigation (comme l'accueil) et
porte son **propre titre** (« Bibliothèque »), au lieu d'emprunter celui de la
barre de titre.

### La page ne se taisait plus jamais

`Library.shouldShow()` exigeait des données : sans jeton ou sans réponse de l'API,
la page disparaissait et la barre latérale de Spotify était censée reprendre la
main — sauf que sur ce téléphone elle n'affiche **aucune** playlist (« je ne vois
aucune de mes playlists »), donc la place restait vide. Notre page s'affiche
maintenant **toujours** sur son onglet, avec sa raison d'être vide (chargement,
pas de jeton, API muette, compte vide) et un bouton **« Réessayer »**, plus le
chemin pour retrouver celle de Spotify (Réglages → Bibliothèque SpotiDuck). Le
jeton arrivant souvent après le premier affichage, « Réessayer » relit vraiment.

Enfin, une sous-page ouverte **depuis** la bibliothèque (playlist, album) garde
l'onglet « bibliothèque » : la page plein écran se retire sur le chemin
(`isLibraryPath`), et la barre latérale n'est jamais laissée posée sur la
sous-page.

### Vérifications

* banc : l'onglet Bibliothèque garde la **navigation**, n'affiche pas la barre de
  titre, montre la page de bibliothèque et son titre ; l'**accueil se retire**
  (`shouldShow()` faux, `hidden` vrai) ; une playlist ouverte depuis la
  bibliothèque retire notre page et laisse la sous-page propre ;
* banc : sans jeton, la page s'affiche **et s'explique** (titre, note, bouton
  « Réessayer »), et un appui sur « Réessayer » avec un jeton arrivé entre-temps
  relit vraiment (état `empty`) ;
* audit : l'onglet fait foi côté accueil, la navigation reste sur la bibliothèque,
  la barre de titre est réservée aux sous-pages, la bibliothèque ne peut plus se
  taire faute de données, `isLibraryPath`, le titre et le bouton de la page, et
  son départ sous la barre de navigation.

## §42 — La bibliothèque lit pour de vrai, le lecteur reste, les statistiques se lisent (v2.11.7)

Trois retours du 25/09 (08:45), capture à l'appui :

1. la page de bibliothèque s'affiche enfin (correctif §41 tenu), mais elle annonce
   **« Votre bibliothèque n'a pas répondu pour l'instant »** — donc rien du compte ;
2. « **le lecteur disparaît quand on scroll vers le bas** » ;
3. « **Les statistiques sont pas bonne il me semble. Rends les statistiques plus
   compréhensible etc** ».

### 1. L'API ne répondait pas parce que le navigateur la refusait

La capture montrait l'état `error` de la page : le jeton était bien capté (sinon le
message aurait été « Connectez-vous… »), mais la requête n'aboutissait pas. La
console de la vraie page le dit mot pour mot :

> `Access to fetch at 'https://api.spotify.com/v1/me/artists?limit=50' from origin
>  'https://open.spotify.com' has been blocked by CORS policy: Response to preflight
>  request doesn't pass access control check`

Autrement dit : `fetch` depuis `open.spotify.com` vers `api.spotify.com` est refusé
par le contrôle d'accès du navigateur (le contrôle préalable ne reçoit pas
d'en-tête `Access-Control-Allow-Origin`). Aucune bibliothèque possible par cette
voie, quel que soit le jeton.

L'application sait déjà faire ces requêtes **elle-même** : le pont Android expose
`nFetch` (la voie dont se sert l'interface d'origine pour ses appels de lecture —
mêmes en-têtes, mêmes cookies, hors navigateur). Le module `Net` l'utilise
désormais **en premier** :

* `Net.get(path)` → `AndBridge.nFetch` (natif, sans CORS) ;
* à défaut de pont (banc, navigateur), repli sur `fetch` ;
* et, dans tous les cas, une **raison** (`Net.reason`) : jeton refusé (401),
  accès refusé (403), trop de requêtes (429), Spotify a répondu N, requête bloquée
  par le navigateur, jeton absent, pont indisponible.

La bibliothèque, l'historique d'écoute (`/me/player/recently-played`) et le
diagnostic (Réglages → Diagnostic, champ `api`) passent par là. La page annonce
maintenant la raison quand elle échoue : *« Votre bibliothèque n'a pas répondu
pour l'instant. Raison : … »* — une capture suffit à savoir ce qui manque.

### 2. Le lecteur ne s'efface plus sous le doigt

`sd-mini-on` était recalculé à chaque repeint à partir d'une **lecture
instantanée** : `Spotify.ready()` cherche la barre de lecture de Spotify dans le
DOM, or cette barre quitte l'arbre pendant un défilement (rendu différé) — la
classe tombait, et le mini-lecteur disparaissait. **Vu une fois, il reste** :
`Spotify.seen` retient qu'un lecteur a existé, et l'affichage ne dépend plus de
l'instant. C'est la seule façon dont il pouvait disparaître (il est `fixed`, dans
notre couche, et ne bouge pas au défilement).

### 3. Les statistiques : mesurées, et lisibles

**Elles étaient déduites, pas mesurées.** Dès qu'un titre apparaissait, on
inscrivait la durée **annoncée** par la page ; un titre survolé dix secondes
comptait quatre minutes, le même titre relancé n'était compté qu'une fois, et le
total ne correspondait à aucune écoute réelle. Désormais :

* `Stats.tick(état)` suit **l'avancement du lecteur** (dix fois par seconde, plus
  à chaque changement d'état) : chaque seconde dont la position progresse est une
  seconde écoutée, attribuée au titre en cours ;
* le pas est borné par le temps réellement écoulé depuis le dernier relevé — un
  saut de position ne fabrique jamais d'écoute, et un retour en arrière (ou le
  même titre relancé) **ferme** l'écoute en cours et en ouvre une nouvelle ;
* `Stats.flush()` enregistre l'écoute au changement de titre, à la pause, quand
  plus rien ne joue, et quand l'application passe en arrière-plan ;
* moins de **dix secondes** (`STATS_MIN_SEC`), ce n'est pas une écoute : un survol
  ne compte pas ;
* les écoutes ainsi mesurées portent `m: 1`. L'historique importé de Spotify
  (durée des titres) et les écoutes enregistrées avant cette version **ne sont pas
  mélangés** avec elles : la page dit « dont X venant de l'historique Spotify » ;
* plus aucune durée inventée : une écoute sans durée compte comme une écoute et
  zéro seconde (`STATS_DEFAULT_SEC` a disparu).

**La page, elle, se lit maintenant de haut en bas** :

* une phrase de tête : « Temps écouté : 12 h 05 · 42 écoutes · Aujourd'hui 1 h 12 » ;
* **Temps écouté** — trois durées (aujourd'hui, sept derniers jours, depuis le
  début), chacune avec le nombre d'écoutes dessous, puis la note qui dit comment
  le temps est obtenu ;
* **Ce que vous écoutez** — les nombres, chacun expliqué (titres passés, titres
  différents, artistes, jours d'affilée) ;
* **Ces sept derniers jours** et **Quand vous écoutez** en **temps écouté** (la
  même unité que les durées du haut, donc comparables), chaque barre portant sa
  valeur ; le moment préféré est celui où le plus de temps a été passé ;
* les classements disent « N écoutes · temps » et non un nombre nu.

**Une requête à la fois.** Le pont natif répond de façon **bloquante** (le fil
JavaScript attend le réseau) : cinq requêtes lancées ensemble gèleraient l'écran
le temps qu'elles aboutissent toutes. La bibliothèque les enchaîne donc une par
une, en laissant la page respirer entre deux, et **s'arrête à la première panne
franche** (rien n'a répondu du tout) : inutile de faire attendre quelqu'un dont le
réseau ne répond pas.

### Vérifications

* banc : la bibliothèque lue **par le pont natif** avec `fetch` en panne (le cas
  du téléphone) — quatre lignes, dont la playlist du compte ; et une panne du pont
  (401) affiche la **raison** avec le bouton « Réessayer » ; rien ne répond → **un
  seul appel** et l'état d'échec ;
* banc : les durées sont **mesurées** — 20 s + 20 s bornées = 42 s pour une écoute,
  un saut de position de 180 s en 1 s ne compte pas, un titre survolé ne compte
  pas, le même titre relancé compte deux écoutes (15 s + 25 s = 40 s) ;
* banc : le mini-lecteur **reste affiché** quand la barre de lecture de Spotify est
  retirée de l'arbre, et quand elle revient ;
* banc : la page de statistiques montre sept tuiles (trois durées + quatre
  nombres), chacune avec son explication ;
* audit : la mesure alimentée par le lecteur, l'absence de notation « durée
  annoncée », le seuil des dix secondes, la distinction mesuré/estimé, les
  moments de la journée en temps, les notes et explications de la page, le verrou
  du lecteur (`Spotify.seen`), l'appel par le pont natif et sa raison.

## §43 — La page ne se fige plus pendant une requête (v2.11.8)

Capture du 25/09 (09:12) : la page de bibliothèque reste sur **« Chargement de
votre bibliothèque… »**, et « **le lecteur ne fait rien quand on clique sur les
boutons** ». Les deux ont la même cause.

### Le pont natif bloquait le fil JavaScript

`AndBridge.nFetch` est appelée **depuis le fil JavaScript de la WebView** : pendant
que la requête attend le réseau, la page entière est gelée — plus aucun appui
n'est traité (les boutons du mini-lecteur, les onglets, tout), et l'écran reste
sur sa dernière image, donc sur « Chargement… ». Cinq requêtes à la suite, avec
les délais du réseau, cela fait un écran mort pendant un long moment.

Deux correctifs :

1. **La requête ne bloque plus.** Le pont expose `nFetchAsync(id, url, options)` :
   la requête part d'un **fil de fond** et sa réponse revient à la page par
   `window.__sdNet(id, {status, body})`. La coque utilise cette voie (elle garde
   `nFetch` en repli pour un pont qui ne l'exposerait pas, et `fetch` quand il n'y
   a pas de pont du tout — banc de test, navigateur).
2. **Rien ne reste en chargement.** La page dit où elle en est — « Chargement de
   votre bibliothèque… (2/5) » — et un délai de garde (25 s) termine la lecture
   avec ce qu'elle a : la page affiche alors « Votre bibliothèque n'a pas répondu
   à temps. Raison : … » avec le bouton « Réessayer ». Le pont qui ne répond pas
   est retenu (`asyncDead`) : les appels suivants ne font plus attendre.

Le chargement lit toujours les cinq sources **une par une** (§42) : c'est ce qui
laisse la page respirer entre deux requêtes.

### Vérifications

* banc : par le pont **asynchrone**, la bibliothèque se lit pendant que la page
  vit (un minuteur s'exécute pendant que la requête est en vol — c'est exactement
  ce que la voie bloquante empêchait), et la voie du navigateur n'est pas touchée ;
* banc : un pont **muet** ne laisse pas la page en « Chargement… » — elle termine
  en échec, dit « le pont n'a pas répondu », n'insiste pas sur la voie du
  navigateur (bloquée par le contrôle d'accès) et retient que le pont est muet ;
* banc : les ponts simulés ne déclarent plus que des méthodes réelles
  (`withoutAsync`) — un `Proxy` qui répondait à tout faisait croire au banc que la
  voie asynchrone existait, et il attendait une réponse qui ne venait jamais ;
* audit : la voie asynchrone côté Android (`nFetchAsync` sur un fil de fond,
  `runJs` dans l'activité), son usage côté page, la réception par `window.__sdNet`,
  le délai de garde, la progression du chargement et la préférence pour la voie
  non bloquante.

## §44 — La bibliothèque se rabat sur Spotify, le lecteur ne part plus (v2.11.9)

Message du 25/09 (09:40), sans capture :

> « Le lecteur a denouveaux disparu et la bibliothèque est tjrs buger. Il arrive
> pas a reconnaître mes playlist »

Trois choses, une seule cause probable : **le lecteur n'était pas connecté**. Pas
de session, donc pas de lecteur (le mini-lecteur n'existait qu'avec un lecteur
prêt : le bas de l'écran se vidait), pas de jeton (la bibliothèque restait sur son
constat d'échec), et aucune porte de sortie (le bouton « Réessayer » ne pouvait
rien donner). La version précédente savait le dire, mais seulement dans le
diagnostic — pas dans ce que l'on voit.

### Le lecteur est toujours là

La barre de lecture était conditionnée à trois lectures d'état : une piste en
cours, un lecteur prêt, ou « vu une fois depuis le chargement de la page ». Le
troisième garde-fou (§42) ne survivait pas à un rechargement de page. Elle est
donc maintenant **inconditionnelle** dans la coque : `sd-mini-on` est posé au
premier repeint, et la coque se repeint **au défilement** (cadence douce), pour
que rien de ce que Spotify démonte en défilant ne l'emporte.

Quand la session est fermée, la barre le dit — « Non connecté · Appuyez pour vous
connecter » — au lieu de rester vide, et l'appui mène à la connexion classique.

### La bibliothèque, quatre voies au lieu d'une

1. **`/me` d'abord.** C'est le seul appel qui dit à quel compte appartient le
   jeton. Sans lui, une réponse validée par un jeton **anonyme** faisait écrire
   « Aucune playlist… pour ce compte » — un mensonge. Le compte est maintenant
   nommé en tête du résumé (« Compte X · Playlists 5 · Albums 2 »), et un jeton
   sans compte donne l'état `guest` (« Le lecteur n'est pas connecté à Spotify »
   ou « Je n'ai pas pu vérifier à quel compte… »), jamais « vide ».
2. **La liste de Spotify, en repli.** La barre latérale du lecteur est déjà
   remplie par Spotify, avec le compte de l'utilisateur, sans jeton ni requête de
   notre part : `fromSpotifyList()` en lit les adresses (playlist, album,
   artiste, podcast) et la page les affiche, en disant d'où elles viennent. Pour
   cela, la barre latérale n'est plus retirée du flux quand notre page la
   remplace : `opacity: 0` au lieu de `display: none` — en `display: none`,
   Spotify ne la remplissait plus, et le repli aurait été vide.
3. **Le jeton redemandé à la page.** La capture n'attrape que les requêtes que la
   page a déjà faites. La page du lecteur sait donner son jeton
   (`/get_access_token`, même origine, donc hors contrôle d'accès) : la coque le
   redemande quand il manque, et une seconde fois si Spotify l'a refusé
   (401/403/419) — puis relit. Un jeton **anonyme** est refusé comme jeton de
   compte : c'est le lecteur qui n'est pas connecté, on le dit.
4. **Le journal des essais.** Quand l'API a failli, la page écrit chaque appel et
   son verdict (« /me → pont 401 · jeton refusé (401) »), l'âge du jeton, et ce
   qu'a donné le renouvellement. Une seule capture suffit alors à savoir ce qui
   manque — la règle posée depuis le §40.

Enfin, « Réessayer » sans session ne pouvait rien donner : la page propose
maintenant **« Se connecter à Spotify »** à côté, qui mène à la connexion
classique (`?allow_password=1`), la même que l'écran d'accueil maison.

### Mesures (CI, ce commit)

* « Lecteur au défilement — page-fr » : `coque posée · avant=visible 412x192 ·
  après=visible 412x192 · sd-mini-on · place réservée=calc(120px * 1)` ;
* « Onglet Bibliothèque — accueil » : `bibliothèque=visible 412x731 lignes=0`
  **`état=indisponible (réponse par navigateur (429))`** — la raison exacte est
  désormais dans l'annotation, et la barre latérale de Spotify (`barre-laterale`)
  n'est plus ce qu'on mesure : c'est **notre** page qui est à l'écran.

### Vérifications

* banc : si l'API ne répond pas, les trois lignes de la liste de Spotify
  s'affichent à la place (adresses, dédoublonnage, note « lues dans la liste de
  Spotify ») et le journal dit que `/me` a été refusé ;
* banc : le jeton redemandé à la page (`/get_access_token`) permet de **relire**
  la bibliothèque et de nommer le compte — sans lui, une bibliothèque sans jeton
  n'avait aucune issue ;
* banc : le lecteur reste affiché **sans session** (barre visible, texte dédié,
  classe `sd-mini-signed-out`) et la bibliothèque propose la connexion ;
* banc : le résumé nomme le compte lu (« Compte Moi · Playlists 2 ») ;
* audit : voie asynchrone conservée, arrêt sur refus de jeton (401/403/419),
  repli sur la liste de Spotify, jeton redemandé et **anonyme refusé**, journal
  présent, lecteur affiché en permanence et repeint au défilement ; sonde :
  barre de Spotify distinguée de la nôtre, lecteur relevé deux fois pendant le
  défilement, raison et journal relevés.
