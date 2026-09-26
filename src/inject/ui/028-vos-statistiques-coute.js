  /* ------------------------------------------------------------------ *
   * 11e-quater. Stats — vos statistiques d'écoute
   *
   * Demande de l'utilisateur (24/09) : « mets les différentes statistiques
   * d'écoutes etc sur l'utilisateur, ajoute plein de données intéressantes ».
   *
   * Principe : l'application **note ce qu'elle voit jouer**. Chaque titre
   * détecté (changement de morceau pendant la lecture) ajoute une ligne
   * horodatée : ça ne dépend d'aucune permission et fonctionne dès la première
   * écoute. En complément, quand la session de la page expose un jeton
   * utilisable, l'historique récent de Spotify (50 derniers titres, avec leur
   * date réelle) est importé — les statistiques ne commencent donc pas à zéro.
   *
   * Tout est **local** (localStorage, 1 500 écoutes maximum) ; rien ne sort du
   * téléphone. Le réglage « Statistiques d'écoute » arrête l'enregistrement.
   *
   * Ce qui est calculé, et vérifié par le banc :
   *   temps d'écoute total / des sept derniers jours / du jour · titres et
   *   artistes différents · classement des artistes et des titres (avec parts) ·
   *   sept derniers jours · moments de la journée (nuit, matin, après-midi,
   *   soir) · jour préféré · série de jours d'affilée · artistes découverts
   *   cette semaine · écoutes du jour
   * ------------------------------------------------------------------ */

  var STATS_KEY = "sd.stats.v1";
  var STATS_MAX = 1500;
  /* En dessous, ce n'est pas une écoute mais un survol : dix secondes. */
  var STATS_MIN_SEC = 10;

  var Stats = {
    entries: [],
    loaded: false,
    lastSync: 0,
    /* L'écoute en cours de mesure : `{k,t,a,ts,sec,pos,at}`. */
    session: null,

    enabled: function () {
      return !!Settings.stats;
    },

    /**
     * Charge les écoutes enregistrées — et **répare** celles qui portent une
     * durée impossible (voir `plausible`). Sans cette passe, un seul titre
     * écouté avant ce correctif continuerait d'afficher « 56095 h 50 », et
     * l'utilisateur devrait effacer ses statistiques pour s'en débarrasser.
     */
    load: function () {
      if (this.loaded) return this.entries;
      this.loaded = true;
      try {
        var raw = window.localStorage.getItem(STATS_KEY);
        if (!raw) return this.entries;
        var parsed = JSON.parse(raw);
        var list = (parsed && parsed.e) || [];
        var self = this;
        var repaired = 0;
        this.entries = list
          .filter(function (e) {
            return e && typeof e.t === "string" && e.t && typeof e.ts === "number";
          })
          .map(function (e) {
            var d = self.plausible(e.d);
            if (d !== (e.d || 0)) {
              repaired++;
              return { k: e.k, t: e.t, a: e.a, ts: e.ts, d: d };
            }
            return e;
          });
        /* Une seule écriture, et seulement si quelque chose a changé : la passe
           de réparation ne doit pas peser à chaque lecture. */
        if (repaired) this.save();
      } catch (e) {
        this.entries = [];
      }
      return this.entries;
    },

    save: function () {
      try {
        window.localStorage.setItem(STATS_KEY, JSON.stringify({ v: 1, e: this.entries }));
      } catch (e) {
        /* stockage refusé ou plein : les statistiques restent en mémoire */
      }
    },

    hasData: function () {
      return this.load().length > 0;
    },

    /* ------------------------------------------------------------------ *
     * Mesurer l'écoute, au lieu de la déduire
     *
     * Avant : dès qu'un titre **apparaissait**, on notait la durée du titre
     * annoncée par la page. Trois défauts visibles sur le téléphone — un titre
     * survolé dix secondes comptait quatre minutes, le même titre écouté deux
     * fois d'affilée n'était compté qu'une fois, et le total ne correspondait à
     * aucune écoute réelle (« les statistiques sont pas bonne »).
     *
     * Maintenant : on suit **l'avancement du lecteur**. Chaque seconde dont la
     * position progresse est une seconde écoutée, attribuée au titre en cours ;
     * on s'arrête quand la position recule (retour/seek), quand on change de
     * titre, ou quand plus rien ne joue. Une écoute de moins de dix secondes
     * n'est pas comptée. Le temps annoncé est alors le temps réellement passé.
     * ------------------------------------------------------------------ */

    /** La clé d'un titre : le même couple titre + artiste. */
    keyOf: function (title, artist) {
      return ((title || "") + "\u0000" + (artist || "")).toLowerCase();
    },

    /** Nourrit la mesure : appelé à chaque rafraîchissement de la position. */
    tick: function (state, nowMs) {
      if (!this.enabled()) return false;
      var s = state || State;
      var now = nowMs || Date.now();
      var title = (s && s.title ? String(s.title) : "").trim();
      if (!s || !s.hasTrack || title.length < 2) {
        this.flush(now);
        return false;
      }
      /* Le stockage n'est lu qu'au premier titre : `tick` tourne dix fois par
         seconde, `load()` n'a rien à y faire. */
      if (!this.loaded) this.load();
      var key = this.keyOf(title, s.artist);
      var pos = Math.max(0, (Number(s.position) || 0) / 1000);
      var wall = this.session ? Math.max(0, (now - this.session.at) / 1000) : 0;
      if (!this.session || this.session.k !== key) {
        /* Nouveau titre : le précédent part avec le temps qu'il a pris. */
        this.flush(now);
        this.session = {
          k: key,
          t: title.slice(0, 80),
          a: (s.artist || "").slice(0, 80),
          ts: now,
          sec: 0,
          pos: pos,
          at: now,
        };
        return true;
      }
      var delta = pos - this.session.pos;
      if (delta < 0) {
        /* Retour en arrière, ou le même titre relancé depuis le début : la
           nouvelle écoute est une écoute, pas une continuation. */
        this.flush(now);
        this.session = {
          k: key,
          t: title.slice(0, 80),
          a: (s.artist || "").slice(0, 80),
          ts: now,
          sec: 0,
          pos: pos,
          at: now,
        };
        return true;
      }
      /* Bornes : jamais plus que le temps écoulé depuis le dernier relevé
         (+2 s de tolérance), donc un saut de position ne fabrique pas
         d'écoute. Une page figée pendant une longue lecture d'arrière-plan
         sous-compte : c'est la seule erreur qui reste, et elle va dans le bon
         sens (on n'invente pas d'écoute). */
      var add = Math.min(delta, wall + 2);
      if (add > 0) this.session.sec += add;
      this.session.pos = pos;
      this.session.at = now;
      return true;
    },

    /** Ferme l'écoute en cours : elle rejoint les statistiques. */
    flush: function (nowMs) {
      var s = this.session;
      if (!s) return false;
      this.session = null;
      if (!(s.sec >= STATS_MIN_SEC)) return false;
      this.load();
      this.entries.push({
        k: s.k,
        t: s.t,
        a: s.a,
        ts: s.ts,
        d: Math.round(s.sec),
        /* `m` : durée **mesurée** pendant l'écoute (voir `summary`). */
        m: 1,
      });
      this.entries.sort(function (a, b) {
        return a.ts - b.ts;
      });
      if (this.entries.length > STATS_MAX) this.entries = this.entries.slice(-STATS_MAX);
      this.save();
      if (Home.built) Home.refresh("stats-mesure");
      return true;
    },

    /** Note une écoute. `at` (ms) permet d'importer un historique daté. */
    /**
     * Une durée d'écoute **plausible**, en secondes.
     *
     * Une seule écoute ne dure pas plus de douze heures : au-delà, la page a
     * annoncé une durée dans une autre unité (millisecondes, microsecondes) et
     * le chiffre ne dit plus rien. On redescend par paliers de mille jusqu'à une
     * valeur qui a un sens — c'est ce qui répare les statistiques déjà
     * enregistrées, celles qui affichaient « 56095 h 50 ».
     */
    MAX_SECONDS: 12 * 3600,
    plausible: function (value) {
      var v = Number(value);
      if (!isFinite(v) || v <= 0) return 0;
      /* Trois paliers suffisent à couvrir les unités qu'une page peut annoncer
         (millisecondes, microsecondes, nanosecondes) : 202 s vaut 202 000 ms,
         202 000 000 µs, 202 000 000 000 ns. Au-delà, la valeur n'est pas une
         durée — on préfère ne rien compter qu'inventer seize minutes. */
      var guard = 0;
      while (v > this.MAX_SECONDS && guard++ < 3) v = v / 1000;
      if (v > this.MAX_SECONDS) return 0;
      return Math.round(v);
    },

    record: function (title, artist, durationSec, at, measured) {
      if (!this.enabled()) return false;
      title = (title || "").trim();
      if (title.length < 2) return false;
      this.load();
      var key = this.keyOf(title, artist);
      var when = typeof at === "number" && at > 0 ? at : Date.now();
      /* Le même titre deux fois en trois minutes est une reprise, pas une
         nouvelle écoute (le web player annonce parfois le même morceau deux
         fois au chargement). */
      var last = this.entries.length ? this.entries[this.entries.length - 1] : null;
      if (last && last.k === key && Math.abs(when - last.ts) < 3 * 60 * 1000) return false;
      var entry = {
        k: key,
        t: title.slice(0, 80),
        a: (artist || "").slice(0, 80),
        ts: when,
        d: this.plausible(durationSec),
      };
      /* `m` seulement quand la durée vient d'une écoute mesurée. Un historique
         importé annonce la durée **du titre**, pas le temps passé : on ne fait
         pas passer l'un pour l'autre dans les totaux. */
      if (measured) entry.m = 1;
      this.entries.push(entry);
      /* Chronologique : l'import d'un historique insère des écoutes passées. */
      this.entries.sort(function (a, b) {
        return a.ts - b.ts;
      });
      if (this.entries.length > STATS_MAX) this.entries = this.entries.slice(-STATS_MAX);
      this.save();
      return true;
    },

    /** Importe l'historique récent de Spotify (`/me/player/recently-played`). */
    importRecent: function (items) {
      if (!this.enabled() || !items || !items.length) return 0;
      this.load();
      var added = 0;
      for (var i = items.length - 1; i >= 0; i--) {
        var item = items[i];
        var track = (item && item.track) || {};
        var name = track.name || "";
        if (!name) continue;
        var artist = "";
        if (track.artists && track.artists.length) artist = track.artists[0].name || "";
        var at = Date.parse(item.played_at || "") || 0;
        if (this.record(name, artist, Math.round((track.duration_ms || 0) / 1000), at)) added++;
      }
      return added;
    },

    /** Récupère l'historique par l'API, avec le jeton que la page utilise déjà.
        Silencieux en cas d'échec : les statistiques locales continuent seules. */
    syncFromApi: function (force) {
      if (!this.enabled() || !Api.authToken) return false;
      var now = Date.now();
      if (!force && now - this.lastSync < 30 * 60 * 1000) return false;
      this.lastSync = now;
      Net.get("/me/player/recently-played?limit=50").then(function (data) {
        if (!data || !data.items) return;
        if (Stats.importRecent(data.items) && Home.built) Home.refresh("stats-api");
      });
      return true;
    },

    clear: function () {
      this.entries = [];
      this.save();
      if (Home.built) Home.refresh("stats-clear");
      return true;
    },

    /* ---------------- calculs ---------------- */

    summary: function (nowMs) {
      this.load();
      var now = nowMs || Date.now();
      var day = 24 * 60 * 60 * 1000;
      var startToday = new Date(now);
      startToday.setHours(0, 0, 0, 0);
      var t0 = startToday.getTime();
      var sum = {
        total: this.entries.length,
        plays: 0,
        seconds: 0,
        /* Dont mesuré pendant l'écoute, et dont estimé (historique importé ou
           écoutes d'avant la mesure) : les deux sont dits séparément. */
        measured: 0,
        measuredPlays: 0,
        estimated: 0,
        estimatedPlays: 0,
        secondsWeek: 0,
        secondsToday: 0,
        playsToday: 0,
        playsWeek: 0,
        first: 0,
        tracks: {},
        artists: {},
        byDay: [],
        bands: { night: 0, morning: 0, afternoon: 0, evening: 0 },
        bandPlays: { night: 0, morning: 0, afternoon: 0, evening: 0 },
        weekdays: [0, 0, 0, 0, 0, 0, 0],
        streak: 0,
        discovery: [],
      };
      var i, e, sec, when, hour, band;
      for (i = 0; i < this.entries.length; i++) {
        e = this.entries[i];
        /* Aucune durée inventée : une écoute sans durée compte comme une
           écoute, et zéro seconde. C'est ce qui rend « 56095 h » impossible. */
        sec = e.d > 0 ? e.d : 0;
        sum.plays++;
        if (!sum.first || e.ts < sum.first) sum.first = e.ts;
        if (e.m) {
          sum.measured += sec;
          sum.measuredPlays++;
        } else {
          sum.estimated += sec;
          sum.estimatedPlays++;
        }
        sum.seconds += sec;
        when = new Date(e.ts);
        if (e.ts >= now - 7 * day) {
          sum.secondsWeek += sec;
          sum.playsWeek++;
        }
        if (e.ts >= t0) {
          sum.secondsToday += sec;
          sum.playsToday++;
        }
        sum.tracks[e.k] = sum.tracks[e.k] || { title: e.t, artist: e.a, n: 0, sec: 0 };
        sum.tracks[e.k].n++;
        sum.tracks[e.k].sec += sec;
        if (e.a) {
          sum.artists[e.a] = sum.artists[e.a] || { name: e.a, n: 0, sec: 0, first: e.ts };
          sum.artists[e.a].n++;
          sum.artists[e.a].sec += sec;
          if (e.ts < sum.artists[e.a].first) sum.artists[e.a].first = e.ts;
        }
        hour = when.getHours();
        if (hour >= 5 && hour < 12) band = "morning";
        else if (hour >= 12 && hour < 18) band = "afternoon";
        else if (hour >= 18 && hour < 24) band = "evening";
        else band = "night";
        /* Les moments de la journée se comptent en **temps écouté** : c'est la
           même unité que le reste de la page, donc comparable. */
        sum.bands[band] += sec;
        sum.bandPlays[band]++;
        sum.weekdays[when.getDay()]++;
      }
      /* Les sept derniers jours, du plus ancien à aujourd'hui — en temps
         écouté, et avec le nombre d'écoutes pour la légende. */
      for (i = 6; i >= 0; i--) {
        var from = t0 - i * day;
        var to = from + day;
        var count = 0;
        var secs = 0;
        for (var j = 0; j < this.entries.length; j++) {
          var entry = this.entries[j];
          if (entry.ts >= from && entry.ts < to) {
            count++;
            secs += entry.d > 0 ? entry.d : 0;
          }
        }
        sum.byDay.push({ day: new Date(from).getDay(), date: from, n: count, sec: secs });
      }
      /* Série de jours d'affilée (aujourd'hui, sinon hier si rien aujourd'hui). */
      var cursor = t0;
      var guard = 0;
      var firstDay = true;
      while (guard++ < 400) {
        var hit = 0;
        for (i = 0; i < this.entries.length && !hit; i++) {
          if (this.entries[i].ts >= cursor && this.entries[i].ts < cursor + day) hit = 1;
        }
        if (hit) {
          sum.streak++;
          cursor -= day;
          firstDay = false;
        } else if (firstDay) {
          cursor -= day; /* la série peut encore courir depuis hier */
          firstDay = false;
        } else break;
      }
      sum.topArtists = this.rank(sum.artists, 6);
      sum.topTracks = this.rank(sum.tracks, 5);
      sum.artistCount = Object.keys(sum.artists).length;
      sum.trackCount = Object.keys(sum.tracks).length;
      for (var name in sum.artists) {
        if (sum.artists[name].first >= now - 7 * day && sum.artists[name].n >= 2) {
          sum.discovery.push(sum.artists[name]);
        }
      }
      sum.discovery.sort(function (a, b) {
        return b.n - a.n;
      });
      sum.discovery = sum.discovery.slice(0, 8);
      /* Le moment préféré : au temps écouté ; à défaut (aucune durée
         mesurée), au nombre d'écoutes. */
      var favKey = "";
      var best = -1;
      var usePlays = sum.seconds <= 0;
      for (var key in sum.bands) {
        var score = usePlays ? sum.bandPlays[key] : sum.bands[key];
        if (score > best) {
          best = score;
          favKey = key;
        }
      }
      sum.favBand = best > 0 ? Stats.bandLabel(favKey) : "";
      sum.favBandShare = sum.seconds > 0 && favKey ? Math.round((sum.bands[favKey] / sum.seconds) * 100) : 0;
      var favDay = -1;
      for (i = 0; i < 7; i++) {
        if (favDay === -1 || sum.weekdays[i] > sum.weekdays[favDay]) favDay = i;
      }
      sum.favDay = sum.total ? Stats.weekdayLabel(favDay, true) : "";
      return sum;
    },

    rank: function (map, limit) {
      var list = [];
      for (var k in map) list.push(map[k]);
      list.sort(function (a, b) {
        return b.n - a.n || b.sec - a.sec;
      });
      var total = 0;
      for (var i = 0; i < list.length; i++) total += list[i].n;
      for (var j = 0; j < list.length; j++) {
        list[j].share = total ? Math.round((list[j].n / total) * 100) : 0;
      }
      return list.slice(0, limit);
    },

    /** « 3 h 20 », « 45 min » — la forme que lit un humain. */
    human: function (seconds) {
      var sec = Math.max(0, Math.round(seconds || 0));
      var h = Math.floor(sec / 3600);
      var min = Math.round((sec % 3600) / 60);
      if (h && min) return h + " h " + min;
      if (h) return h + " h";
      return min + " min";
    },

    /** « il y a 2 min », « il y a 1 h » — l'âge d'un jeton, en clair. */
    sinceText: function (ts) {
      var sec = Math.max(0, Math.round((Date.now() - (ts || 0)) / 1000));
      if (sec < 90) return "il y a " + sec + " s";
      if (sec < 5400) return "il y a " + Math.round(sec / 60) + " min";
      return "il y a " + Math.round(sec / 3600) + " h";
    },

    /** « 25/09 » — et l'année seulement si ce n'est pas celle en cours. */
    dayLabel: function (ts) {
      var d = new Date(ts);
      if (!isFinite(d.getTime())) return "";
      var two = function (n) {
        return (n < 10 ? "0" : "") + n;
      };
      var short = two(d.getDate()) + "/" + two(d.getMonth() + 1);
      return d.getFullYear() === new Date().getFullYear() ? short : short + "/" + d.getFullYear();
    },

    bandLabel: function (band) {
      return (
        {
          night: Settings.labels.bandNight,
          morning: Settings.labels.bandMorning,
          afternoon: Settings.labels.bandAfternoon,
          evening: Settings.labels.bandEvening,
        }[band] || ""
      );
    },

    weekdayLabel: function (index, long) {
      var list = long ? Settings.labels.weekdays : Settings.labels.weekdaysShort;
      return (list || [])[index] || "";
    },
  };

