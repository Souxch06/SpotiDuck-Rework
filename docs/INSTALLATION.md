# Installer SpotiDuck sans être interrompu par Play Protect

Play Protect est un service de **Google**, pas une permission Android : il
analyse tout APK installé hors du Play Store. Aucune application ne peut le
désactiver pour elle-même, et rien dans un APK ne supprime cet écran (demander
`REQUEST_INSTALL_PACKAGES` ou embarquer un installeur le rendrait au contraire
plus méfiant).

## 1. Couper la vérification (à faire une fois)

1. Ouvre le **Play Store**.
2. Touche ton **icône de profil** (en haut à droite) → **Play Protect**.
3. Touche l'**engrenage ⚙️** (en haut à droite).
4. **Décoche « Analyser les applis avec Play Protect »**.

L'application peut t'y emmener directement :

* **mode d'origine** (celui livré par défaut) : appui long sur la page → bouton
  **Play Protect** ;
* **habillage SpotiDuck** : Paramètres → **À propos** → **Vérification Play
  Protect**.

Tu peux réactiver l'analyse après : l'application déjà installée continue de
fonctionner.

## 2. Si l'avertissement apparaît quand même

| Ce que tu vois | Ce que ça veut dire | Quoi faire |
| --- | --- | --- |
| « Play Protect n'a pas pu vérifier cette appli » / développeur inconnu | SpotiDuck n'est pas sur le Play Store et est signé avec sa propre clé | **⋮ → Plus de détails → Installer quand même**, ou couper la vérification (§1) |
| « Application non sécurisée bloquée » (un seul bouton) | verdict négatif de l'analyse pour cet APK | il faut passer par le réglage (§1) ; aucun « Installer quand même » n'est proposé |

Autre contournement, sans rien désactiver : installer depuis un ordinateur avec

```bash
adb install -r SpotiDuck-2.7.1-e3b7e00.apk
```

L'interface d'installation n'est pas utilisée, donc aucune interruption.

## Ce qui a été fait côté application

* `MainActivity.openPlayProtect()` ouvre l'écran Play Protect (services Google,
  puis Play Store, puis réglages de sécurité du téléphone) et répond si elle a
  réussi ; `Bridge.openPlayProtect()` l'expose à la page.
* Ligne **Vérification Play Protect** dans les réglages de l'habillage, bouton
  **Play Protect** dans le sélecteur d'interface du mode d'origine.
* Rien qui aggrave l'analyse : permissions limitées à ce dont l'application a
  besoin (Internet, état réseau, veille, notifications, service de lecture),
  aucune demande d'installation d'autres applications, aucun accès aux autres
  paquets.
* Même certificat depuis la 2.6.0 : les mises à jour s'installent par-dessus, et
  une clé qui signe toujours la même application finit par être connue de
  l'appareil.

## La seule voie vers un verdict « de confiance »

Publier sur le Play Store, ou déposer un
[recours auprès de Play Protect](https://support.google.com/googleplay/android-developer/contact/protectappeals).
Ni l'un ni l'autre n'est possible pour un lecteur Spotify non officiel : la
vérification restera donc à couper sur le téléphone.
