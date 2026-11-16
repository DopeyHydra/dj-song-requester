package com.dopeyhydra.djsongrequester

import android.Manifest
import android.annotation.SuppressLint
import android.app.DownloadManager
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.Message
import android.view.Menu
import android.view.MenuItem
import android.view.View
import android.webkit.CookieManager
import android.webkit.URLUtil
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebStorage
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsControllerCompat
import com.google.android.material.appbar.MaterialToolbar
import com.google.android.material.button.MaterialButton
import com.google.android.material.progressindicator.LinearProgressIndicator

/** Admin-Panel des Servers in einer WebView – Login per Passwort oder SSO läuft wie im Browser. */
class MainActivity : AppCompatActivity() {

    private lateinit var server: String
    private lateinit var webView: WebView
    private lateinit var progress: LinearProgressIndicator
    private lateinit var errorView: LinearLayout
    private lateinit var errorDetail: TextView

    /** Download, der auf die Speicher-Berechtigung wartet (nur Android 8/9). */
    private var pendingDownload: (() -> Unit)? = null
    private val storagePermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        val action = pendingDownload
        pendingDownload = null
        if (granted) action?.invoke()
        else Toast.makeText(this, R.string.download_permission, Toast.LENGTH_LONG).show()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        server = Server.saved(this) ?: run { changeServer(); return }

        WindowCompat.setDecorFitsSystemWindows(window, false)
        WindowInsetsControllerCompat(window, window.decorView).apply {
            isAppearanceLightStatusBars = false
            isAppearanceLightNavigationBars = false
        }
        setContentView(R.layout.activity_main)
        applyInsets(findViewById(R.id.root))

        val toolbar = findViewById<MaterialToolbar>(R.id.toolbar)
        setSupportActionBar(toolbar)
        supportActionBar?.title = getString(R.string.app_name)
        supportActionBar?.subtitle = Uri.parse(server).host

        progress = findViewById(R.id.progress)
        errorView = findViewById(R.id.errorView)
        errorDetail = findViewById(R.id.errorDetail)
        findViewById<MaterialButton>(R.id.retryButton).setOnClickListener { reload() }
        findViewById<MaterialButton>(R.id.changeServerButton).setOnClickListener { confirmChangeServer() }

        webView = findViewById(R.id.webview)
        setupWebView()

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (webView.canGoBack()) webView.goBack()
                else { isEnabled = false; onBackPressedDispatcher.onBackPressed() }
            }
        })

        if (savedInstanceState == null || webView.restoreState(savedInstanceState) == null) {
            webView.loadUrl(adminUrl())
        }
    }

    private fun adminUrl() = "$server/admin/"

    @SuppressLint("SetJavaScriptEnabled")
    private fun setupWebView() {
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, false)

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            cacheMode = WebSettings.LOAD_DEFAULT
            mediaPlaybackRequiresUserGesture = true
            setSupportMultipleWindows(true) // target="_blank" → externer Browser (siehe onCreateWindow)
            javaScriptCanOpenWindowsAutomatically = false
            userAgentString = "$userAgentString DJSongRequesterApp/${BuildConfig.VERSION_NAME}"
        }

        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url
                // http(s) bleibt in der App – auch die Keycloak-Anmeldeseite
                if (url.scheme == "http" || url.scheme == "https") return false
                openExternal(url) // spotify:, intent:, mailto: …
                return true
            }

            override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
                progress.visibility = View.VISIBLE
            }

            override fun onPageFinished(view: WebView, url: String?) {
                progress.visibility = View.INVISIBLE
                CookieManager.getInstance().flush()
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame) showError(error.description?.toString())
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView, newProgress: Int) {
                progress.setProgressCompat(newProgress, true)
            }

            // Links mit target="_blank" (Gästeseite, Spotify, Event-Link) im externen Browser öffnen
            override fun onCreateWindow(view: WebView, isDialog: Boolean, isUserGesture: Boolean, resultMsg: Message): Boolean {
                if (!isUserGesture) return false
                val temp = WebView(view.context)
                temp.webViewClient = object : WebViewClient() {
                    private var handled = false
                    private fun handOff(v: WebView, url: String?) {
                        if (handled || url.isNullOrBlank() || url == "about:blank") return
                        handled = true
                        v.stopLoading()
                        openExternal(Uri.parse(url))
                        v.post { v.destroy() }
                    }
                    override fun shouldOverrideUrlLoading(v: WebView, request: WebResourceRequest): Boolean {
                        handOff(v, request.url.toString())
                        return true
                    }
                    // Manche WebView-Versionen melden den ersten Aufruf eines neuen Fensters nur hier
                    override fun onPageStarted(v: WebView, url: String?, favicon: Bitmap?) {
                        handOff(v, url)
                    }
                }
                (resultMsg.obj as WebView.WebViewTransport).webView = temp
                resultMsg.sendToTarget()
                return true
            }
        }

        // QR-Code-Downloads (PNG/SVG) in den Download-Ordner
        webView.setDownloadListener { url, userAgent, contentDisposition, mimeType, _ ->
            val start = { enqueueDownload(url, userAgent, contentDisposition, mimeType) }
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q &&
                ContextCompat.checkSelfPermission(this, Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED
            ) {
                pendingDownload = start
                storagePermission.launch(Manifest.permission.WRITE_EXTERNAL_STORAGE)
            } else {
                start()
            }
        }
    }

    private fun enqueueDownload(url: String, userAgent: String, contentDisposition: String?, mimeType: String?) {
        try {
            val fileName = URLUtil.guessFileName(url, contentDisposition, mimeType)
            val request = DownloadManager.Request(Uri.parse(url))
                .setMimeType(mimeType)
                .addRequestHeader("User-Agent", userAgent)
                .setTitle(fileName)
                .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, fileName)
            // Session-Cookie mitschicken, sonst lehnt der Server den Download ab
            CookieManager.getInstance().getCookie(url)?.let { request.addRequestHeader("Cookie", it) }
            getSystemService(DownloadManager::class.java).enqueue(request)
            Toast.makeText(this, getString(R.string.download_started, fileName), Toast.LENGTH_SHORT).show()
        } catch (e: Exception) {
            Toast.makeText(this, R.string.download_failed, Toast.LENGTH_LONG).show()
        }
    }

    private fun openExternal(uri: Uri) {
        try {
            val intent = if (uri.scheme == "intent") Intent.parseUri(uri.toString(), Intent.URI_INTENT_SCHEME)
            else Intent(Intent.ACTION_VIEW, uri)
            intent.addCategory(Intent.CATEGORY_BROWSABLE)
            intent.component = null
            intent.selector = null
            startActivity(intent)
        } catch (e: ActivityNotFoundException) {
            Toast.makeText(this, R.string.no_app, Toast.LENGTH_SHORT).show()
        } catch (e: Exception) {
            Toast.makeText(this, R.string.no_app, Toast.LENGTH_SHORT).show()
        }
    }

    private fun showError(detail: String?) {
        errorDetail.text = listOfNotNull(Uri.parse(server).host, detail).joinToString("\n")
        errorView.visibility = View.VISIBLE
    }

    private fun reload() {
        errorView.visibility = View.GONE
        val current = webView.url
        if (current.isNullOrBlank() || current == "about:blank") webView.loadUrl(adminUrl()) else webView.reload()
    }

    override fun onCreateOptionsMenu(menu: Menu): Boolean {
        menuInflater.inflate(R.menu.main, menu)
        return true
    }

    override fun onOptionsItemSelected(item: MenuItem): Boolean = when (item.itemId) {
        R.id.action_reload -> { reload(); true }
        R.id.action_guest -> { openExternal(Uri.parse("$server/")); true }
        R.id.action_change_server -> { confirmChangeServer(); true }
        else -> super.onOptionsItemSelected(item)
    }

    private fun confirmChangeServer() {
        AlertDialog.Builder(this)
            .setTitle(R.string.change_server_title)
            .setMessage(R.string.change_server_msg)
            .setPositiveButton(R.string.yes_change) { _, _ -> changeServer() }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    /** Abmelden (Cookies löschen) und zurück zur Server-Eingabe. */
    private fun changeServer() {
        CookieManager.getInstance().removeAllCookies(null)
        CookieManager.getInstance().flush()
        WebStorage.getInstance().deleteAllData()
        if (::webView.isInitialized) {
            webView.clearCache(true)
            webView.clearHistory()
        }
        startActivity(Intent(this, SetupActivity::class.java).putExtra(SetupActivity.EXTRA_CHANGE_SERVER, true))
        finish()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        if (::webView.isInitialized) webView.saveState(outState)
    }

    override fun onResume() {
        super.onResume()
        if (::webView.isInitialized) webView.onResume()
    }

    override fun onPause() {
        if (::webView.isInitialized) webView.onPause()
        CookieManager.getInstance().flush()
        super.onPause()
    }

    override fun onDestroy() {
        if (::webView.isInitialized) webView.destroy()
        super.onDestroy()
    }
}
