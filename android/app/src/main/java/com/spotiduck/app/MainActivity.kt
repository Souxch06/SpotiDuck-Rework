package com.spotiduck.app

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
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

/**
 * SpotiDuck — WebView shell around the Spotify web player.
 *
 * Responsibilities (and nothing else):
 *  1. serve one of the two interfaces the user can pick between:
 *       • `native` (default) — Chrome-Android user agent, so open.spotify.com
 *         serves **its own mobile interface** (bottom navigation bar, compact
 *         rows, full-screen player). Nothing is redrawn; the app only hides the
 *         browser banners and mirrors the metadata to the notification.
 *       • `inject` — desktop user agent plus `assets/spotiduck-ui.js`, the
 *         SpotiDuck layer (tab bar, queue, settings, offline handling…).
 *     The mode is a long-press (3 s anywhere on the page) away, so switching
 *     costs nothing; it is stored in SharedPreferences and survives restarts;
 *  2. inject `assets/spotiduck-ui.js` after every page load (it is a single
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
    private var uiMode: String = MODE_NATIVE
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

        uiMode = prefs().getString(KEY_UI_MODE, MODE_NATIVE) ?: MODE_NATIVE
        powerManager = getSystemService(POWER_SERVICE) as? PowerManager
        adBlocker = AdBlocker(this).also { it.loadAsync() }
        uiBundle = runCatching { assets.open("spotiduck-ui.js").bufferedReader().use { it.readText() } }
            .getOrElse {
                Log.e(TAG, "assets/spotiduck-ui.js missing — run `node tools/build.mjs`", it)
                ""
            }

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
                userAgentString = if (uiMode == MODE_INJECT) DESKTOP_UA else MOBILE_UA
                loadWithOverviewMode = false
                useWideViewPort = true
                builtInZoomControls = false
                displayZoomControls = false
                setSupportZoom(false)
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
               le script de la page continue de recevoir ses évènements. */
            setOnLongClickListener { true }
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
             * `spotify:`, `intent:`, `market:`, `mailto:`… sortent de
             * l'application ou affichent une page d'erreur Chrome — les deux
             * apparaissent à l'utilisateur comme un pop-up. Tout ce qui n'est pas
             * du web reste donc dans la page (donc : rien ne se passe), et la
             * navigation http(s) continue normalement.
             */
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val scheme = request.url?.scheme?.lowercase() ?: return false
                return scheme != "http" && scheme != "https"
            }

            override fun onPageStarted(view: WebView, url: String?, favicon: android.graphics.Bitmap?) {
                injectViewportScript()
            }

            /**
             * The layer is a plain script, so it can be injected the same way
             * the previous implementation did it. Re-injecting on every page
             * load is harmless: the runtime is idempotent (`window.SpotiDuckUI`
             * already present → it returns immediately).
             */
            override fun onPageFinished(view: WebView, url: String?) {
                view.evaluateJavascript("window.__sdBridgeReady=true;", null)
                val script = if (uiMode == MODE_INJECT) uiBundle else nativeScript
                if (script.isNotEmpty()) view.evaluateJavascript(script, null)
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
            if (uiMode == MODE_INJECT) {
                webView.setPadding(0, 0, 0, 0)
                injectInsets(bars.top / scale, bars.bottom / scale, bars.left / scale, bars.right / scale)
            } else {
                /* Mode natif : la page ne connaît pas nos variables, donc on
                   retire la hauteur des barres système de la zone de rendu —
                   rien ne passe sous la barre d'état ni sous celle de gestes. */
                webView.setPadding(bars.left, bars.top, bars.right, bars.bottom)
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
    private fun injectViewportScript() {
        if (!FAKE_DESKTOP_VIEWPORT) return
        webView.evaluateJavascript(VIEWPORT_SPOOF_JS, null)
    }

    /* ------------------------------------------------------------------ *
     * Choix de l'interface (native Spotify ⇄ couche SpotiDuck)
     * ------------------------------------------------------------------ */

    fun currentUiMode(): String = uiMode

    /**
     * Bascule l'interface : change le user-agent, mémorise le choix et
     * recharge. Spotify décide de sa mise en page au chargement, donc un
     * rechargement est nécessaire — c'est aussi ce qui rend le changement
     * instantané pour l'utilisateur.
     */
    fun switchUiMode(mode: String) {
        val clean = if (mode == MODE_INJECT) MODE_INJECT else MODE_NATIVE
        prefs().edit().putString(KEY_UI_MODE, clean).apply()
        if (clean == uiMode) return
        uiMode = clean
        webView.settings.userAgentString = if (clean == MODE_INJECT) DESKTOP_UA else MOBILE_UA
        webView.reload()
        Toast.makeText(
            this,
            if (clean == MODE_INJECT) R.string.ui_mode_inject_toast else R.string.ui_mode_native_toast,
            Toast.LENGTH_SHORT
        ).show()
    }

    /** Sélecteur : appui long de 3 s (n'importe où) ou rangée des paramètres. */
    fun showUiChooser() {
        val labels = arrayOf(getString(R.string.ui_mode_native), getString(R.string.ui_mode_inject))
        val modes = arrayOf(MODE_NATIVE, MODE_INJECT)
        val checked = modes.indexOf(uiMode).coerceAtLeast(0)
        AlertDialog.Builder(this)
            .setTitle(getString(R.string.ui_mode_title))
            .setSingleChoiceItems(labels, checked) { dialog, which ->
                switchUiMode(modes[which])
                dialog.dismiss()
            }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
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
        const val MODE_NATIVE = "native"
        const val MODE_INJECT = "inject"
        private const val PREFS = "spotiduck"
        private const val KEY_UI_MODE = "ui_mode"

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
