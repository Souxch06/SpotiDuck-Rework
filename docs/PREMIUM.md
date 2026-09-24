# Les fonctions Premium, et ce que cette application peut en faire

Demande d'origine : « ajoute toutes les fonctionnalités disponibles avec Premium
sur le projet, 100 % gratuit ». Ce document répond fonction par fonction, sans
arrondir. La conclusion tient en une phrase : **la plupart de ces fonctions ne
sont pas dans la page, elles sont dans le compte** — l'application affiche le
lecteur web de Spotify, elle ne décide ni de la qualité du son, ni des droits du
compte, ni du droit de télécharger.

Ce qui suit distingue trois choses très différentes :

* ce que **l'application peut** faire (et fait déjà) ;
* ce qui est **déjà gratuit** chez Spotify, mais pas au même endroit selon
  l'appareil — et donc ce qu'il suffit d'utiliser ;
* ce qu'**aucune application tierce ne peut** obtenir, parce que ça se décide
  sur les serveurs de Spotify, à la seconde où le son est préparé.

---

## 1. Ce que l'application fait déjà

| | |
| --- | --- |
| **Publicité et pistage** | 1 314 hôtes bloqués (régies publicitaires, mesure d'audience, `adeventtracker`, `ads-akp`, `ads-fa`, `adstudio`, `aet`, `pixel`…). Le blocage se fait au niveau réseau, dans la WebView, avant même que la requête ne parte. |
| **Invitations à l'abonnement** | fenêtres, encarts et le bouton Premium de la barre du bas sont retirés (§17 de `docs/UI-REWORK.md`). Plus aucune relance d'abonnement dans l'interface. |
| **Bandeaux « application »** | « Ouvrir dans l'application », liens Play Store / App Store : retirés. |
| **Confort** | paroles (gratuites chez Spotify), file d'attente, recherche, bibliothèque, navigation complète, notification Android et écran verrouillé. |

Le blocage réseau est le même principe qu'un bloqueur de publicité de
navigateur : il empêche le **chargement** d'hôtes publicitaires connus. Il ne
touche pas au son, qui vient d'ailleurs.

## 2. Ce qui est déjà gratuit chez Spotify — mais pas au même endroit

C'est ici que se trouve la vraie réponse à « je veux les fonctions Premium ».

Depuis septembre 2025, un compte gratuit peut **choisir un titre** et le lire :
sur mobile comme sur le web. Mais il y a une réserve : l'écoute à la demande est
**allouée par jour**. Quand l'allocation est épuisée, le compte repasse en
mélange, avec **six sauts par heure**. C'est le palier gratuit de Spotify, pas
une limite de l'application.

La différence importante pour ce projet :

| Où | Compte gratuit | Ce que ça change ici |
| --- | --- | --- |
| **Lecteur web bureau** (modes *Interface d'origine* et *Habillage SpotiDuck*) | Lecture à la demande : on choisit le titre, l'album, la position. Les sauts ne sont pas comptés comme sur mobile. | C'est le mode qui donne **le plus de latitude** à un compte gratuit. |
| **Page web mobile** (affichage mobile, livré par défaut) | Allocations mobiles : écoute à la demande limitée par jour, puis mélange et six sauts par heure. | C'est la page de Spotify, avec ses règles. |

Autrement dit : le mode livré par défaut est celui qui **ressemble** le plus à
l'application Spotify, et l'interface d'origine est celui qui **laisse** le plus
de choses faire à un compte gratuit. Les deux sont dans le sélecteur (appui long
de 3 secondes), et la session de connexion suit le changement de mode.

## 3. Ce qu'aucune application tierce ne peut obtenir

Pour chacune de ces fonctions, la décision est prise par les serveurs de
Spotify, en fonction du **compte** — pas de la page, pas du navigateur, pas du
téléphone.

| Fonction Premium | Pourquoi c'est hors de portée |
| --- | --- |
| **Qualité 320 kbps, sans perte (FLAC)** | Le palier gratuit plafonne à 160 kbps. L'adresse du flux audio est **signée par Spotify** au moment de la lecture, pour le compte qui la demande. Falsifier une valeur dans la page ne fait pas servir un autre fichier. |
| **Téléchargement / écoute hors ligne** | Les téléchargements des applications officielles passent par un contenu chiffré, sous licence, que seul un client agréé sait ouvrir. Une WebView ne peut pas, et cette application ne télécharge rien. |
| **Sauts illimités, lecture à la demande sans réserve** | C'est un compteur côté serveur (allocations, six sauts par heure). Le contourner, ce serait contourner le palier gratuit lui-même. |
| **Spotify Connect, Duo/Family Mix, livres audio** | Fonctions attachées au compte. Elles n'existent pas dans la page web. |
| **Suppression totale des annonces audio** | Les annonces sont insérées **dans le flux de lecture** servi par Spotify. Le blocage réseau arrête les régies publicitaires, pas ce qui est déjà dans le son : bloquer les serveurs de diffusion ferait taire la musique avec. |

## 4. Ce que ce projet ne fera pas

L'application n'usurpera pas un état Premium auprès de Spotify, ne débloquera
pas les fonctions payantes en falsifiant ce que la page vérifie, et ne
contournera pas les compteurs de sauts ni les allocations quotidiennes.

Trois raisons, dans l'ordre d'importance :

1. **C'est prendre un service payant sans le payer.** Le blocage de publicité
   est un choix défensif, courant et discutable ; débloquer les fonctions d'un
   abonnement en est un autre : c'est l'objet même de l'abonnement.
2. **Ça ne marche pas.** Tout ce qui compte (qualité, téléchargement, compteurs)
   est décidé par le serveur pour le compte connecté. Il n'y a pas de « drapeau »
   à basculer.
3. **Ça se paie sur le compte.** Les clients modifiés finissent détectés, et
   c'est le compte de la personne qui écoute qui est fermé — un compte bloqué,
   c'est aussi la perte des albums, des listes et de l'historique.

## 5. Ce qui reste à faire, si c'est utile

* Un indicateur dans la sonde **Diagnostic** (appui long → Diagnostic) disant
  dans quel mode on est, et donc quelles règles de palier gratuit s'appliquent.
* Un rappel, à l'ouverture du sélecteur d'interface, de la différence entre les
  modes (le mode bureau laisse plus de latitude à un compte gratuit).
* Continuer à retirer les invitations à l'abonnement là où elles réapparaissent.

Les trois sont légitimes, aucune ne demande de forcer quoi que ce soit. Il
suffit de le dire.
