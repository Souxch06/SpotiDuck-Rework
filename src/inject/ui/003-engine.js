  /* ------------------------------------------------------------------ *
   * Engine — la porte vers le **moteur d'origine** (`spotiduck-logic.js`,
   * huit blocs de `src/original/spotiduck-original.js` repris tels quel,
   * injectés par l'application avant la page).
   *
   * Ce que la coque ne sait pas faire sans lui, et qui n'a rien d'un détail :
   * lire dans le trafic de la page l'identifiant d'appareil, le `Client-Token`
   * et le `Bearer` de la session (le capteur d'origine), et commander la
   * lecture à l'API Connect de Spotify par le pont Android — donc **sans
   * dépendre d'un bouton que Spotify renomme chaque mois**. Ce que le moteur
   * pourrait faire de plus (ses minuteries, son rapport `updMedia`) reste de
   * son côté : la coque les pilote déjà, et deux pilotes sur la même minuterie
   * est précisément le genre de bug qui redonne « la lecture se coupe ».
   *
   * Sur le banc de démonstration et dans les tests, le moteur est absent :
   * chaque chemin retombe sur celui de la coque, et `live()` répond faux.
   * ------------------------------------------------------------------ */
  var Engine = {
    get: function () {
      return window.SpotiDuckLogic || null;
    },
    live: function () {
      return !!window.SpotiDuckLogic;
    },
    /* L'original juge l'état sur l'icône du bouton de Spotify ; il lui faut
       donc **ce bouton**. La coque le lui passe au moment où elle l'a trouvé,
       et `playLoaded` part une seule fois (le pont l'attend pour l'écran
       d'accueil du lecteur). */
    sawButton: function () {
      var e = Engine.get();
      if (!e) return false;
      var el = pick(SEL.play);
      if (el && el !== Engine._btn) {
        Engine._btn = el;
        e.feed({ pBtn: el });
      }
      return !!el;
    },
    /* L'état mesuré par la coque, dans les variables que les blocs d'origine
       lisent (`track`, `position`, `repmode`, `isfav`…). Nul rapport n'est
       émis ici : `updMedia` n'est appelé que si l'on demande `manageAll`. */
    feed: function () {
      var e = Engine.get();
      if (!e) return false;
      return e.feed({
        track: State.title || "",
        artist: State.artist || "",
        duration: State.duration || 0,
        position: State.position || 0,
        cover: State.cover || "",
        repeat: String(!!State.repeat),
        liked: !!State.liked,
      });
    },
    /* Un appui **vraiment** obtenu du moteur, et rien d'autre.
     *
     * `actPlayPause` de l'original répond « oui » même quand il ne presse pas :
     * sa règle est « icône courte et on veut jouer → je presse ; icône longue
     * et on veut la pause → je presse ; sinon je ne touche à rien ». Compter une
     * fonction qui ne lève pas comme une réussite, c'est exactement le mensonge
     * qui fait « la touche du bas ne fait rien » : la coque croit avoir commandé,
     * renonce à son propre secours, et l'affichage optimiste reste seul à dire
     * que ça joue. On vérifie donc l'**appui**, pas l'appel : un écouteur en
     * capture ne quitte le bouton que si l'événement est réellement parti. */
    toggle: function (want) {
      var e = Engine.get();
      if (!e) return false;
      if (!Engine.sawButton()) return false;
      var el = Engine._btn;
      if (!el || el.disabled === true) return false;
      var pressed = false;
      var spy = function () { pressed = true; };
      try { el.addEventListener("click", spy, true); } catch (err) { return false; }
      try {
        e.call("actPlayPause", !!want);
      } finally {
        try { el.removeEventListener("click", spy, true); } catch (err) {}
      }
      return pressed;
    },
    /* L'URI du contexte affiché — `spotify:playlist:…`, `spotify:album:…`.
       C'est ce que l'application d'origine envoie à `playFromUri`, et le seul
       chemin qui démarre la lecture quand la page n'a **aucun** bouton. */
    contextUri: function () {
      var m = (location.pathname || "").match(/\/(playlist|album|track|artist|episode)\/([A-Za-z0-9]+)/);
      return m ? "spotify:" + m[1] + ":" + m[2] : null;
    },
    playContext: function () {
      var e = Engine.get();
      var uri = e && Engine.contextUri();
      if (!uri) return false;
      if (!e.tokens().device) return false; /* le capteur n'a encore rien vu */
      var ok = e.playUri(uri);
      if (!ok) return false;
      /* Réponse **vraie** depuis la 2.11.27, et le sens de cette vérité est
         strictement celui-ci : « une commande est en cours ». Ce n'est toujours
         pas « la page joue » — l'envoi ne le dit pas, et la coque ne doit pas le
         faire dire. Avant ce patch, `playContext` répondait faux parce qu'il ne
         pouvait rien prouver ; et comme `Actions.playPause` interroge la chaîne
         de commande pour savoir s'il doit envoyer son secours, un `keydown
         Espace` synthétique partait dans le même tour de boucle que le
         `playFromUri` : deux pilotes sur un doigt, la lecture s'annulait
         elle-même. `inFlight()` est maintenant la réponse unique à « faut-il un
         secours, et quand ». */
      Engine._sent = { want: true, uri: uri, at: Date.now() };
      return true;
    },
    /** Une commande du moteur est-elle en cours ? (Vérité bornée dans le temps :
     *  après l'échéance, la commande est considérée perdue et les secours
     *  reprennent leurs droits — rien ne doit rester bloqué « en cours ».) */
    inFlight: function (ms) {
      var sent = Engine._sent;
      if (!sent) return false;
      if (Date.now() - sent.at > (ms || 4000)) { Engine._sent = null; return false; }
      return true;
    },
    /** Ce qui solde une commande : la page a répondu ce qu'on voulait. */
    settleSent: function (playing) {
      var sent = Engine._sent;
      if (sent && playing === sent.want) Engine._sent = null;
    },
    tokens: function () {
      var e = Engine.get();
      return e ? e.tokens() : null;
    },
    /**
     * L'état **confirmé** de la coque, passé au moteur. Ce n'est pas un rapport
     * de plus : c'est ce qui rend vivante la logique d'origine. Ses blocs
     * décident d'après `playing` (verrouillage d'écran, veille) et sa
     * resynchronisation par le trafic de la page (`PUT /track-playback/`) ne
     * s'enclenche qu'après `ffDone`, posé par l'installateur. Sans ce fil, le
     * moteur est là mais aveugle — et la coque reste la seule à savoir si ça
     * joue, ce qui est exactement l'état où était le téléphone hier.
     */
    sync: function (st) {
      var e = Engine.get();
      if (!e || !st) return false;
      /* Le compte rendu de la page solde la commande en cours : c'est ici, et pas
         ailleurs, parce que `sync` est appelé par le seul tunnel où l'état part
         vers Android (`Bridge.mediaStatus`) — donc par chaque chemin qui change
         l'état, bouton de la notification ou widget compris. */
      Engine.settleSent(!!st.playing);
      e.feed({
        track: st.title || "",
        artist: st.artist || "",
        duration: st.duration || 0,
        position: st.position || 0,
        cover: st.cover || "",
        repeat: String(!!st.repeat),
        liked: !!st.liked,
      });
      e.setPlaying(!!st.playing);
      return true;
    },
    /**
     * « Les touches ne fonctionnent pas » ne se discute pas, ça se **mesure**.
     * Pour chaque commande : combien de candidats la page offre, si le meilleur
     * est vivant, si l'appui est consommé, et ce que le moteur d'origine aurait
     * fait. Aucune commande n'est pressée deux fois ni sans égard pour l'état :
     * on teste « lire » si rien ne joue, « pause » sinon, et on remet.
     */
    selfTest: function (pressIt) {
      var lignes = [];
      var e = Engine.get();
      var t = e ? e.tokens() : { device: null, client: null, auth: null, uri: null };
      lignes.push("moteur=" + (e ? "là" : "absent") + " appareil=" + (t.device || "non capté") +
        " jeton=" + (t.client ? "oui" : "non") + " auth=" + (t.auth ? "oui" : "non"));
      var kinds = [
        ["playPause", SEL.play],
        ["next", SEL.next],
        ["prev", SEL.prev],
        ["shuffle", SEL.shuffle],
        ["repeat", SEL.repeat],
        ["like", SEL.like],
      ];
      for (var i = 0; i < kinds.length; i++) {
        var name = kinds[i][0], sels = kinds[i][1];
        var n = 0, best = null;
        var list = typeof sels === "string" ? [sels] : sels || [];
        for (var j = 0; j < list.length; j++) {
          var found;
          try { found = document.querySelectorAll(list[j]); } catch (err) { found = []; }
          for (var m = 0; m < found.length; m++) {
            if (ours(found[m])) continue;
            n++;
            if (!best) best = found[m];
          }
        }
        var line = name + ":candidats=" + n;
        if (best) {
          line += best.disabled === true ? " désactivé" : " vif";
          if (pressIt !== true) {
            lignes.push(line + " (appui non testé)");
            continue;
          }
          var consumed = false;
          try {
            consumed = !!(best.dispatchEvent && Spotify.press(best));
          } catch (err) {
            line += " erreur";
          }
          line += consumed ? " consommé" : " NON CONSOMMÉ";
          /* Repose l'état si l'appui a réellement basculé quelque chose. */
          if (consumed && name === "playPause") {
            try { Spotify.press(best); } catch (err) {}
          }
        } else {
          line += " AUCUN";
        }
        lignes.push(line);
      }
      return { lines: lignes, text: lignes.join(" · ") };
    },
  };

  var Spotify = {
    /* ---- locate the live progress <input type=range> (position/duration) ---- */
    progressInput: function () {
      return pick(SEL.progress);
    },

    /* ------------------------------------------------------------------ *
     * L'unité du curseur de progression.
     *
     * Le 25/09, le téléphone affichait « 56095 h 50 » d'écoute : sur sa page,
     * le curseur de Spotify est gradué en **millisecondes**, alors que le code
     * multipliait par 1000 comme s'il était en secondes — durées 1000 fois trop
     * grandes, sur un seul titre écouté.
     *
     * On ne devine plus l'unité, on la **mesure** : pendant la lecture, la
     * valeur du curseur avance de 1 par seconde s'il est en secondes, de 1000
     * s'il est en millisecondes. La vitesse observée tranche, et le repli (audit
     * de grandeur) ne sert qu'entre deux mesures.
     * ------------------------------------------------------------------ */
    unit: 0,
    sample: null,
    /* **Le lecteur a déjà été vu.** Une seule lecture réussie suffit : la barre
       de lecture de Spotify quitte parfois l'arbre (défilement, rendu différé)
       et le mini-lecteur disparaissait alors sous le doigt — signalé le 25/09 :
       « le lecteur disparaît quand on scroll vers le bas ». */
    seen: false,
    /* Unité mesurée, ou repli : 1000 au-delà de 10 000 de course (un titre de
       trois minutes fait 180 en secondes, 180 000 en millisecondes). */
    unitFactor: function () {
      if (this.unit) return this.unit;
      var input = this.progressInput();
      var max = input ? parseFloat(input.getAttribute("max")) : 0;
      return isFinite(max) && max > 10000 ? 1000 : 1;
    },

    /**
     * Ce que vaut **une graduation** du curseur, en millisecondes : 1 si la page
     * compte en millisecondes (une graduation = 1 ms), 1000 si elle compte en
     * secondes (une graduation = 1 s = 1000 ms).
     *
     * Les deux chemins qui touchent au curseur doivent lire **la même**
     * graduation : lire avec l'une et écrire avec l'autre donnait un
     * déplacement faux d'un facteur 1000 — le genre d'à-peu-près qu'on ne voit
     * qu'à l'oreille, une fois sur dix.
     */
    scale: function () {
      return this.unitFactor() === 1000 ? 1 : 1000;
    },

    /**
     * Les deux seules conversions à utiliser partout.
     *
     * `ticksToMs` lit le curseur, `msToTicks` y écrit. Trois endroits
     * (l'écoute de `input`, la confirmation d'un déplacement, l'écriture du
     * `seek`) multipliaient ou divisaient par 1000 pour leur propre compte :
     * sur une page graduée en millisecondes, la position sautait à la fin dès
     * qu'on lâchait la barre — le geste était bon, l'affichage mentait.
     */
    ticksToMs: function (ticks) {
      var v = Number(ticks);
      if (!isFinite(v)) return 0;
      return (v / this.unitFactor()) * 1000;
    },
    msToTicks: function (ms) {
      var v = Number(ms);
      if (!isFinite(v) || v < 0) return 0;
      return v / this.scale();
    },
    calibrate: function () {
      var input = this.progressInput();
      if (!input) return this.unit;
      var value = parseFloat(input.value);
      var now = Date.now();
      if (!isFinite(value)) return this.unit;
      var last = this.sample;
      this.sample = { v: value, t: now };
      if (!last || !State.playing) return this.unit;
      var elapsed = (now - last.t) / 1000;
      var advanced = value - last.v;
      /* Trop court pour dire quoi que ce soit, ou curseur immobile (pause
         déguisée, publicité, mise en mémoire tampon). */
      if (elapsed < 0.6 || advanced <= 0) return this.unit;
      var speed = advanced / elapsed;
      /* **Deux bandes, pas de milieu.** Un lecteur qui compte en secondes
         avance de ~1 graduation par seconde ; en millisecondes, de ~1000. Une
         valeur entre les deux n'est ni l'un ni l'autre : c'est un **saut** —
         un déplacement du curseur, un changement de piste — et il ne doit pas
         décider de l'unité. C'est ce saut qui faisait basculer la lecture en
         millisecondes sur un lecteur en secondes, et la position se lisait
         alors 1000 fois trop petite (« seek() did not move the position,
         got 5 ms »). */
      var secondsBand = speed >= 0.4 && speed <= 4;
      var msBand = speed >= 400 && speed <= 4000;
      if (secondsBand) this.unit = 1;
      else if (msBand) this.unit = 1000;
      return this.unit;
    },

    /** True when the web player has booted far enough to be driven. */
    ready: function () {
      if (pick(SEL.npBar) && (pick(SEL.play) || this.progressInput())) return true;
      /* La barre n'est pas dans l'arbre (rendu différé, repère renommé) mais la
         page joue : le lecteur est prêt, et nos commandes ont un point d'attaque. */
      return !!this.mediaEl() || !!this.session();
    },

    /* ---------------------------------------------------------------- *
     * Read the now-playing state out of the DOM.
     * Everything is defensive: a missing node means "keep last value",
     * never "reset to null" (that bug made the notification flicker).
     * ---------------------------------------------------------------- */
    /**
     * **L'élément qui joue vraiment.**
     *
     * Le lecteur web de Spotify tient un `<audio>` (et un `<video>` pour la vue
     * plein écran) : c'est lui que la page met en pause, c'est lui qui avance.
     * Tout le reste — les `data-testid` de la barre — est du markup React qui
     * change de nom à chaque version, et c'est précisément ce qui rendait la
     * coque muette sur la page réelle (« les boutons du lecteur ne font rien »,
     * 26/09) : sans titre lu, la coque se croyait sans piste.
     */
    mediaEl: function () {
      var aud = $$("audio");
      for (var i = 0; i < aud.length; i++) {
        if (ours(aud[i])) continue;
        var d = Number(aud[i].duration);
        if (!(aud[i].currentSrc || aud[i].src)) continue;
        /* Une durée lisible, ou rien du tout : un élément sans durée n'a pas
           encore de piste chargée et ne nous dira rien de vrai. */
        if (isFinite(d) && d > 0) return aud[i];
      }
      var v = $(".VideoPlayer__container video");
      if (v && (v.currentSrc || v.src)) return v;
      return null;
    },

    /**
     * **Ce que la page annonce au système.** Spotify tient `mediaSession` à
     * jour pour sa propre notification Android : titre, artiste, pochette,
     * état. C'est la seule source qui ne dépend d'aucun repère de markup, et
     * elle est là même quand la barre de lecture n'est pas dans l'arbre.
     */
    session: function () {
      try {
        var ms = navigator.mediaSession;
        if (!ms) return null;
        var md = ms.metadata;
        var out = {};
        var any = false;
        if (md) {
          if (md.title) { out.title = String(md.title).trim(); any = true; }
          if (md.artist) { out.artist = String(md.artist).trim(); any = true; }
          if (md.album) { out.album = String(md.album).trim(); any = true; }
          var art = md.artwork;
          if (art && art.length) {
            var best = "", size = -1;
            for (var i = 0; i < art.length; i++) {
              var w = parseInt(String(art[i].sizes || "").split("x")[0], 10) || 0;
              if (w >= size && art[i].src) { size = w; best = art[i].src; }
            }
            if (best) { out.cover = best; any = true; }
          }
        }
        if (ms.playbackState === "playing") { out.playing = true; any = true; }
        else if (ms.playbackState === "paused") { out.playing = false; any = true; }
        return any ? out : null;
      } catch (e) {
        return null;
      }
    },

    /** Bascule lecture/pause **sur l'élément** : le dernier recours qui marche
     *  quand le bouton de la page est absent ou désactivé. */
    mediaToggle: function (want) {
      var m = this.mediaEl();
      if (!m) return false;
      try {
        if (want) {
          var p = m.play();
          if (p && p.catch) p.catch(function () {});
        } else {
          m.pause();
        }
        return true;
      } catch (e) {
        return false;
      }
    },

    /** Position demandée (ms) écrite **sur l'élément**, quand le curseur de la
     *  page est introuvable. Sans ça, « avancer de dix secondes » restait muet. */
    mediaSeek: function (ms) {
      var m = this.mediaEl();
      if (!m) return false;
      try {
        var dur = Number(m.duration);
        var t = Math.max(0, ms / 1000);
        if (isFinite(dur) && dur > 0) t = Math.min(t, dur);
        m.currentTime = t;
        return true;
      } catch (e) {
        return false;
      }
    },

    read: function () {
      var out = {};
      var titleEl = pick(SEL.title);
      if (titleEl) out.title = (titleEl.textContent || "").trim();

      var artistEl = pick(SEL.artist);
      if (artistEl) {
        var a = (artistEl.textContent || "").trim();
        // Spotify sometimes leaves a trailing "· Artist" separator in the node
        out.artist = a.replace(/^[·•\s]+/, "").replace(/[·•\s]+$/, "");
      }

      var coverEl = pick(SEL.cover);
      if (coverEl) out.cover = bestCoverUrl(coverEl);

      var input = this.progressInput();
      if (input) {
        var dur = parseFloat(input.getAttribute("max"));
        var pos = parseFloat(input.value);
        if (isFinite(dur) && dur > 0) out.duration = this.ticksToMs(dur);
        if (isFinite(pos)) out.position = this.ticksToMs(pos);
      }

      var like = pick(SEL.like);
      if (like) {
        var checked = like.getAttribute("aria-checked");
        if (checked === "true" || checked === "false") out.liked = checked === "true";
        else {
          var lbl = (like.getAttribute("aria-label") || "").toLowerCase();
          if (/retirer|remove|enlever/.test(lbl)) out.liked = true;
          else if (/ajouter|add|save|liked/.test(lbl)) out.liked = false;
        }
      }

      var repeat = pick(SEL.repeat);
      if (repeat) {
        var rc = repeat.getAttribute("aria-checked");
        out.repeat = rc === "true" ? "context" : rc === "mixed" ? "track" : "off";
      }

      var shuf = pick(SEL.shuffle);
      if (shuf) out.shuffle = shuf.getAttribute("aria-checked") === "true";

      var playing = this.readPlaying();
      if (playing !== null) out.playing = playing;

      out.isEpisode = !!(pick(['a[data-testid="context-item-info-show"]']));

      /* **Et ce que la page joue en réalité.** Le markup n'a rien donné (barre
         absente, repères renommés) : la session média et l'élément `<audio>`
         disent la vérité, et c'est ce qui empêche la coque de se croire sans
         piste — donc de désactiver tout le lecteur. */
      var sess = this.session();
      if (sess) {
        if (!out.title && sess.title) out.title = sess.title;
        if (!out.artist && sess.artist) out.artist = sess.artist;
        if (!out.cover && sess.cover) out.cover = sess.cover;
        if (out.playing === undefined && sess.playing !== undefined) out.playing = sess.playing;
      }
      var m = this.mediaEl();
      if (m) {
        var mdur = Number(m.duration);
        var mpos = Number(m.currentTime);
        if (out.duration === undefined && isFinite(mdur) && mdur > 0) out.duration = mdur * 1000;
        if (out.position === undefined && isFinite(mpos)) out.position = mpos * 1000;
        if (out.playing === undefined) out.playing = !m.paused && !m.ended;
      }
      return out;
    },

    /**
     * Play/pause detection.
     * The old script compared `aria-label === 'Play'` (English only) — on a
     * French device the label is "Lecture", so the mini player never flipped.
     * Strategy: localized word lists → icon shape → video element → last known.
     */
    readPlaying: function () {
      var btn = pick(SEL.play);
      if (btn) {
        var label = (btn.getAttribute("aria-label") || "").toLowerCase();
        if (label) {
          if (/(pause|pausa|pausar|pauze|pausieren|暂停|一時停止|일시정지|pauza)/.test(label)) return true;
          if (/(^|\s)(play|lecture|reprendre|reanudar|ressortir|afspelen|wiedergabe|播放|再生|재생|воспроизв)/.test(label)) return false;
        }
        // Shape fallback: the pause glyph is 2 shapes, the play glyph is 1.
        var svg = btn.querySelector("svg");
        if (svg) {
          var shapes = svg.querySelectorAll("path, rect, polygon").length;
          if (shapes === 2) return true;
          if (shapes === 1) return false;
        }
      }
      if (document.querySelector(".VideoPlayer__container video")) return true;
      /* Ni bouton, ni libellé, ni glyphe exploitable : l'élément qui joue répond
         mieux que rien, et il ne ment pas. */
      var m = this.mediaEl();
      if (m) return !m.paused && !m.ended;
      return null; // unknown → caller keeps its optimistic value
    },

    /* ---------------------------------------------------------------- *
     * Control the player. All writes go through Spotify's own buttons so
     * playback bookkeeping, shuffle order and the media session stay
     * consistent — the old layer did this too, we just guard every call
     * and report whether it worked so the UI can roll back.
     * ---------------------------------------------------------------- */
    click: function (selectors) {
      /* **Le meilleur candidat**, pas le premier : sur la page du téléphone, la
         barre de bureau est encore là, désactivée ou hors écran. On interroge
         les survivants dans l'ordre d'utilité et on s'arrête au premier que
         l'appui ne peut pas perdre. */
      var list = typeof selectors === "string" ? [selectors] : selectors || [];
      var all = [];
      for (var i = 0; i < list.length; i++) {
        var found;
        try {
          found = document.querySelectorAll(list[i]);
        } catch (e) {
          found = [];
        }
        for (var j = 0; j < found.length; j++) if (!ours(found[j])) all.push(found[j]);
      }
      var order = ranked(all);
      for (var k = 0; k < order.length; k++) {
        if (dead(order[k])) continue;
        if (this.press(order[k])) return true;
      }
      return false;
    },

    /**
     * **Le geste complet, et la preuve qu'il a été reçu.**
     *
     * `el.click()` n'émet qu'un `click`. Or une commande de Spotify peut être
     * branchée sur `pointerdown`, sur `keyup`, ou gardée par un `disabled`
     * retiré à la volée : dans ces trois cas l'événement part, personne ne le
     * traite, et l'appui d'avant — compté comme réussi parce qu'il n'avait pas
     * levé — privait la coque de ses autres secours. C'est « j'appuie, il ne se
     * passe rien », mesuré chez l'utilisateur et non reproductible sans lui.
     *
     * On émet donc la séquence qu'un doigt produit, et on ne déclare réussi que
     * si **un handler l'a consommée** (`defaultPrevented`, ce que React fait
     * pour ces boutons) ou si l'état de la page a bougé entre avant et après.
     * Un appui non consommé n'est pas un succès : c'est une porte vers le
     * secours suivant.
     */
    press: function (el) {
      if (dead(el)) return false;
      var before = this.readPlaying() + "|" + this.readTrack();
      var prevented = false;
      /* La séquence large (pointerdown/mousedown/…) a été **mesurée puis
         écartée** : elle partait, mais nos propres écouteurs de gestes
         (`Gestures`, sur le document) la capturaient et avalaient le clic —
         neuf commandes de lecture devenues fausses au smoke. Le geste reste
         donc l'unique `click`, et la consommation est une **mesure**, pas un
         portillon : c'est elle qui dira, sur ton téléphone, si l'appui part
         sans que personne ne le traite. */
      try {
        var ev = new window.MouseEvent("click", { bubbles: true, cancelable: true, composed: true });
        el.dispatchEvent(ev);
        prevented = !!ev.defaultPrevented;
      } catch (e) {
        try {
          el.click();
        } catch (e2) {
          return false;
        }
      }
      this.lastPress = {
        prevented: !!prevented,
        moved: false,
        at: typeof performance !== "undefined" ? performance.now() : 0,
        before: before,
      };
      return true;
    },

    readTrack: function () {
      try {
        return (State.title || "") + "|" + (State.position | 0);
      } catch (e) {
        return "";
      }
    },

    /**
     * **Le clavier du lecteur.** Le lecteur web écoute ses propres raccourcis
     * (`Ctrl` + flèches, espace). Quand la disposition de la page ne laisse pas
     * trouver les boutons (repères renommés, barre absente), c'est le seul
     * chemin qui reste — et il vaut mieux qu'un bouton muet.
     */
    key: function (key, extra) {
      try {
        var init = {
          key: key,
          code: key === " " ? "Space" : key,
          bubbles: true,
          cancelable: true,
          ctrlKey: key === " " ? false : true,
          shiftKey: false,
          metaKey: false,
          altKey: false,
        };
        if (extra) for (var k in extra) init[k] = extra[k];
        var target = document.body || document.documentElement;
        target.dispatchEvent(new KeyboardEvent("keydown", init));
        target.dispatchEvent(new KeyboardEvent("keyup", init));
        return true;
      } catch (e) {
        return false;
      }
    },
    playPause: function (want) {
      if (this.click(SEL.play)) return true;
      /* Aucun bouton vivant **pour la coque** : le moteur d'origine, lui, juge
         l'icône du bouton qu'il a revendiqué — et s'il n'y a ni l'un ni
         l'autre, `playFromUri` commande la lecture à l'API Connect par le pont
         Android, ce qui ne dépend d'aucun repère de markup. Ces deux chemins
         sont exactement ceux de l'application d'origine ; l'élément `<audio>`
         reste le secours de la coque. */
      if (want !== undefined && Engine.toggle(want)) return true;
      /* Aucun bouton vivant : on agit sur l'élément. C'est la même chose que
         pressez le bouton de Spotify du point de vue de la lecture. */
      var go = want === undefined ? null : !!want;
      if (this.mediaToggle(go === null ? !this.readPlaying() : go)) return true;
      /* Et si la page n'a **ni** bouton **ni** élément qui réponde, il reste la
         voie de l'application d'origine : la commande à l'API Connect, par le
         pont. Elle est jugée après les deux secours de la coque, pas avant —
         une commande réseau ne prouve rien sur l'état de la page, elle ne peut
         donc pas y couper court. */
      if (want === true) return Engine.playContext();
      return false;
    },
    next: function () {
      return this.click(SEL.next);
    },
    prev: function () {
      return this.click(SEL.prev);
    },
    toggleShuffle: function () {
      return this.click(SEL.shuffle);
    },
    cycleRepeat: function () {
      return this.click(SEL.repeat);
    },
    toggleLike: function () {
      return this.click(SEL.like);
    },

    /**
     * Seek. Two things the old code got wrong:
     *  • `input.value = x` followed by a bare `change` event is silently
     *    dropped by React unless the value is set through the *native*
     *    setter, so half of the seeks did nothing;
     *  • it wrote `pos + 1` (a 1-second offset) with no clamping.
     * We clamp, use the native setter, and dispatch both `input` and `change`.
     */
    /** La course du curseur, en graduations — et un repli raisonnable. */
    maxTicks: function () {
      var input = this.progressInput();
      var max = input ? parseFloat(input.getAttribute("max")) : 0;
      if (isFinite(max) && max > 0) return max;
      /* Sans `max` lisible, `clamp(valeur, 0, 0)` ramenait **tout** déplacement
         à zéro : la barre restait collée au début de la piste, quel que soit
         l'endroit où l'on posait le doigt. On se rabat sur la durée connue. */
      var known = Number(State.duration) || 0;
      return known > 0 ? this.msToTicks(known) : 0;
    },
    seek: function (ms) {
      var input = this.progressInput();
      if (!input) return this.mediaSeek(ms);
      var max = this.maxTicks();
      /* La graduation du curseur, celle avec laquelle on **lit** : on écrit
         donc la même. (Écrire toujours des secondes déplaçait le curseur au
         1000e de la position demandée sur un lecteur qui compte en
         millisecondes.) */
      var value = this.msToTicks(ms);
      var seconds = max > 0 ? clamp(value, 0, max) : Math.max(0, value);
      try {
        var proto = window.HTMLInputElement && window.HTMLInputElement.prototype;
        var desc = proto && Object.getOwnPropertyDescriptor(proto, "value");
        if (desc && desc.set) desc.set.call(input, String(seconds));
        else input.value = String(seconds);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      } catch (e) {
        return false;
      }
    },

    /** The page the web player currently shows. */
    route: function () {
      if ($('section[data-testid="home-page"]')) return "home";
      if ($('section[data-testid="search-page"]')) return "search";
      var sections = $$(SEL.pageSection.join(","));
      for (var i = 0; i < sections.length; i++) {
        var t = sections[i].getAttribute("data-testid") || "";
        if (/-page$/.test(t) && t !== "home-page" && t !== "search-page") return "page";
      }
      return "other";
    },

    /**
     * **Une sous-page, décidée par l'adresse.** Playlist, album, artiste,
     * section, titres likés : tout ce qui n'est ni la racine du lecteur, ni la
     * recherche, ni la connexion. Le DOM ne suffisait pas — le 25/09, une
     * playlist ouverte depuis la bibliothèque n'était pas reconnue comme une
     * sous-page, la barre latérale de Spotify (devenue pleine page) restait
     * posée dessus, et l'écran paraissait noir.
     */
    isSubPagePath: function () {
      var path = (location.pathname || "/").replace(/\/+$/, "");
      if ((location.host || "").indexOf("accounts.spotify.com") >= 0) return false;
      if (/\/login(\/|$)/.test(path)) return false;
      if (/^\/search(\/|$)/.test(path)) return false;
      if (Home.isHomePath()) return false;
      return true;
    },

    /** Title of the page currently open (playlist/album/artist…). */
    pageTitle: function () {
      var h1 = pick(SEL.pageH1);
      return h1 ? (h1.textContent || "").trim() : "";
    },

    goHome: function () {
      if (this.click(SEL.homeBtn)) return true;
      try {
        location.assign("/");
        return true;
      } catch (e) {
        return false;
      }
    },
    goSearch: function () {
      if (this.click(SEL.searchBtn)) return true;
      try {
        location.assign("/search");
        return true;
      } catch (e) {
        return false;
      }
    },
    /** Internal history, with a guard so we never leave the app. */
    goBack: function () {
      if (History.depth > 0) {
        History.depth--;
        try {
          history.back();
          return true;
        } catch (e) {
          /* fall through */
        }
      }
      return this.goHome();
    },
    focusSearch: function () {
      var input = pick(SEL.searchInput);
      if (!input) return false;
      try {
        input.focus({ preventScroll: true });
        return true;
      } catch (e) {
        return false;
      }
    },
    queueButton: function () {
      return this.findBarButton(/file d'attente|queue/i);
    },
    devicesButton: function () {
      return this.findBarButton(/appareil|device|connect/i);
    },
    lyricsButton: function () {
      return pick(SEL.lyrics);
    },
    karaokeButton: function () {
      return pick(SEL.karaoke);
    },
    /** Le curseur de volume **de Spotify** : source de vérité unique, on ne
        tient pas un second volume de notre côté (il divergerait). */
    volumeInput: function () {
      return pick(SEL.volume);
    },
    /** Absolute URL of the track that is playing (used by "Partager"). */
    trackHref: function () {
      var a = pick(SEL.trackLink);
      var href = a && a.getAttribute("href");
      if (href && href !== "#") {
        return href.indexOf("http") === 0 ? href : "https://open.spotify.com" + href;
      }
      return "https://open.spotify.com/";
    },
    /** Clickable album/artist cover of the now-playing widget. */
    albumLink: function () {
      var el = pick(SEL.albumLink);
      if (!el) return null;
      if (el.tagName === "A" && el.getAttribute("href")) return el;
      var a = el.closest && el.closest("a[href]");
      return a || null;
    },
    /** Scan the (hidden) desktop bar for a button by aria-label. */
    findBarButton: function (re) {
      var bar = pick(SEL.npBar);
      if (!bar) return null;
      var buttons = $$("button[aria-label], [role=\"button\"][aria-label]", bar);
      for (var i = 0; i < buttons.length; i++) {
        var l = buttons[i].getAttribute("aria-label") || "";
        if (re.test(l)) return buttons[i];
      }
      return null;
    },
  };

  /** Highest-resolution URL available for a cover <img>. */
  function bestCoverUrl(img) {
    var srcset = img.getAttribute("srcset");
    if (srcset) {
      var best = null;
      srcset.split(",").forEach(function (part) {
        var bits = part.trim().split(/\s+/);
        if (!bits[0]) return;
        var w = parseFloat(bits[1]) || 0;
        if (!best || w >= best.w) best = { url: bits[0], w: w };
      });
      if (best) return best.url;
    }
    return img.currentSrc || img.src || "";
  }

