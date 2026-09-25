package com.spotiduck.app

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.widget.RemoteViews

/**
 * Le widget de l'écran d'accueil : pochette, titre, artiste, et les quatre
 * commandes (précédent, lecture/pause, suivant) — c'est ce que SpotiDuck
 * annonçait comme « widget support ».
 *
 * Il ne lit rien lui-même : la musique est décodée par le lecteur web, donc
 * l'état vient de [PlaybackService], qui le tient de la page. Les boutons
 * envoient exactement les mêmes actions que la notification, au même service —
 * un seul chemin, donc un seul endroit où ça peut casser.
 */
class PlayerWidget : AppWidgetProvider() {

    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        render(context, manager, ids)
    }

    override fun onReceive(context: Context, intent: Intent) {
        super.onReceive(context, intent)
        // Le système peut redemander une mise à jour par un autre chemin :
        // dans tous les cas, on redessine l'état courant.
        refresh(context)
    }

    companion object {

        /** Redessine les widgets posés : appelé à chaque changement de lecture. */
        fun refresh(context: Context) {
            val manager = AppWidgetManager.getInstance(context) ?: return
            val ids = manager.getAppWidgetIds(ComponentName(context, PlayerWidget::class.java))
            if (ids == null || ids.isEmpty()) return
            render(context, manager, ids)
        }

        private fun render(context: Context, manager: AppWidgetManager, ids: IntArray) {
            val status = PlaybackService.currentStatus()
            val playing = status?.playing == true
            val title = status?.title?.takeIf { it.isNotBlank() } ?: context.getString(R.string.app_name)
            val artist = status?.artist?.takeIf { it.isNotBlank() }
                ?: context.getString(R.string.widget_idle)

            for (id in ids) {
                val views = RemoteViews(context.packageName, R.layout.widget_player)
                views.setTextViewText(R.id.widget_title, title)
                views.setTextViewText(R.id.widget_artist, artist)
                views.setImageViewResource(
                    R.id.widget_toggle,
                    if (playing) R.drawable.ic_pause else R.drawable.ic_play
                )
                views.setContentDescription(
                    R.id.widget_toggle,
                    context.getString(if (playing) R.string.action_pause else R.string.action_play)
                )
                // Pochette : seulement si elle est déjà en mémoire (elle est
                // chargée pour la notification) — sinon l'icône de l'application.
                views.setImageViewResource(R.id.widget_cover, R.drawable.ic_notification)
                status?.cover?.takeIf { it.isNotBlank() }?.let { url ->
                    PlaybackService.coverFor(url)?.let { views.setImageViewBitmap(R.id.widget_cover, it) }
                }

                views.setOnClickPendingIntent(R.id.widget_root, openIntent(context))
                views.setOnClickPendingIntent(
                    R.id.widget_previous,
                    action(context, PlaybackService.ACTION_PREVIOUS)
                )
                views.setOnClickPendingIntent(
                    R.id.widget_toggle,
                    action(context, if (playing) PlaybackService.ACTION_PAUSE else PlaybackService.ACTION_PLAY)
                )
                views.setOnClickPendingIntent(R.id.widget_next, action(context, PlaybackService.ACTION_NEXT))

                manager.updateAppWidget(id, views)
            }
        }

        private fun openIntent(context: Context): PendingIntent = PendingIntent.getActivity(
            context,
            0,
            Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )

        /** Mêmes actions que la notification, même service : une seule route. */
        private fun action(context: Context, action: String): PendingIntent = PendingIntent.getService(
            context,
            action.hashCode(),
            Intent(context, PlaybackService::class.java).setAction(action),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
    }
}
