package com.spotiduck.app

import android.content.Context
import android.webkit.CookieManager
import android.webkit.WebResourceResponse
import java.io.ByteArrayInputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.atomic.AtomicInteger

/**
 * Blocage des publicités et des traqueurs, à deux étages.
 *
 * **1. Les hôtes.** La liste `adblock_hosts.txt` que ce dépôt publie (format
 * hôtes : `0.0.0.0 ads.example.com`, `#` pour les commentaires) est lue une fois,
 * sur un fil d'arrière-plan, puis comparée à l'**hôte** de chaque requête de la
 * WebView — sous-ressources comprises. Ces requêtes reçoivent une réponse vide :
 * elles n'aboutissent jamais.
 *
 * **2. Les publicités audio.** Spotify insère ses annonces **dans le flux de
 * lecture** : le lecteur attend un fichier audio, et lui répondre « rien » le
 * laisse devant un fichier manquant. L'application d'origine avait la solution —
 * elle servait **du silence** à la place (`assets/silent.mp3`, remplacé à la
 * volée après avoir regardé le type de contenu). C'est repris ici, avec la même
 * prudence qu'elle : on ne remplace que si l'adresse ressemble à une publicité
 * **et** si la réponse est bien de l'audio (`audio/mpeg`) — la musique n'est pas
 * servie dans ce format, et `podz-content` / `gew4-spclient` ne sont jamais
 * touchés.
 *
 * Ce n'est pas un déblocage de compte : c'est un bloqueur, dans l'application.
 */
class AdBlocker(private val context: Context) {

    private val blocked = HashSet<String>(8192)

    /** Contenu de `assets/silent.mp3`, lu en même temps que la liste. */
    private var silent: ByteArray? = null

    /** Nombre d'annonces remplacées par du silence (affiché par la sonde). */
    val silenced = AtomicInteger()

    /** Dernier remplacement : adresse et type, pour la sonde. */
    @Volatile
    var lastSilenced: String = ""

    @Volatile
    private var loaded = false

    fun loadAsync() = Thread {
        if (loaded) return@Thread
        try {
            context.assets.open("adblock_hosts.txt").bufferedReader().useLines { lines ->
                lines.forEach { line ->
                    val cleaned = line.substringBefore('#').trim()
                    if (cleaned.isEmpty()) return@forEach
                    // Accepts both `0.0.0.0 ads.example.com` and a bare hostname.
                    val host = cleaned.split(Regex("\\s+")).lastOrNull()?.lowercase() ?: return@forEach
                    if (host.contains('.') && host != "0.0.0.0" && host != "127.0.0.1") {
                        blocked.add(host)
                    }
                }
            }
        } catch (_: Exception) {
            // No list shipped → ad blocking is simply off.
        }
        try {
            context.assets.open("silent.mp3").use { it.readBytes() }.let { silent = it }
        } catch (_: Exception) {
            // Sans ce fichier, on bloque comme avant : réponse vide.
        }
        /* Liste personnalisée (fonctionnalité annoncée par SpotiDuck) : un
           fichier `custom_blocklist.txt` déposé dans le dossier privé de
           l'application, même format que la liste publiée — un hôte par ligne,
           `#` pour les commentaires. Il **ajoute** des hôtes, il n'en retire
           aucun, et les serveurs de lecture restent hors de portée du blocage
           quelle que soit la liste : c'est écrit dans `isBlocked`, pas dans le
           fichier, pour qu'aucun fichier ne puisse couper la musique. */
        try {
            val custom = java.io.File(context.filesDir, CUSTOM_LIST)
            if (custom.isFile) {
                custom.readLines().forEach { line ->
                    val cleaned = line.substringBefore('#').trim()
                    if (cleaned.isEmpty()) return@forEach
                    val host = cleaned.split(Regex("\\s+")).lastOrNull()?.lowercase() ?: return@forEach
                    if (host.contains('.')) blocked.add(host)
                }
                Log.i(TAG, "liste personnalisée : ${blocked.size} règles")
            }
        } catch (_: Exception) {
            // Un fichier illisible ne doit pas empêcher le blocage de la liste publiée.
        }
        loaded = true
    }.also { it.isDaemon = true }.start()

    /** True when [url] (or one of its parent domains) is on the list. */
    fun isBlocked(url: String): Boolean {
        if (!loaded) return false
        if (url.startsWith("data:") || url.startsWith("blob:")) return false
        /* Les serveurs de lecture ne sont **jamais** bloqués, même par une liste
           personnalisée : les couper, c'est faire taire toute la musique. */
        if (NEVER_BLOCK.containsMatchIn(url)) return false
        val host = hostOf(url) ?: return false
        if (blocked.contains(host)) return true
        // Sub-domains: a rule for `doubleclick.net` also blocks
        // `ad.doubleclick.net`.
        var idx = host.indexOf('.')
        while (idx >= 0 && idx < host.length - 1) {
            if (blocked.contains(host.substring(idx + 1))) return true
            idx = host.indexOf('.', idx + 1)
        }
        return false
    }

    /**
     * Adresses qui servent des publicités **audio** (les chemins relevés dans
     * l'application d'origine, plus les hôtes publicitaires de Spotify).
     * `podz-content` et `gew4-spclient` sont exclus : ce sont les serveurs de
     * lecture, jamais bloqués.
     */
    fun isAdAudio(url: String): Boolean {
        if (!loaded) return false
        if (!url.startsWith("http")) return false
        if (NEVER_BLOCK.containsMatchIn(url)) return false
        return AD_AUDIO.containsMatchIn(url)
    }

    /**
     * Le type de contenu d'une adresse, **sans lire le corps** : c'est ainsi que
     * l'application d'origine distinguait une publicité audio d'une musique.
     * `null` quand on n'a pas pu savoir (réseau, délai) — on bloque alors comme
     * avant, sans jamais remplacer quelque chose d'incertain.
     *
     * Appelé depuis `shouldInterceptRequest`, qui s'exécute hors du fil
     * principal : la requête est faite, la réponse est jetée, et la WebView
     * refait la sienne.
     */
    fun sniffContentType(url: String, headers: Map<String, String>?): String? {
        var conn: HttpURLConnection? = null
        return try {
            conn = (URL(url).openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                connectTimeout = 3500
                readTimeout = 3500
                instanceFollowRedirects = false
                headers?.forEach { (key, value) ->
                    if (!key.equals("Range", true)) runCatching { setRequestProperty(key, value) }
                }
                if (getRequestProperty("User-Agent") == null) {
                    runCatching { setRequestProperty("User-Agent", DESKTOP_UA) }
                }
                if (getRequestProperty("Cookie") == null) {
                    runCatching {
                        CookieManager.getInstance().getCookie(url)?.let { setRequestProperty("Cookie", it) }
                    }
                }
            }
            val type = conn.contentType ?: return null
            lastSilenced = "$type · $url"
            type
        } catch (_: Exception) {
            null
        } finally {
            runCatching { conn?.disconnect() }
        }
    }

    /** Du silence, servi comme un vrai fichier audio. */
    fun silentResponse(): WebResourceResponse {
        val bytes = silent
        if (bytes == null) return emptyResponse()
        silenced.incrementAndGet()
        return WebResourceResponse(
            "audio/mpeg",
            null,
            200,
            "OK",
            mapOf(
                "Access-Control-Allow-Origin" to "*",
                "Content-Length" to bytes.size.toString(),
                "Cache-Control" to "no-store"
            ),
            ByteArrayInputStream(bytes)
        )
    }

    /**
     * Réponse vide : la requête n'aboutit pas. `Access-Control-Allow-Origin: *`
     * parce que la page est en `fetch`/XHR sur ces adresses et qu'un refus sans
     * en-tête laisse une erreur dans la console — l'application d'origine
     * faisait exactement la même réponse.
     */
    fun emptyResponse(): WebResourceResponse = WebResourceResponse(
        "text/plain",
        "utf-8",
        200,
        "OK",
        mapOf("Access-Control-Allow-Origin" to "*"),
        ByteArrayInputStream(ByteArray(0))
    )

    val ruleCount: Int get() = blocked.size

    private fun hostOf(url: String): String? {
        var s = url
        val scheme = s.indexOf("://")
        if (scheme >= 0) s = s.substring(scheme + 3)
        else if (s.startsWith("//")) s = s.substring(2)
        val slash = s.indexOf('/')
        if (slash >= 0) s = s.substring(0, slash)
        val at = s.indexOf('@')
        if (at >= 0) s = s.substring(at + 1)
        val colon = s.indexOf(':')
        if (colon >= 0) s = s.substring(0, colon)
        return s.lowercase().takeIf { it.contains('.') }
    }

    companion object {
        private const val TAG = "SpotiDuck"

        /** Nom du fichier de liste personnalisée, dans les fichiers privés. */
        const val CUSTOM_LIST = "custom_blocklist.txt"

        /** Ce que même un bloqueur ne doit pas toucher. */
        private val NEVER_BLOCK = Regex("podz-content|gew4-spclient", RegexOption.IGNORE_CASE)

        /** Chemins et hôtes des publicités audio. */
        private val AD_AUDIO = Regex(
            "(akamaized\\.net|scdn\\.co|spotifycdn\\.com|spotify\\.com)/audio/|" +
                "mp3-?ad\\.|/(mp3ad|audio-ads)/|" +
                "amillionads\\.com|2mdn\\.net|adxcel\\.com|adstudio-assets\\.scdn\\.co",
            RegexOption.IGNORE_CASE
        )

        private const val DESKTOP_UA =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
                "Chrome/124.0.0.0 Safari/537.36"
    }
}
