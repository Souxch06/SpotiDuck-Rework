# Clé de signature de SpotiDuck

Ce dossier contient le **certificat** de la clé avec laquelle la CI signe les
APK publiés :

| | |
| --- | --- |
| Fichier | `spotiduck.crt` (certificat X.509, sans clé privée) |
| Empreinte SHA-256 | `2C:A5:C2:4E:F4:F9:17:7D:8E:9D:96:2C:F6:42:8A:D1:92:30:D4:02:00:75:ED:7F:95:FA:DD:7D:9F:15:A3:A6` |
| Alias / mot de passe | `spotiduck` / `spotiduck` |
| Clé privée | dérivée du *seed* public et embarquée dans `.github/workflows/android.yml` |

## Pourquoi ces deux fichiers sont dans le dépôt

Android ne se contente pas de vérifier que la nouvelle version est signée avec la
**même clé** : il compare le **certificat du signataire**. Un certificat
auto-signé regénéré à chaque compilation (numéro de série aléatoire, date de
début = date du build) change donc d'une version à l'autre et Android refuse la
mise à jour :

> L'application n'a pas été installée car le paquet est en conflit avec un
> paquet existant.

C'est exactement ce qui cassait les mises à jour avant la v2.6.0 : la clé privée
était stable, mais le certificat était recréé par `openssl req -new -x509` à
chaque exécution de la CI.

`spotiduck.crt` est généré **une fois** avec un numéro de série et des dates
figés, puis versionné. La compilation ne fait plus que l'assembler avec la clé
dans un conteneur PKCS#12 pour Gradle.

## Ce n'est pas un secret

La clé privée est déjà présente dans le dépôt (bloc base64 dans
`.github/workflows/android.yml`, produit par `android/tools/derive-key.py`).
Ce certificat ne contient d'ailleurs que la partie publique. Le but n'est pas la
sécurité mais la **continuité des mises à jour** : tout le monde peut vérifier
que les APK publiés viennent bien de cette clé.

Si vous préférez signer avec votre propre clé, renseignez les secrets
`SD_KEYSTORE_BASE64`, `SD_KEYSTORE_PASSWORD`, `SD_KEY_ALIAS` et
`SD_KEY_PASSWORD` : le workflow les utilise à la place. Attention : changer de
clé (ou de certificat) plus tard oblige les utilisateurs à désinstaller une fois.
