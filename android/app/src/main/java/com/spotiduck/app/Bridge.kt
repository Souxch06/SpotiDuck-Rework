package com.spotiduck.app

import android.util.Log
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.lang.ref.WeakReference
import java.net.HttpURLConnection
import java.net.URL
import java.nio.charset.StandardCharsets
import java.util.Locale

/**
 * The `AndBridge` object injected into the WebView.
 *
 * The interface name is **not** hard-coded on the JavaScript side (the runtime
 * feature-detects it), so only the methods below matter:
 *
 *   recMediaStatus(json) · recMediaPosition(ms) · playLoaded() · cssInjected()
 *   manageTShut(bool) · manageTSleep(bool) · wakeUp() · wakeOff() · isWoke()
 *   loginDetected() · deferMessage(string) · uiMode() · setUiMode(string)
 *   showUiChooser() · nFetch(url, options)
 *
 * Every method is called on a background thread by the WebView, so anything
 * touching the UI is posted to the main thread.
 */
class Bridge(activity: MainActivity) {

    private val activity = WeakReference(activity)



    /** Last known playback state, used by the notification and by `isWoke()`. */
    @Volatile
    var playing: Boolean = false
        private set

    @Volatile
    private var woke: Boolean = false

    /** `manageTSleep(true)` = the sleep timer is armed (keep the CPU awake). */
    @Volatile
    private var sleepLock: Boolean = false

    /** `manageTShut(true)` = shutting the app down when idle is allowed. */
    @Volatile
    private var shutdownArmed: Boolean = true

    @JavascriptInterface
    fun recMediaStatus(json: String?) {
        val data = try {
            JSONObject(json ?: return)
        } catch (e: Exception) {
            Log.w(TAG, "recMediaStatus: invalid payload", e)
            return
        }
        playing = data.optBoolean("playing", false)
        val act = activity.get() ?: return
        act.runOnUiThread {
            act.onMediaStatus(
                title = data.optString("track"),
                artist = data.optString("artist"),
                cover = data.optString("cover"),
                durationMs = data.optLong("duration", 0L),
                positionMs = data.optLong("position", 0L),
                playing = playing,
                favourite = data.optBoolean("fav", false)
            )
        }
    }

    @JavascriptInterface
    fun recMediaPosition(ms: Int) {
        val act = activity.get() ?: return
        act.runOnUiThread { act.onMediaPosition(ms.toLong()) }
    }

    @JavascriptInterface
    fun playLoaded() {
        Log.i(TAG, "player loaded")
    }

    @JavascriptInterface
    fun cssInjected() {
        Log.i(TAG, "UI injected")
    }

    @JavascriptInterface
    fun loginDetected() {
        activity.get()?.let { act ->
            act.runOnUiThread { act.onLoggedIn() }
        }
    }

    /**
     * L'état de connexion **constaté par la page** : `in` (connecté), `out`
     * (déconnecté) ou `login` (page de connexion, où être déconnecté est
     * normal). C'est la seule source fiable : le cookie dit qu'une session a
     * existé, la page dit si elle vaut encore quelque chose.
     *
     * Sert à deux choses : ranger la session dès qu'elle est valable, et jeter
     * une copie de secours qui ne ramène rien au lieu de la réinjecter à chaque
     * lancement.
     */
    @JavascriptInterface
    fun loginState(state: String?) {
        val act = activity.get() ?: return
        val clean = when (state) {
            "in" -> "in"
            "out" -> "out"
            "login" -> "login"
            else -> return
        }
        act.runOnUiThread { act.onLoginState(clean) }
    }

    /** Ouvre la page de connexion e-mail + mot de passe, sans détour. */
    @JavascriptInterface
    fun openLogin() {
        val act = activity.get() ?: return
        act.runOnUiThread { act.openLoginPage() }
    }

    /**
     * Nettoie l'état de la page de connexion : les cookies CSRF d'`accounts.spotify.com`
     * uniquement — jamais `sp_dc` ni `sp_key`. C'est ce qu'il faut quand le
     * formulaire répond « e-mail ou mot de passe incorrect » alors que les
     * identifiants sont bons : le jeton de la page ne correspond plus.
     */
    @JavascriptInterface
    fun resetLoginState(): Boolean = activity.get()?.resetLoginPageState() ?: false

    /**
     * Sleep timer / shutdown locks. The UI arms them on playback changes:
     * playing → `manageTSleep(true)` + `manageTShut(false)`, paused → the
     * inverse. Keeping the CPU awake while a track plays is what allows the
     * WebView to keep decoding audio with the screen off.
     */
    @JavascriptInterface
    fun manageTSleep(wantSleep: Boolean) {
        sleepLock = wantSleep
        activity.get()?.let { act ->
            act.runOnUiThread { act.applyWakeState(wantSleep, shutdownArmed) }
        }
    }

    @JavascriptInterface
    fun manageTShut(wantShut: Boolean) {
        shutdownArmed = wantShut
        activity.get()?.let { act ->
            act.runOnUiThread { act.setShutdownArmed(wantShut) }
        }
    }

    /** Screen on (used while a video/podcast plays in the background). */
    @JavascriptInterface
    fun wakeUp() {
        woke = true
        activity.get()?.let { act -> act.runOnUiThread { act.setKeepScreenOn(true) } }
    }

    @JavascriptInterface
    fun wakeOff() {
        woke = false
        activity.get()?.let { act -> act.runOnUiThread { act.setKeepScreenOn(false) } }
    }

    @JavascriptInterface
    fun isWoke(): Boolean = woke

    /**
     * Messages the injected layer wants to surface to the user. Same two
     * messages as the previous implementation, with the same meaning:
     *  - `unlock` → the player was stuck and the layer skipped a track
     *  - `reload` → the session died and the layer is reloading
     */
    @JavascriptInterface
    fun deferMessage(message: String?) {
        val act = activity.get() ?: return
        act.runOnUiThread { act.onDeferredMessage(message ?: "") }
    }

    /**
     * Interface choisie — `native` = l'interface mobile de Spotify elle-même,
     * `inject` = la couche SpotiDuck. Le user-agent et le script injecté en
     * dépendent, donc le changement recharge la page.
     */
    /**
     * Requête HTTP pour l'interface d'origine — **reprise de l'implémentation
     * de l'application d'origine** (`WebService.nFetch`) : mêmes en-têtes, même
     * forme de réponse, mêmes cookies.
     *
     * L'interface d'origine ne passe pas par `fetch()` du navigateur pour les
     * appels de lecture (connect-state) : la WebView est bloquée sur ces
     * requêtes, donc c'est l'application qui les fait, avec ses propres cookies
     * Spotify, et renvoie le résultat au script sous la forme
     * `{"status":200,"body":"…","headers":{…}}` (et `status: 0` en cas d'échec).
     *
     * Appelée depuis le thread JavaScript de la WebView : la requête bloquante
     * n'a donc rien à faire du thread principal.
     */
    @JavascriptInterface
    fun nFetch(url: String, optionsJson: String?): String {
        val result = JSONObject()
        var connection: HttpURLConnection? = null
        return try {
            val options = JSONObject(optionsJson ?: "{}")
            val method = if (options.has("method")) options.getString("method") else "GET"
            val body = if (!options.has("body") || options.isNull("body")) null else options.getString("body")
            val headers = if (!options.has("headers") || options.isNull("headers")) JSONObject() else options.getJSONObject("headers")

            val url2 = URL(url)
            connection = (url2.openConnection() as HttpURLConnection).apply {
                requestMethod = method
                connectTimeout = 10_000
                readTimeout = 10_000
            }

            /* Ces en-têtes-là ne sont pas recopiés tels quels : ils sont
               régénérés plus bas pour rester cohérents (c'est ce que fait
               l'application d'origine). */
            val skip = setOf(
                "x-requested-with",
                "sec-ch-ua-full-version-list",
                "sec-ch-ua-platform-version",
                "sec-ch-ua-arch",
                "sec-ch-ua-bitness",
                "sec-ch-ua-model"
            )
            val keys = headers.keys()
            while (keys.hasNext()) {
                val name = keys.next()
                if (!skip.contains(name.lowercase(Locale.ROOT))) {
                    connection.setRequestProperty(name, headers.getString(name))
                }
            }
            connection.setRequestProperty("User-Agent", DESKTOP_UA)
            connection.setRequestProperty("sec-ch-ua-platform", "\"Windows\"")
            connection.setRequestProperty("sec-ch-ua-mobile", "?0")
            connection.setRequestProperty(
                "sec-ch-ua",
                "\"Not;A=Brand\";v=\"8\", \"Chromium\";v=\"150\", \"Google Chrome\";v=\"150\""
            )
            CookieManager.getInstance().getCookie(url)?.let { connection.setRequestProperty("Cookie", it) }

            if (!body.isNullOrEmpty()) {
                connection.doOutput = true
                connection.outputStream.use { it.write(body.toByteArray(StandardCharsets.UTF_8)) }
            }

            val status = connection.responseCode
            val headerFields = connection.headerFields

            /* Les cookies renvoyés par Spotify doivent revenir dans la WebView,
               sinon la session se désynchronise au bout de quelques minutes. */
            headerFields?.forEach { (name, values) ->
                if (name != null && name.equals("Set-Cookie", ignoreCase = true)) {
                    values?.forEach { CookieManager.getInstance().setCookie(url, it) }
                }
            }
            CookieManager.getInstance().flush()

            val stream: InputStream? = if (status >= 400) connection.errorStream else connection.inputStream
            result.put("status", status)
            result.put("body", readAll(stream))
            val outHeaders = JSONObject()
            headerFields?.forEach { (name, values) ->
                if (name != null && !values.isNullOrEmpty()) outHeaders.put(name, values[0])
            }
            result.put("headers", outHeaders)
            connection.disconnect()
            result.toString()
        } catch (e: Exception) {
            Log.w(TAG, "nFetch failed: ${e.message}")
            runCatching {
                result.put("status", 0)
                result.put("body", e.toString())
                result.put("headers", JSONObject())
            }
            connection?.disconnect()
            result.toString()
        }
    }

    private fun readAll(stream: InputStream?): String {
        if (stream == null) return ""
        return stream.use { input ->
            val out = ByteArrayOutputStream()
            val buffer = ByteArray(8192)
            var read = input.read(buffer)
            while (read > 0) {
                out.write(buffer, 0, read)
                read = input.read(buffer)
            }
            out.toString(StandardCharsets.UTF_8.name())
        }
    }

    @JavascriptInterface
    fun uiMode(): String = activity.get()?.currentUiMode() ?: MainActivity.MODE_ORIGINAL

    @JavascriptInterface
    fun setUiMode(mode: String?) {
        val act = activity.get() ?: return
        act.runOnUiThread { act.switchUiMode(mode ?: MainActivity.MODE_NATIVE) }
    }

    /**
     * Mène à l'écran Play Protect : c'est là que se désactive l'analyse qui
     * interrompt l'installation des APK venus d'ailleurs. L'application ne peut
     * pas la désactiver elle-même (service Google, pas une permission).
     *
     * @return `true` si un écran a pu être ouvert.
     */
    @JavascriptInterface
    fun openPlayProtect(): Boolean = activity.get()?.openPlayProtect() ?: false

    /** Ouvre le sélecteur (appui long de 3 s ou rangée des paramètres). */
    @JavascriptInterface
    fun showUiChooser() {
        val act = activity.get() ?: return
        act.runOnUiThread { act.showUiChooser() }
    }

    companion object {
        const val TAG = "SpotiDuck"

        /** Même agent que la WebView : la requête doit passer pour la même session. */
        const val DESKTOP_UA =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36"
    }
}
