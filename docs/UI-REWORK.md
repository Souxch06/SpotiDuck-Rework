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
