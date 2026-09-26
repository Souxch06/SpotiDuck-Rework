  /* ------------------------------------------------------------------ *
   * 7. Icons (24×24). Line icons where a stroked glyph reads better on a
   *    small screen, filled where Spotify's own design is solid.
   * ------------------------------------------------------------------ */
  var ICONS = {
    homeLine:
      '<path d="M12.5 3.247a1 1 0 0 0-1 0L4 7.577V20h4.5v-6a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v6H20V7.577l-7.5-4.33zm-2-1.732a3 3 0 0 1 3 0l7.5 4.33a2 2 0 0 1 1 1.732V21a1 1 0 0 1-1 1h-6.5a1 1 0 0 1-1-1v-6h-3v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V7.577a2 2 0 0 1 1-1.732l7.5-4.33z"/>',
    homeSolid:
      '<path d="M13.5 1.515a3 3 0 0 0-3 0L3 5.845a2 2 0 0 0-1 1.732V21a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1v-6h4v6a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V7.577a2 2 0 0 0-1-1.732l-7.5-4.33z"/>',
    searchLine:
      '<path d="M10.533 1.279c-5.18 0-9.407 4.14-9.407 9.279s4.226 9.279 9.407 9.279c2.234 0 4.29-.77 5.907-2.058l4.353 4.353a1 1 0 1 0 1.414-1.414l-4.344-4.344a9.157 9.157 0 0 0 2.077-5.816c0-5.14-4.226-9.28-9.407-9.28zm-7.407 9.279c0-4.006 3.302-7.28 7.407-7.28s7.407 3.274 7.407 7.28-3.302 7.279-7.407 7.279-7.407-3.273-7.407-7.28z"/>',
    searchSolid:
      '<path d="M10.533 1.279c-5.18 0-9.407 4.14-9.407 9.279s4.226 9.279 9.407 9.279c2.234 0 4.29-.77 5.907-2.058l4.353 4.353a1 1 0 1 0 1.414-1.414l-4.344-4.344a9.157 9.157 0 0 0 2.077-5.816c0-5.14-4.226-9.28-9.407-9.28zm-4.8 9.279c0-2.77 2.03-4.8 4.8-4.8 2.77 0 4.8 2.03 4.8 4.8 0 2.77-2.03 4.8-4.8 4.8-2.77 0-4.8-2.03-4.8-4.8z"/>',
    libraryLine:
      '<path d="M3 22a1 1 0 0 1-1-1V3a1 1 0 0 1 2 0v18a1 1 0 0 1-1 1zm6.5 0a1 1 0 0 1-1-1V3a1 1 0 0 1 2 0v18a1 1 0 0 1-1 1zM15.8 3.2a1 1 0 0 1 1.2-.7l1.6.4a1 1 0 0 1 .7 1.2l-4.6 17.6a1 1 0 0 1-1.2.7l-1.6-.4a1 1 0 0 1-.7-1.2l4.6-17.6z"/>',
    librarySolid:
      '<path d="M3 22a1 1 0 0 1-1-1V3a1 1 0 0 1 2 0v18a1 1 0 0 1-1 1zM9 22a1 1 0 0 1-1-1V3a1 1 0 0 1 2 0v18a1 1 0 0 1-1 1zm7.4-19.6a1 1 0 0 1 1.2-.7l1.5.4a1 1 0 0 1 .7 1.2l-4.4 17.6a1 1 0 0 1-1.2.7l-1.5-.4a1 1 0 0 1-.7-1.2l4.4-17.6z"/>',
    play: '<path d="M7.05 3.606l13.49 7.788a.7.7 0 0 1 0 1.212L7.05 20.394A.7.7 0 0 1 6 19.788V4.212a.7.7 0 0 1 1.05-.606z"/>',
    pause:
      '<path d="M5.7 3a.7.7 0 0 0-.7.7v16.6a.7.7 0 0 0 .7.7h3.6a.7.7 0 0 0 .7-.7V3.7a.7.7 0 0 0-.7-.7H5.7zm9 0a.7.7 0 0 0-.7.7v16.6a.7.7 0 0 0 .7.7h3.6a.7.7 0 0 0 .7-.7V3.7a.7.7 0 0 0-.7-.7h-3.6z"/>',
    next: '<path d="M17.7 3a.7.7 0 0 0-.7.7v6.805L5.05 3.606A.7.7 0 0 0 4 4.212v15.576a.7.7 0 0 0 1.05.606L17 13.495V20.3a.7.7 0 0 0 .7.7h1.6a.7.7 0 0 0 .7-.7V3.7a.7.7 0 0 0-.7-.7h-1.6z"/>',
    prev: '<path d="M6.3 3a.7.7 0 0 1 .7.7v6.805l11.95-6.899A.7.7 0 0 1 20 4.212v15.576a.7.7 0 0 1-1.05.606L7 13.495V20.3a.7.7 0 0 1-.7.7H4.7a.7.7 0 0 1-.7-.7V3.7a.7.7 0 0 1 .7-.7h1.6z"/>',
    shuffleLine:
      '<g fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M18 4.5 21 7.5l-3 3"/><path d="M18 13.5l3 3-3 3"/><path d="M3 7.5h3.7a4 4 0 0 1 3.4 1.9l3 5.2a4 4 0 0 0 3.4 1.9H21"/><path d="M3 16.5h3.7a4 4 0 0 0 3.4-1.9l3-5.2A4 4 0 0 1 16.5 7.5H21"/></g>',
    repeatLine:
      '<g fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3.5l3 3-3 3"/><path d="M20 6.5H7a4 4 0 0 0-4 4v1"/><path d="M7 20.5l-3-3 3-3"/><path d="M4 17.5h13a4 4 0 0 0 4-4v-1"/></g>',
    heartLine:
      '<path d="M12 20.7 4.9 13.9A4.9 4.9 0 0 1 12 7.2a4.9 4.9 0 0 1 7.1 6.7L12 20.7z" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/>',
    heartSolid:
      '<path d="M12 20.7 4.9 13.9A4.9 4.9 0 0 1 12 7.2a4.9 4.9 0 0 1 7.1 6.7L12 20.7z"/>',
    checkCircle:
      '<path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm4.7 7.7-5.4 5.4a1 1 0 0 1-1.4 0l-2.6-2.6 1.4-1.4 1.9 1.9 4.7-4.7 1.4 1.4z"/>',
    /* Tête de canard du logo — écran d'accueil et icône de notification. */
    duck:
      '<path d="M13.5 2.3a6.3 6.3 0 0 0-6.1 7.9L2.7 12a1 1 0 0 0 0 1.9l4.7 1.8A6.3 6.3 0 1 0 13.5 2.3zm1.6 4.4a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z"/>',
    queueLine:
      '<g fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h12M4 12h12M4 18h7"/><path d="M17.5 14.5 21.5 17l-4 2.5z" fill="currentColor" stroke="none"/></g>',
    deviceLine:
      '<g fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"><rect x="5" y="2.5" width="14" height="19" rx="1.5"/><circle cx="12" cy="9.5" r="2.6"/><circle cx="12" cy="16.5" r="1.6"/></g>',
    lyricsLine:
      '<g fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3.5h8.5L18 7v13.5H6z"/><path d="M8.5 11h7M8.5 14.5h7M8.5 8h3.5"/></g>',
    micLine:
      '<path d="M12 1.8A3.2 3.2 0 0 0 8.8 5v6a3.2 3.2 0 0 0 6.4 0V5A3.2 3.2 0 0 0 12 1.8zm-6 9.2a1 1 0 0 1 1 1 5 5 0 0 0 10 0 1 1 0 1 1 2 0 7 7 0 0 1-6 6.93V21h2.6a1 1 0 1 1 0 2H10.4a1 1 0 1 1 0-2H13v-2.07A7 7 0 0 1 5 12a1 1 0 0 1 1-1z"/>',
    speakerLine:
      '<path d="M11.4 3.05a1 1 0 0 1 .6.92v16.06a1 1 0 0 1-1.62.78L6.1 17.4H4a1 1 0 0 1-1-1V7.6a1 1 0 0 1 1-1h2.1l4.28-3.41a1 1 0 0 1 1.02-.14zM15.7 8.1a1 1 0 0 1 1.4.08 5.6 5.6 0 0 1 0 7.64 1 1 0 1 1-1.49-1.33 3.6 3.6 0 0 0 0-4.98 1 1 0 0 1 .09-1.41zM18.6 5.1a1 1 0 0 1 1.41.02 9.6 9.6 0 0 1 0 13.76 1 1 0 0 1-1.44-1.39 7.6 7.6 0 0 0 0-10.98 1 1 0 0 1 .03-1.41z"/>',
    shareLine:
      '<g fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5v11"/><path d="M8.5 7 12 3.5 15.5 7"/><path d="M5.5 11.5v8h13v-8"/></g>',
    plusLine:
      '<g fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></g>',
    chevronDown:
      '<path d="M5.3 9.1a1 1 0 0 1 1.4 0L12 14.4l5.3-5.3a1 1 0 1 1 1.4 1.4L12 17.2 5.3 10.5a1 1 0 0 1 0-1.4z"/>',
    chevronLeft:
      '<path d="M15.7 4.3a1 1 0 0 1 0 1.4L9.4 12l6.3 6.3a1 1 0 0 1-1.4 1.4l-7-7a1 1 0 0 1 0-1.4l7-7a1 1 0 0 1 1.4 0z"/>',
    ellipsis:
      '<path d="M6 12a1.75 1.75 0 1 1-3.5 0 1.75 1.75 0 0 1 3.5 0zm7.75 0a1.75 1.75 0 1 1-3.5 0 1.75 1.75 0 0 1 3.5 0zm7.75 0a1.75 1.75 0 1 1-3.5 0 1.75 1.75 0 0 1 3.5 0z"/>',
    musicNote:
      '<path d="M20 3.2v12.3a3.5 3.5 0 1 1-2-3.2V6.6l-8 1.7v9.2a3.5 3.5 0 1 1-2-3.2V5.6l12-2.4z"/>',
    gearLine:
      '<g fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 2.8l1.2 1.9 2.2-.5.6 2.2 2 .9-.9 2 1.2 1.9-1.2 1.9.9 2-2 .9-.6 2.2-2.2-.5L12 21.2l-1.2-1.9-2.2.5-.6-2.2-2-.9.9-2L5.7 12l1.2-1.9-.9-2 2-.9.6-2.2 2.2.5z"/></g>',
    discLine:
      '<g fill="none" stroke="currentColor" stroke-width="1.9"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.6"/></g>',
    /* Barre de navigation supérieure (disposition d'origine de SpotiDuck). */
    bellLine:
      '<g fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9.5a6 6 0 0 1 12 0c0 4 1.2 5.6 2.2 6.6.5.5.1 1.4-.6 1.4H4.4c-.7 0-1.1-.9-.6-1.4C4.8 15.1 6 13.5 6 9.5z"/><path d="M9.8 20.2a2.4 2.4 0 0 0 4.4 0"/></g>',
    friendsLine:
      '<g fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="9.2" cy="8.6" r="3.4"/><path d="M2.8 19.4c0-3 2.9-5 6.4-5s6.4 2 6.4 5"/><path d="M16.4 6.2a3.2 3.2 0 0 1 0 6.2"/><path d="M17.6 14.8c2.2.5 3.6 1.9 3.6 4"/></g>',
    spotifyLogo:
      '<g><circle cx="12" cy="12" r="10"/><g fill="none" stroke="#000" stroke-width="1.9" stroke-linecap="round"><path d="M7 9c3.3-.9 6.7-.5 9.6 1.3"/><path d="M7.6 12.6c2.7-.7 5.4-.4 7.8 1.1"/><path d="M8.2 15.9c2.1-.5 4.2-.3 6 .9"/></g></g>',
    personLine:
      '<g fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"><circle cx="12" cy="8" r="3.6"/><path d="M4.8 20.4c0-3.3 3.2-5.6 7.2-5.6s7.2 2.3 7.2 5.6"/></g>',
    refreshLine:
      '<g fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20 3.6V8h-4.4"/></g>',
    cloudOffLine:
      '<g fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M7.5 18h8a4 4 0 0 0 .8-7.9 5.5 5.5 0 0 0-8-2.6M6.6 18a3.8 3.8 0 0 1-.4-7.6"/><path d="M3.5 3.5l17 17"/></g>',
    checkLine: '<path d="M9.6 16.3 5.3 12l-1.4 1.4 5.7 5.7L20.4 7.4 19 6z"/>',
    infoLine:
      '<g fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.6v.2"/></g>',
    shieldLine:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v6c0 4.2-2.9 7.6-7 9-4.1-1.4-7-4.8-7-9V6l7-3z"/><path d="M9.5 12l1.8 1.8L14.8 10"/></svg>',
    arrowUndo:
      '<g fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/></g>',
    plusCircle:
      '<g fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/></g>',
  };

  function svg(paths, cls) {
    return (
      '<svg class="' +
      (cls || "") +
      '" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
      paths +
      "</svg>"
    );
  }

