package com.spotiduck.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.os.Build
import android.os.IBinder
import android.support.v4.media.MediaMetadataCompat
import android.support.v4.media.session.MediaSessionCompat
import android.support.v4.media.session.PlaybackStateCompat
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.ConcurrentHashMap

/**
 * Foreground media service: the notification and the lock screen / headset
 * controls for playback that actually happens inside the WebView.
 *
 * The audio is decoded by Spotify's web player, so there is no audio session to
 * attach to — the service mirrors the state the injected layer reports
 * (`recMediaStatus` / `recMediaPosition`) into a `MediaSessionCompat`, and sends
 * every user action back into the page through [SpotiDuckUI]'s public API.
 */
class PlaybackService : Service() {

    data class Status(
        val title: String,
        val artist: String,
        val cover: String,
        val durationMs: Long,
        val positionMs: Long,
        val playing: Boolean
    )

    private lateinit var session: MediaSessionCompat
    private var current: Status? = null
    private var largeIcon: Bitmap? = null
    private var foreground = false

    override fun onCreate() {
        super.onCreate()
        instance = this
        createChannel()
        session = MediaSessionCompat(this, "SpotiDuck").apply {
            setCallback(object : MediaSessionCompat.Callback() {
                override fun onPlay() = control("SpotiDuckUI.play()")
                override fun onPause() = control("SpotiDuckUI.pause()")
                override fun onSkipToNext() = control("SpotiDuckUI.next()")
                override fun onSkipToPrevious() = control("SpotiDuckUI.previous()")
                override fun onStop() = control("SpotiDuckUI.pause()")
                override fun onSeekTo(pos: Long) = control("SpotiDuckUI.seek($pos)")
            })
            isActive = true
        }
        current = lastStatus
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val action = intent?.action
        // Actions coming from the notification buttons (the session callback
        // handles the lock screen / headset ones).
        when (action) {
            ACTION_PLAY -> control("SpotiDuckUI.play()")
            ACTION_PAUSE -> control("SpotiDuckUI.pause()")
            ACTION_NEXT -> control("SpotiDuckUI.next()")
            ACTION_PREVIOUS -> control("SpotiDuckUI.previous()")
            ACTION_STOP -> {
                control("SpotiDuckUI.pause()")
                stopSelf()
                return START_NOT_STICKY
            }
        }
        val status = lastStatus ?: current
        // Promote to foreground *before* touching the notification: Android
        // requires startForeground() within a few seconds of the start, and a
        // post from the background is silently dropped on 12+.
        if (!foreground) startForegroundCompat(buildNotification(status ?: emptyStatus()))
        if (status != null) render(status)
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        instance = null
        session.isActive = false
        session.release()
        super.onDestroy()
    }

    /* ------------------------------------------------------------------ *
     * Rendering
     * ------------------------------------------------------------------ */

    @android.annotation.SuppressLint("MissingPermission") // POST_NOTIFICATIONS is requested by the activity
    private fun render(status: Status) {
        current = status
        lastStatus = status
        updateSession(status)
        if (status.cover.isNotBlank() && status.cover != iconUrl) {
            loadIcon(status.cover)
        }
        NotificationManagerCompat.from(this)
            .takeIf { it.areNotificationsEnabled() }
            ?.let { manager ->
                runCatching { manager.notify(NOTIFICATION_ID, buildNotification(status)) }
            }
    }

    private fun updateSession(status: Status) {
        val metadata = MediaMetadataCompat.Builder()
            .putString(MediaMetadataCompat.METADATA_KEY_TITLE, status.title)
            .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, status.artist)
            .putLong(MediaMetadataCompat.METADATA_KEY_DURATION, status.durationMs)
            .apply { largeIcon?.let { putBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART, it) } }
            .build()
        session.setMetadata(metadata)

        val state = if (status.playing) PlaybackStateCompat.STATE_PLAYING else PlaybackStateCompat.STATE_PAUSED
        session.setPlaybackState(
            PlaybackStateCompat.Builder()
                .setActions(
                    PlaybackStateCompat.ACTION_PLAY or
                        PlaybackStateCompat.ACTION_PAUSE or
                        PlaybackStateCompat.ACTION_PLAY_PAUSE or
                        PlaybackStateCompat.ACTION_SKIP_TO_NEXT or
                        PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS or
                        PlaybackStateCompat.ACTION_SEEK_TO
                )
                .setState(state, status.positionMs, if (status.playing) 1f else 0f)
                .build()
        )
    }

    private fun buildNotification(status: Status): Notification {
        val content = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )

        val builder = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(status.title.ifBlank { getString(R.string.app_name) })
            .setContentText(status.artist)
            .setContentIntent(content)
            .setDeleteIntent(action(ACTION_STOP))
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setOngoing(status.playing)
            .addAction(R.drawable.ic_skip_previous, getString(R.string.action_previous), action(ACTION_PREVIOUS))
            .addAction(
                if (status.playing) R.drawable.ic_pause else R.drawable.ic_play,
                getString(if (status.playing) R.string.action_pause else R.string.action_play),
                action(if (status.playing) ACTION_PAUSE else ACTION_PLAY)
            )
            .addAction(R.drawable.ic_skip_next, getString(R.string.action_next), action(ACTION_NEXT))
            .setStyle(
                androidx.media.app.NotificationCompat.MediaStyle()
                    .setMediaSession(session.sessionToken)
                    .setShowActionsInCompactView(0, 1, 2)
            )

        largeIcon?.let { builder.setLargeIcon(it) }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            builder.priority = NotificationCompat.PRIORITY_LOW
        }
        return builder.build()
    }

    private fun action(action: String): PendingIntent = PendingIntent.getService(
        this,
        action.hashCode(),
        Intent(this, PlaybackService::class.java).setAction(action),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
    )

    private fun startForegroundCompat(notification: Notification) {
        foreground = true
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification, android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = getSystemService(NotificationManager::class.java) ?: return
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, getString(R.string.channel_playback), NotificationManager.IMPORTANCE_LOW).apply {
                description = getString(R.string.channel_playback_desc)
                setShowBadge(false)
                lockscreenVisibility = Notification.VISIBILITY_PUBLIC
            }
        )
    }

    private fun loadIcon(url: String) {
        iconUrl = url
        Thread {
            val bitmap = iconCache[url] ?: try {
                val connection = (URL(url).openConnection() as HttpURLConnection).apply {
                    connectTimeout = 5000
                    readTimeout = 5000
                }
                connection.inputStream.use { BitmapFactory.decodeStream(it) }
            } catch (e: Exception) {
                null
            }
            if (bitmap != null) {
                iconCache[url] = bitmap
                if (iconCache.size > 12) iconCache.remove(iconCache.keys.first())
            }
            if (bitmap != null && instance === this) {
                largeIcon = bitmap
                render(current ?: return@Thread)
            }
        }.also { it.isDaemon = true }.start()
    }

    private fun control(js: String) {
        jsExecutor?.invoke(js) ?: Log.w(TAG, "no UI attached for: $js")
    }

    companion object {
        private const val TAG = "SpotiDuck"
        private const val CHANNEL_ID = "spotiduck_playback"
        private const val NOTIFICATION_ID = 42

        private const val ACTION_PLAY = "com.spotiduck.app.PLAY"
        private const val ACTION_PAUSE = "com.spotiduck.app.PAUSE"
        private const val ACTION_NEXT = "com.spotiduck.app.NEXT"
        private const val ACTION_PREVIOUS = "com.spotiduck.app.PREVIOUS"
        private const val ACTION_STOP = "com.spotiduck.app.STOP"

        @Volatile
        private var instance: PlaybackService? = null

        @Volatile
        private var lastStatus: Status? = null

        private var iconUrl: String = ""
        private val iconCache = ConcurrentHashMap<String, Bitmap>()

        /**
         * Set by the activity: runs JavaScript inside the WebView. Kept as a
         * lambda so the service never holds a WebView reference.
         */
        @Volatile
        var jsExecutor: ((String) -> Unit)? = null

        private fun emptyStatus() = Status("", "", "", 0L, 0L, false)

        /** Called by the bridge on every meaningful playback change. */
        fun update(context: Context, status: Status) {
            lastStatus = status
            val running = instance
            if (running != null) {
                running.render(status)
                return
            }
            if (!status.playing) return // no notification for a cold paused state
            runCatching {
                ContextCompat.startForegroundService(
                    context,
                    Intent(context, PlaybackService::class.java)
                )
            }.onFailure { Log.w(TAG, "could not start the playback service", it) }
        }

        /** Cheap position refresh (the notification re-renders only on change). */
        fun position(ms: Long) {
            val status = lastStatus ?: return
            val updated = status.copy(positionMs = ms)
            lastStatus = updated
            instance?.updateSession(updated)
        }

        fun stop(context: Context) {
            instance?.stopSelf()
            runCatching { context.stopService(Intent(context, PlaybackService::class.java)) }
        }

        val isRunning: Boolean get() = instance != null
    }
}
