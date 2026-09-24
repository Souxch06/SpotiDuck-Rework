/*
 * SpotiDuck — mode « interface Spotify ».
 *
 * Chargé à la place de la couche injectée quand l'utilisateur choisit
 * l'interface native : le user-agent est celui de Chrome Android, donc
 * open.spotify.com sert sa **propre interface mobile** (barre de navigation
 * basse, listes compactes, lecteur plein écran) — rien n'est redessiné ici.
 *
 * Ce script ne fait que quatre choses, et rien d'autre :
 *
 *   1. supprimer les pop-ups que Spotify réserve aux navigateurs mobiles
 *      (bandeaux « Ouvrir dans l'application », consentement aux cookies,
 *      infobulles, promotions plein écran) et les empêcher de revenir. Le
 *      bandeau « ouvrir dans l'application » et les invitations à
 *      l'abonnement — y compris le bouton de la barre du bas — sont en plus
 *      traqués par leur **texte** et par la destination de leurs liens, parce
 *      que Spotify renomme ses attributs d'une version à l'autre ;
 *   2. exposer un `window.SpotiDuckUI` minimal (lecture, pause, suivant,
 *      précédent, j'aime, avance) pour que les boutons de la notification
 *      Android et de l'écran de verrouillage fonctionnent : ils cliquent les
 *      vrais boutons de Spotify au lieu de piloter notre propre lecture ;
 *   3. alimenter la notification (titre, artiste, pochette, position) par le
 *      pont `AndBridge` — sinon l'écran de verrouillage reste vide ;
 *   4. installer un appui long de 3 secondes, invisible, qui rouvre le choix
 *      de l'interface (c'est le seul moyen de revenir en arrière puisque notre
 *      couche n'est plus là où sont ses paramètres) ;
 *   5. ne pas laisser une page de connexion sans issue : si Spotify n'affiche
 *      que des boutons sociaux (qui ne marchent pas dans une WebView), un bouton
 *      « e-mail et mot de passe » mène à la page qui affiche le formulaire ;
 *   6. veiller sur les onglets de la barre du bas : si un appui ne produit rien
 *      (lien `spotify:` que la WebView ne sait pas ouvrir, routeur de Spotify
 *      inerte, page qui ne peint pas), l'application fait la navigation
 *      elle-même vers l'adresse que l'onglet désigne.
 */
(function () {
  if (window.__sdNative) return;
  window.__sdNative = true;

  var NATIVE = "native";

  /* ------------------------------------------------------------------ *
   * 1. Viewport : le meta que Spotify ne déclare pas
   *
   * Sans lui, la WebView se donne une largeur de mise en page de 980 px : la
   * page est alors dessinée pour un écran trois fois plus large que le
   * téléphone (d'où une interface énorme, coupée, qu'il faut faire glisser).
   * ------------------------------------------------------------------ */
  /* Pas de `viewport-fit=cover` : la fenêtre de la WebView est désormais
     **à l'intérieur** des barres système (l'application réserve leur place), donc
     la page n'a pas à s'en écarter elle-même — et `cover` l'invitait justement à
     dessiner dessous, ce qui mettait sa barre du haut à moitié sous la barre
     d'état. */
  var VIEWPORT_CONTENT =
    "width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no";

  function ensureViewport() {
    var head = document.head || document.documentElement;
    if (!head) return;
    var metas = document.querySelectorAll("meta[name='viewport']");
    var meta = metas[0];
    if (!meta) {
      meta = document.createElement("meta");
      meta.setAttribute("name", "viewport");
      head.appendChild(meta);
    }
    for (var i = 1; i < metas.length; i++) {
      if (metas[i].parentNode) metas[i].parentNode.removeChild(metas[i]);
    }
    if (meta.getAttribute("content") !== VIEWPORT_CONTENT) {
      meta.setAttribute("content", VIEWPORT_CONTENT);
    }
  }

  ensureViewport();
  window.setTimeout(ensureViewport, 400);
  window.setTimeout(ensureViewport, 1500);

  /* ------------------------------------------------------------------ *
   * 2. Pop-ups et bandeaux : masqués, puis retirés du DOM
   * ------------------------------------------------------------------ */
  var POPUPS = [
    // « Installer / ouvrir l'application »
    "div[data-testid='banner']",
    "[data-encore-id='banner']",
    "[data-testid='install-app-banner']",
    "[data-testid='mobile-app-banner']",
    "[data-testid='app-install-prompt']",
    "[data-testid='open-in-app-button']",
    "a[href^='/download']",
    "a[href*='play.google.com']",
    "a[href*='apps.apple.com']",
    "button[data-testid='web-player-link']",
    ".encore-internal-announcements",
    // Consentement aux cookies (OneTrust est ce que Spotify utilise sur le web)
    "#onetrust-consent-sdk",
    "#onetrust-banner-sdk",
    "#onetrust-pc-sdk",
    "#onetrust-pc-dark-filter",
    ".onetrust-pc-dark-filter",
    ".optanon-alert-box-wrapper",
    "[id^='onetrust']",
    "[class*='onetrust']",
    "iframe[title*='cookie' i]",
    "iframe[src*='consent' i]",
    "[data-testid='cookie-banner']",
    "[data-testid='cookie-policy-banner']",
    "[data-testid='consent-banner']",
    "[data-testid='gdpr-banner']",
    // Infobulles, bulles d'aide, menus contextuels
    "[data-testid='hover-or-focus-tooltip']",
    "[data-tippy-root]",
    "[role='tooltip']",
    // Promotions qui recouvrent la page
    "[data-testid='promo-banner']",
    "[data-testid='premium-upsell']",
    "[data-testid='premium-upsell-dialog']",
    "[data-testid='upgrade-to-premium']",
    "[data-testid='upgrade-banner']",
    "[data-testid='upsell-banner']",
    "[data-testid='upsell-dialog']",
    "[data-testid='announcement-banner']",
    /* Les offres changent de nom souvent : ce qui contient « premium » ou
       « upsell » dans son identifiant technique en fait partie. */
    "[data-testid*='premium' i]",
    "[data-testid*='upsell' i]",
    "[data-testid*='upgrade' i]",
    "[data-encore-id='premiumUpsell']",
    "[data-encore-id='premium-upsell']",
  ];

  /* Même chose pour l'apparence : rien de ce qui fait « page web » ne doit
     rester (barres de défilement, surbrillance bleue au toucher, barre de
     sélection, menu d'appui long, rebond de défilement). */
  var css = document.createElement("style");
  css.setAttribute("data-sd", "native-mode");
  /* Une règle par sélecteur : si l'un d'eux devenait invalide (un attribut
     exotique ajouté plus tard), les autres continueraient de s'appliquer. */
  var hideCss = POPUPS.map(function (sel) {
    return sel + "{display:none !important}";
  }).join("\n");
  css.textContent =
    hideCss +
    /* Ce que les balayages par texte (section 2-bis) ont reconnu :
       « ouvrir dans l'application », et les invitations à l'abonnement. */
    "\n[data-sd-appprompt='1']{display:none !important}\n" +
    "\n[data-sd-premium='1']{display:none !important}\n" +
    /* …et la fenêtre que le balayage a reconnue : elle part en entier, avec ses
       boutons, sa croix de fermeture et son fond assombri. */
    "\n[data-sd-premium-dialog='1']{display:none !important}\n" +
    "\n" +
    "html{-webkit-text-size-adjust:100% !important;-webkit-tap-highlight-color:transparent !important;overscroll-behavior:none !important}\n" +
    "body{overscroll-behavior:none !important;-webkit-tap-highlight-color:transparent !important}\n" +
    "*,*::before,*::after{-webkit-touch-callout:none !important;-webkit-user-drag:none}\n" +
    "html,body,div,span,li,p,h1,h2,h3,h4,h5,h6,a,button,label{-webkit-user-select:none;user-select:none}\n" +
    "input,textarea,[contenteditable='true'],[contenteditable='']{-webkit-user-select:text !important;user-select:text !important}\n" +
    "::-webkit-scrollbar{width:0 !important;height:0 !important;background:transparent !important}\n" +
    "::-webkit-scrollbar-thumb,::-webkit-scrollbar-track,::-webkit-scrollbar-corner{background:transparent !important}\n";
  (document.head || document.documentElement).appendChild(css);

  function visible(el) {
    return !!(el && el.getClientRects && el.getClientRects().length);
  }

  /**
   * Les bannières de consentement posent `overflow:hidden` sur `<body>` pour
   * bloquer le défilement derrière elles. Comme on les masque au lieu de
   * cliquer « Accepter », le verrou resterait en place : on le relâche, mais
   * seulement si aucun vrai dialogue n'est ouvert.
   */
  function unlockScroll() {
    if (visible(document.querySelector("[role='dialog']"))) return;
    var b = document.body;
    var h = document.documentElement;
    if (!b) return;
    if (b.style && b.style.overflow === "hidden") b.style.overflow = "";
    if (h.style && h.style.overflow === "hidden") h.style.overflow = "";
    if (b.style && (b.style.position === "fixed" || b.style.position === "absolute")) b.style.position = "";
  }

  /**
   * Masque (CSS) et, pour les bannières de consentement — qui ne sont pas
   * gérées par React —, retire carrément du DOM : elles ne peuvent donc plus
   * intercepter le moindre appui.
   */
  function purge() {
    var found = 0;
    for (var i = 0; i < POPUPS.length; i++) {
      var nodes;
      try {
        nodes = document.querySelectorAll(POPUPS[i]);
      } catch (e) {
        continue;
      }
      for (var j = 0; j < nodes.length; j++) {
        var n = nodes[j];
        found++;
        if (n.getAttribute("data-sd-purged") === "1") continue;
        n.setAttribute("data-sd-purged", "1");
        var sig = (n.id || "") + " " + (typeof n.className === "string" ? n.className : "");
        if (/onetrust|cookie|consent|optanon|gdpr/i.test(sig) && n.parentNode) {
          try {
            n.parentNode.removeChild(n);
          } catch (e) {}
        }
      }
    }
    if (found) unlockScroll();
    return found;
  }

  /* Le balayage complet est trop lourd pour être relancé à chaque rendu de
     Spotify (l'application redessine en permanence) : on ne relance `purge`
     que si le nœud ajouté ressemble de près ou de loin à un pop-up. */
  var LOOKS_LIKE_POPUP = /onetrust|cookie|consent|optanon|banner|announcement|upsell|promo|upgrade|install-app|open-in-app|tooltip|tippy|modal-overlay/i;
  function suspect(node) {
    if (!node || node.nodeType !== 1) return false;
    var sig = "";
    try {
      sig =
        (node.id || "") +
        " " +
        (typeof node.className === "string" ? node.className : "") +
        " " +
        (node.getAttribute("data-testid") || "") +
        " " +
        (node.getAttribute("aria-label") || "");
    } catch (e) {
      return false;
    }
    return LOOKS_LIKE_POPUP.test(sig);
  }

  purge();
  window.setTimeout(purge, 300);
  window.setTimeout(purge, 1200);
  window.setTimeout(purge, 3500);
  try {
    new MutationObserver(function (records) {
      var hit = false;
      for (var i = 0; i < records.length && !hit; i++) {
        var added = records[i].addedNodes;
        for (var j = 0; j < added.length; j++) {
          if (suspect(added[j])) {
            hit = true;
            break;
          }
        }
      }
      if (!hit) return;
      if (purge()) window.setTimeout(unlockScroll, 900);
    }).observe(document.documentElement, { childList: true, subtree: true });
  } catch (e) {}

  /* ------------------------------------------------------------------ *
   * 2-bis. Ce que Spotify pousse à l'utilisateur
   *
   * Deux familles d'éléments, un seul balayage :
   *
   *  · « Ouvrir dans l'application » — celui du haut de page. Il renvoie vers
   *    `spotify:` ou vers une fiche de magasin, et ici il ne mène nulle part :
   *    il n'y a pas d'« application Spotify » à ouvrir, c'est l'application
   *    elle-même.
   *  · Les invitations à l'abonnement — encarts, fenêtres, et le bouton de la
   *    barre du bas.
   *
   * Les sélecteurs par attributs de la section 2 sont fragiles : Spotify
   * renomme ses attributs d'une version à l'autre. Ces deux-là regardent ce que
   * l'élément **dit** et où ses liens **mènent** — ce que le CSS ne sait pas
   * faire.
   * ------------------------------------------------------------------ */
  var APP_PROMPT_TEXT = /ouvrir dans l'application|ouvrir l'application|ouvrir spotify|ouvrir l'appli|écouter dans l'application|continuer dans l'application|télécharger l'application|lancer l'application|open (the )?app|open spotify|get the app|download the app/i;
  var APP_PROMPT_LINK = /^(market:|intent:)/i;
  var APP_STORE_LINK = /play\.google\.com|apps\.apple\.com|itunes\.apple\.com|\/download/i;
  var PREMIUM_TEXT = new RegExp(
    [
      "passe[rz]? (?:à|a|au) premium",
      "passer premium",
      "essay(?:ez|er) premium",
      "essai (?:gratuit|de premium|premium)",
      "premium (?:gratuit|gratuitement|sans engagement)",
      "découvr(?:ez|ir) premium",
      "devenez premium",
      "abonnez-vous",
      "s'abonner",
      "souscri(?:re|vez)",
      "offre premium",
      "musique en aléatoire",
      "lecture en aléatoire",
      "interruptions publicitaires",
      "sans (?:publicité|pub|interruption)",
      "get premium",
      "try premium",
      "go premium",
      "upgrade (?:to|your) premium",
      "free trial",
      "start (?:your )?free trial",
      "subscribe",
      "premium for",
    ].join("|"),
    "i"
  );
  /**
   * Un prix affiché (« **à 0 €** pendant 3 mois », « 3 mois offerts », « 30 %
   * de réduction ») : ce n'est pas une preuve à soi seul — la page en parle
   * aussi dans ses conditions — mais c'en est une dès que ça apparaît dans une
   * **fenêtre posée par-dessus** la page. C'est exactement l'offre du démarrage.
   */
  var MONEY_TEXT = /(^|[^0-9])0+([,.][0-9]{2})?\s*(€|euros?|\$|£)|(^|[^0-9])(€|\$|£)\s*0+([,.][0-9]{2})?([^0-9]|$)|gratuit pendant|mois (?:offert|gratuit)|(?:offert|gratuit)[a-z]* pendant|% de r[ée]duction|r[ée]duction de|économisez|profitez de/i;
  var PREMIUM_LINK = /spotify:premium|spotify\.com\/premium|^\/premium(?:\/|\?|$)|^https?:\/\/[^/]*\/premium(?:\/|\?|$)/i;
  var OVERLAY_NAME = /modal|dialog|overlay|pop-?up|upsell|sheet|encore-.*overlay|consent/i;

  /**
   * La fenêtre posée par-dessus la page, s'il y en a une : cinq niveaux au plus,
   * et seulement des signes qui ne trompent pas — `role="dialog"`,
   * `aria-modal`, un nom qui parle de fenêtre, ou bien un bloc fixé qui couvre
   * la majeure partie de l'écran. Une barre de navigation ne peut pas passer
   * pour une fenêtre : elle est large mais basse.
   */
  function overlayAncestor(el) {
    var n = el && el.parentNode;
    var hops = 0;
    while (n && n !== document.body && n !== document.documentElement && hops < 6) {
      var role = "";
      var modal = "";
      var sig = "";
      try {
        role = (n.getAttribute("role") || "").toLowerCase();
        modal = (n.getAttribute("aria-modal") || "").toLowerCase();
        sig =
          (n.id || "") +
          " " +
          (typeof n.className === "string" ? n.className : "") +
          " " +
          (n.getAttribute("data-testid") || "");
      } catch (e) {
        return null;
      }
      var named = OVERLAY_NAME.test(sig);
      if (role === "dialog" || role === "alertdialog" || modal === "true" || named) {
        /* Un conteneur nommé « dialog » qui porte tout le document n'est pas
           une fenêtre : on ne masque jamais l'application entière. */
        if (n === document.body || n === document.documentElement) return null;
        return n;
      }
      var pos = "";
      var rect = null;
      try {
        pos = document.defaultView.getComputedStyle(n).position || "";
        rect = n.getBoundingClientRect();
      } catch (e) {}
      if (rect && /fixed|absolute/.test(pos)) {
        var vw = document.documentElement.clientWidth || 360;
        var vh = document.documentElement.clientHeight || 640;
        if (rect.width >= vw * 0.6 && rect.height >= vh * 0.35) return n;
      }
      n = n.parentNode;
      hops++;
    }
    return null;
  }

  function clickablesIn(el) {
    try {
      return el.querySelectorAll("a,button,[role='button']").length;
    } catch (e) {
      return 99;
    }
  }

  /**
   * L'élément est-il posé au-dessus du contenu — `position` `fixed`, `absolute`
   * ou `sticky`, ou `role="banner"` / `role="dialog"` ? Au-delà de cinq niveaux
   * on s'arrête et on ne touche à rien : masquer un parent trop large
   * emporterait du vrai contenu.
   */
  function bannerAncestor(el) {
    var n = el && el.parentNode;
    var hops = 1;
    while (n && n !== document.body && hops <= 5) {
      var role = n.getAttribute ? n.getAttribute("role") : null;
      var pos = "";
      try {
        pos = document.defaultView.getComputedStyle(n).position || "";
      } catch (e) {}
      if (role === "banner" || role === "dialog" || /fixed|absolute|sticky/.test(pos)) return n;
      n = n.parentNode;
      hops++;
    }
    return null;
  }

  /**
   * L'élément est-il dans une barre de navigation ? Un `<nav>`, un
   * `role="navigation"`, ou une barre collée qui porte au moins trois
   * commandes (c'est la barre du bas de la page mobile).
   */
  function inBar(el) {
    var n = el && el.parentNode;
    var hops = 0;
    while (n && n !== document.body && hops < 6) {
      var role = n.getAttribute ? n.getAttribute("role") : null;
      if (n.tagName === "NAV" || role === "navigation") return true;
      var pos = "";
      try {
        pos = document.defaultView.getComputedStyle(n).position || "";
      } catch (e) {}
      if (/fixed|sticky/.test(pos) && clickablesIn(n) >= 3) return true;
      n = n.parentNode;
      hops++;
    }
    return false;
  }

  /**
   * Ce qu'on masque : le bandeau entier s'il ne porte que l'invitation,
   * l'invitation seule s'il porte aussi les commandes de la page (logo,
   * recherche, profil) — enlever la barre du haut parce qu'elle contient une
   * phrase serait pire que la laisser. Dans une barre de navigation, on ne
   * touche jamais qu'à l'élément lui-même.
   */
  function placeSweep(el, allowInBar) {
    if (clickablesIn(el) > 2) return null; // une barre, pas un encart
    /* Dans une barre de navigation, on ne touche jamais qu'à l'élément
       lui-même — et seulement s'il dit lui-même ce qu'il est : un onglet ne
       doit pas disparaître sur une déduction. */
    if (inBar(el)) return allowInBar ? el : null;
    var band = bannerAncestor(el);
    if (band) return clickablesIn(band) <= 2 ? band : el;
    /* Pas de bandeau autour : seul un signe explicite autorise à masquer
       l'élément lui-même (un lien vers le magasin d'applications peut très bien
       être un simple lien de la page). */
    return allowInBar ? el : null;
  }

  var SWEEP_SELECTOR = "a,button,[role='button'],[data-testid],[role='banner']";

  function sweep(attr, verdict) {
    var els;
    try {
      els = document.querySelectorAll(SWEEP_SELECTOR);
    } catch (e) {
      return 0;
    }
    var hits = 0;
    for (var i = 0; i < els.length && i < 900; i++) {
      var el = els[i];
      if (el.getAttribute(attr) === "1") continue;
      var href = "";
      var text = "";
      try {
        href = el.getAttribute("href") || "";
        text = (el.textContent || "").replace(/\s+/g, " ").trim();
      } catch (e) {
        continue;
      }
      if (text.length > 160) text = "";
      var found = verdict(text, href, el);
      if (!found) continue;
      var host = found.host || placeSweep(el, found.allowInBar);
      if (!host) continue;
      var mark = found.attr || attr;
      if (host.getAttribute(attr) === "1" || host.getAttribute("data-sd-premium-dialog") === "1") continue;
      host.setAttribute(mark, "1");
      hits++;
    }
    return hits;
  }

  /**
   * Le texte de ce qui entoure l'élément (cinq niveaux au plus, 160 caractères
   * au plus) dit-il qu'il s'agit d'une invitation ? C'est ce qui permet de
   * reconnaître un bandeau dont le bouton ne dit que « Ouvrir ».
   */
  function ancestorInvite(el) {
    var n = el.parentNode;
    var hops = 0;
    while (n && n !== document.body && hops < 5) {
      var t = "";
      try {
        t = (n.textContent || "").replace(/\s+/g, " ").trim();
      } catch (e) {
        return false;
      }
      if (t.length <= 160 && APP_PROMPT_TEXT.test(t)) return true;
      n = n.parentNode;
      hops++;
    }
    return false;
  }

  function appPromptVerdict(text, href, el) {
    var byText = APP_PROMPT_TEXT.test(text);
    var byLink = APP_PROMPT_LINK.test(href) || APP_STORE_LINK.test(href);
    if (!byText && !byLink) {
      /* Un lien `spotify:` n'est pas une preuve : la barre du bas de la page
         mobile en est pleine (`spotify:collection` est l'onglet Bibliothèque).
         Seule une phrase d'invitation autour autorise à masquer — c'est ainsi
         qu'un onglet de navigation survit toujours. */
      if (!/^spotify:/i.test(href) || !ancestorInvite(el)) return null;
      byText = true;
    }
    return { allowInBar: byText };
  }

  function premiumVerdict(text, href, el) {
    var byText = PREMIUM_TEXT.test(text);
    var byLink = PREMIUM_LINK.test(href);
    /* Un onglet « Premium » tout court : dans une barre, ou qui mène aux
       offres. Une simple étiquette « Premium » ailleurs n'est pas touchée. */
    if (!byText && !byLink && /^premium$/i.test(text) && (href !== "" || inBar(el))) {
      byText = true;
    }
    /* Une **fenêtre** posée par-dessus la page qui parle d'offre ou de prix :
       elle part en entier, quel que soit son nombre de boutons. C'est le cas de
       l'offre du démarrage (« à 0 € pendant 3 mois »), qui a une croix de
       fermeture, deux boutons, et ne correspondait donc à aucun de nos motifs
       par attribut. */
    var overlay = overlayAncestor(el);
    var byMoney = false;
    if (overlay) {
      var full = "";
      try {
        full = (overlay.textContent || "").replace(/\s+/g, " ").trim();
      } catch (e) {
        full = "";
      }
      if (full.length > 3000) full = full.slice(0, 3000);
      if (PREMIUM_TEXT.test(full) || MONEY_TEXT.test(full) || PREMIUM_LINK.test(href)) {
        return { host: overlay, attr: "data-sd-premium-dialog" };
      }
      byMoney = MONEY_TEXT.test(text);
    }
    if (!byText && !byLink && !byMoney) return null;
    /* Ici, un lien vers les offres suffit, même dans une barre : c'est
       précisément le bouton d'abonnement du bas de page qu'on veut retirer. */
    return { allowInBar: byText || byLink };
  }

  function sweepAll() {
    return sweep("data-sd-appprompt", appPromptVerdict) + sweep("data-sd-premium", premiumVerdict);
  }

  sweepAll();
  window.setTimeout(sweepAll, 400);
  window.setTimeout(sweepAll, 1500);
  window.setTimeout(sweepAll, 4000);
  /* Spotify repose son bandeau et ses encarts à chaque changement d'écran : le
     balayage est donc répété, mais borné (900 éléments, des motifs courts). */
  window.setInterval(sweepAll, 2000);

  /* ------------------------------------------------------------------ *
   * 2-bis. Connexion : ne jamais rester devant une page sans issue
   *
   * La page de connexion de Spotify met ses boutons sociaux en avant et
   * n'affiche le formulaire e-mail/mot de passe que si on le lui demande. Dans
   * une WebView, les boutons sociaux ne mènent nulle part : Google refuse
   * d'ouvrir son OAuth depuis un navigateur embarqué (« disallowed_useragent »).
   * Sans rien, on arrive donc sur une page où **aucun** des boutons proposés ne
   * peut fonctionner.
   *
   * L'application d'origine réglait exactement ça, avec le même truc que le
   * nôtre : un bouton « Email + Password Classic Login » inséré dans la page,
   * pointant vers `?allow_password=1` — le paramètre qui force Spotify à
   * afficher son formulaire. C'est repris ici, en français, et seulement quand
   * il n'y a pas déjà un champ de mot de passe à l'écran.
   *
   * Rien n'est envoyé nulle part : le bouton est un lien vers la même page.
   * ------------------------------------------------------------------ */
  var LOGIN_HOST = /(^|\.)accounts\.spotify\.com$/i;
  var LOGIN_PATH = /\/(login|signup|password|reset|fr\/login|intl-[a-z-]+\/login)/i;

  function emailField() {
    try {
      return document.querySelector(
        "input[type='password'],input[name='password'],input[autocomplete='current-password'],#login-password"
      );
    } catch (e) {
      return null;
    }
  }

  function passwordAllowed() {
    return /allow_password=1/.test(window.location.search);
  }

  function removeLoginHelp() {
    var bar = document.getElementById("sd-login-help");
    if (bar && bar.parentNode) bar.parentNode.removeChild(bar);
  }

  /** L'utilisateur a masqué le bandeau : on ne le lui remet pas de la session. */
  function loginHelpHidden() {
    try {
      return window.sessionStorage.getItem("sd-login-help") === "hidden";
    } catch (e) {
      return false;
    }
  }

  function showLoginHelp() {
    if (!LOGIN_HOST.test(window.location.hostname) || !LOGIN_PATH.test(window.location.pathname)) {
      removeLoginHelp();
      return;
    }
    /* Un champ de mot de passe est là : Spotify propose déjà le formulaire. */
    if (emailField() || passwordAllowed()) {
      removeLoginHelp();
      return;
    }
    if (loginHelpHidden()) {
      removeLoginHelp();
      return;
    }
    if (document.getElementById("sd-login-help")) return;
    var bar = document.createElement("div");
    bar.id = "sd-login-help";
    bar.setAttribute("data-sd", "login-help");
    bar.style.cssText =
      "position:fixed;left:0;right:0;bottom:0;z-index:2147483000;padding:12px 16px 20px;" +
      "background:#121212;border-top:1px solid #2a2a2a;font-family:inherit;text-align:center";
    var note = document.createElement("div");
    note.style.cssText = "color:#a7a7a7;font-size:12px;line-height:1.4;margin-bottom:8px";
    note.textContent =
      "Les boutons Google/Apple/Facebook ne fonctionnent pas dans l'application. La connexion par e-mail, si.";
    var link = document.createElement("a");
    link.setAttribute("data-sd", "login-help-button");
    link.href = "?allow_password=1";
    link.textContent = "Utiliser mon e-mail et mon mot de passe";
    link.style.cssText =
      "display:block;padding:12px;border-radius:30px;background:#1ed760;color:#000;" +
      "font-weight:700;text-decoration:none;font-size:15px";
    /* Un « masquer » : c'est notre bandeau, pas celui de Spotify, et personne
       n'a à le subir s'il ne veut pas. Masqué, il ne revient plus. */
    var hide = document.createElement("a");
    hide.setAttribute("data-sd", "login-help-hide");
    hide.href = "#";
    hide.textContent = "Masquer";
    hide.style.cssText =
      "display:inline-block;margin-top:8px;color:#a7a7a7;font-size:12px;text-decoration:underline";
    hide.addEventListener("click", function (e) {
      e.preventDefault();
      try {
        window.sessionStorage.setItem("sd-login-help", "hidden");
      } catch (err) {}
      removeLoginHelp();
    });
    bar.appendChild(note);
    bar.appendChild(link);
    bar.appendChild(hide);
    (document.body || document.documentElement).appendChild(bar);
  }

  /**
   * Consentement Facebook : quand on se connecte avec Facebook, Facebook affiche
   * d'abord son propre écran de consentement, qu'il faut accepter à la main.
   * L'application d'origine cliquait le premier bouton de cette page — même
   * chose ici, sur cette page-là uniquement.
   */
  function acceptFacebookConsent() {
    if (!/facebook\.com$/i.test(window.location.hostname)) return;
    if (!/privacy\/consent/i.test(window.location.pathname)) return;
    try {
      var target = document.querySelector("#facebook div[role=button],div[role=button]");
      if (target) target.click();
    } catch (e) {}
  }

  var loginTick = function () {
    acceptFacebookConsent();
    showLoginHelp();
  };

  /* Pour le banc d'essai : la vérification du formulaire de connexion. */
  window.__sdLoginTick = loginTick;

  loginTick();
  window.setTimeout(loginTick, 600);
  window.setTimeout(loginTick, 1800);
  window.setTimeout(loginTick, 3500);
  window.setInterval(loginTick, 2500);

  /* ------------------------------------------------------------------ *
   * 2-ter. Les onglets de la barre du bas
   *
   * Constat utilisateur, deux versions de suite : « le bouton Bibliothèque ne
   * fait rien, quand on clique il ne s'affiche rien ». Trois causes possibles,
   * et aucune n'est visible depuis la page :
   *
   *   a. l'onglet est un lien `spotify:` — que la WebView ne sait pas ouvrir
   *      (l'application le convertit, mais le script de Spotify peut avoir
   *      intercepté le clic avant) ;
   *   b. l'onglet est un simple bouton, et le routeur de Spotify décide de ne
   *      rien faire dans une WebView ;
   *   c. la navigation aboutit, mais la page ne peint rien.
   *
   * Ce qui suit ne devine pas : au clic, on note ce qui s'est passé, et si rien
   * n'a bougé au bout d'une seconde, on **fait la navigation nous-mêmes** vers
   * l'adresse que l'onglet désigne (bibliothèque, recherche, accueil). C'est la
   * seule chose qui marche dans les trois cas (a), (b) et (c) — dans le (c) la
   * page est simplement rechargée sur la bonne adresse.
   * ------------------------------------------------------------------ */
  var NAV_TABS = [
    { re: /biblioth|library|collection|ma musique/i, route: "/collection" },
    { re: /recherch|search/i, route: "/search" },
    { re: /accueil|home/i, route: "/" },
  ];

  /** L'adresse que cet onglet désigne, ou `null` s'il ne dit rien. */
  function routeForNav(el) {
    var href = "";
    var label = "";
    try {
      href = (el.getAttribute && el.getAttribute("href")) || "";
      label =
        (el.getAttribute &&
          (el.getAttribute("aria-label") || el.getAttribute("title") || "")) ||
        "";
      label = (label + " " + (el.textContent || "")).replace(/\s+/g, " ").trim();
    } catch (e) {
      return null;
    }
    /* 1. Ce que le lien dit. */
    if (/^spotify:/i.test(href)) {
      var tail = href.replace(/^spotify:/i, "").split(":")[0].toLowerCase();
      if (tail === "collection" || tail === "library") return "/collection";
      if (tail === "search") return "/search";
      if (tail === "home" || tail === "app") return "/";
    } else if (/^\/(collection|search)?(\/|\?|$)/i.test(href)) {
      return href.split("?")[0] || "/";
    }
    /* 2. Ce que l'onglet raconte, quand le lien ne dit rien (bouton JS). */
    for (var i = 0; i < NAV_TABS.length; i++) {
      if (NAV_TABS[i].re.test(label)) return NAV_TABS[i].route;
    }
    return null;
  }

  /** Le bouton ou le lien sous le doigt, en remontant quelques niveaux. */
  function pressable(e) {
    var el = e.target;
    var hops = 0;
    while (el && el !== document.body && hops < 6) {
      var role = el.getAttribute ? el.getAttribute("role") : "";
      if (el.tagName === "A" || el.tagName === "BUTTON" || role === "button") return el;
      el = el.parentNode;
      hops++;
    }
    return null;
  }

  function goTo(route) {
    try {
      window.location.assign(route);
    } catch (e) {
      try {
        window.location.href = route;
      } catch (err) {}
    }
  }

  function watchNav() {
    document.addEventListener(
      "click",
      function (e) {
        var el = pressable(e);
        if (!el || !inBar(el)) return;
        var route = routeForNav(el);
        var before = window.location.pathname + window.location.search;
        var tap = {
          label: "",
          href: "",
          route: route || "",
          before: before,
          after: "",
          forced: "",
        };
        try {
          tap.label = (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 20);
          tap.href = el.getAttribute("href") || "";
        } catch (err) {}
        /* Ce que la sonde de diagnostic affiche : le dernier onglet touché, ce
           qu'il désignait, et ce qui s'est réellement passé. */
        try {
          window.__sdNavTap = tap;
        } catch (err) {}
        if (!route) return;
        window.setTimeout(function () {
          var after = window.location.pathname + window.location.search;
          tap.after = after;
          /* La page a suivi toute seule : rien à faire. */
          if (after !== before) return;
          /* On est déjà sur cette adresse : l'onglet est simplement un
             « retour en haut », on ne recharge pas la page sous le doigt. */
          if (route === after) return;
          tap.forced = route;
          goTo(route);
        }, 1200);
      },
      true
    );
  }

  watchNav();

  /* Pour le banc d'essai : la correspondance onglet → adresse, vérifiable sans
     navigateur. */
  window.__sdNavRouteFor = routeForNav;

  /* ------------------------------------------------------------------ *
   * 2. Pont minimal pour la notification Android
   * ------------------------------------------------------------------ */
  function bridge(name, arg) {
    try {
      var b = window.AndBridge;
      if (b && typeof b[name] === "function") {
        if (arg === undefined) b[name]();
        else b[name](arg);
      }
    } catch (e) {}
  }

  function q(sel, root) {
    try {
      return (root || document).querySelector(sel);
    } catch (e) {
      return null;
    }
  }

  function byLabel(res, root) {
    var nodes = (root || document).querySelectorAll("button,[role='button']");
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      var s = [n.getAttribute("aria-label"), n.getAttribute("title"), n.textContent]
        .filter(Boolean)
        .join(" ");
      if (res.test(s)) return n;
    }
    return null;
  }

  function playPauseBtn() {
    return (
      q("button[data-testid='control-button-playpause']") ||
      q("[data-testid='now-playing-widget'] ~ * button[aria-label*='ause']") ||
      byLabel(/(pause|play|lecture|reprendre)/i)
    );
  }

  function clickBtn(btn) {
    if (!btn) return false;
    try {
      btn.click();
      return true;
    } catch (e) {
      return false;
    }
  }

  function setNativeInput(input, value) {
    if (!input) return false;
    try {
      var proto = window.HTMLInputElement && window.HTMLInputElement.prototype;
      var setter = proto && Object.getOwnPropertyDescriptor(proto, "value") && Object.getOwnPropertyDescriptor(proto, "value").set;
      if (setter) setter.call(input, value);
      else input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    } catch (e) {
      return false;
    }
  }

  /* Le shim : mêmes noms de méthodes que la couche injectée, pour que
     `PlaybackService` n'ait rien à savoir du mode choisi. */
  window.SpotiDuckUI = {
    version: "native",
    mode: NATIVE,
    play: function () {
      var b = playPauseBtn();
      /* Attention à la langue : le bouton annonce l'action à venir. « Pause »
         veut dire « déjà en lecture », mais « Lecture » (FR) / « Play » (EN)
         veut dire « en pause, appuie pour reprendre » — il faut donc cliquer. */
      if (b && /pause/i.test(b.getAttribute("aria-label") || "")) return true;
      return clickBtn(b);
    },
    pause: function () {
      var b = playPauseBtn();
      if (b && /play|lecture/i.test(b.getAttribute("aria-label") || "")) return true; // déjà en pause
      return clickBtn(b);
    },
    playPause: function () {
      return clickBtn(playPauseBtn());
    },
    next: function () {
      return clickBtn(
        q("button[data-testid='control-button-skip-forward']") ||
          byLabel(/(next|suivant|suivante)/i)
      );
    },
    previous: function () {
      return clickBtn(
        q("button[data-testid='control-button-skip-back']") ||
          byLabel(/(previous|pr[ée]c[ée]dent)/i)
      );
    },
    like: function () {
      var b =
        q("[data-testid='now-playing-widget'] button[aria-checked]") ||
        byLabel(/^(j'aime|like|aimer|retirer)/i);
      return clickBtn(b);
    },
    seek: function (ms) {
      var input = q("[data-testid='playback-progressbar'] input[type='range']") || q("input[type='range']");
      if (!input) return false;
      var max = parseFloat(input.max || input.getAttribute("max") || "0");
      var value = ms / 1000; // Spotify exprime sa barre de progression en secondes
      return setNativeInput(input, Math.max(0, Math.min(max, value)));
    },
    sync: function () {
      publish(true);
    },
    back: function () {
      if (window.history.length > 1) {
        window.history.back();
        return true;
      }
      return false;
    },
    /* Rien à piloter : l'interface est celle de Spotify. */
    openPlayer: function () {},
    closePlayer: function () {},
    openSettings: function () {},
    close: function () {},
    set: function () {
      return false;
    },
  };

  /* ------------------------------------------------------------------ *
   * 3. Métadonnées → notification + état de veille
   * ------------------------------------------------------------------ */
  var last = "";
  var lastPos = 0;
  var lastPlaying = false;

  function readPlaying() {
    var b = playPauseBtn();
    var label = (b && (b.getAttribute("aria-label") || "")) || "";
    if (/pause/i.test(label)) return true;
    if (/play|lecture|reprendre/i.test(label)) return false;
    return lastPlaying;
  }

  function publish(force) {
    var titleEl =
      q("[data-testid='context-item-link']") ||
      q("[data-testid='now-playing-widget'] a[href*='/track/']") ||
      q("[data-testid='nowplaying-track-link']");
    var artistEl =
      q("[data-testid='context-item-info-artist']") ||
      q("[data-testid='nowplaying-artist']") ||
      q("[data-testid='context-item-info-show']");
    var img = q("[data-testid='cover-art-image']") || q("img[data-testid='cover-art-image']");
    var range = q("[data-testid='playback-progressbar'] input[type='range']") || q("input[type='range']");

    var title = titleEl ? (titleEl.textContent || "").trim() : "";
    var artist = artistEl ? (artistEl.textContent || "").trim() : "";
    var cover = img ? img.getAttribute("src") || "" : "";
    var max = range ? parseFloat(range.max || "0") : 0;
    var val = range ? parseFloat(range.value || "0") : 0;
    var duration = /^\s*\d{4,}$/.test(String(range && range.max)) ? max : max * 1000;
    var position = /^\s*\d{4,}$/.test(String(range && range.max)) ? val : val * 1000;
    var playing = readPlaying();
    if (!title) return;

    var key = [title, artist, playing].join("|");
    if (!force && key === last) {
      if (Math.abs(position - lastPos) > 4000) {
        lastPos = position;
        bridge("recMediaPosition", Math.round(position));
      }
      return;
    }
    last = key;
    lastPos = position;
    lastPlaying = playing;
    bridge(
      "recMediaStatus",
      JSON.stringify({
        track: title,
        artist: artist,
        cover: cover,
        duration: Math.round(duration || 0),
        position: Math.round(position || 0),
        playing: playing,
        repeat: "false",
        fav: false,
      })
    );
  }

  publish(true);
  window.setInterval(publish, 1000);

  /* ------------------------------------------------------------------ *
   * 4. Appui long (3 s, n'importe où) → choix de l'interface
   * ------------------------------------------------------------------ */
  var hold = 0;
  var from = null;
  var swallowUntil = 0;

  function pressPoint(e) {
    var t = (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0]) || e;
    return { x: t.clientX || 0, y: t.clientY || 0 };
  }

  function startHold(e) {
    window.clearTimeout(hold);
    from = pressPoint(e);
    hold = window.setTimeout(function () {
      hold = 0;
      from = null;
      swallowUntil = Date.now() + 700;
      try {
        if (navigator.vibrate) navigator.vibrate(20);
      } catch (err) {}
      bridge("showUiChooser");
    }, 3000);
  }

  function cancelHold() {
    window.clearTimeout(hold);
    hold = 0;
    from = null;
  }

  /* Un doigt qui fait défiler la page n'est pas un appui long : au-delà de
     12 px, on abandonne. C'est ce qui évite le « pop-up » qui s'ouvrait en
     gardant le doigt posé pendant un défilement. */
  function movedFar(e) {
    if (!from) return false;
    var p = pressPoint(e);
    return Math.abs(p.x - from.x) > 12 || Math.abs(p.y - from.y) > 12;
  }

  ["touchstart", "mousedown"].forEach(function (ev) {
    document.addEventListener(ev, startHold, { passive: true, capture: true });
  });
  ["touchmove", "mousemove"].forEach(function (ev) {
    document.addEventListener(
      ev,
      function (e) {
        if (movedFar(e)) cancelHold();
      },
      { passive: true, capture: true }
    );
  });
  ["touchend", "touchcancel", "mouseup", "scroll"].forEach(function (ev) {
    document.addEventListener(ev, cancelHold, { passive: true, capture: true });
  });
  /* Le clic qui suit le relâchement appartient au choix de l'interface, pas à
     Spotify : sans ça, un appui long sur une liste lance le morceau touché. */
  document.addEventListener(
    "click",
    function (e) {
      if (swallowUntil && Date.now() < swallowUntil) {
        swallowUntil = 0;
        e.preventDefault();
        e.stopPropagation();
      }
    },
    { capture: true }
  );
})();
