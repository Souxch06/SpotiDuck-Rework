  /* ------------------------------------------------------------------ *
   * 11e-ter. Home — **notre** page d'accueil
   *
   * Le 24/09, l'accueil du web player a été repris trois fois (mise en page de
   * bureau, quatre colonnes de pochettes de 59 px, conteneurs de 440 px rognés
   * dans une page de 412) et il restait « coupé » et « pas très beau ». Décision
   * prise avec l'utilisateur : l'application affiche **son propre** accueil.
   *
   * Le principe : on ne recopie pas Spotify, on **lit** la page. Titres de
   * rangées, pochettes, liens : tout vient du DOM réel (donc c'est bien la
   * musique de l'utilisateur, ses recommandations, sa bibliothèque), et on le
   * rend avec notre mise en page — qui, elle, est écrite pour un téléphone et
   * n'a aucune métrique de bureau à rattraper.
   *
   * Ce que ça garantit :
   *   · rien ne peut être « coupé » : la grille est en `auto-fill` sur une
   *     largeur de carte utile, la pochette remplit sa case ;
   *   · chaque commande fait quelque chose : les cartes et « Tout afficher »
   *     sont de vrais liens de la page, les filtres filtrent, les raccourcis
   *     utilisent le routeur existant ;
   *   · si nos données sont vides (page de connexion, session fermée, écran de
   *     rangées qui n'existe pas), l'accueil **s'efface** et la page reprend la
   *     main : jamais d'écran maison vide par-dessus un écran vide.
   * ------------------------------------------------------------------ */

  var HOME_MAX_SHELVES = 8;
  var HOME_MAX_CARDS = 12;

  var Home = {
    el: null,
    built: false,
    data: [],
    filter: "all",
    greeting: "",

    /** Les rangées de la page : titre, lien « tout afficher », cartes. */
    readPage: function () {
      var shelves = $$('section[data-testid="component-shelf"], div[data-testid="grid-container"]');
      /* `rows`, pas `out` : l'audit de cohérence lit les objets du fichier sans
         tenir compte des portées, et un `out` local homonyme d'un objet global
         lui fait croire à un appel de méthode manquant. */
      var rows = [];
      var seen = {};
      for (var i = 0; i < shelves.length && rows.length < HOME_MAX_SHELVES; i++) {
        var shelf = shelves[i];
        var head = shelf.querySelector("h2, .encore-text-headline-large, [data-encore-id=\"text\"]");
        var title = head ? (head.textContent || "").replace(/\s+/g, " ").trim() : "";
        if (!title) continue;
        /* **Une carte n'est pas forcément un lien.** Sur la vraie page, les
           cartes de l'accueil sont des `div[role=button]` (la mesure du 24/09 :
           `CARTE div.OniARfz…`), et la première version de ce lecteur ne
           cherchait que des `a[href]` : elle ne trouvait rien, l'accueil se
           masquait, et l'utilisateur revoyait exactement l'écran de Spotify
           (« rien n'a changé »). On accepte donc les deux formes, et quand il
           n'y a pas d'adresse, on **clique la carte d'origine** au moment de
           l'appui (voir `openOriginal`). */
        var CARD_SEL =
          'a[href], [role="button"], [data-testid="card-clickable"], div[data-encore-id="card"], [data-testid="shortcut-card"]';
        var candidates = shelf.querySelectorAll(CARD_SEL);
        var cards = [];
        var seenHref = {};
        var seenLabel = {};
        for (var j = 0; j < candidates.length && cards.length < HOME_MAX_CARDS; j++) {
          var node = candidates[j];
          var img = node.querySelector("img");
          if (!img) continue;
          /* L'adresse : celle de la carte, ou celle d'un lien qu'elle contient. */
          var inner = node.querySelector("a[href]");
          var href = node.getAttribute("href") || (inner ? inner.getAttribute("href") : "") || "";
          if (href === "#") href = "";
          /* Le libellé : nom accessible, puis texte de la carte, puis l'image. */
          var label = (node.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
          if (!label) {
            var t = node.querySelector("p, span.encore-text, [data-encore-id=\"text\"]");
            label = t ? (t.textContent || "").replace(/\s+/g, " ").trim() : "";
          }
          if (!label) label = (img.getAttribute("alt") || "").trim();
          if (!label && href) label = decodeURIComponent(href.split("/").filter(Boolean).pop() || "");
          label = label.replace(/\s*·\s*/g, " · ").slice(0, 60);
          if (!label || label.length < 2) continue;
          var dedupe = href || label.toLowerCase();
          if (seenHref[dedupe] || seenLabel[label.toLowerCase()]) continue;
          seenHref[dedupe] = 1;
          seenLabel[label.toLowerCase()] = 1;
          var sub = node.querySelector("span.encore-text-body-small, p.encore-text-body-small");
          cards.push({
            href: href,
            img: img.currentSrc || img.getAttribute("src") || "",
            title: label,
            sub: sub ? (sub.textContent || "").replace(/\s+/g, " ").trim().slice(0, 40) : "",
            type: Home.typeOf(href, title, label),
            /* Pour retrouver la carte d'origine : le rang de la rangée et celui de
               la carte dans cette rangée. */
            shelf: i,
            card: j,
          });
        }
        if (!cards.length) continue;
        /* Le lien « Tout afficher » : Spotify l'écrit, le nomme parfois
           seulement en `aria-label`, et pointe toujours vers une section
           (`/section/…`). Trois lectures valent mieux qu'une : le texte, le
           libellé d'accessibilité, et la destination. */
        var more = null;
        var headLinks = shelf.querySelectorAll("a[href]");
        for (var k = 0; k < headLinks.length; k++) {
          var link = headLinks[k];
          var said = (link.textContent || "") + " " + (link.getAttribute("aria-label") || "");
          var href = link.getAttribute("href") || "";
          if (/tout afficher|show all|see all|afficher tout/i.test(said) || /\/section\//.test(href)) {
            more = href;
            break;
          }
        }
        var key = title.toLowerCase();
        if (seen[key]) continue;
        seen[key] = 1;
        rows.push({ title: title, more: more, cards: cards });
      }
      return rows;
    },

    /** Clique la carte **d'origine** de la page (quand elle n'est pas un lien).
        Les cartes sont relues au moment de l'appui : entre l'affichage et le
        clic, Spotify a pu reconstruire ses rangées. */
    openOriginal: function (shelfIndex, cardIndex) {
      var shelves = $$('section[data-testid="component-shelf"], div[data-testid="grid-container"]');
      var shelf = shelves[shelfIndex];
      if (!shelf) return false;
      var CARD_SEL =
        'a[href], [role="button"], [data-testid="card-clickable"], div[data-encore-id="card"], [data-testid="shortcut-card"]';
      var candidates = [];
      var all = shelf.querySelectorAll(CARD_SEL);
      for (var i = 0; i < all.length; i++) {
        if (all[i].querySelector("img")) candidates.push(all[i]);
      }
      var node = candidates[cardIndex];
      if (!node) return false;
      var link = node.tagName === "A" && node.getAttribute("href") ? node : node.querySelector("a[href]");
      if (link && link.getAttribute("href")) {
        location.assign(link.getAttribute("href"));
        return true;
      }
      node.click();
      return true;
    },

    /** Musique, podcast, ou autre — d'après l'adresse et les mots du titre. */
    typeOf: function (href, shelfTitle, label) {
      var h = (href || "").toLowerCase();
      var s = ((shelfTitle || "") + " " + (label || "")).toLowerCase();
      if (/\/(show|episode)\//.test(h) || /podcast|episode|emission/.test(s)) return "podcast";
      if (/\/(album|artist|track|playlist|collection|section)\//.test(h)) return "music";
      return "other";
    },

    /** **Le chemin fait foi.** La détection de vue (`State.route`) dépend du DOM
        de Spotify : quand elle se trompait, l'accueil se croyait « ailleurs » et
        ne s'affichait jamais — c'est l'autre moitié du « rien n'a changé ».
        L'adresse, elle, ne se trompe pas : la racine du web player est
        l'accueil, tout le reste (playlist, album, artiste, recherche) est une
        autre page. */
    isHomePath: function () {
      var path = (location.pathname || "/").replace(/\/+$/, "") || "";
      if (path === "" || path === "/" || path === "/home") return true;
      /* `/fr`, `/fr-FR`, `/en`… **et `/intl-fr`** : c'est le chemin que Spotify
         sert réellement en France (relevé sur le téléphone : `page /intl-fr/`).
         La première version ne l'acceptait pas — donc l'accueil maison ne
         s'affichait pas là où l'utilisateur arrive. Une sous-page (playlist,
         album, artiste, `/section/…`) n'est jamais un chemin d'accueil. */
      return /^\/(?:intl-)?[a-z]{2}(?:-[a-z]{2})?$/i.test(path);
    },

    /**
     * L'état de l'accueil, en une phrase, pour le diagnostic.
     *
     * « Rien n'a changé » a coûté deux versions parce que le diagnostic ne
     * disait pas **pourquoi** l'accueil ne s'affichait pas : il fallait deviner
     * entre les données, le chemin, la session et le réglage. Cette phrase
     * nomme la raison, et le nombre de rangées quand il s'affiche.
     */
    describe: function () {
      if (!Settings.homeBoard) return "désactivé (réglage)";
      if (!this.built) return "pas construit";
      if (!this.data.length && !Stats.hasData()) return "masqué (aucune donnée)";
      if (!this.isHomePath()) return "masqué (hors accueil)";
      if (LoginState.isLoginPage()) return "masqué (page de connexion)";
      if (!LoginState.signedIn()) return "masqué (session fermée)";
      var cards = this.el ? this.el.querySelectorAll(".sd-home-card").length : 0;
      return (this.el && this.el.hidden ? "masqué" : "affiché") + " " + this.data.length + " rangées/" + cards + " cartes";
    },

    shouldShow: function () {
      if (!Settings.homeBoard) return false;
      if (!this.built) return false;
      /* **L'onglet fait foi.** Signalé le 25/09 : « quand on clique sur l'onglet
         bibliothèque, la barre en haut disparaît et rien d'autre n'apparaît ; je
         reste bloqué sur l'écran d'accueil ». L'accueil ne regardait que le
         chemin de l'URL — or un appui sur l'onglet Bibliothèque **ne change pas
         d'URL** (c'est la barre latérale de Spotify qui est montrée) : l'accueil
         se croyait donc toujours à sa place et couvrait l'écran. */
      if (State.tab !== "home") return false;
      /* Les statistiques suffisent : l'accueil est **notre** écran, il n'a pas
         besoin que Spotify publie des rangées pour exister. */
      if (!this.data.length && !Stats.hasData()) return false;
      if (!this.isHomePath()) return false;
      if (LoginState.isLoginPage()) return false;
      if (!LoginState.signedIn()) return false;
      return true;
    },

    /** Construit (une fois) le squelette de l'accueil. */
    build: function () {
      if (this.built) return true;
      var el = document.createElement("div");
      el.className = "sd-home";
      el.setAttribute("role", "region");
      el.setAttribute("aria-label", Settings.labels.home);
      el.innerHTML =
        '<div class="sd-home-greet">' +
        '<span class="sd-home-hello"></span>' +
        '<span class="sd-home-sub"></span>' +
        "</div>" +
        '<div class="sd-home-chips" role="tablist">' +
        '<button class="sd-chip sd-chip-all is-active" type="button" role="tab" data-filter="all"></button>' +
        '<button class="sd-chip sd-chip-music" type="button" role="tab" data-filter="music"></button>' +
        '<button class="sd-chip sd-chip-podcast" type="button" role="tab" data-filter="podcast"></button>' +
        "</div>" +
        '<div class="sd-home-stats"></div>' +
        '<div class="sd-home-shortcuts"></div>' +
        '<div class="sd-home-sections"></div>';
      this.el = el;
      UI.layer.appendChild(el);

      /* Les filtres : c'est le seul endroit de l'accueil où l'appui ne navigue
         pas — il filtre, et l'état « actif » se voit (aria-selected). */
      var self = this;
      $$(".sd-chip", el).forEach(function (chip) {
        chip.addEventListener("click", function () {
          self.setFilter(chip.getAttribute("data-filter"));
        });
      });
      this.built = true;
      return true;
    },

    /** Les raccourcis : trois commandes réelles, jamais décoratives. */
    buildShortcuts: function () {
      var box = $(".sd-home-shortcuts", this.el);
      if (!box || box.childNodes.length) return;
      var items = [
        { key: "search", label: Settings.labels.search, icon: ICONS.searchLine, run: function () { Router.tab("search"); } },
        { key: "library", label: Settings.labels.library, icon: ICONS.libraryLine, run: function () { Router.tab("library"); } },
        { key: "settings", label: Settings.labels.settings, icon: ICONS.gearLine, run: function () { Sheets.open("settings"); } },
        { key: "liked", label: Settings.labels.likedSongs || Settings.labels.library, icon: ICONS.heartLine, run: function () {
            var a = pick(['a[href*="/collection/tracks"]', 'a[href*="/collection"]']);
            if (a) location.assign(a.getAttribute("href"));
            else Router.tab("library");
          } },
      ];
      items.forEach(function (item) {
        var b = document.createElement("button");
        b.type = "button";
        b.className = "sd-shortcut sd-shortcut-" + item.key;
        b.innerHTML =
          '<span class="sd-shortcut-icon">' + svg(item.icon) + "</span>" +
          '<span class="sd-shortcut-label"></span>';
        $(".sd-shortcut-label", b).textContent = item.label;
        b.addEventListener("click", item.run);
        box.appendChild(b);
      });
    },

    setFilter: function (name) {
      this.filter = name === "music" || name === "podcast" ? name : "all";
      $$(".sd-chip", this.el).forEach(function (chip) {
        var on = chip.getAttribute("data-filter") === Home.filter;
        chip.classList.toggle("is-active", on);
        chip.setAttribute("aria-selected", on ? "true" : "false");
      });
      this.renderSections();
      var visible = $$(".sd-home-card", this.el).length;
      if (!visible) Toast.show(Settings.labels.homeEmptyCategory, 1600);
    },

    /* ---------------- statistiques ---------------- */

    /**
     * Le bloc « Vos statistiques », refait le 25/09 : « les statistiques sont
     * pas bonne il me semble. Rends les statistiques plus compréhensible ».
     *
     * Trois principes :
     *  1. **le temps d'abord** — trois durées (aujourd'hui, sept jours, depuis
     *     le début), dans la même unité, avec le nombre d'écoutes en dessous ;
     *  2. **les nombres expliqués** — chaque compteur dit ce qu'il compte
     *     (« jours de suite avec une écoute »), dans une section à part ;
     *  3. **une seule unité par graphique** — les sept derniers jours et les
     *     moments de la journée sont en temps écouté, comme les durées du
     *     haut, et chaque barre porte sa valeur.
     */
    renderStats: function () {
      var box = $(".sd-home-stats", this.el);
      if (!box) return false;
      var L = Settings.labels;
      var sum = Stats.summary();
      box.textContent = "";
      box.hidden = false;

      /* En-tête : le titre, et le bouton d'effacement à droite. */
      var head = document.createElement("div");
      head.className = "sd-home-head";
      var h = document.createElement("h2");
      h.className = "sd-home-section-title";
      h.textContent = L.statsTitle;
      head.appendChild(h);
      var reset = document.createElement("button");
      reset.type = "button";
      reset.className = "sd-stat-reset";
      reset.textContent = L.statsClear;
      reset.addEventListener("click", function () {
        Stats.clear();
        Toast.show(L.statsCleared, 1600);
      });
      head.appendChild(reset);
      box.appendChild(head);

      if (!sum.total) {
        var empty = document.createElement("p");
        empty.className = "sd-stat-empty";
        empty.textContent = L.statsEmpty;
        box.appendChild(empty);
        return true;
      }

      var plays = this.plays(sum.plays);

      /* La ligne de tête : le temps écouté, en clair, et la période couverte. */
      var lead = document.createElement("p");
      lead.className = "sd-stat-lead";
      lead.textContent =
        L.statsLead.replace("%s", Stats.human(sum.seconds)).replace("%s", plays) +
        (sum.playsToday ? " · " + L.statsToday + " " + Stats.human(sum.secondsToday) : "");
      box.appendChild(lead);

      /* 1. Le temps écouté — la question que l'on se pose d'abord. */
      var timeCard = document.createElement("div");
      timeCard.className = "sd-stat-card";
      timeCard.appendChild(this.statTitle(L.statsTimeSection));
      var tiles = document.createElement("div");
      tiles.className = "sd-stat-tiles";
      [
        [Stats.human(sum.secondsToday), L.statsToday, this.plays(sum.playsToday)],
        [Stats.human(sum.secondsWeek), L.statsDays.replace(/^(Ces|ces) /, ""), this.plays(sum.playsWeek)],
        [
          Stats.human(sum.seconds),
          L.statsTotal,
          sum.first ? L.statsSince.replace("%s", Stats.dayLabel(sum.first)) : plays,
        ],
      ].forEach(function (triple) {
        tiles.appendChild(Home.statTile(triple[0], triple[1], triple[2]));
      });
      timeCard.appendChild(tiles);
      var measureNote = document.createElement("p");
      measureNote.className = "sd-stat-note";
      measureNote.textContent = L.statsNoteMeasure;
      timeCard.appendChild(measureNote);
      if (sum.estimatedPlays) {
        var estNote = document.createElement("p");
        estNote.className = "sd-stat-note sd-stat-note-est";
        estNote.textContent = L.statsNoteEstimate.replace("%s", Stats.human(sum.estimated));
        timeCard.appendChild(estNote);
      }
      box.appendChild(timeCard);

      /* 2. Les nombres : chacun dit ce qu'il compte. */
      var numbersCard = document.createElement("div");
      numbersCard.className = "sd-stat-card";
      numbersCard.appendChild(this.statTitle(L.statsNumbersSection));
      var numbers = document.createElement("div");
      numbers.className = "sd-stat-tiles";
      [
        [String(sum.plays), L.statsPlayed, L.statsHintTrack],
        [String(sum.trackCount), L.statsTracks, L.statsHintDifferent],
        [String(sum.artistCount), L.statsArtists, L.statsHintArtist],
        [String(sum.streak), L.statsStreak, L.statsHintStreak],
      ].forEach(function (triple) {
        numbers.appendChild(Home.statTile(triple[0], triple[1], triple[2]));
      });
      numbersCard.appendChild(numbers);
      box.appendChild(numbersCard);

      /* 3. Les sept derniers jours, en temps écouté : hauteur = minutes. */
      var week = document.createElement("div");
      week.className = "sd-stat-card";
      week.appendChild(this.statTitle(L.statsDays));
      var weekSum = sum.secondsWeek || 0;
      var maxSec = 1;
      sum.byDay.forEach(function (d) {
        if (d.sec > maxSec) maxSec = d.sec;
      });
      var chart = document.createElement("div");
      chart.className = "sd-stat-chart";
      var todayIndex = sum.byDay.length - 1;
      sum.byDay.forEach(function (d, index) {
        var col = document.createElement("div");
        col.className = "sd-stat-col" + (index === todayIndex ? " is-today" : "");
        var count = document.createElement("span");
        count.className = "sd-stat-count";
        count.textContent = d.sec ? Stats.human(d.sec) : "";
        count.setAttribute(
          "title",
          Stats.weekdayLabel(d.day) + " · " + Stats.human(d.sec) + " · " + Home.plays(d.n)
        );
        var bar = document.createElement("span");
        bar.className = "sd-stat-bar";
        bar.style.height = Math.max(d.sec ? 6 : 2, Math.round((d.sec / maxSec) * 100)) + "%";
        var label = document.createElement("span");
        label.className = "sd-stat-day";
        label.textContent = Stats.weekdayLabel(d.day);
        col.appendChild(count);
        col.appendChild(bar);
        col.appendChild(label);
        chart.appendChild(col);
      });
      week.appendChild(chart);
      var weekNote = document.createElement("p");
      weekNote.className = "sd-stat-note";
      weekNote.textContent = L.statsLead.replace("%s", Stats.human(weekSum)).replace("%s", this.plays(sum.playsWeek));
      week.appendChild(weekNote);
      box.appendChild(week);

      /* 4. Quand vous écoutez : temps écouté, part, et le moment préféré. */
      var bands = document.createElement("div");
      bands.className = "sd-stat-card";
      bands.appendChild(this.statTitle(L.statsBands));
      var bandBox = document.createElement("div");
      bandBox.className = "sd-stat-bands";
      var bandMax = 1;
      ["morning", "afternoon", "evening", "night"].forEach(function (key) {
        if (sum.bands[key] > bandMax) bandMax = sum.bands[key];
      });
      ["morning", "afternoon", "evening", "night"].forEach(function (key) {
        var row = document.createElement("div");
        row.className = "sd-stat-band" + (Stats.bandLabel(key) === sum.favBand ? " is-fav" : "");
        var name = document.createElement("span");
        name.className = "sd-stat-band-name";
        name.textContent = Stats.bandLabel(key);
        var track = document.createElement("span");
        track.className = "sd-stat-bar-track";
        var fill = document.createElement("i");
        fill.style.width = Math.max(3, Math.round((sum.bands[key] / bandMax) * 100)) + "%";
        track.appendChild(fill);
        var value = document.createElement("span");
        value.className = "sd-stat-bar-value";
        value.textContent = sum.seconds
          ? L.statsBandShare.replace("%s", Stats.human(sum.bands[key])).replace(
              "%s",
              String(Math.round((sum.bands[key] / sum.seconds) * 100))
            )
          : Home.plays(sum.bandPlays[key]);
        row.appendChild(name);
        row.appendChild(track);
        row.appendChild(value);
        bandBox.appendChild(row);
      });
      bands.appendChild(bandBox);
      var facts = document.createElement("div");
      facts.className = "sd-stat-facts";
      [
        [L.statsFavBand, sum.favBand],
        [L.statsFavDay, sum.favDay],
      ].forEach(function (pair) {
        if (!pair[1]) return;
        var fact = document.createElement("span");
        fact.className = "sd-stat-fact";
        fact.innerHTML = "<b></b><span></span>";
        $("b", fact).textContent = pair[1];
        $("span", fact).textContent = pair[0];
        facts.appendChild(fact);
      });
      if (facts.childNodes.length) bands.appendChild(facts);
      box.appendChild(bands);

      /* 5. Les classements : « N écoutes · temps », jamais un nombre nu. */
      if (sum.topTracks.length) {
        var tracks = document.createElement("div");
        tracks.className = "sd-stat-card";
        tracks.appendChild(this.statTitle(L.statsTopTracks));
        tracks.appendChild(
          this.statBars(
            sum.topTracks.map(function (item) {
              return {
                name: item.title,
                ratio: item.n,
                value: Home.plays(item.n) + " · " + Stats.human(item.sec),
              };
            })
          )
        );
        box.appendChild(tracks);
      }
      if (sum.topArtists.length) {
        var artists = document.createElement("div");
        artists.className = "sd-stat-card";
        artists.appendChild(this.statTitle(L.statsTopArtists));
        artists.appendChild(
          this.statBars(
            sum.topArtists.map(function (artist) {
              return {
                name: artist.name,
                ratio: artist.n,
                value: Home.plays(artist.n) + " · " + Stats.human(artist.sec),
              };
            })
          )
        );
        box.appendChild(artists);
      }

      /* 6. Découvertes de la semaine. */
      if (sum.discovery.length) {
        var disc = document.createElement("div");
        disc.className = "sd-stat-card";
        disc.appendChild(this.statTitle(L.statsDiscovery));
        var chips = document.createElement("div");
        chips.className = "sd-stat-chips";
        sum.discovery.forEach(function (artist) {
          var chip = document.createElement("span");
          chip.className = "sd-stat-chip";
          chip.textContent = artist.name;
          chips.appendChild(chip);
        });
        disc.appendChild(chips);
        box.appendChild(disc);
      }
      return true;
    },

    /** « 1 écoute », « 12 écoutes » — jamais « 1 écoutes ». */
    plays: function (n) {
      var L = Settings.labels;
      var count = Math.max(0, Math.round(Number(n) || 0));
      return count === 1 ? L.statsHintOneListen : L.statsHintListen.replace("%s", String(count));
    },

    /** Une tuile : la valeur, ce qu'elle est, et ce qu'elle compte. */
    statTile: function (value, label, hint) {
      var tile = document.createElement("div");
      tile.className = "sd-stat-tile";
      var v = document.createElement("span");
      v.className = "sd-stat-value";
      v.textContent = value;
      var l = document.createElement("span");
      l.className = "sd-stat-label";
      l.textContent = label;
      tile.appendChild(v);
      tile.appendChild(l);
      if (hint) {
        var hintEl = document.createElement("span");
        hintEl.className = "sd-stat-hint";
        hintEl.textContent = hint;
        tile.appendChild(hintEl);
      }
      return tile;
    },

    /** Des barres comparables : la plus longue vaut 100 %. */
    statBars: function (rows) {
      var list = document.createElement("div");
      list.className = "sd-stat-bars";
      var top = 1;
      rows.forEach(function (row) {
        if (row.ratio > top) top = row.ratio;
      });
      rows.forEach(function (row) {
        var el = document.createElement("div");
        el.className = "sd-stat-bar-row";
        var name = document.createElement("span");
        name.className = "sd-stat-bar-label";
        name.textContent = row.name;
        var track = document.createElement("span");
        track.className = "sd-stat-bar-track";
        var fill = document.createElement("i");
        fill.style.width = Math.max(4, Math.round((row.ratio / top) * 100)) + "%";
        track.appendChild(fill);
        var value = document.createElement("span");
        value.className = "sd-stat-bar-value";
        value.textContent = row.value;
        el.appendChild(name);
        el.appendChild(track);
        el.appendChild(value);
        list.appendChild(el);
      });
      return list;
    },

    statTitle: function (text) {
      var h = document.createElement("h3");
      h.className = "sd-stat-card-title";
      h.textContent = text;
      return h;
    },

    renderSections: function () {
      var box = $(".sd-home-sections", this.el);
      if (!box) return;
      box.textContent = "";
      var shown = 0;
      for (var i = 0; i < this.data.length; i++) {
        var sec = this.data[i];
        var cards = sec.cards.filter(
          function (c) {
            if (Home.filter === "all") return true;
            return c.type === Home.filter;
          }
        );
        if (!cards.length) continue;
        shown++;
        var node = document.createElement("section");
        node.className = "sd-home-section";
        var head = document.createElement("div");
        head.className = "sd-home-head";
        var h = document.createElement("h2");
        h.className = "sd-home-section-title";
        h.textContent = sec.title;
        head.appendChild(h);
        if (sec.more) {
          var more = document.createElement("a");
          more.className = "sd-home-more";
          more.href = sec.more;
          more.textContent = Settings.labels.homeMore;
          more.addEventListener("click", function (ev) {
            /* Un vrai lien de la page : on laisse la navigation se faire, mais on
               referme l'accueil d'abord pour ne pas le retrouver par-dessus la
               playlist ouverte. */
            ev.stopPropagation();
            Home.hide();
          });
          head.appendChild(more);
        }
        node.appendChild(head);
        var grid = document.createElement("div");
        grid.className = "sd-home-grid";
        cards.forEach(function (c) {
          /* Avec une adresse : un lien réel (menu contextuel, copie, partage).
             Sans adresse : un bouton qui clique la carte d'origine — « chaque
             commande reliée à quelque chose ». */
          var a = document.createElement(c.href ? "a" : "button");
          if (c.href) a.href = c.href;
          else a.type = "button";
          a.className = "sd-home-card sd-home-card-" + c.type;
          a.innerHTML =
            '<span class="sd-home-cover"></span>' +
            '<span class="sd-home-meta"><span class="sd-home-title"></span><span class="sd-home-sub"></span></span>';
          $(".sd-home-title", a).textContent = c.title;
          $(".sd-home-sub", a).textContent = c.sub;
          var cover = $(".sd-home-cover", a);
          if (c.img) {
            var img = document.createElement("img");
            img.loading = "lazy";
            img.decoding = "async";
            img.alt = "";
            img.src = c.img;
            cover.appendChild(img);
          }
          a.addEventListener("click", function (ev) {
            Home.hide();
            if (!c.href) {
              ev.preventDefault();
              Home.openOriginal(c.shelf, c.card);
            }
          });
          grid.appendChild(a);
        });
        node.appendChild(grid);
        box.appendChild(node);
      }
      this.el.classList.toggle("sd-home-empty", shown === 0);
      box.setAttribute("data-empty", Settings.labels.homeEmptyCategory);
      return shown;
    },

    /** Rafraîchit les données de la page, puis montre ou cache l'accueil. */
    refresh: function (reason) {
      if (!Settings.homeBoard) return this.hide();
      if (!this.build()) return false;
      this.data = this.readPage();
      this.greeting = new Date().getHours() < 18 ? Settings.labels.homeMorning : Settings.labels.homeEvening;
      $(".sd-home-hello", this.el).textContent = this.greeting;
      $(".sd-home-sub", this.el).textContent = Settings.labels.homeSub;
      $$(".sd-chip", this.el).forEach(function (chip) {
        var name = chip.getAttribute("data-filter");
        chip.textContent =
          name === "music" ? Settings.labels.homeMusic : name === "podcast" ? Settings.labels.homePodcasts : Settings.labels.homeAll;
      });
      this.buildShortcuts();
      this.renderStats();
      this.renderSections();
      var show = this.shouldShow();
      this.el.hidden = !show;
      if (!show) this.hide();
      return show;
    },

    hide: function () {
      if (!this.el) return false;
      this.el.hidden = true;
      return true;
    },
  };

