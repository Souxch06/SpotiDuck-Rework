package com.spotiduck.app

import android.Manifest
import android.annotation.SuppressLint
import android.content.ClipData
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
import android.os.PowerManager
import android.provider.Settings
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
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

    private lateinit var webView: WebView
    private lateinit var adBlocker: AdBlocker
    private val bridge = Bridge(this)
    private val ui = Handler(Looper.getMainLooper())

    private var uiBundle: String = ""
    private var nativeScript: String = ""
    private var originalScript: String = ""
    private var originalFingerprint: String = ""
    private var uiMode: String = MODE_DEFAULT
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

        uiMode = storedUiMode()
        powerManager = getSystemService(POWER_SERVICE) as? PowerManager
        adBlocker = AdBlocker(this).also { it.loadAsync() }
        uiBundle = readAsset("spotiduck-ui.js")
        originalScript = readAsset("spotiduck-original.js")
        originalFingerprint = readAsset("original-fingerprint.js")

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
                setSupportMultipleWindows(false) // target="_blank" stays in-app
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
                if (uiMode == MODE_ORIGINAL) showUiChooser()
                true
            }
            overScrollMode = View.OVER_SCROLL_NEVER // pas de halo bleu en bout de liste
        }
        webView.addJavascriptInterface(bridge, "AndBridge")
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true)

        setContentView(webView)
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

            /** Ad blocking: the same hosts list the project publishes. */
            override fun shouldInterceptRequest(
                view: WebView,
                request: WebResourceRequest
            ): WebResourceResponse? {
                val url = request.url?.toString() ?: return null
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
                if (web != null) view.loadUrl(web)
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
                if (uiMode != MODE_ORIGINAL) view.evaluateJavascript(VIEWPORT_META_JS, null)
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

    private fun installWebChromeClient() {
        webView.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(msg: android.webkit.ConsoleMessage): Boolean {
                Log.d("SpotiDuckJS", "${msg.message()} (${msg.sourceId()}:${msg.lineNumber()})")
                return true
            }
        }
    }

    /**
     * Android 15+ draws edge to edge: the system bars overlap the WebView. The
     * injected stylesheet already knows how to reserve that space
     * (`env(safe-area-inset-*)` + the `--sd-safe-*-override` hooks), so we
     * forward the real insets to it instead of guessing.
     */
    private fun installInsetsForwarding() {
        ViewCompat.setOnApplyWindowInsetsListener(webView) { _, insets ->
            val bars = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
            )
            val scale = resources.displayMetrics.density
            /* La WebView reste plein écran et c'est la page qui réserve la place
               des barres système (`--sd-safe-*-override`). Réduire la zone de
               rendu par du padding rognait le haut de la page sur certaines
               versions de WebView. */
            webView.setPadding(0, 0, 0, 0)
            injectInsets(bars.top / scale, bars.bottom / scale, bars.left / scale, bars.right / scale)
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
            val text = runCatching { JSONObject("{\"v\":$raw}").getString("v") }.getOrElse { raw ?: "" }
            AlertDialog.Builder(this)
                .setTitle(getString(R.string.diagnostic_title))
                .setMessage(text)
                .setPositiveButton(android.R.string.ok, null)
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
        webView.settings.userAgentString = userAgentFor(clean)
        webView.reload()
        Toast.makeText(this, toastFor(clean), Toast.LENGTH_SHORT).show()
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
            getString(R.string.ui_mode_native),
            getString(R.string.ui_mode_original),
            getString(R.string.ui_mode_inject)
        )
        val modes = arrayOf(MODE_NATIVE, MODE_ORIGINAL, MODE_INJECT)
        val checked = modes.indexOf(uiMode).coerceAtLeast(0)
        AlertDialog.Builder(this)
            .setTitle(getString(R.string.ui_mode_title))
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
        val parts = uri.toString().removePrefix("spotify:").split(":")
        if (parts.size < 2 || parts[0].isBlank() || parts[1].isBlank()) return null
        return when {
            parts[0] == "user" && parts.size >= 4 && parts[2] == "playlist" ->
                "https://open.spotify.com/user/${parts[1]}/playlist/${parts[3]}"
            parts[0] in WEB_KINDS -> "https://open.spotify.com/${parts[0]}/${parts[1]}"
            else -> null
        }
    }

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

    override fun onDestroy() {
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

        /** Interfaces proposées à l'utilisateur (voir `switchUiMode`). */
        const val MODE_ORIGINAL = "original"
        const val MODE_NATIVE = "native"
        const val MODE_INJECT = "inject"

        /**
         * Interface livrée par défaut : la **page web mobile de Spotify** — la
         * page que Spotify sert lui-même à un téléphone. C'est l'affichage
         * mobile demandé : navigation basse, listes compactes, lecteur plein
         * écran, rien de redessiné ici.
         *
         * Deux écueils déjà payés, à ne pas repayer : la 2.6.0 l'avait livrée
         * par défaut puis on l'a retirée, parce que cette version-là n'offrait
         * aucun moyen d'en sortir. Aujourd'hui le sélecteur (appui long) est
         * toujours là, dans tous les modes. Le second — la connexion — dépend
         * de ce que Spotify sert à un agent mobile : voir la note au-dessus de
         * `storedUiMode`.
         */
        const val MODE_DEFAULT = MODE_NATIVE

        /** Incrémenter à chaque fois que `MODE_DEFAULT` change. */
        const val UI_MODE_REV = 4

        /** Types d'URL `spotify:` convertibles en lien web. */
        private val WEB_KINDS = setOf(
            "track", "album", "playlist", "artist", "episode", "show", "concert", "prerelease"
        )

        private const val PREFS = "spotiduck"
        private const val KEY_UI_MODE = "ui_mode"
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
                "Chrome/124.0.0.0 Mobile Safari/537.36"

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
            return [
              "vue " + de.clientWidth + "x" + de.clientHeight + " px CSS",
              "fenetre " + window.innerWidth + "x" + window.innerHeight + " densite " + window.devicePixelRatio,
              "ecran " + screen.width + "x" + screen.height,
              "feuilles " + q("style"),
              "barre haut " + q("#Desktop_LeftSidebar_Id") + " / lecteur bas " + q("aside[data-testid=now-playing-bar]") + " / accueil " + q("section[data-testid=home-page]"),
              "rangees " + q("div[data-testid=grid-container]") + " / lignes " + q("div[data-testid=tracklist-row]") + " / navigation " + q("#global-nav-bar"),
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
