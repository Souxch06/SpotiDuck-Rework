# Architecture du dépôt — comment ce projet se construit, et qui le vérifie

Ce document est la carte, pas le journal. Le journal des passes est
[`UI-REWORK.md`](UI-REWORK.md) ; le chemin d'installation est
[`INSTALLATION.md`](INSTALLATION.md) ; la question de l'abonnement est traitée dans
[`PREMIUM.md`](PREMIUM.md). Ce qui suit répond à trois questions : **qu'est-ce qui
génère quoi**, **quelles règles ne doivent jamais être cassées**, et **quel garde-fou
attrape quelle classe de défaut**.

---

## 1. Le graphe de construction

Il n'y a **qu'un chemin de construction** (`npm run build`) et **un seul chemin de
livraison** (`npm run sync:android`, appelé par `npm run android`). Avant la passe
2.11.25, `android` rejouait deux générateurs dans son propre ordre — ce qui laissait
une porte : on pouvait livrer des ressources construites par une chaîne partielle.

```
src/inject/*.css ─┐ (14 feuilles, dans l'ordre des numéros de fichier)
                  ├─ tools/build.mjs ──────────────► dist/spotiduck-ui.js   [LA COQUE]
src/inject/spotiduck-ui.js ─┘   (+ window.__SD_VERSION__ depuis package.json)

src/original/spotiduck-original.js ─┬─ tools/build-original-fit.mjs ─► dist/original-fingerprint.js
                                    │                                 ► dist/spotiduck-original.js
                                    └─ tools/build-original.mjs ─────► dist/spotiduck-identity.js

SLICES (10 blocs verrouillés) ─ tools/build-logic.mjs ──────────────► dist/spotiduck-logic.js
                                                    ▲                  [LE MOTEUR]
                       tools/build-logic.locks.json┘

dist/* + android/app/src/main/assets/native-mode.js + adblock_hosts.txt + silent.mp3
      └─ tools/sync-android.mjs ──► android/app/src/main/assets/*
```

Trois propriétés sont voulues, et `npm run check` les vérifie :

* **Les sorties sont versionnées.** `dist/` et `android/app/src/main/assets/` sont
  dans le dépôt, parce que l'APK est construit par la CI à partir du dépôt, sans
  étape de build : ce qui est commité **est** ce qui est livré. Corollaire — et c'est
  la source n° 1 des faux bugs de ce projet — : une retouche de `src/` non
  reconstruite part telle quelle dans l'APK, sans un message. D'où la règle 2 du
  portique et le `git diff --exit-code` de la CI.
* **Le moteur n'est pas réécrit, il est découpé.** `tools/build-logic.mjs` ne produit
  que du **collage** : dix blocs recopiés octet pour octet de
  `src/original/spotiduck-original.js`, choisis par des marqueurs `from`/`to`
  uniques, plus une colle qui ne fait que transférer. Un bloc doit cadrer un **tout**
  de l'original, jamais une moitié : une portion ne se relit pas et ne se prouve pas.
* **Un verrou ne se pose pas tout seul.** Les empreintes (longueur + md5) vivent dans
  `tools/build-logic.locks.json`, et seul `node tools/build-logic.mjs --record-locks`
  y touche. Une construction ordinaire qui trouve un bloc sans empreinte **échoue**
  au lieu de certifier ce qu'elle vient de fabriquer — sinon « repris tel quel »
  veut dire « ce que le générateur a bien voulu sortir », ce qui n'est une preuve de
  rien.

### Ordre d'injection dans la WebView

`MainActivity.onPageStarted` injecte, dans cet ordre, et cet ordre est un contrat :

1. `spotiduck-logic.js` — le moteur, avant tout : il doit poser son capteur sur
   `fetch` **avant** que la page n'émette le `Client-Token` de la session ;
2. `spotiduck-identity.js` + `original-fingerprint.js` ;
3. `spotiduck-ui.js` — la coque, qui dessine et qui alimente le moteur ;
4. `native-mode.js` — le mode « page desktop habillée », indépendant.

## 2. Qui fait quoi

| Fichier | Rôle | Ce qu'il ne fait pas |
| --- | --- | --- |
| `src/inject/spotiduck-ui.js` | la coque : 41 modules dans une IIFE, `Engine` (porte vers le moteur), `Bridge`, `Spotify.click/press/key`, `Actions.*`, `Gestures`, `diagnose()` | ne connaît aucune règle métier de l'original |
| `src/inject/NN-*.css` | l'habillage, numéroté dans l'ordre d'application | rien de comportemental |
| `dist/spotiduck-logic.js` (généré) | le moteur : capteur de jetons, `playFromUri`, veille, réveils, `act*`, `manageAll`, `updMedia` | **ne dessine rien** ; ses sorties d'origine qui touchaient la page (`updNpbState`, `clickNP`, `closeNowPlay`, `addCSSHacks`) restent des no-ops fournis par la coque |
| `native-mode.js` | repli « page desktop habillée », utilisé par les comptes gratuits | ne touche pas au moteur |
| `tools/build-*.mjs` | générateurs | n'écrivent jamais hors de `dist/` (+ le fichier de verrous, uniquement avec `--record-locks`) |
| `tools/check.mjs` | le portique d'hygiène, section 4 | ne juge pas le comportement (c'est `smoke`) ni les liens (c'est `audit`) |
| `tools/audit-links.mjs` | 11 groupes : sélecteurs candidats, classes CSS ↔ bundle, chaînes de commandes, chaîne de lecture, ordre d'injection | — |
| `tools/smoke.mjs`, `tools/smoke-logic.mjs` | 154 + 29 assertions de comportement, dans jsdom / `node:vm`, sans WebView | ne prouve pas le rendu réel |
| `tools/regress-audit.mjs` | rejoue chaque régression vécue contre l'audit (43 cas) | — |
| `tools/probe-*.mjs` | sondes sur la vraie page, exécutées par leurs workflows, hors chemin de release | ne bloquent pas une release |
| `tools/make-silence.mjs` | régénère `silent.mp3` (l'asset qui retient le processus Android en vie pendant la lecture) | — |

## 3. Invariants — ce qui ne doit jamais être cassé

Règles de la coque (rappelées en tête de `src/inject/spotiduck-ui.js`) :

1. **Jamais d'écriture dans l'arbre React de Spotify.** Tout vit dans `.sd-layer`.
2. **Événementiel, pas de scrutation** : `MutationObserver` + un seul ticker `rAF`.
   *Exception assumée* : le moteur garde les `setInterval` de l'original — c'est son
   comportement d'origine, et le portage est un collage.
3. **Pas de globale** sauf `window.SpotiDuckUI` (et, pour le moteur, l'unique façade
   `window.SpotiDuckLogic` + les globales implicites que l'original se partage).
4. **Toute sélecteur de Spotify est une liste de candidats avec repli** — la page
   change de markup tous les quelques mois, une sélecteur unique meurt en silence.
5. **`document.documentElement.clientWidth/Height`, jamais `window.innerWidth`** :
   la WebView rapporte une largeur qui n'est pas celle du viewport layouté.
6. **La lecture d'abord, l'élégence ensuite** : une décision de mise en page qui
   compromet la lecture sur compte gratuit est une mauvaise décision. Le mode desktop
   habillé reste la réponse par défaut aux deux modes.
7. **Un seul maître par flux d'état.** Un deuxième pilote de rapport (`manageAll`,
   `updMedia`) ou de lecture coupe la lecture ; l'installateur du moteur reste
   auto-limitant par `.fuckd`, et la coque ne passe par `Engine.sync` que par le
   tunnel unique `Bridge.mediaStatus`.
8. **Toute affirmation de rendu s'accompagne d'une mesure sur la configuration livrée**
   (agent + identité + URL), pas d'une coquille vide de jsdom.

## 4. Carte des garde-fous — quelle règle attrape quelle classe de défaut

| Classe de défaut | Qui l'attrape, et où |
| --- | --- |
| JS/outil qui ne se parse plus (accent grave dans un gabarit, guillemet non fermé) | `check` règle 1 (acorn) ; la CI tombe en code 1 même si le portique meurt lui-même |
| Ressource livrée périmée (`dist` ≠ assets, `src` ≠ `dist`) | `check` règle 2 (comparaison d'octets), CI étape 2 (`git diff --exit-code`) |
| Asset ou source non suivi par git (clone frais amputé) | `check` règle 3 (`git ls-files`) |
| Index qui déclare un fichier supprimé alors qu'il existe (après rollback/reset/merge) | `check` règle 4 (`git diff --cached --name-status`) |
| Bloc d'origine sans verrou, ou verrou non fidèle | `build-logic` (échoue, n'écrit pas), `check` règle 5, `audit` groupe 11 |
| Méthode du pont citée par le JS, absente du Kotlin | `check` règle 6a ; `audit` (pont, deux sens) |
| Commentaire Kotlin non fermé, chaîne brute non fermée | `check` (décompte des délimiteurs — déterministe) |
| Grammaire Kotlin complète | `android.yml` → `compileDebugKotlin` (le seul à avoir raison) |
| XML de ressource mal formé | `check` (jsdom en `text/xml`) — faute avant `aapt2`, donc avant quatre minutes de build |
| Référence `§NN` vers une section de doc inexistante | `check` (les deux formes de titres sont admises : `## 6.` et `## §30 —`) |
| `scripts` npm / workflows qui pointent dans le vide | `check` règle 7 |
| Feuille CSS absente du bundle, bundle sans la version du dépôt | `check` règle 8 |
| Régression de comportement (gestes, file d'attente, mini-lecteur, moteur) | `smoke` (154) + `smoke-logic` (29) |
| Lien interne cassé (sélecteur, classe, chaîne de commande, ordre d'injection) | `audit` (11 groupes) |
| Un défaut vécu qui revient | `regress-audit` (43 cas : le défaut est réinjecté, l'audit doit hurler) |
| Le portique lui-même (règle décorative) | `check --selftest` (5 mutations, dont « le portique ne dit rien » → échec) |
| Ce qui ne se voit que sur le téléphone | le diagnostic `· commandes …` du téléphone, et les workflows de sonde |

## 5. Procédure de release

1. `npm install && npm run build && npm run check && npm run check:selftest` ;
2. `npm run verify` (build, check, fumée, audit, régressions) ;
3. `npm run android` puis **relire `git diff --stat`** : les ressources générées ont
   changé, c'est normal, un contenu qui change *sans* raison ne l'est pas ;
4. monter la version dans `package.json` **seul** — le bundle la porte toute seul
   (`check` règle 8 refuse un bundle qui n'a pas la version du dépôt) ;
5. `git add -A && git commit` (le portique est passé, `git add -A` fait partie du
   rituel : c'est lui qui vide l'index des fantômes), pousser la branche de session ;
6. tag annoté `vX.Y.Z` poussé, `gh release create` ; **surveiller**
   `android.yml` jusqu'à `success` (c'est lui qui construit et signe l'APK) ;
7. vérifier la pièce jointe (`SpotiDuck-X.Y.Z-<sha>.apk`, taille non nulle), puis
   supprimer la release précédente : **une seule release doit exister** ;
8. commentaire de PR en français avec ce qui change, ce qui est mesuré, et ce qui
   reste dû.

## 6. Ce que ce dépôt ne vérifie pas — et pourquoi c'est assumé

* **Le rendu réel.** jsdom ne peint pas. Une mise en page n'est validée que par
  mesure dans la WebView (les sondes) ou par le téléphone de l'utilisateur.
* **Le markup de Spotify**, qui change sans prévenir : les listes de candidats et
  l'audit existent pour *voir* la dérive, pas pour l'empêcher.
* **Le Kotlin** n'est compilé qu'à la sortie de release (pas de SDK ici) ; d'où le
  refus d'écrire un approximateur de syntaxe maison — une règle à faux positifs est
  retirée, puis le code se casse en confiance.
* **La grammaire des SLICES** : un marqueur `from`/`to` inventé de mémoire ne casse
  pas le build, il casse le *sens*. Le rituel est de lire la source à la ligne près
  (`sed -n 'A,Bp' src/original/spotiduck-original.js | fold -w 172 -s`) puis de relire
  le diff du fichier de verrous.

## 7. Dettes ouvertes (reportées, pas ignorées)

Voir `UI-REWORK.md` §56 à §59 pour le détail : unité de position (secondes de
l'original contre millisecondes de la page), `Net`/`Api` à lire par `Engine.tokens()`,
`updMedia`/`manageAll` comme rapporteur unique, la page desktop à 412 px (le passe
d'affichage ne s'ouvre qu'une fois la logique terminée), et — côté utilisateur — la
ligne `· commandes …` du diagnostic du téléphone, seule arbitre du défaut de
touche de lecture encore non confirmé sur l'appareil.
