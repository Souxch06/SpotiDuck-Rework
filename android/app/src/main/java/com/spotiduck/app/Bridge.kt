package com.spotiduck.app

import android.util.Log
import android.webkit.JavascriptInterface
import org.json.JSONObject
import java.lang.ref.WeakReference

/**
 * The `AndBridge` object injected into the WebView.
 *
 * The interface name is **not** hard-coded on the JavaScript side (the runtime
 * feature-detects it), so only the methods below matter:
 *
 *   recMediaStatus(json) · recMediaPosition(ms) · playLoaded() · cssInjected()
 *   manageTShut(bool) · manageTSleep(bool) · wakeUp() · wakeOff() · isWoke()
 *   loginDetected() · deferMessage(string)
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

    companion object {
        const val TAG = "SpotiDuck"
    }
}
