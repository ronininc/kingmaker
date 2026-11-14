package org.ronininc.ronin

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.os.IBinder

/** The hosted presence on Android: keeps the engine's loopback surface server + mesh session alive
 *  as a foreground service. It is a face-and-session keeper, exactly like the desktop shell — the
 *  jobs, vault, and audit live in the engine's records, so if an OEM killer takes this service down,
 *  nothing is lost; the surface returns with its receipts intact (§7.1) when relaunched. */
class RoninService : Service() {
    override fun onCreate() {
        super.onCreate()
        val mgr = getSystemService(NotificationManager::class.java)
        mgr.createNotificationChannel(NotificationChannel("ronin", "Ronin OS", NotificationManager.IMPORTANCE_LOW))
        val note = Notification.Builder(this, "ronin")
            .setContentTitle("Ronin OS")
            .setContentText("Sovereign session running")
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .build()
        startForeground(1, note)
        Engine.startLoopbackSurface(applicationContext) // 127.0.0.1 only, as on every mounting
    }
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_STICKY
    override fun onBind(intent: Intent?): IBinder? = null
}
