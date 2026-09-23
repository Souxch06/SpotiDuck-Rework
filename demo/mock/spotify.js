/* ==========================================================================
   Mock Spotify web player — DOM fixture + fake playback engine.
   --------------------------------------------------------------------------
   Exposes `window.MockSpotify` so the injected layer can be driven in tests.
   Everything here mimics the *desktop* web player: same containers, same
   `data-testid` names, same ARIA conventions (localized `aria-label`,
   `aria-checked` on shuffle/repeat/like).
   ========================================================================== */
(function () {
  "use strict";

  /* ------------------------------------------------------------ fixtures */
  // Covers are generated as SVG data URIs: no network, no CORS taint, so the
  // accent-colour extraction of the mobile layer is exercised for real.
  function cover(hue, label, sub) {
    var svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 320">' +
      '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">' +
      '<stop offset="0" stop-color="hsl(' +
      hue +
      ',72%,58%)"/><stop offset="1" stop-color="hsl(' +
      ((hue + 45) % 360) +
      ',70%,22%)"/>' +
      "</linearGradient></defs>" +
      '<rect width="320" height="320" fill="url(#g)"/>' +
      (sub
        ? '<circle cx="250" cy="70" r="90" fill="rgba(255,255,255,.10)"/>' +
          '<circle cx="80" cy="260" r="120" fill="rgba(0,0,0,.18)"/>'
        : "") +
      '<text x="26" y="286" font-family="Segoe UI,Roboto,sans-serif" font-size="30" font-weight="700" fill="rgba(255,255,255,.95)">' +
      label +
      "</text></svg>";
    return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  }

  var TRACKS = [
    { title: "Baarishein", artist: "Anuv Jain", album: "Baarishein", duration: 207, hue: 210, liked: true },
    { title: "Jeena Jeena", artist: "Sachin-Jigar, Atif Aslam", album: "Badlapur", duration: 229, hue: 12, liked: false },
    { title: "Hazel Eyes", artist: "Sam Smith", album: "Hazel Eyes", duration: 184, hue: 42, liked: false },
    { title: "Full Moon Chamber", artist: "Prateek Kuhad", album: "Full Moon Chamber", duration: 241, hue: 280, liked: true },
    { title: "Alta Makhi", artist: "Sambalpuri Pop", album: "Alta Makhi", duration: 198, hue: 330, liked: false },
    { title: "Mantu Chhuria", artist: "Mantu Chhuria", album: "Hae Go", duration: 215, hue: 160, liked: false },
    { title: "Kesariya", artist: "Arijit Singh", album: "Brahmastra", duration: 268, hue: 24, liked: true },
    { title: "Sahiba", artist: "Aditya Rikhari", album: "Sahiba", duration: 190, hue: 6, liked: false },
  ];

  var LIBRARY = [
    { kind: "playlist", name: "Titres likés", meta: ["Playlist", "8 titres"], hue: 265, round: false, liked: true },
    { kind: "playlist", name: "\\(^o^)/", meta: ["Playlist", "OV32LO2D"], hue: 190 },
    { kind: "playlist", name: "All Out 00s Hindi", meta: ["Playlist", "Spotify"], hue: 350 },
    { kind: "playlist", name: "90's", meta: ["Playlist", "OV32LO2D"], hue: 300 },
    { kind: "playlist", name: "Arijit Singh Radio", meta: ["Playlist", "Made for you"], hue: 45 },
    { kind: "artist", name: "Yo Yo Honey Singh", meta: ["Artiste"], hue: 100, round: true },
    { kind: "artist", name: "Prateek Kuhad", meta: ["Artiste"], hue: 220, round: true },
    { kind: "album", name: "Hae Go", meta: ["Album", "Mantu Chhuria"], hue: 20 },
  ];

  var state = {
    trackIndex: 0,
    playing: false,
    position: 0, // seconds
    shuffle: false,
    repeat: "off", // off | context | track
    liked: {},
    volume: 0.75,
    route: "home",
  };
  TRACKS.forEach(function (t, i) {
    state.liked[i] = !!t.liked;
  });

  /* ------------------------------------------------------------- helpers */
  function el(html) {
    var t = document.createElement("template");
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  }
  function q(sel, root) {
    return (root || document).querySelector(sel);
  }
  var ICON = {
    home: '<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M12.5 3.247a1 1 0 0 0-1 0L4 7.577V20h4.5v-6a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v6H20V7.577l-7.5-4.33zm-2-1.732a3 3 0 0 1 3 0l7.5 4.33a2 2 0 0 1 1 1.732V21a1 1 0 0 1-1 1h-6.5a1 1 0 0 1-1-1v-6h-3v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V7.577a2 2 0 0 1 1-1.732l7.5-4.33z"/></svg>',
    search:
      '<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M10.5 2a8.5 8.5 0 1 0 5.3 15.2l4.5 4.5 1.4-1.4-4.5-4.5A8.5 8.5 0 0 0 10.5 2zm0 2a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13z"/></svg>',
    bell: '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M12 22a2.5 2.5 0 0 0 2.45-2h-4.9A2.5 2.5 0 0 0 12 22zm7-5V11a7 7 0 0 0-5.5-6.8V3.5a1.5 1.5 0 0 0-3 0v.7A7 7 0 0 0 5 11v6l-1.7 1.7h17.4L19 17z"/></svg>',
    people:
      '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M9 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm8 0a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM9 14c-3 0-7 1.5-7 4.5V21h14v-2.5C16 15.5 12 14 9 14zm8 0c-.7 0-1.4.1-2.1.2 1.3 1 2.1 2.3 2.1 4.3V21h6v-2.5c0-3-3-4.5-6-4.5z"/></svg>',
    logo: '<svg width="34" height="34" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm4.6 14.4a.8.8 0 0 1-1.1.3c-2.9-1.8-6.6-2.2-10.4-1.2a.8.8 0 1 1-.4-1.5c4.2-1.1 8.3-.7 11.6 1.3.4.2.5.7.3 1.1zm1.2-2.8a1 1 0 0 1-1.3.3c-3.3-2-8.3-2.6-12.2-1.4a1 1 0 1 1-.6-1.9c4.4-1.3 10-.7 13.8 1.7.4.2.6.8.3 1.3zm.1-2.9C14.1 8.5 7.5 8.3 4 9.4a1.2 1.2 0 1 1-.7-2.3c4-1.2 11.3-1 15.7 1.6a1.2 1.2 0 0 1-1.2 2z"/></svg>',
    play: '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M7.05 3.606l13.49 7.788a.7.7 0 0 1 0 1.212L7.05 20.394A.7.7 0 0 1 6 19.788V4.212a.7.7 0 0 1 1.05-.606z"/></svg>',
    pause:
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M5.7 3a.7.7 0 0 0-.7.7v16.6a.7.7 0 0 0 .7.7h3.6a.7.7 0 0 0 .7-.7V3.7a.7.7 0 0 0-.7-.7H5.7zm9 0a.7.7 0 0 0-.7.7v16.6a.7.7 0 0 0 .7.7h3.6a.7.7 0 0 0 .7-.7V3.7a.7.7 0 0 0-.7-.7h-3.6z"/></svg>',
    skipBack:
      '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M6.3 3a.7.7 0 0 1 .7.7v6.805l11.95-6.899A.7.7 0 0 1 20 4.212v15.576a.7.7 0 0 1-1.05.606L7 13.495V20.3a.7.7 0 0 1-.7.7H4.7a.7.7 0 0 1-.7-.7V3.7a.7.7 0 0 1 .7-.7h1.6z"/></svg>',
    skipForward:
      '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M17.7 3a.7.7 0 0 0-.7.7v6.805L5.05 3.606A.7.7 0 0 0 4 4.212v15.576a.7.7 0 0 0 1.05.606L17 13.495V20.3a.7.7 0 0 0 .7.7h1.6a.7.7 0 0 0 .7-.7V3.7a.7.7 0 0 0-.7-.7h-1.6z"/></svg>',
    shuffle:
      '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M16.5 3.5 21 8l-4.5 4.5V9.7h-2.1c-.6 0-1.2.3-1.5.8l-1.4 2.2-1.2-1.9 1.4-2.2a3.7 3.7 0 0 1 2.7-1.5h2.1V3.5zM3 7.5h3.3c1.1 0 2.1.5 2.7 1.5l4 6.2c.3.5.9.8 1.5.8H21v2.5h-6.5c-1.1 0-2.1-.5-2.7-1.5l-4-6.2a1.8 1.8 0 0 0-1.5-.8H3V7.5zm0 8.5h3.3c.6 0 1.2-.3 1.5-.8l.5-.8 1.2 1.9-.5.8c-.6 1-1.6 1.5-2.7 1.5H3V16z"/></svg>',
    repeat:
      '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M6 4h11l-2.5-2.5L16 0l5 4.5-5 4.5-1.5-1.5L17 6H6a2 2 0 0 0-2 2v2H2V8a4 4 0 0 1 4-4zm12 16H7l2.5 2.5L8 24l-5-4.5L8 15l1.5 1.5L7 18h11a2 2 0 0 0 2-2v-2h2v2a4 4 0 0 1-4 4z"/></svg>',
    check:
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm4.7 7.7-5.4 5.4a1 1 0 0 1-1.4 0l-2.6-2.6 1.4-1.4 1.9 1.9 4.7-4.7 1.4 1.4z"/></svg>',
    lyrics:
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M6 3h9l4 4v14H6V3zm2 5h5V7H8v1zm0 4h8v-1H8v1zm0 4h8v-1H8v1z"/></svg>',
    queue:
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M3 6h14v2H3V6zm0 5h14v2H3v-2zm0 5h9v2H3v-2zm14.5-5.5L22 13l-4.5 2.5v-5z"/></svg>',
    device:
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M6 2h12a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1zm6 7a3 3 0 1 0 0 6 3 3 0 0 0 0-6zm0 8a2 2 0 1 0 0 4 2 2 0 0 0 0-4z"/></svg>',
    volume:
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M11 4 6 8H3v8h3l5 4V4zm4.5 3.5a6 6 0 0 1 0 9l1.4 1.4a8 8 0 0 0 0-11.8l-1.4 1.4z"/></svg>',
    expand:
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M4 4h7v2H6v5H4V4zm9 0h7v7h-2V6h-5V4zM4 13h2v5h5v2H4v-7zm14 0h2v7h-7v-2h5v-5z"/></svg>',
    empty:
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a5 5 0 0 0-5 5v4H5v11h14V11h-2V7a5 5 0 0 0-5-5zm-3 9V7a3 3 0 0 1 6 0v4H9z"/></svg>',
  };

  /* ------------------------------------------------------------ rendering */
  var mainView, widget, progressInput, curTimeEl, durTimeEl;

  function trackAt(i) {
    return TRACKS[((i % TRACKS.length) + TRACKS.length) % TRACKS.length];
  }
  function currentTrack() {
    return trackAt(state.trackIndex);
  }
  function coverFor(t) {
    return cover(t.hue, t.title.split(" ")[0], true);
  }

  function homePage() {
    var shortcuts = [
      { name: "\\(^o^)/", hue: 190 },
      { name: "Titres likés", hue: 265 },
      { name: "90's", hue: 300 },
      { name: "phonk", hue: 275 },
      { name: "All Out 00s Hindi", hue: 350 },
      { name: "Arijit Singh Radio", hue: 45 },
    ]
      .map(function (s) {
        return (
          '<button class="shortcut" data-testid="card">' +
          '<img src="' +
          cover(s.hue, "") +
          '" alt="">' +
          "<span>" +
          s.name +
          "</span></button>"
        );
      })
      .join("");

    var shelves = [
      {
        title: "Trending Now India",
        items: TRACKS.slice(0, 4).map(function (t) {
          return { title: t.title, sub: "Artiste : " + t.artist.split(",")[0], hue: t.hue };
        }),
      },
      {
        title: "Pre-save upcoming releases",
        items: [
          { title: "Hazel Eyes", sub: "Sam Smith", hue: 42 },
          { title: "Full Moon Chamber", sub: "Prateek Kuhad", hue: 280 },
          { title: "Sahiba", sub: "Aditya Rikhari", hue: 6 },
        ],
      },
    ]
      .map(function (shelf) {
        var cards = shelf.items
          .map(function (c) {
            return (
              '<div data-testid="card">' +
              '<div data-testid="card-image"><img src="' +
              cover(c.hue, "") +
              '" alt=""></div>' +
              '<div data-testid="card-title">' +
              c.title +
              "</div>" +
              '<div data-testid="card-subtitle">' +
              c.sub +
              "</div></div>"
            );
          })
          .join("");
        return (
          '<section data-testid="component-shelf">' +
          "<h2>" +
          shelf.title +
          "</h2>" +
          '<div data-testid="grid-container">' +
          cards +
          "</div></section>"
        );
      })
      .join("");

    return (
      '<section data-testid="home-page">' +
      '<div class="contentSpacing">' +
      '<div data-testid="home-filter-chips" role="tablist">' +
      '<button role="tab" aria-selected="true">Tout</button>' +
      '<button role="tab">Musique</button>' +
      '<button role="tab">Podcasts</button>' +
      "</div>" +
      "</div>" +
      '<div class="contentSpacing">' +
      '<div data-testid="grid-container" class="shortcut-grid">' +
      shortcuts +
      "</div></div>" +
      shelves +
      "</section>"
    );
  }

  function searchPage() {
    var cats = [
      ["Podcasts", 260],
      ["Nouveautés", 340],
      ["Classements", 30],
      ["Concerts", 200],
      ["Humeur", 120],
      ["Pop", 300],
      ["Hip-hop", 20],
      ["Électro", 180],
      ["Rock", 0],
    ]
      .map(function (c) {
        return (
          '<div class="browse-card" style="background:linear-gradient(135deg,hsl(' +
          c[1] +
          ',65%,45%),hsl(' +
          ((c[1] + 40) % 360) +
          ',60%,28%))" data-testid="search-card">' +
          c[0] +
          "</div>"
        );
      })
      .join("");
    return (
      '<section data-testid="search-page">' +
      '<div class="contentSpacing"><h1>Parcourir tout</h1></div>' +
      '<div data-testid="grid-container" class="browse-grid">' +
      cats +
      "</div></section>"
    );
  }

  function playlistPage(item) {
    var t = item || { name: "Playlist du jour", meta: ["Playlist", "OV32LO2D"], hue: 265 };
    var rows = TRACKS.map(function (tr, i) {
      return (
        '<div data-testid="tracklist-row" role="row">' +
        '<div aria-colindex="1" class="row-index">' +
        (i + 1) +
        "</div>" +
        '<div aria-colindex="2" class="cell-title">' +
        '<img src="' +
        cover(tr.hue, "") +
        '" alt="">' +
        "<div><div class=\"t\">" +
        tr.title +
        '</div><div class="a">' +
        tr.artist +
        "</div></div></div>" +
        '<div aria-colindex="3">' +
        tr.album +
        "</div>" +
        '<div aria-colindex="4" class="row-menu">' +
        ICON.check +
        "</div>" +
        "</div>"
      );
    }).join("");

    return (
      '<section data-testid="playlist-page">' +
      '<div class="page-hero">' +
      '<img src="' +
      cover(t.hue, "") +
      '" alt="">' +
      "<div><div class=\"kind\">Playlist</div><h1>" +
      t.name +
      "</h1>" +
      '<div class="meta">' +
      (t.meta || []).join(" • ") +
      " • 8 titres • 26 min</div></div></div>" +
      '<div data-testid="topbar-content"><span>Playlist</span>' +
      '<button data-testid="play-button" aria-label="Lecture">' +
      ICON.play +
      "</button></div>" +
      '<div data-testid="action-bar-row">' +
      '<button data-testid="play-button" aria-label="Lecture">' +
      ICON.play +
      "</button>" +
      "<button aria-label=\"S'abonner\">" +
      ICON.check +
      "</button>" +
      "<button aria-label=\"Plus d'options\">…</button>" +
      "</div>" +
      '<div data-testid="tracklist-container">' +
      '<div data-testid="tracklist-header" role="row">' +
      "<div>#</div><div>Titre</div><div>Album</div><div></div></div>" +
      rows +
      "</div></section>"
    );
  }

  function renderMain() {
    if (state.route === "home") mainView.innerHTML = homePage();
    else if (state.route === "search") mainView.innerHTML = searchPage();
    else mainView.innerHTML = playlistPage(state.playlistItem);
    bindMain();
    q(".main-view-container__scroll-node").scrollTop = 0;
  }

  function bindMain() {
    // Shortcut tiles open a playlist page (mini SPA navigation)
    mainView.querySelectorAll(".shortcut").forEach(function (b) {
      b.addEventListener("click", function () {
        state.playlistItem = {
          name: b.querySelector("span").textContent,
          meta: ["Playlist", "OV32LO2D"],
          hue: Math.floor(Math.random() * 360),
        };
        navigate("playlist");
      });
    });
    // Clicking any row starts that track — like the real player
    mainView.querySelectorAll('div[data-testid="tracklist-row"]').forEach(function (row, i) {
      row.addEventListener("dblclick", function () {
        play(i);
      });
      row.addEventListener("click", function () {
        play(i);
      });
    });
    mainView.querySelectorAll('button[data-testid="play-button"]').forEach(function (b) {
      b.addEventListener("click", function () {
        play(0);
      });
    });
  }

  /* --------------------------------------------------------------- shell */
  function shell() {
    var libRows = LIBRARY.map(function (l, i) {
      return (
        '<div role="row" data-lib="' +
        i +
        '"' +
        (l.round ? ' class="is-round"' : "") +
        ">" +
        '<img src="' +
        cover(l.hue, "") +
        '" alt="">' +
        '<div role="gridcell"><div class="lib-name">' +
        l.name +
        '</div><div class="lib-meta">' +
        l.meta
          .map(function (m) {
            return "<span>" + m + "</span>";
          })
          .join('<span aria-hidden="true">•</span>') +
        "</div></div></div>"
      );
    }).join("");

    var queueRows = TRACKS.slice(1, 6)
      .map(function (t) {
        return (
          '<div class="queue-row"><img src="' +
          cover(t.hue, "") +
          '" alt=""><div><div>' +
          t.title +
          '</div><div class="q-a">' +
          t.artist +
          "</div></div></div>"
        );
      })
      .join("");

    var root = el(
      '<div data-testid="root">' +
        /* ---------------- top bar ---------------- */
        '<div id="global-nav-bar">' +
        '<div class="nav-buttons">' +
        '<button class="nav-pill" aria-label="Précédent">‹</button>' +
        '<button class="nav-pill" aria-label="Suivant">›</button>' +
        "</div>" +
        '<button data-testid="home-button" class="nav-icon" aria-label="Accueil">' +
        ICON.home +
        "</button>" +
        '<button data-testid="search-button" class="nav-icon" aria-label="Rechercher">' +
        ICON.search +
        "</button>" +
        '<form role="search"><input data-testid="search-input" placeholder="Que souhaitez-vous écouter ?" aria-label="Rechercher"></form>' +
        '<div class="nav-logo">' +
        ICON.logo +
        "</div>" +
        '<button class="nav-icon" aria-label="Notifications">' +
        ICON.bell +
        "</button>" +
        '<button class="nav-icon" aria-label="Activité des amis">' +
        ICON.people +
        "</button>" +
        '<button data-testid="user-widget-link" class="nav-icon is-round" aria-label="Profil">A</button>' +
        "</div>" +
        /* ---------------- main ---------------- */
        '<div class="main-view-container">' +
        '<div class="main-view-container__scroll-node">' +
        '<div class="main-view-container__scroll-node-child">' +
        '<div id="main-view"></div>' +
        "</div></div></div>" +
        /* ---------------- library ---------------- */
        '<div id="Desktop_LeftSidebar_Id">' +
        "<nav><div>Accueil</div><div>Rechercher</div></nav>" +
        "<header><div><div><h1>Bibliothèque</h1></div></div>" +
        '<div><button aria-label="Réduire la bibliothèque">+</button><button aria-label="Agrandir">↗</button></div></header>' +
        '<div class="YourLibraryX">' +
        "<div><header>" +
        '<div class="library-chips"><span>Playlists</span><span>Artistes</span><span>Albums</span></div>' +
        "</header>" +
        '<div role="grid" class="library-list">' +
        libRows +
        "</div></div></div></div>" +
        /* ---------------- side panel (queue) ---------------- */
        '<div id="Desktop_PanelContainer_Id">' +
        '<div><h3>File d\'attente</h3>' +
        queueRows +
        "</div></div>" +
        /* ---------------- now playing bar ---------------- */
        '<aside data-testid="now-playing-bar">' +
        '<div data-testid="now-playing-widget">' +
        '<div><img data-testid="cover-art-image" src="" alt=""></div>' +
        '<div class="np-links">' +
        '<a data-testid="context-item-link" href="#">—</a>' +
        '<a data-testid="context-item-info-artist" href="#">—</a>' +
        "</div>" +
        "<div>" +
        '<button class="np-like" data-testid="add-button" aria-checked="false" aria-label="Ajouter aux Titres likés">' +
        ICON.check +
        "</button>" +
        "</div></div>" +
        '<div data-testid="player-controls">' +
        '<div class="control-row">' +
        '<button data-testid="control-button-shuffle" aria-checked="false" aria-label="Activer la lecture aléatoire">' +
        ICON.shuffle +
        "</button>" +
        '<button data-testid="control-button-skip-back" aria-label="Précédent">' +
        ICON.skipBack +
        "</button>" +
        '<button data-testid="control-button-playpause" aria-label="Lecture" aria-live="polite">' +
        ICON.play +
        "</button>" +
        '<button data-testid="control-button-skip-forward" aria-label="Suivant">' +
        ICON.skipForward +
        "</button>" +
        '<button data-testid="control-button-repeat" aria-checked="false" aria-label="Activer la répétition">' +
        ICON.repeat +
        "</button>" +
        "</div>" +
        '<div class="playback-row">' +
        '<span class="cur-time">0:00</span>' +
        '<div data-testid="playback-progressbar">' +
        '<input type="range" min="0" max="100" value="0" step="0.1" aria-label="Barre de progression">' +
        "</div>" +
        '<span class="dur-time">0:00</span>' +
        "</div></div>" +
        '<div class="np-right">' +
        '<button data-testid="lyrics-button" data-testid-extra="lyrics" aria-label="Paroles">' +
        ICON.lyrics +
        "</button>" +
        '<button aria-label="File d\'attente">' +
        ICON.queue +
        "</button>" +
        '<button data-testid="control-button-connect" aria-label="Connexion à un appareil">' +
        ICON.device +
        "</button>" +
        '<button aria-label="Volume">' +
        ICON.volume +
        "</button>" +
        '<button data-testid="fullscreen-mode-button" aria-label="Plein écran">' +
        ICON.expand +
        "</button>" +
        "</div>" +
        "</aside>" +
        "</div>"
    );
    document.body.appendChild(root);

    mainView = q("#main-view");
    widget = q('div[data-testid="now-playing-widget"]');
    progressInput = q('div[data-testid="playback-progressbar"] input[type="range"]');
    curTimeEl = q(".cur-time");
    durTimeEl = q(".dur-time");

    wireShell();
    renderMain();
    renderPlayer();
  }

  /* ----------------------------------------------------------- navigation */
  function navigate(route, opts) {
    state.route = route;
    if (route === "search") renderMain();
    else if (route === "home") renderMain();
    else renderMain();
    if (!opts || !opts.silent) history.pushState({ route: route }, "", route === "home" ? "/" : "/" + route);
  }

  function wireShell() {
    q('button[data-testid="home-button"]').addEventListener("click", function () {
      navigate("home");
    });
    q('button[data-testid="search-button"]').addEventListener("click", function () {
      navigate("search");
    });
    var form = q('#global-nav-bar form[role="search"]');
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      navigate("search");
    });
    q('input[data-testid="search-input"]').addEventListener("focus", function () {
      if (state.route !== "search") navigate("search");
    });

    // Library rows navigate to a playlist page
    q("#Desktop_LeftSidebar_Id").addEventListener("click", function (e) {
      var row = e.target.closest('div[role="row"]');
      if (!row) return;
      var item = LIBRARY[parseInt(row.getAttribute("data-lib"), 10)];
      state.playlistItem = { name: item.name, meta: item.meta, hue: item.hue };
      navigate("playlist");
    });

    /* ---- transport ---- */
    q('button[data-testid="control-button-playpause"]').addEventListener("click", togglePlay);
    q('button[data-testid="control-button-skip-forward"]').addEventListener("click", nextTrack);
    q('button[data-testid="control-button-skip-back"]').addEventListener("click", prevTrack);
    q('button[data-testid="control-button-shuffle"]').addEventListener("click", function () {
      state.shuffle = !state.shuffle;
      this.setAttribute("aria-checked", state.shuffle ? "true" : "false");
    });
    q('button[data-testid="control-button-repeat"]').addEventListener("click", function () {
      state.repeat = state.repeat === "off" ? "context" : state.repeat === "context" ? "track" : "off";
      this.setAttribute("aria-checked", state.repeat === "off" ? "false" : state.repeat === "track" ? "mixed" : "true");
    });
    q('button[data-testid="add-button"]').addEventListener("click", function () {
      state.liked[state.trackIndex] = !state.liked[state.trackIndex];
      renderPlayer();
    });
    q('button[aria-label="File d\'attente"]').addEventListener("click", function () {
      var panel = q("#Desktop_PanelContainer_Id");
      panel.style.display = panel.style.display === "block" ? "none" : "block";
    });
    // Seek: the real player listens to input/change on the range input
    progressInput.addEventListener("input", function () {
      state.position = parseFloat(progressInput.value) || 0;
      renderTimes();
    });
    progressInput.addEventListener("change", function () {
      state.position = parseFloat(progressInput.value) || 0;
      renderTimes();
    });
    window.addEventListener("popstate", function () {
      navigate(state.route, { silent: true });
    });
  }

  /* ------------------------------------------------------------ playback */
  function togglePlay() {
    state.playing = !state.playing;
    renderPlayer();
  }
  function play(index) {
    state.trackIndex = index;
    state.position = 0;
    state.playing = true;
    renderPlayer();
  }
  function nextTrack() {
    state.trackIndex = (state.trackIndex + 1) % TRACKS.length;
    state.position = 0;
    renderPlayer();
  }
  function prevTrack() {
    state.trackIndex = (state.trackIndex - 1 + TRACKS.length) % TRACKS.length;
    state.position = 0;
    renderPlayer();
  }

  function renderPlayer() {
    var t = currentTrack();
    var img = widget.querySelector('img[data-testid="cover-art-image"]');
    var src = coverFor(t);
    if (img.getAttribute("src") !== src) img.setAttribute("src", src);
    widget.querySelector('a[data-testid="context-item-link"]').textContent = t.title;
    widget.querySelector('a[data-testid="context-item-info-artist"]').textContent = t.artist;

    var likeBtn = widget.querySelector("div:last-child > button");
    var liked = !!state.liked[state.trackIndex];
    likeBtn.setAttribute("aria-checked", liked ? "true" : "false");
    likeBtn.setAttribute("aria-label", liked ? "Retirer des Titres likés" : "Ajouter aux Titres likés");

    var playBtn = q('button[data-testid="control-button-playpause"]');
    playBtn.innerHTML = state.playing ? ICON.pause : ICON.play;
    playBtn.setAttribute("aria-label", state.playing ? "Pause" : "Lecture");

    progressInput.setAttribute("max", String(t.duration));
    progressInput.value = String(Math.min(state.position, t.duration));
    renderTimes();
  }

  function renderTimes() {
    var t = currentTrack();
    curTimeEl.textContent = fmt(state.position);
    durTimeEl.textContent = fmt(t.duration);
  }
  function fmt(s) {
    s = Math.max(0, Math.floor(s));
    return Math.floor(s / 60) + ":" + (s % 60 < 10 ? "0" : "") + (s % 60);
  }

  // The engine paints the DOM exactly like React would: the mobile layer
  // only ever *reads* these nodes, so this keeps both sides honest.
  setInterval(function () {
    if (!state.playing) return;
    var t = currentTrack();
    state.position += 0.25;
    if (state.position >= t.duration) {
      if (state.repeat === "track") state.position = 0;
      else nextTrack();
      return;
    }
    progressInput.value = String(state.position);
    renderTimes();
  }, 250);

  /* ---------------------------------------------------------------- boot */
  shell();
  window.MockSpotify = {
    state: state,
    tracks: TRACKS,
    play: play,
    navigate: navigate,
    get track() {
      return currentTrack();
    },
  };
})();
