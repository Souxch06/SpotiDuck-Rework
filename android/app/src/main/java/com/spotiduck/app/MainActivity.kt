package com.spotiduck.app

import android.Manifest
import android.annotation.SuppressLint
import android.content.ClipData
import android.content.ComponentCallbacks2
import android.content.ClipboardManager
import android.content.ComponentName
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.Message
import android.os.PowerManager
import android.provider.Settings
import android.util.Log
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.JsPromptResult
import android.webkit.JsResult
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import org.json.JSONObject

/**
 * SpotiDuck — WebView shell around the Spotify web player.
 *
 * Responsibilities (and nothing else):
 *  1. serve one of the three interfaces the user can pick between:
 *       • `native` (default) — Chrome-Android user agent, so open.spotify.com
 *         serves **its own mobile page**; nothing is redrawn, the app only
 *         hides the browser banners, pins the viewport and mirrors the
 *         metadata to the notification (`assets/native-mode.js`);
 *       • `original` — the project's original injected script
 *         (`assets/spotiduck-original.js`) on the **desktop** web player, with
 *         the original app's WebView settings: that is the interface SpotiDuck
 *         has always had, unedited;
 *       • `inject` — the same desktop player plus `assets/spotiduck-ui.js`, our
 *         own layer (top navigation, mini player, sheets, settings…);
 *     The mode is a long-press away (the chooser also opens Play Protect
 *     settings); it is stored in SharedPreferences and survives restarts;
 *  2. inject the script of that mode after every page load (each is a single
 *     self-contained script, CSS included);
 *  3. expose the `AndBridge` object the layer talks to;
 *  4. keep the audio alive (wake lock, foreground service, notification);
 *  5. block ad hosts from `assets/adblock_hosts.txt`;
 *  6. forward the hardware back button to the UI (`SpotiDuckUI.back()`).
 */
class MainActivity : AppCompatActivity() {

    private lateinit var root: FrameLayout
    private lateinit var webView: WebView
    private lateinit var adBlocker: AdBlocker
    private val bridge = Bridge(this)
    private val ui = Handler(Looper.getMainLooper())

    private var uiBundle: String = ""
    private var nativeScript: String = ""
    private var originalScript: String = ""
    private var originalFingerprint: String = ""
    /* L'identité « bureau » de la coque : agent + navigator (client hints,
       greffons, plateforme). Voir `src/original/spotiduck-identity.js`. */
    private var identityScript: String = ""
    private var uiMode: String = MODE_DEFAULT
    /** Dernier lien non-web traité (converti, ou avalé) : affiché par la sonde. */
    private var lastHandledLink: String = ""
    /** Horodatage du dernier enregistrement des cookies sur le disque. */
    private var lastCookieFlush: Long = 0L
    /** Horodatage du dernier enregistrement de la session (copie de secours). */
    private var lastSessionSave: Long = 0L
    /** Dernière copie écrite : on ne réécrit pas la même chose toutes les secondes. */
    private var sessionHash: String = ""
    /** La page a confirmé la connexion : la copie de secours vaut la peine. */
    private var sessionConfirmed = false
    /** Une copie vient d'être réinjectée dans ce lancement (voir `onLoginState`). */
    private var sessionRestored = false
    /** Une seule tentative de récupération automatique par lancement. */
    private var sessionRecoveryTried = false
    /** Instant du lancement (voir `justLaunched`). */
    private var launchAt: Long = 0L
    /** Les fenêtres ouvertes par la page (connexion Google, Apple…) : empilées. */
    private val loginWindows = ArrayList<LoginWindow>()
    private var powerManager: PowerManager? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private var shutdownRunnable: Runnable? = null
    private var shutdownArmed = true

    /** Colour of the app background while the page loads (avoids a white flash). */
    private val appBg = Color.parseColor("#000000")

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)

        launchAt = System.currentTimeMillis()
        uiMode = storedUiMode()
        powerManager = getSystemService(POWER_SERVICE) as? PowerManager
        adBlocker = AdBlocker(this).also { it.loadAsync() }
        uiBundle = readAsset("spotiduck-ui.js")
        originalScript = readAsset("spotiduck-original.js")
        originalFingerprint = readAsset("original-fingerprint.js")
        identityScript = readAsset("spotiduck-identity.js")

        nativeScript = runCatching { assets.open("native-mode.js").bufferedReader().use { it.readText() } }
            .getOrElse {
                Log.e(TAG, "assets/native-mode.js missing", it)
                ""
            }

        webView = WebView(this).apply {
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
            setBackgroundColor(appBg)
            settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true
                databaseEnabled = true
                mediaPlaybackRequiresUserGesture = false // playback can start on its own
                userAgentString = userAgentFor(uiMode)
                /* Mise en page : exactement les réglages de l'application
                   d'origine (`useWideViewPort`, `loadWithOverviewMode`,
                   `initialScale = 100`), pour que l'affichage d'origine soit
                   reproduit tel quel — largeur de mise en page calculée par la
                   page elle-même.

                   La couche SpotiDuck, elle, est écrite en dp et a besoin d'un
                   `<meta name="viewport">` : elle le pose pour son propre compte
                   (voir VIEWPORT_META_JS, uniquement dans ce mode-là). Sans ce
                   meta, elle se retrouvait mise en page sur 980 px et paraissait
                   énorme et rognée. */
                loadWithOverviewMode = true
                useWideViewPort = true
                builtInZoomControls = false
                displayZoomControls = false
                /* L'application d'origine acceptait le zoom (son interface était
                   mise en page par la page) : on garde ce comportement dans le
                   mode d'origine seulement. */
                setSupportZoom(uiMode == MODE_ORIGINAL)
                if (uiMode == MODE_ORIGINAL) setInitialScale(100)
                textZoom = 100 // never let the system font scale break the layout
                cacheMode = WebSettings.LOAD_DEFAULT
                javaScriptCanOpenWindowsAutomatically = true
                /* `target="_blank"` reste dans l'application : au lieu d'une
                   seconde fenêtre, le client ci-dessous charge la destination
                   dans la vue courante. L'option doit donc être **activée** —
                   sans elle, `window.open` ne fait rien du tout dans une
                   WebView, et « Continuer avec Google » (qui passe par là)
                   semblait mort. */
                setSupportMultipleWindows(true)
                mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
                saveFormData = false // pas de « Enregistrer ce mot de passe ? »
                savePassword = false
            }
            /* Un appui long sur du texte ou une pochette ouvre le menu du
               navigateur (sélection, « Enregistrer l'image », « Copier ») : dans
               une application, c'est un pop-up de trop. Le geste est avalé ici,
               le script de la page continue de recevoir ses évènements.

               Dans le mode d'origine, il ouvre le choix de l'interface : ce
               mode n'a pas d'écran de réglages (l'application d'origine en
               avait un, séparé), et sans cela il n'y aurait plus aucun moyen
               d'en changer. Les deux autres interfaces gèrent leur propre
               geste. */
            setOnLongClickListener {
                /* **Sortie de secours dans tous les modes.** Le geste est avalé
                   partout (pas de menu de navigateur), donc il ne coûte rien :
                   dans le mode d'origine c'était déjà le chemin du sélecteur,
                   et dans les deux autres il n'y avait aucun raccourci — si la
                   page ne s'affiche pas, rester coincé sans issue est pire que
                   tout. */
                showUiChooser()
                true
            }
            overScrollMode = View.OVER_SCROLL_NEVER // pas de halo bleu en bout de liste
        }
        webView.addJavascriptInterface(bridge, "AndBridge")
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true)

        /* La session d'abord : si la WebView a perdu ses cookies (mise à jour
           qui tue le processus avant l'écriture sur disque, réinstallation,
           nettoyage par le système), on remet celle qu'on avait sauvegardée.
           Sans ça, chaque mise à jour demandait de se reconnecter. */
        restoreSession()

        /* L'application arrive parfois déconnectée alors que la copie de secours
           est là : `onLoginState("out")` la réinjecte alors une fois, et jette
           la copie si elle ne ramène rien. */

        /* La WebView est posée dans un conteneur : c'est ce conteneur qui
           reçoit la place des barres système dans le mode mobile (voir
           `installInsetsForwarding`). Donner cette marge à la WebView
           elle-même rognait le haut de la page sur certaines versions. */
        root = FrameLayout(this).apply {
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
            setBackgroundColor(appBg)
            addView(webView)
        }
        setContentView(root)
        webView.setBackgroundColor(appBg)

        // Les commandes de la notification (Play/Next/…) sont exécutées dans la
        // page : le service a besoin d'un moyen d'appeler `window.SpotiDuckUI`.
        PlaybackService.jsExecutor = { js -> webView.post { webView.evaluateJavascript(js, null) } }

        installWebViewClient()
        installWebChromeClient()
        installInsetsForwarding()
        installBackHandling()
        askForNotificationPermission()

        val deepLink = intent?.data?.takeIf { it.host == "open.spotify.com" }?.toString()
        webView.loadUrl(deepLink ?: START_URL)
    }

    /* ------------------------------------------------------------------ *
     * WebView plumbing
     * ------------------------------------------------------------------ */

    private fun installWebViewClient() {
        webView.webViewClient = object : WebViewClient() {

            /**
             * Publicités et traqueurs — deux réponses différentes selon ce que
             * la page attend.
             *
             *  · **Publicité audio** : le lecteur attend un flux et lui servir
             *    « rien » le laisse devant un fichier manquant. On regarde donc
             *    le type de contenu (`audio/mpeg` = annonce, la musique n'est pas
             *    servie ainsi) et on répond **du silence**, comme l'application
             *    d'origine.
             *  · **Traqueurs et régies** : réponse vide, la requête n'aboutit
             *    pas.
             */
            override fun shouldInterceptRequest(
                view: WebView,
                request: WebResourceRequest
            ): WebResourceResponse? {
                val url = request.url?.toString() ?: return null
                if (adBlocker.isAdAudio(url)) {
                    val type = adBlocker.sniffContentType(url, request.requestHeaders)
                    if (type != null && type.startsWith("audio/")) {
                        Log.v(TAG, "ad audio silenced: $url ($type)")
                        return adBlocker.silentResponse()
                    }
                }
                return if (adBlocker.isBlocked(url)) {
                    Log.v(TAG, "blocked: $url")
                    adBlocker.emptyResponse()
                } else {
                    null
                }
            }

            /**
             * `spotify:track:ID` se transforme en `https://open.spotify.com/track/ID` :
             * Spotify s'en sert partout (« ouvrir dans l'application ») et une
             * WebView ne sait pas l'ouvrir — sans cette conversion, le clic ne
             * fait rien du tout. Les autres schémas (`intent:`, `market:`,
             * `mailto:`) sortiraient de l'application ou afficheraient une page
             * d'erreur : ils sont ignorés.
             */
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url ?: return false
                val scheme = url.scheme?.lowercase() ?: return false
                if (scheme == "http" || scheme == "https") return false
                val web = spotifyDeepLinkToWeb(url)
                lastHandledLink = if (web != null) {
                    view.loadUrl(web)
                    "converti $url -> $web"
                } else {
                    /* On ne laisse pas la WebView partir sur un schéma qu'elle
                       ne sait pas ouvrir (page d'erreur), mais on **note** ce
                       qu'on a avalé : un bouton de la page qui ne fait rien est
                       justement un lien que la WebView ne sait pas ouvrir, et
                       la sonde de diagnostic affiche cette ligne. C'est elle
                       qui dira si le bouton Bibliothèque est de ceux-là. */
                    "ignore $url"
                }
                return true
            }

            override fun onPageStarted(view: WebView, url: String?, favicon: android.graphics.Bitmap?) {
                if (uiMode == MODE_ORIGINAL) {
                    /* L'application d'origine injecte son empreinte **ici**,
                       avant que la page n'ait lu quoi que ce soit : c'est elle
                       qui fait calculer à Spotify la mise en page d'un bureau
                       1920×1080, et donc l'affichage d'origine. Injectée plus
                       tard, elle arrive après les premières décisions de la
                       page (et après le calcul de la mise en page). */
                    if (originalFingerprint.isNotEmpty()) {
                        view.evaluateJavascript(originalFingerprint, null)
                    }
                    return
                }
                /* L'identité avant tout le reste : la WebView annonce déjà
                   Chrome Windows, mais `navigator` répondait encore
                   « Android » (plateforme, client hints, greffons) — soit un
                   mélange que Spotify appelle « navigateur non compatible ».
                   Voir `src/original/spotiduck-identity.js`. */
                if (identityScript.isNotEmpty()) {
                    view.evaluateJavascript(identityScript, null)
                }
                injectViewportScript()
                /* `document.head` n'existe pas encore : le script s'installe et
                   pose le meta dès qu'il le peut (la WebView recalcule alors sa
                   mise en page). */
                view.evaluateJavascript(VIEWPORT_META_JS, null)
            }

            /**
             * The layer is a plain script, so it can be injected the same way
             * the previous implementation did it. Re-injecting on every page
             * load is harmless: the runtime is idempotent (`window.SpotiDuckUI`
             * already present → it returns immediately).
             */
            override fun onPageFinished(view: WebView, url: String?) {
                view.evaluateJavascript("window.__sdBridgeReady=true;", null)
                /* Le lecteur est chargé : les cookies de session viennent d'être
                   posés ou rafraîchis. On les écrit sur le disque **tout de
                   suite** (la WebView le fait paresseusement, et une mise à jour
                   tue le processus avant) et on garde une copie de secours. */
                if (url != null && SPOTIFY_SESSION_HOST.containsMatchIn(url)) {
                    flushCookies()
                    saveSession("fin de chargement")
                }
                if (uiMode != MODE_ORIGINAL) view.evaluateJavascript(VIEWPORT_META_JS, null)
                /* Douze secondes : le temps qu'une page Spotify s'affiche sur un
                   téléphone, pas celui d'un chargement bloqué. */
                view.postDelayed({ checkContentUsable() }, 12000L)
                val script = scriptFor(uiMode)
                if (script.isEmpty()) {
                    Log.e(TAG, "no script for mode $uiMode")
                } else {
                    view.evaluateJavascript(script, null)
                }
            }

            override fun onReceivedError(
                view: WebView,
                request: WebResourceRequest,
                error: android.webkit.WebResourceError
            ) {
                if (request.isForMainFrame) {
                    Log.w(TAG, "main frame error: ${error.description}")
                }
            }
        }
    }

    /**
     * Le client des fenêtres de la page.
     *
     * « Continuer avec Google » (et Apple, et Facebook) ouvre une **seconde
     * fenêtre** : Spotify appelle `window.open(...)`, y joue l'autorisation, et
     * attend que cette fenêtre lui rende la main (`window.opener`). Une WebView
     * qui n'accepte pas les fenêtres rend le bouton inerte — c'était la 2.8.0.
     * Une WebView qui charge l'adresse dans la vue courante casse le lien entre
     * les deux pages — c'était la 2.8.1, et le retour de connexion n'arrivait
     * plus. Mesuré en CI : la page de connexion ouvre bien
     * `accounts.google.com/v3/signin/identifier?client_id=1046568431490-…&redirect_uri=https://accounts.spotify.com/login/google/redirect`.
     *
     * Ici, la fenêtre demandée est **réellement** une fenêtre : une seconde
     * WebView posée par-dessus la première, même profil (donc mêmes cookies) et
     * même agent. Elle se ferme quand la page la ferme, et le retour de
     * connexion retombe alors dans la vue principale.
     */
    private fun installWebChromeClient() {
        webView.webChromeClient = SpotiChrome(isPopup = false)
    }

    /** Ce que la page a le droit de demander au navigateur. */
    private inner class SpotiChrome(private val isPopup: Boolean) : WebChromeClient() {

        override fun onCreateWindow(
            view: WebView,
            isDialog: Boolean,
            isUserGesture: Boolean,
            resultMsg: Message
        ): Boolean {
            val transport = resultMsg.obj as? WebView.WebViewTransport ?: return false
            val popup = buildPopupWebView()
            transport.webView = popup
            resultMsg.sendToTarget()
            showLoginWindow(popup)
            return true
        }

        override fun onCloseWindow(window: WebView) {
            if (window === webView) return
            closeLoginWindow(window)
        }

        /**
         * **Le contenu protégé** — la permission que la WebView demande avant
         * d'ouvrir Widevine, son module de déchiffrement.
         *
         * Sans elle, Android refuse. Spotify ne trouve alors plus de module
         * pour ses flux chiffrés et remplace le lecteur par un écran « La
         * lecture de contenus protégés est désactivée — Consultez le site
         * d'aide Spotify… » (capture du 24/09). Ce n'était donc pas
         * l'affichage : c'était **le moteur de lecture**, et rien d'autre dans
         * l'application ne pouvait le réparer.
         *
         * Une WebView dont le `WebChromeClient` n'implémente pas cette méthode
         * **refuse par défaut** : le silence était la panne. On accorde donc
         * explicitement, et rien d'autre — caméra, microphone et
         * géolocalisation restent refusés, la page n'en a pas besoin.
         */
        override fun onPermissionRequest(request: PermissionRequest) {
            val resources = request.resources ?: emptyArray()
            val granted = resources.filter { it == PermissionRequest.RESOURCE_PROTECTED_MEDIA_ID }
            if (granted.isEmpty()) {
                request.deny()
                return
            }
            request.grant(granted.toTypedArray())
        }

        override fun onProgressChanged(view: WebView, newProgress: Int) {
            if (!isPopup) return
            loginWindows.firstOrNull { it.web === view }?.let { entry ->
                entry.progress.progress = newProgress
                entry.progress.visibility = if (newProgress >= 100) View.GONE else View.VISIBLE
            }
        }

        override fun onReceivedTitle(view: WebView, title: String?) {
            if (!isPopup) return
            loginWindows.firstOrNull { it.web === view }?.title?.text = title ?: getString(R.string.login_window_title)
        }

        /**
         * Les boîtes de la page (`alert`, `confirm`, `prompt`). Sans elles, une
         * page qui en utilise une attend une réponse qui n'arrive jamais : la
         * WebView se bloque, et rien ne l'explique à l'écran.
         */
        override fun onJsAlert(view: WebView, url: String?, message: String?, result: JsResult?): Boolean {
            if (message == null || result == null) return false
            AlertDialog.Builder(this@MainActivity)
                .setMessage(message)
                .setPositiveButton(android.R.string.ok) { _, _ -> result.confirm() }
                .setOnCancelListener { result.cancel() }
                .show()
            return true
        }

        override fun onJsConfirm(view: WebView, url: String?, message: String?, result: JsResult?): Boolean {
            if (message == null || result == null) return false
            AlertDialog.Builder(this@MainActivity)
                .setMessage(message)
                .setPositiveButton(android.R.string.ok) { _, _ -> result.confirm() }
                .setNegativeButton(android.R.string.cancel) { _, _ -> result.cancel() }
                .setOnCancelListener { result.cancel() }
                .show()
            return true
        }

        override fun onJsPrompt(
            view: WebView,
            url: String?,
            message: String?,
            defaultValue: String?,
            result: JsPromptResult?
        ): Boolean {
            if (message == null || result == null) return false
            val field = EditText(this@MainActivity).apply { setText(defaultValue ?: "") }
            AlertDialog.Builder(this@MainActivity)
                .setMessage(message)
                .setView(field)
                .setPositiveButton(android.R.string.ok) { _, _ -> result.confirm(field.text.toString()) }
                .setNegativeButton(android.R.string.cancel) { _, _ -> result.cancel() }
                .setOnCancelListener { result.cancel() }
                .show()
            return true
        }

        override fun onConsoleMessage(msg: android.webkit.ConsoleMessage): Boolean {
            Log.d("SpotiDuckJS", "${msg.message()} (${msg.sourceId()}:${msg.lineNumber()}) [${if (isPopup) "fenêtre" else "page"}]")
            return true
        }
    }

    /**
     * La seconde WebView : mêmes réglages que la vue principale, parce que c'est
     * la même session qui continue dedans. L'agent compte double ici : Google
     * juge l'agent annoncé, et un agent différent entre la page et sa fenêtre
     * suffit à faire échouer l'autorisation.
     */
    private fun buildPopupWebView(): WebView = WebView(this).apply {
        settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            mediaPlaybackRequiresUserGesture = false
            userAgentString = userAgentFor(uiMode)
            setSupportMultipleWindows(true)
            javaScriptCanOpenWindowsAutomatically = true
            loadWithOverviewMode = true
            useWideViewPort = true
            builtInZoomControls = false
            displayZoomControls = false
            setSupportZoom(false)
            textZoom = 100
            cacheMode = WebSettings.LOAD_DEFAULT
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            saveFormData = false
            savePassword = false
        }
        setBackgroundColor(appBg)
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(this, true)
        webChromeClient = SpotiChrome(isPopup = true)
        webViewClient = object : WebViewClient() {
            /** Une fenêtre de connexion ne sort jamais de l'application. */
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val scheme = request.url?.scheme?.lowercase() ?: return false
                if (scheme == "http" || scheme == "https") return false
                val web = spotifyDeepLinkToWeb(request.url)
                if (web != null) view.loadUrl(web)
                return true
            }

            override fun onPageFinished(view: WebView, url: String?) {
                watchLoginWindowPage(view, url)
            }
        }
    }

    /**
     * Ce que devient la fenêtre de connexion, page après page.
     *
     *  · elle revient au lecteur : l'autorisation a abouti, la session est
     *    posée dans le pot commun — on la range tout de suite, on ferme la
     *    fenêtre et on recharge la vue principale ;
     *  · elle tombe sur un refus de Google : on l'explique en français, avec la
     *    seule issue qui reste (e-mail + mot de passe), au lieu de laisser
     *    l'utilisateur devant une page d'erreur en anglais.
     */
    private fun watchLoginWindowPage(view: WebView, url: String?) {
        if (url.isNullOrBlank()) return
        val host = runCatching { Uri.parse(url).host ?: "" }.getOrDefault("")
        if (host == "open.spotify.com") {
            loginReturned = true
            flushCookies(force = true)
            saveSession("retour de connexion", force = true)
            closeLoginWindow(view)
            return
        }
        if (!REFUSING_HOST.containsMatchIn(host)) return
        view.evaluateJavascript("document.body?document.body.innerText.slice(0,900):''") { raw ->
            if (REFUSAL.containsMatchIn(decodeJsString(raw))) offerPasswordLogin()
        }
    }

    /** Vrai quand une fenêtre de connexion est revenue sur le lecteur. */
    private var loginReturned = false

    /** Une seule explication par fenêtre : pas de dialogue en rafale. */
    private var passwordHelpShown = false

    /** `sp_dc` était-il déjà là quand la fenêtre s'est ouverte ? */
    private var sessionCookieBeforePopup = false

    /** Pose la fenêtre de connexion par-dessus la vue principale. */
    private fun showLoginWindow(popup: WebView) {
        val dp = resources.displayMetrics.density
        val bar = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.parseColor("#121212"))
        }
        val head = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding((16 * dp).toInt(), (10 * dp).toInt(), (6 * dp).toInt(), (10 * dp).toInt())
        }
        val title = TextView(this).apply {
            text = getString(R.string.login_window_title)
            setTextColor(Color.WHITE)
            textSize = 15f
            maxLines = 1
            ellipsize = android.text.TextUtils.TruncateAt.END
        }
        val close = TextView(this).apply {
            text = getString(R.string.close)
            setTextColor(Color.parseColor("#1ed760"))
            textSize = 15f
            setPadding((16 * dp).toInt(), (6 * dp).toInt(), (16 * dp).toInt(), (6 * dp).toInt())
            setOnClickListener { closeLoginWindow(popup) }
        }
        head.addView(title, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        head.addView(close)
        val progress = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply {
            max = 100
            visibility = View.VISIBLE
        }
        bar.addView(
            head,
            LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
        )
        bar.addView(progress, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, (3 * dp).toInt()))
        bar.addView(popup, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))

        val dialog = AlertDialog.Builder(this)
            .setView(bar)
            .setCancelable(false)
            .create()
        dialog.setOnKeyListener { _, keyCode, event ->
            if (keyCode == KeyEvent.KEYCODE_BACK && event.action == KeyEvent.ACTION_UP) {
                closeLoginWindow(popup)
                true
            } else {
                false
            }
        }
        loginReturned = false
        passwordHelpShown = false
        sessionCookieBeforePopup = hasSessionCookie()
        loginWindows.add(LoginWindow(dialog, popup, title, progress))
        dialog.window?.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        dialog.show()
        Log.i(TAG, "fenêtre de connexion ouverte (${loginWindows.size} à l'écran)")
    }

    /** Ferme une fenêtre de connexion — et range la session si elle a abouti. */
    private fun closeLoginWindow(web: WebView) {
        val entry = loginWindows.firstOrNull { it.web === web } ?: return
        loginWindows.remove(entry)
        runCatching { entry.dialog.dismiss() }
        runCatching { entry.web.destroy() }
        val loggedInNow = hasSessionCookie()
        if (loginReturned || (loggedInNow && !sessionCookieBeforePopup)) {
            sessionConfirmed = loggedInNow
            flushCookies(force = true)
            saveSession("connexion terminée", force = true)
            webView.reload()
        }
    }

    /** Tout fermer (le bouton retour de la fenêtre, ou une connexion refusée). */
    private fun closeAllLoginWindows() {
        loginWindows.map { it.web }.forEach { closeLoginWindow(it) }
    }

    /** Une fenêtre de connexion ouverte par la page, et ses repères à l'écran. */
    private class LoginWindow(
        val dialog: AlertDialog,
        val web: WebView,
        val title: TextView,
        val progress: ProgressBar
    )

    /**
     * Une chaîne renvoyée par `evaluateJavascript` est du **JSON** : les accents
     * y sont échappés (`\u00e9`). Sans les décoder, on ne reconnaîtrait pas le
     * refus de Google écrit en français.
     */
    private fun decodeJsString(raw: String?): String {
        if (raw == null) return ""
        val body = raw.trim().removePrefix("\"").removeSuffix("\"")
        return body
            .replace(Regex("""\\u([0-9a-fA-F]{4})""")) { m ->
                m.groupValues[1].toInt(16).toChar().toString()
            }
            .replace("""\n""", " ")
            .replace("\\\"", "\"")
            .replace("\\\\", "\\")
    }

    /**
     * Google refuse l'autorisation aux navigateurs embarqués : c'est une
     * politique de Google, il n'y a pas de réglage qui la désactive. Reste la
     * porte e-mail/mot de passe — on l'ouvre, et on le dit clairement.
     */
    private fun offerPasswordLogin() {
        if (passwordHelpShown) return
        passwordHelpShown = true
        runCatching {
            AlertDialog.Builder(this)
                .setTitle(R.string.login_blocked_title)
                .setMessage(R.string.login_blocked_text)
                .setPositiveButton(R.string.login_blocked_action) { _, _ ->
                    closeAllLoginWindows()
                    openLoginPage()
                }
                .setNegativeButton(R.string.close, null)
                .show()
        }
    }

    /** La porte de connexion, e-mail et mot de passe directement affichés. */
    fun openLoginPage() {
        webView.loadUrl(LOGIN_URL)
    }


    /**
     * Deux régimes, selon le mode, parce que les pages ne savent pas les mêmes
     * choses des barres système du téléphone.
     *
     *  · **Affichage mobile** : c'est la page de Spotify telle quelle, écrite
     *    pour un navigateur — où c'est le navigateur qui gère les barres. En
     *    plein écran sous la barre d'état, sa barre du haut se retrouve à moitié
     *    dessous : elle paraît trop haute, et ses boutons tombent dans la zone
     *    de la barre d'état où l'appui ne part pas (il la fait descendre). On
     *    lui donne donc une zone de rendu **à l'intérieur** des barres.
     *
     *  · **Les deux autres** interfaces dessinent leurs propres barres et
     *    réservent la place elles-mêmes (`env(safe-area-inset-*)` et les
     *    variables `--sd-safe-*-override`) : la WebView reste plein écran, on se
     *    contente de leur transmettre les valeurs mesurées.
     */
    private fun installInsetsForwarding() {
        ViewCompat.setOnApplyWindowInsetsListener(root) { _, insets ->
            val bars = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
            )
            if (uiMode == MODE_NATIVE) {
                if (root.paddingTop != bars.top || root.paddingBottom != bars.bottom ||
                    root.paddingLeft != bars.left || root.paddingRight != bars.right
                ) {
                    root.setPadding(bars.left, bars.top, bars.right, bars.bottom)
                }
                /* Consommés : le conteneur a pris la place, la page n'a plus à
                   s'en écarter elle-même (`env(safe-area-inset-*)` renverrait
                   sinon la barre d'état une seconde fois). */
                return@setOnApplyWindowInsetsListener WindowInsetsCompat.CONSUMED
            } else {
                if (root.paddingTop != 0 || root.paddingBottom != 0 ||
                    root.paddingLeft != 0 || root.paddingRight != 0
                ) {
                    root.setPadding(0, 0, 0, 0)
                }
                val scale = resources.displayMetrics.density
                injectInsets(
                    bars.top / scale,
                    bars.bottom / scale,
                    bars.left / scale,
                    bars.right / scale
                )
            }
            insets
        }
    }

    private fun injectInsets(top: Float, bottom: Float, left: Float, right: Float) {
        val js = buildString {
            append("(function(){var s=document.documentElement.style;")
            append("s.setProperty('--sd-safe-t-override','${top}px');")
            append("s.setProperty('--sd-safe-b-override','${bottom}px');")
            append("s.setProperty('--sd-safe-l-override','${left}px');")
            append("s.setProperty('--sd-safe-r-override','${right}px');")
            append("})();")
        }
        webView.evaluateJavascript(js, null)
    }

    /**
     * Optional desktop-viewport spoofing.
     *
     * The previous implementation forced `window.innerWidth/Height` to 1920×1080
     * so Spotify keeps serving its desktop layout. The current stylesheet takes
     * over that layout with CSS only and is built for a *real* viewport, so this
     * is off by default — flip it to `true` if a future web player update
     * decides to render a mobile shell from the user agent instead.
     */
    /**
     * Montre ce que la page a **réellement** sous les yeux : largeur de mise en
     * page, valeurs vues par le JavaScript (celles que l'empreinte d'origine
     * remplace), feuilles de style posées, présence des repères de la page
     * bureau, et si l'interface d'origine est en service.
     *
     * Un rendu qui diffère d'un téléphone à l'autre ne peut pas se corriger
     * autrement : cette ligne-là est le seul accès au téléphone.
     */
    fun showDiagnostic() {
        webView.evaluateJavascript(DIAGNOSTIC_JS) { raw ->
            val probe = runCatching { JSONObject("{\"v\":$raw}").getString("v") }.getOrElse { raw ?: "" }
            /* Ce que l'application a fait du dernier lien non-web : converti, ou
               avalé (donc inerte pour l'utilisateur). */
            val link = if (lastHandledLink.isEmpty()) "" else "\n\ndernier lien : $lastHandledLink"
            /* Ce que le blocage a réellement fait : combien de publicités sont
               passées en silence, et sur quel hôte. C'est la seule trace d'un
               blocage qui aurait touché autre chose que de la publicité. */
            /* Où en est la session : le cookie `sp_dc` est celui qui porte la
               connexion. S'il est là, la mise à jour suivante ne demandera rien ;
               s'il manque alors qu'une copie existe, c'est `restoreSession` qui
               travaille. */
            val names = cookieNames(WEB_BASE)
            val savedAt = prefs().getLong(KEY_SESSION_AT, 0L)
            val age = if (savedAt == 0L) "" else {
                val minutes = (System.currentTimeMillis() - savedAt) / 60_000L
                if (minutes < 90) " (il y a ${minutes} min)" else " (il y a ${minutes / 60} h)"
            }
            val backup = when {
                readSession() != null -> "oui$age"
                prefs().getString(KEY_SESSION, null) == null -> "non"
                else -> "jetée (" + (prefs().getString(KEY_SESSION_INVALID, "") ?: "") + ")"
            }
            val sessionLine = "\n\nsession : sp_dc " +
                (if (names.contains("sp_dc")) "présent" else "absent") +
                " · " + names.size + " cookies" +
                (if (names.isEmpty()) "" else " (" + names.take(6).joinToString(", ") + ")") +
                "\ncopie de secours : " + backup +
                (if (sessionConfirmed) " · page connectée" else "")
            val ad = buildString {
                append("\n\npublicités muettes : ").append(adBlocker.silenced.get())
                append(" · hôtes bloqués : ").append(adBlocker.ruleCount)
                if (adBlocker.lastSilenced.isNotEmpty()) {
                    append("\nblocage : ").append(adBlocker.lastSilenced)
                }
            }
            val text = probe + link + ad + sessionLine
            AlertDialog.Builder(this)
                .setTitle(getString(R.string.diagnostic_title))
                .setMessage(text)
                .setPositiveButton(android.R.string.ok, null)
                .setNegativeButton(R.string.session_restore) { _, _ ->
                    Toast.makeText(this, restoreSessionManually(), Toast.LENGTH_LONG).show()
                }
                .setNeutralButton(R.string.diagnostic_copy) { _, _ ->
                    val clip = getSystemService(ClipboardManager::class.java)
                    clip?.setPrimaryClip(ClipData.newPlainText("SpotiDuck", text))
                    Toast.makeText(this, R.string.diagnostic_copied, Toast.LENGTH_SHORT).show()
                }
                .show()
        }
    }

    private fun injectViewportScript() {
        if (!FAKE_DESKTOP_VIEWPORT) return
        webView.evaluateJavascript(VIEWPORT_SPOOF_JS, null)
    }

    /* ------------------------------------------------------------------ *
     * Choix de l'interface (native Spotify ⇄ couche SpotiDuck)
     * ------------------------------------------------------------------ */

    fun currentUiMode(): String = uiMode

    /**
     * L'interface d'origine a besoin du même agent que l'application d'origine :
     * c'est la page **bureau** de Spotify qu'elle habille (l'ancien script en
     * dépendait totalement : sélecteurs `#Desktop_LeftSidebar_Id`,
     * `data-testid=tracklist-row`, barre de lecture `aside`). La page web mobile
     * est le seul mode qui demande un agent Chrome Android.
     */
    private fun userAgentFor(mode: String): String =
        if (mode == MODE_NATIVE) MOBILE_UA else DESKTOP_UA

    /** Le script injecté selon le mode choisi. */
    private fun scriptFor(mode: String): String = when (mode) {
        MODE_ORIGINAL -> originalScript
        MODE_INJECT -> uiBundle
        else -> nativeScript
    }

    /**
     * Mode enregistré… **s'il a été choisi**. La 2.6.0 écrivait `native` pour
     * tout le monde au premier lancement, y compris aux installations mises à
     * jour, et sans aucun moyen d'en sortir : c'est ce qui avait imposé de
     * revenir en arrière. Seul un choix explicite de l'utilisateur est
     * désormais respecté — le mode par défaut, lui, s'applique tel quel.
     *
     * Le sélecteur d'interface (appui long) reste accessible dans les trois
     * modes, y compris celui-ci : c'est la sortie de secours si Spotify sert
     * une page inutilisable (connexion refusée, région, panne).
     */
    private fun storedUiMode(): String {
        val p = prefs()
        if (!p.getBoolean(KEY_UI_MODE_CHOSEN, false)) return MODE_DEFAULT
        /* Le mode livré par défaut a changé deux fois (2.6.0 puis 2.6.1). Les
           choix enregistrés avant cette révision-ci ne sont donc plus des
           choix : on les oublie une fois, et on repart de l'interface
           d'origine. Au-delà de cette révision, un choix explicite est
           respecté. */
        if (p.getInt(KEY_UI_MODE_REV, 0) < UI_MODE_REV) return MODE_DEFAULT
        return when (p.getString(KEY_UI_MODE, MODE_DEFAULT)) {
            MODE_INJECT -> MODE_INJECT
            MODE_NATIVE -> MODE_NATIVE
            else -> MODE_ORIGINAL
        }
    }

    /**
     * Bascule l'interface : change le user-agent, mémorise le choix et
     * recharge. Spotify décide de sa mise en page au chargement, donc un
     * rechargement est nécessaire — c'est aussi ce qui rend le changement
     * instantané pour l'utilisateur.
     */
    fun switchUiMode(mode: String) {
        val clean = when (mode) {
            MODE_INJECT -> MODE_INJECT
            MODE_NATIVE -> MODE_NATIVE
            else -> MODE_ORIGINAL
        }
        prefs().edit()
            .putString(KEY_UI_MODE, clean)
            .putBoolean(KEY_UI_MODE_CHOSEN, true)
            .putInt(KEY_UI_MODE_REV, UI_MODE_REV)
            .apply()
        if (clean == uiMode) return
        uiMode = clean
        /* Les barres système ne sont pas réservées de la même façon dans le
           mode mobile (voir `installInsetsForwarding`) : on redemande les
           insets, sinon le changement de mode garderait la marge de l'autre. */
        ViewCompat.requestApplyInsets(root)
        webView.settings.userAgentString = userAgentFor(clean)
        webView.reload()
        Toast.makeText(this, toastFor(clean), Toast.LENGTH_SHORT).show()
    }

    /**
     * **Filet de sécurité : une page qui n'affiche rien ramène à la coque.**
     *
     * La sonde montre que ce n'est pas la même chose de « la page n'a rien
     * rendu » et de « notre feuille a tout masqué » — et, sur un téléphone
     * qu'on n'a pas sous la main, rien ne les distinguait : la capture du 24/09
     * était un écran noir sous la barre du haut, sans un mot d'explication.
     *
     * Douze secondes après la fin du chargement, l'application mesure donc le
     * contenu (absent, vide, ou écrasé sur une bande étroite — la mise en page
     * d'origine tombait à 132 px de large) :
     *
     *   · une autre interface était active → on revient à la nôtre, en le
     *     disant : c'est le seul mode dont on sait qu'il affiche la page ;
     *   · c'était déjà la nôtre → on le dit aussi, et l'appui long (3 s) ouvre
     *     le choix de l'interface, donc on n'est jamais coincé.
     */
    private fun checkContentUsable() {
        if (!::webView.isInitialized) return
        webView.evaluateJavascript(CONTENT_PROBE_JS) { value ->
            val result = (value ?: "").trim().trim('"')
            if (result.startsWith("ok")) return@evaluateJavascript
            Log.w(TAG, "contenu inutilisable ($result), interface=$uiMode")
            val message =
                if (uiMode == MODE_INJECT) getString(R.string.ui_blank_hint)
                else getString(R.string.ui_blank_fallback)
            Toast.makeText(this, message, Toast.LENGTH_LONG).show()
            /* Une seule tentative par chargement : un rechargement en boucle
               serait pire que l'écran vide. */
            if (uiMode != MODE_INJECT) switchUiMode(MODE_INJECT)
        }
    }

    /**
     * Ouvre l'écran **Play Protect** du Play Store (ou, à défaut, le réglage
     * de sécurité du téléphone).
     *
     * L'application ne peut pas désactiver Play Protect : ce n'est pas une
     * permission Android mais un service de Google, qui analyse les APK
     * installés hors du Play Store et refuse parfois de les laisser passer.
     * Ce qu'on peut faire, c'est mener l'utilisateur au réglage en deux gestes
     * au lieu de le laisser le chercher dans le Play Store.
     *
     * @return `true` si un écran a été ouvert, `false` pour que l'interface
     *         affiche le chemin à suivre à la main.
     */
    fun openPlayProtect(): Boolean {
        val candidates = listOf(
            /* Play Protect, dans les services Google. */
            Intent().setComponent(
                ComponentName("com.google.android.gms", "com.google.android.gms.security.settings.VerifyAppsSettingsActivity")
            ),
            /* Le même écran, dans le Play Store. */
            Intent().setComponent(
                ComponentName("com.android.vending", "com.google.android.finsky.activities.SettingsActivity")
            ),
            Intent(Intent.ACTION_VIEW, Uri.parse("market://playprotect")),
            /* À défaut : les réglages de sécurité du téléphone, puis le Play Store. */
            Intent(Settings.ACTION_SECURITY_SETTINGS),
            packageManager.getLaunchIntentForPackage("com.android.vending")
        )
        for (candidate in candidates) {
            if (candidate == null) continue
            candidate.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            val ok = runCatching { startActivity(candidate); true }.getOrElse { false }
            if (ok) return true
        }
        return false
    }

    /** Sélecteur : appui long de 3 s (n'importe où) ou rangée des paramètres. */
    fun showUiChooser() {
        /* Le mode livré par défaut est en tête : c'est celui qu'on cherche en
           ouvrant ce sélecteur, et c'est celui que la version a choisi. */
        val labels = arrayOf(
            getString(R.string.ui_mode_inject),
            getString(R.string.ui_mode_original),
            getString(R.string.ui_mode_native)
        )
        val modes = arrayOf(MODE_INJECT, MODE_ORIGINAL, MODE_NATIVE)
        val checked = modes.indexOf(uiMode).coerceAtLeast(0)
        AlertDialog.Builder(this)
            .setTitle(getString(R.string.ui_mode_title))
            .setMessage(getString(R.string.ui_mode_note))
            .setSingleChoiceItems(labels, checked) { dialog, which ->
                switchUiMode(modes[which])
                dialog.dismiss()
            }
            /* Ce que la page a réellement sous les yeux : sans ça, un rendu qui
               diffère d'un téléphone à l'autre ne se corrige qu'à l'aveugle. */
            .setPositiveButton(R.string.diagnostic) { _, _ -> showDiagnostic() }
            .setNegativeButton(android.R.string.cancel, null)
            /* Le seul chemin vers Play Protect dans le mode d'origine (pas
               d'écran de réglages) : l'installation suivante ne sera plus
               interrompue par sa vérification. */
            .setNeutralButton(R.string.play_protect) { _, _ ->
                if (!openPlayProtect()) {
                    Toast.makeText(this, R.string.play_protect_path, Toast.LENGTH_LONG).show()
                }
            }
            .show()
    }

    /**
     * `spotify:track:4uLU6hMCjMI75M1A2tKUQC` → `https://open.spotify.com/track/…`
     * (`spotify:user:name:playlist:id` est traité à part : c'est le seul cas où
     * l'identifiant n'est pas le deuxième segment).
     */
    private fun spotifyDeepLinkToWeb(uri: android.net.Uri): String? {
        if (uri.scheme?.lowercase() != "spotify") return null
        val parts = uri.toString().removePrefix("spotify:").split(":").filter { it.isNotBlank() }
        if (parts.isEmpty()) return null
        val kind = parts[0].lowercase()
        /* Un seul segment : les onglets de la page mobile (`spotify:collection`
           est la bibliothèque). Sans cette conversion, ils ne faisaient rien du
           tout — avalés par le garde-fou ci-dessus. */
        if (parts.size == 1) {
            return when (kind) {
                "collection", "library" -> "$WEB_BASE/collection"
                "search" -> "$WEB_BASE/search"
                else -> null
            }
        }
        return when {
            kind == "user" && parts.size >= 4 && parts[2] == "playlist" ->
                "$WEB_BASE/user/${parts[1]}/playlist/${parts[3]}"
            kind == "user" -> "$WEB_BASE/user/${parts[1]}"
            kind == "search" -> "$WEB_BASE/search/${Uri.encode(parts.drop(1).joinToString(":"))}"
            kind in WEB_KINDS -> "$WEB_BASE/$kind/${parts[1]}"
            else -> null
        }
    }

    /* ------------------------------------------------------------------ *
     * La session : écrite sur le disque, et gardée en secours
     *
     * Ce qui est en jeu, c'est `sp_dc` — le cookie qui porte la connexion. La
     * WebView l'écrit **paresseusement**, et une mise à jour tue le processus :
     * ce qui n'a pas été écrit est perdu, et l'utilisateur se retrouve
     * déconnecté. On écrit donc la session nous-mêmes, à chaque occasion.
     *
     * Trois règles, apprises à la dure — chacune corrige un défaut réel :
     *
     *  1. **aucun doublon** : un cookie réinjecté alors qu'il existe déjà sous
     *     l'autre portée (hôte seul d'un côté, `.spotify.com` de l'autre) laisse
     *     deux cookies du même nom ; le serveur en lit un au hasard. C'est
     *     exactement ce qui fait répondre « e-mail ou mot de passe incorrect » à
     *     une connexion par ailleurs valable. On expire donc la ou les variantes
     *     existantes avant d'écrire la nôtre.
     *  2. **écriture synchrone** (`commit`) : une mise à jour peut tuer le
     *     processus dans la milliseconde qui suit ; `apply()` écrit « plus
     *     tard », c'est-à-dire parfois jamais.
     *  3. **une copie qui ne ramène pas la session est jetée**. Sinon elle est
     *     réinjectée à chaque lancement et empoisonne toutes les connexions
     *     suivantes — la panne devient permanente et incompréhensible.
     * ------------------------------------------------------------------ */

    /** Force l'écriture des cookies sur le disque. */
    private fun flushCookies(force: Boolean = false) {
        val now = System.currentTimeMillis()
        /* `flush()` écrit tout le magasin sur le disque : inutile de le refaire
           trois fois en une seconde (fin de page, pause, arrêt se suivent). */
        if (!force && now - lastCookieFlush < 3_000L) return
        runCatching {
            CookieManager.getInstance().flush()
            lastCookieFlush = now
        }
    }

    /** Le pot de cookies contient-il encore la session ? */
    private fun hasSessionCookie(url: String = WEB_BASE): Boolean = runCatching {
        CookieManager.getInstance().getCookie(url)?.contains("sp_dc=") == true
    }.getOrDefault(false)

    /** Les **noms** des cookies d'une adresse (jamais leurs valeurs). */
    private fun cookieNames(url: String): List<String> = runCatching {
        CookieManager.getInstance().getCookie(url)
            ?.split("; ")
            ?.mapNotNull { it.substringBefore("=").trim().ifEmpty { null } }
            ?: emptyList()
    }.getOrDefault(emptyList())

    /**
     * Écrit la session sur le disque : par adresse, en une seule fois, et de
     * façon synchrone. Rien n'est écrit si le pot ne contient pas de session —
     * une copie d'un état déconnecté ne servirait qu'à nuire.
     */
    private fun saveSession(reason: String, force: Boolean = false) {
        runCatching {
            flushCookies(force = true) // on écrit d'abord ce que la WebView garde en mémoire
            val cm = CookieManager.getInstance()
            val backup = JSONObject()
            COOKIE_URLS.forEach { url ->
                val header = cm.getCookie(url)?.takeIf { it.isNotBlank() } ?: return@forEach
                backup.put(url, header)
            }
            val json = backup.toString()
            if (!json.contains("sp_dc=")) return
            val now = System.currentTimeMillis()
            if (!force && json == sessionHash && now - lastSessionSave < 60_000L) return
            sessionHash = json
            lastSessionSave = now
            /* `commit()` : synchrone. `apply()` écrit « plus tard », et une mise à
               jour du paquet tue le processus avant ce « plus tard ». */
            prefs().edit()
                .putString(KEY_SESSION, json)
                .putLong(KEY_SESSION_AT, now)
                .putBoolean(KEY_SESSION_OK, sessionConfirmed || hasSessionCookie())
                .commit()
            Log.i(TAG, "session écrite ($reason, ${cookieNames(WEB_BASE).size} cookies sur le lecteur)")
        }
    }

    /** La copie de secours, telle qu'elle a été écrite. */
    private fun readSession(): JSONObject? = runCatching {
        val raw = prefs().getString(KEY_SESSION, null) ?: return null
        val backup = JSONObject(raw)
        if (!backup.toString().contains("sp_dc=")) return null
        if (!prefs().getBoolean(KEY_SESSION_OK, false)) return null
        /* Une copie trop vieille n'est plus une connexion : `sp_dc` vit un an,
           mais la session côté serveur, non. Passé deux mois, on ne la propose
           plus — mieux vaut une page de connexion qu'une session fantôme. */
        val at = prefs().getLong(KEY_SESSION_AT, 0L)
        if (at > 0L && System.currentTimeMillis() - at > SESSION_MAX_AGE_MS) return null
        backup
    }.getOrNull()

    /**
     * Remet la copie dans le pot de cookies.
     *
     * Appelée au démarrage (avant tout chargement de page) et, si la page se
     * révèle déconnectée, une seconde fois dans le même lancement. Jamais
     * au-dessus d'une session vivante, sauf demande explicite de l'utilisateur.
     */
    private fun restoreSession(force: Boolean = false): Boolean {
        if (!force && hasSessionCookie()) return false
        val backup = readSession() ?: return false
        var restored = 0
        runCatching {
            val cm = CookieManager.getInstance()
            COOKIE_URLS.forEach { url ->
                val header = backup.optString(url, "")
                if (header.isBlank()) return@forEach
                header.split("; ").forEach { pair ->
                    val name = pair.substringBefore("=").trim()
                    if (name.isEmpty() || !pair.contains("=")) return@forEach
                    /* Règle 1 : une seule variante de ce nom peut exister. */
                    expireCookie(cm, url, name)
                    val rules = if (name.startsWith("__Host-")) {
                        /* `__Host-` impose : pas de Domain, Path=/, Secure. */
                        "Path=/; Max-Age=31536000; Secure; SameSite=None"
                    } else {
                        "Domain=.spotify.com; Path=/; Max-Age=31536000; Secure; SameSite=None"
                    }
                    cm.setCookie(url, "$pair; $rules")
                    restored++
                }
            }
            cm.flush()
        }
        if (restored == 0) return false
        sessionRestored = true
        if (!hasSessionCookie()) {
            /* Le pot refuse ce qu'on lui donne : la copie ne vaut rien ici. */
            invalidateSession("le pot n'a pas accepté la copie")
            return false
        }
        Log.i(TAG, "session réinjectée ($restored cookies, ${if (force) "demandé" else "pot vide"})")
        return true
    }

    /** Expire les deux portées possibles d'un nom de cookie. */
    private fun expireCookie(cm: CookieManager, url: String, name: String) {
        runCatching { cm.setCookie(url, "$name=; Max-Age=0; Path=/") }
        runCatching { cm.setCookie(url, "$name=; Domain=.spotify.com; Max-Age=0; Path=/") }
    }

    /** Jette la copie : elle ne ramène pas la session, elle ne doit plus servir. */
    private fun invalidateSession(reason: String) {
        sessionHash = ""
        runCatching {
            prefs().edit()
                .remove(KEY_SESSION)
                .putBoolean(KEY_SESSION_OK, false)
                .putString(KEY_SESSION_INVALID, reason)
                .commit()
        }
        Log.w(TAG, "copie de session jetée ($reason)")
    }

    /**
     * L'état de connexion, tel que la page le constate.
     *
     * C'est la seule source fiable : le cookie dit qu'une session a existé, la
     * page dit si elle vaut encore quelque chose. Reçoit `in`, `out` (page du
     * lecteur) ou `login` (page de connexion, où être déconnecté est normal).
     */
    fun onLoginState(state: String) {
        if (state == "in") {
            sessionConfirmed = true
            sessionRestored = false
            sessionRecoveryTried = true
            saveSession("page connectée", force = true)
            return
        }
        /* `out` : lecteur sans session. `login` : page de connexion, ou accueil
           déconnecté — pour la session, c'est la même chose. */
        val wasConnected = sessionConfirmed
        sessionConfirmed = false
        when {
            /* D'abord le cas le plus important : l'utilisateur **s'est
               déconnecté**. On jette la copie, sinon elle le reconnecterait au
               prochain lancement et il n'aurait aucun moyen de rester
               déconnecté. */
            wasConnected -> invalidateSession("déconnexion demandée")
            /* On vient de réinjecter la copie et la page reste déconnectée :
               elle est morte. La garder ferait échouer les connexions
               suivantes. */
            sessionRestored -> invalidateSession("réinjectée mais la page reste déconnectée")
            /* Dernier cas : le pot a perdu la session alors qu'une copie existe.
               On la remet **une fois**, et seulement au tout début du lancement :
               plus tard, l'utilisateur a pu se déconnecter exprès, et le
               reconnecter d'office serait une trahison. */
            !sessionRecoveryTried && justLaunched() && !hasSessionCookie() && readSession() != null -> {
                sessionRecoveryTried = true
                if (restoreSession()) {
                    Toast.makeText(this, R.string.session_restored, Toast.LENGTH_SHORT).show()
                    webView.reload()
                }
            }
        }
    }

    /**
     * Les 45 premières secondes d'un lancement. Au-delà, un état déconnecté ne
     * déclenche plus rien : l'utilisateur a pu se déconnecter lui-même, et une
     * reconnexion automatique passerait pour un bug.
     */
    private fun justLaunched(): Boolean = System.currentTimeMillis() - launchAt < 45_000L

    /**
     * « Rétablir la session » : ce que fait l'utilisateur quand il se retrouve
     * déconnecté alors que la copie est là. On réinjecte, on recharge, et si
     * ça ne suffit pas la copie est jetée par `onLoginState` — jamais de
     * session fantôme qui n'en finit pas de pourrir les connexions.
     */
    fun restoreSessionManually(): String {
        if (!hasSessionCookie() && readSession() == null) return getString(R.string.session_none)
        val restored = restoreSession(force = true)
        sessionRecoveryTried = true
        if (restored) {
            webView.reload()
            return getString(R.string.session_restored)
        }
        return getString(R.string.session_none)
    }

    /* Nettoyage ciblé de la page de connexion : les cookies de session CSRF sont
       les seuls qui gênent un formulaire envoyé depuis une page restée ouverte
       (le jeton de la page ne correspond plus à celui du serveur, et la
       connexion échoue pour une raison qui n'a rien à voir avec le mot de
       passe). On ne touche **jamais** à `sp_dc` ni `sp_key`. */
    fun resetLoginPageState(): Boolean = runCatching {
        val cm = CookieManager.getInstance()
        var removed = 0
        cookieNames(LOGIN_ORIGIN).filter { it.startsWith("csrf") || it.startsWith("__Host-csrf") }
            .forEach { name ->
                expireCookie(cm, LOGIN_ORIGIN, name)
                removed++
            }
        cm.flush()
        Log.i(TAG, "état de connexion nettoyé ($removed cookies csrf)")
        removed > 0
    }.getOrDefault(false)

    /* readAsset et toastFor : emportées par erreur lors de la refonte de la
       session (elles vivaient au milieu du bloc remplacé). C'est la
       compilation qui les a réclamées — elles sont restaurées ici. */
    private fun readAsset(name: String): String =
        runCatching { assets.open(name).bufferedReader().use { it.readText() } }
            .getOrElse {
                Log.e(TAG, "assets/$name missing — run `npm run build`", it)
                ""
            }

    private fun toastFor(mode: String): Int = when (mode) {
        MODE_INJECT -> R.string.ui_mode_inject_toast
        MODE_NATIVE -> R.string.ui_mode_native_toast
        else -> R.string.ui_mode_original_toast
    }

    /** Vrai si le lecteur porte une session (cookie `sp_dc`). */
    fun sessionPresent(): Boolean = hasSessionCookie()

    /** La version installée (celle de l'APK) — pour le diagnostic. */
    fun appVersion(): String = runCatching {
        packageManager.getPackageInfo(packageName, 0).versionName ?: ""
    }.getOrDefault("")

    private fun prefs() = getSharedPreferences(PREFS, MODE_PRIVATE)

    /* ------------------------------------------------------------------ *
     * Hardware back → the UI owns the topmost panel
     * ------------------------------------------------------------------ */

    private fun installBackHandling() {
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                webView.evaluateJavascript("window.SpotiDuckUI?SpotiDuckUI.back():false") { result ->
                    val consumed = result?.trim('"') == "true"
                    if (!consumed) {
                        if (webView.canGoBack()) webView.goBack() else finish()
                    }
                }
            }
        })
    }

    /* ------------------------------------------------------------------ *
     * Playback plumbing (called by the Bridge on the main thread)
     * ------------------------------------------------------------------ */

    fun onMediaStatus(
        title: String,
        artist: String,
        cover: String,
        durationMs: Long,
        positionMs: Long,
        playing: Boolean,
        favourite: Boolean
    ) {
        if (title.isBlank()) return
        PlaybackService.update(
            this,
            PlaybackService.Status(title, artist, cover, durationMs, positionMs, playing)
        )
        // Idle shutdown only applies while nothing is playing.
        scheduleShutdown()
    }

    fun onMediaPosition(positionMs: Long) {
        PlaybackService.position(positionMs)
    }

    fun onLoggedIn() {
        /* C'est le moment où la session vaut la peine d'être écrite : juste
           après une connexion, avant que quoi que ce soit puisse la perdre. */
        flushCookies(force = true)
        sessionConfirmed = true
        saveSession("connexion détectée", force = true)
        Toast.makeText(this, R.string.logged_in, Toast.LENGTH_SHORT).show()
    }

    fun onDeferredMessage(message: String) {
        val text = when (message) {
            "unlock" -> getString(R.string.msg_unlock)
            "reload" -> getString(R.string.msg_reload)
            else -> message
        }
        if (text.isNotBlank()) Toast.makeText(this, text, Toast.LENGTH_SHORT).show()
    }

    /** Wake lock + auto-stop, driven by the layer's sleep/shutdown locks. */
    fun applyWakeState(wantSleep: Boolean, shutdownAllowed: Boolean) {
        if (wantSleep) acquireWakeLock() else releaseWakeLock()
        setShutdownArmed(shutdownAllowed)
    }

    fun setShutdownArmed(armed: Boolean) {
        shutdownArmed = armed
        scheduleShutdown()
    }

    private fun scheduleShutdown() {
        shutdownRunnable?.let { ui.removeCallbacks(it) }
        if (shutdownArmed && !bridge.playing) {
            val task = Runnable {
                if (!bridge.playing) {
                    Log.i(TAG, "idle for ${IDLE_SHUTDOWN_MS / 60000} min — stopping playback service")
                    PlaybackService.stop(this)
                }
            }
            shutdownRunnable = task
            ui.postDelayed(task, IDLE_SHUTDOWN_MS)
        }
    }

    private fun acquireWakeLock() {
        val pm = powerManager ?: return
        if (wakeLock?.isHeld == true) return
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "SpotiDuck:playback").apply {
            setReferenceCounted(false)
            runCatching { acquire(WAKE_LOCK_TIMEOUT_MS) }
        }
    }

    private fun releaseWakeLock() {
        wakeLock?.let { if (it.isHeld) runCatching { it.release() } }
        wakeLock = null
    }

    fun setKeepScreenOn(on: Boolean) {
        runOnUiThread { webView.keepScreenOn = on }
    }

    /* ------------------------------------------------------------------ *
     * Lifecycle
     * ------------------------------------------------------------------ */

    /**
     * The WebView is deliberately **not** paused with the activity: Spotify's
     * player must keep its timers and its audio running while the phone is in a
     * pocket, exactly like the previous implementation did.
     */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        val url = intent.data?.takeIf { it.host == "open.spotify.com" }?.toString() ?: return
        webView.loadUrl(url)
    }

    override fun onResume() {
        super.onResume()
        webView.evaluateJavascript("window.SpotiDuckUI&&SpotiDuckUI.sync()", null)
    }

    /**
     * Quitter l'application (ou la mettre en arrière-plan) est le dernier moment
     * sûr pour écrire les cookies : après, le processus peut être tué sans
     * préavis — c'est exactement ce qui arrive pendant une mise à jour.
     */
    override fun onPause() {
        super.onPause()
        flushCookies()
        /* Une mise à jour peut tuer le processus sans passer par `onStop` : on
           écrit la session dès que l'écran n'est plus devant. */
        saveSession("mise en arrière-plan")
    }

    override fun onStop() {
        super.onStop()
        flushCookies(force = true)
        saveSession("arrêt", force = true)
    }

    /** Le système réclame de la place : tout ce qu'on garde doit être écrit. */
    override fun onTrimMemory(level: Int) {
        super.onTrimMemory(level)
        if (level >= ComponentCallbacks2.TRIM_MEMORY_UI_HIDDEN) {
            flushCookies(force = true)
            saveSession("mémoire réclamée", force = true)
        }
    }

    override fun onDestroy() {
        flushCookies(force = true)
        saveSession("destruction", force = true)
        /* Une fenêtre de connexion qui survit à sa page laisserait un dialogue
           vide à l'écran. */
        closeAllLoginWindows()
        shutdownRunnable?.let { ui.removeCallbacks(it) }
        PlaybackService.jsExecutor = null
        releaseWakeLock()
        webView.destroy()
        super.onDestroy()
    }

    private fun askForNotificationPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return
        requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1001)
    }

    companion object {
        const val TAG = "SpotiDuck"
        const val START_URL = "https://open.spotify.com/"
        private const val WEB_BASE = "https://open.spotify.com"

        /** Interfaces proposées à l'utilisateur (voir `switchUiMode`). */
        const val MODE_ORIGINAL = "original"
        const val MODE_NATIVE = "native"
        const val MODE_INJECT = "inject"

        /**
         * Interface livrée par défaut : **la coque SpotiDuck**
         * (`MODE_INJECT`) — la nôtre, celle du projet, posée par-dessus le
         * moteur d'origine (empreinte navigateur « bureau » + page bureau),
         * donc la lecture continue de fonctionner.
         *
         * L'interface d'origine avait été livrée par défaut en 2.9.3 sur la foi
         * d'une mesure de sonde : la coque n'y laissait voir que sa barre du
         * haut. La cause a été trouvée depuis, et ce n'était pas la mise en page
         * de la coque : son **écran d'accueil** ne se retirait jamais quand la
         * page était construite dans un conteneur déjà en place (il n'était
         * réévalué que sur les mutations du `<body>`), si bien qu'il restait
         * posé par-dessus la coque et la masquait — la mesure relevait cet
         * écran, pas la coque. Corrigé et vérifié : `sd-welcome-on` disparaît
         * dès que le lecteur apparaît, la coque réapparaît.
         *
         * L'interface d'origine et la page mobile restent sélectionnables
         * (appui long de 3 s, ou rangée des paramètres), le défaut en tête.
         * L'écueil déjà payé, à ne pas repayer : la 2.6.0 avait livré un défaut
         * sans aucun moyen d'en sortir.
         */
        /**
         * Ce que l'application mesure sur la page : le contenu est-il là, et
         * utilisable ? « ok 412x667 » est la seule réponse rassurante ; tout le
         * reste déclenche le filet de sécurité ci-dessus.
         */
        private const val CONTENT_PROBE_JS = """(function(){
  var a = document.querySelector('[data-testid="home-page"], #main-view, main[data-testid], main');
  if (!a) return 'absent';
  var r = a.getBoundingClientRect();
  var t = (a.innerText || a.textContent || '').replace(/\s+/g, ' ').trim();
  var n = a.querySelectorAll('button,[role=button],a[href],img,input,iframe,svg,canvas').length;
  /* On mesure ce qui est **rendu**, pas la largeur d'une boîte : le 25/09 le
     téléphone affichait « la page n'a rien affiché » avec, dans le même
     message, « contenu 29x2756 » — la page avait 2 756 px de contenu et le test
     de largeur (200 px) la déclarait vide. Une page haute et étroite s'affiche :
     elle n'a rien d'une panne, et le repli d'interface n'a rien à corriger. */
  if (t.length < 20 && n === 0) return 'vide ' + Math.round(r.width) + 'x' + Math.round(r.height);
  return 'ok ' + Math.round(r.width) + 'x' + Math.round(r.height) + ' t' + t.length + '/e' + n +
    ' \"' + t.slice(0, 50) + '\"';
})()"""

        const val MODE_DEFAULT = MODE_INJECT

        /* Version de la préférence enregistrée : à incrémenter quand
           `MODE_DEFAULT` change — pas à chaque changement de la coque, sinon
           le choix explicite de l'utilisateur (« interface d'origine ») serait
           écrasé au moment d'une mise à jour. */
        const val UI_MODE_REV = 8

        /** Types d'URL `spotify:` convertibles en lien web. */
        private val WEB_KINDS = setOf(
            "track", "album", "playlist", "artist", "episode", "show", "concert", "prerelease"
        )

        private const val PREFS = "spotiduck"
        private const val KEY_UI_MODE = "ui_mode"

        /**
         * La copie de secours de la session : les cookies de connexion **par
         * adresse** (et non une seule chaîne aplatie, qui mélangeait les
         * portées et fabriquait des doublons).
         */
        private const val KEY_SESSION = "session"
        private const val KEY_SESSION_AT = "session_at"
        private const val KEY_SESSION_OK = "session_ok"
        private const val KEY_SESSION_INVALID = "session_invalid"

        /** Au-delà, la copie n'est plus proposée : `sp_dc` vit un an, la session non. */
        private const val SESSION_MAX_AGE_MS = 60L * 24L * 3600L * 1000L

        /**
         * La porte de connexion : la page où le formulaire e-mail + mot de passe
         * est **directement affiché**. Mesuré en CI : `accounts.spotify.com/fr/login`
         * ne demande que l'e-mail, `?allow_password=1` affiche bien les deux
         * champs (`open.spotify.com/login`, lui, répond 404).
         */
        const val LOGIN_URL = "https://accounts.spotify.com/fr/login?allow_password=1"
        private const val LOGIN_ORIGIN = "https://accounts.spotify.com"

        /** Les hôtes dont on sauvegarde les cookies : le lecteur et la connexion. */
        private val COOKIE_URLS = listOf(
            "https://open.spotify.com",
            "https://accounts.spotify.com",
            "https://api.spotify.com"
        )

        /** Les adresses dont la session compte : le lecteur et la connexion. */
        private val SPOTIFY_SESSION_HOST = Regex("open\\.spotify\\.com|accounts\\.spotify\\.com")

        /** Les domaines qui peuvent refuser une autorisation dans une WebView. */
        private val REFUSING_HOST = Regex("google\\.com|apple\\.com|facebook\\.com", RegexOption.IGNORE_CASE)

        /** Les mots d'un refus d'autorisation, dans les deux langues servies. */
        private val REFUSAL = Regex(
            "disallowed_useragent|doesn't comply|does not comply|not permitted to make|" +
                "Accès bloqué|Access blocked|ne respecte pas|n'est pas conforme",
            RegexOption.IGNORE_CASE
        )
        private const val KEY_UI_MODE_CHOSEN = "ui_mode_chosen"
        private const val KEY_UI_MODE_REV = "ui_mode_rev"

        /** Chrome on Windows: what open.spotify.com checks to serve the desktop app. */
        private const val DESKTOP_UA =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
                "Chrome/124.0.0.0 Safari/537.36"

        /**
         * Chrome on Android: the same page is served the *mobile* web player,
         * which is Spotify's own mobile interface (bottom bar, compact lists).
         */
        private const val MOBILE_UA =
            "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) " +
                "Chrome/150.0.0.0 Mobile Safari/537.36"

        private const val FAKE_DESKTOP_VIEWPORT = false
        private const val IDLE_SHUTDOWN_MS = 15L * 60L * 1000L
        private const val WAKE_LOCK_TIMEOUT_MS = 6L * 60L * 60L * 1000L

        /**
         * Sonde de diagnostic : une ligne par constat, lisible au téléphone.
         * `evaluateJavascript` renvoie une chaîne JSON, donc entre guillemets
         * (décodée par `showDiagnostic`).
         */
        private const val DIAGNOSTIC_JS = """
          (function(){
            var q = function (s) { try { return document.querySelectorAll(s).length } catch (e) { return -1 } };
            var de = document.documentElement;
            /* Ce que la page croit devoir réserver pour la barre d'état : 0 veut
               dire que la fenêtre est déjà à l'intérieur des barres. */
            var safeTop = function () {
              var d = document.createElement("div");
              d.style.cssText = "position:fixed;top:0;left:0;width:0;height:env(safe-area-inset-top,0px)";
              (document.body || de).appendChild(d);
              var h = d.offsetHeight || 0;
              if (d.parentNode) d.parentNode.removeChild(d);
              return h;
            };
            /* Ce qui se trouve sous les six premiers pixels : si c'est le
               bandeau du haut, il est bien à l'écran ; s'il est absent, la page
               commence ailleurs. */
            var topThing = function () {
              var e = document.elementFromPoint(Math.round(de.clientWidth / 2), 6);
              if (!e) return "aucun";
              var c = typeof e.className === "string" ? e.className : "";
              return e.tagName.toLowerCase() + (c ? "." + c.split(" ")[0] : "");
            };
            /* Les barres de navigation : leurs entrées, leur destination, et
               si elles sont visibles. C'est ce que la sonde a servi à établir
               sur le bouton Bibliothèque — un `<a href="spotify:collection">`
               qu'aucune WebView ne sait ouvrir. */
            var navLine = function () {
              var navs = document.querySelectorAll("nav,[role='navigation']");
              if (!navs.length) return "aucune";
              var out = [];
              for (var i = 0; i < navs.length && i < 2; i++) {
                var items = navs[i].querySelectorAll("a,button,[role='button']");
                var parts = [];
                for (var j = 0; j < items.length && j < 6; j++) {
                  var t = (items[j].textContent || items[j].getAttribute("aria-label") || "")
                    .replace(/\s+/g, " ").trim().slice(0, 14);
                  var h = items[j].getAttribute("href") || "-";
                  var vis = items[j].getClientRects().length ? "" : "(masque)";
                  parts.push(t + "|" + h + vis);
                }
                out.push(parts.join(" , "));
              }
              return out.join(" ; ");
            };
            /* Encarts d'abonnement encore présents, marqués ou non. */
            var premiumLine = function (marked) {
              if (marked) return q("[data-sd-premium='1']");
              var els = document.querySelectorAll("a,button,[role='button'],[data-testid]");
              var n = 0;
              for (var i = 0; i < els.length && i < 900; i++) {
                var t = (els[i].textContent || "").replace(/\s+/g, " ").trim();
                if (t.length <= 160 && /premium|abonn|souscri|upgrade/i.test(t)) n++;
              }
              return n;
            };
            /* Le dernier onglet de la barre du bas touché : ce qu'il désignait,
               et ce que la page en a fait. Un `after` vide veut dire que le
               script de veille s'apprêtait à forcer la navigation. */
            var navTap = function () {
              var t = window.__sdNavTap;
              if (!t) return "aucun";
              return (t.label || "?") + " | " + (t.href || "-") + " -> " +
                (t.route || "sans adresse") + " | avant " + (t.before || "?") +
                " apres " + (t.after || "en cours") + (t.forced ? " -> force " + t.forced : "");
            };
            /* Invites « ouvrir dans l'application » encore présentes, marquées ou
               non : c'est le seul moyen de savoir si Spotify les repose. */
            var appPrompts = function (marked) {
              if (marked) return q("[data-sd-appprompt='1']");
              var els = document.querySelectorAll("a,button,[role='button'],[data-testid]");
              var n = 0;
              for (var i = 0; i < els.length && i < 900; i++) {
                var t = (els[i].textContent || "").replace(/\s+/g, " ").trim();
                if (t.length <= 160 && /ouvrir dans l'application|ouvrir l'application|open (the )?app/i.test(t)) n++;
              }
              return n;
            };
            return [
              "vue " + de.clientWidth + "x" + de.clientHeight + " px CSS",
              "fenetre " + window.innerWidth + "x" + window.innerHeight + " densite " + window.devicePixelRatio,
              "ecran " + screen.width + "x" + screen.height,
              "feuilles " + q("style"),
              "barre haut " + q("#Desktop_LeftSidebar_Id") + " / lecteur bas " + q("aside[data-testid=now-playing-bar]") + " / accueil " + q("section[data-testid=home-page]"),
              "rangees " + q("div[data-testid=grid-container]") + " / lignes " + q("div[data-testid=tracklist-row]") + " / navigation " + q("#global-nav-bar"),
              "haut de page " + topThing() + " / barre d'etat reservee par la page " + safeTop() + " px",
              "invites ouvrir-dans-l-application " + appPrompts(false) + " / retirees " + appPrompts(true),
              "invitations premium " + premiumLine(false) + " / retirees " + premiumLine(true),
              "fenetres d'offre " + q("[data-sd-premium-dialog='1']"),
              "dernier onglet " + navTap(),
              "navigation " + navLine(),
              "interface d'origine " + (typeof window.firstFuck === "function" ? "chargee" : "absente"),
              "adresse " + location.pathname
            ].join("\n");
          })()
        """

        /**
         * Force un `<meta name="viewport" content="width=device-width…">`.
         *
         * Mesuré en CI (`inspect-page.yml`) : open.spotify.com en déclare un,
         * pour l'agent bureau (`width=device-width, initial-scale=1,
         * maximum-scale=1`) comme pour l'agent Android. Ce script est donc un
         * filet, pas le correctif de l'affichage : il garantit à la couche une
         * mise en page à la largeur réelle de l'écran si la page cessait d'en
         * déclarer (sans ce meta, une WebView se donne 980 px de large — media
         * queries, unités `vw` et tailles de police visent alors un écran trois
         * fois trop large, et tout paraît énorme et rogné). Il vérifie dix fois
         * (la page se construit en plusieurs fois) et ne touche à rien d'autre.
         */
        private const val VIEWPORT_META_JS = """
            (function(){
              if (window.__sdViewportMeta) return;
              window.__sdViewportMeta = true;
              var CONTENT = "width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover";
              function ensure(){
                var root = document.head || document.documentElement;
                if (!root) return false;
                var metas = document.querySelectorAll("meta[name='viewport']");
                var meta = metas[0];
                if (!meta) {
                  meta = document.createElement("meta");
                  meta.setAttribute("name", "viewport");
                  (document.head || document.documentElement).appendChild(meta);
                }
                for (var i = 1; i < metas.length; i++) {
                  if (metas[i].parentNode) metas[i].parentNode.removeChild(metas[i]);
                }
                if (meta.getAttribute("content") !== CONTENT) meta.setAttribute("content", CONTENT);
                return true;
              }
              ensure();
              var n = 0;
              var t = window.setInterval(function(){
                ensure();
                if (++n > 10) window.clearInterval(t);
              }, 200);
            })();
        """

        private const val VIEWPORT_SPOOF_JS = """
            (function(){
              if (window.__sdViewport) return;
              window.__sdViewport = true;
              var w = 1920, h = 1080;
              var def = function(prop, value){
                try { Object.defineProperty(window, prop, { get: function(){ return value; }, configurable: true }); }
                catch (e) {}
              };
              def('innerWidth', w); def('innerHeight', h);
              def('outerWidth', w); def('outerHeight', h);
              try {
                Object.defineProperty(window.screen, 'width', { get: function(){ return w; }, configurable: true });
                Object.defineProperty(window.screen, 'height', { get: function(){ return h; }, configurable: true });
              } catch (e) {}
            })();
        """
    }
}
