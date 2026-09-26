  /* ------------------------------------------------------------------ *
   * 11e-quinquies. Library — **notre** bibliothèque
   *
   * Signalé le 25/09 : « sur l'onglet bibliothèque, je ne vois aucune de mes
   * playlists enregistrées sur mon compte ».
   *
   * L'onglet ne faisait qu'afficher la barre latérale de Spotify
   * (`#Desktop_LeftSidebar_Id`, `.YourLibraryX`) en plein écran, avec notre
   * feuille par-dessus. Quand son rendu ne suit pas — liste vide, conteneur
   * replié, classe renommée par Spotify — il ne reste rien à voir, et on ne
   * peut pas réparer depuis ici une liste qu'on ne lit pas.
   *
   * Cette page lit donc la bibliothèque **à la source** : l'API du lecteur, avec
   * le jeton que la page utilise déjà (`Api.authToken`, le même que les
   * statistiques d'écoute). Playlists (créées et suivies), titres likés, albums
   * enregistrés, artistes suivis, podcasts enregistrés — puis notre mise en
   * page : lignes de 64 px, pochettes de 56 px, filtres par type, compteurs, et
   * des adresses réelles (`/playlist/…`, `/album/…`) que le routeur de Spotify
   * ouvre comme n'importe quel lien.
   *
   * Prudence : rien ne s'affiche tant qu'il n'y a rien à montrer. Si le jeton
   * manque ou si l'API ne répond pas, la barre latérale de Spotify reste visible
   * telle quelle (le comportement d'avant) — on ne peut pas perdre l'accès à sa
   * musique en installant cette version.
   * ------------------------------------------------------------------ */

