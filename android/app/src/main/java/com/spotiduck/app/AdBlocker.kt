package com.spotiduck.app

import android.content.Context
import android.webkit.WebResourceResponse
import java.io.ByteArrayInputStream

/**
 * Host-level ad/tracker blocking.
 *
 * The list is the same `adblock_hosts.txt` this repository publishes (hosts
 * format: `0.0.0.0 ads.example.com`, `#` for comments). It is read once, on a
 * background thread, and matched against the *host* of every request the
 * WebView makes — including sub-resources, so audio ads served from a
 * different domain are blocked too.
 */
class AdBlocker(private val context: Context) {

    private val blocked = HashSet<String>(8192)

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
        loaded = true
    }.also { it.isDaemon = true }.start()

    /** True when [url] (or one of its parent domains) is on the list. */
    fun isBlocked(url: String): Boolean {
        if (!loaded) return false
        if (url.startsWith("data:") || url.startsWith("blob:")) return false
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

    fun emptyResponse(): WebResourceResponse =
        WebResourceResponse("text/plain", "utf-8", ByteArrayInputStream(ByteArray(0)))

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
}
