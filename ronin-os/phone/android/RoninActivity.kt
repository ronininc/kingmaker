package org.ronininc.ronin

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.webkit.WebView

/** Full-screen WebView presenting the identical loopback surface (§5.1: one surface, every frame).
 *  usesCleartextTraffic=false in the manifest is overridden for loopback ONLY by the network
 *  security config shipped with the app (127.0.0.1 cleartext permitted; nothing else is). */
class RoninActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        startService(Intent(this, RoninService::class.java))
        val web = WebView(this)
        web.settings.javaScriptEnabled = true
        web.loadUrl("http://127.0.0.1:8931/")
        setContentView(web)
    }
}
