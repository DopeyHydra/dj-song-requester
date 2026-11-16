package com.dopeyhydra.djsongrequester

import android.content.Intent
import android.os.Bundle
import android.view.View
import android.view.inputmethod.EditorInfo
import android.widget.ProgressBar
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.updatePadding
import com.google.android.material.button.MaterialButton
import com.google.android.material.textfield.TextInputEditText
import com.google.android.material.textfield.TextInputLayout
import java.util.concurrent.Executors

/** Startbildschirm: Server-Adresse eingeben und prüfen. */
class SetupActivity : AppCompatActivity() {

    companion object {
        /** Wenn gesetzt, wird die gespeicherte Adresse nicht automatisch geöffnet. */
        const val EXTRA_CHANGE_SERVER = "change_server"
    }

    private val executor = Executors.newSingleThreadExecutor()
    private lateinit var input: TextInputEditText
    private lateinit var layout: TextInputLayout
    private lateinit var button: MaterialButton
    private lateinit var progress: ProgressBar

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val saved = Server.saved(this)
        if (saved != null && !intent.getBooleanExtra(EXTRA_CHANGE_SERVER, false)) {
            openMain()
            return
        }

        WindowCompat.setDecorFitsSystemWindows(window, false)
        setContentView(R.layout.activity_setup)
        applyInsets(findViewById(R.id.root))
        limitWidth(findViewById(R.id.card))

        input = findViewById(R.id.urlInput)
        layout = findViewById(R.id.urlLayout)
        button = findViewById(R.id.connectButton)
        progress = findViewById(R.id.progress)

        if (saved != null) input.setText(saved)
        input.setOnEditorActionListener { _, actionId, _ ->
            if (actionId == EditorInfo.IME_ACTION_GO) { connect(); true } else false
        }
        input.setOnFocusChangeListener { _, _ -> layout.error = null }
        button.setOnClickListener { connect() }
    }

    private fun connect() {
        layout.error = null
        val text = input.text?.toString().orEmpty()
        if (text.isBlank()) { layout.error = getString(R.string.err_empty); return }
        val candidates = Server.candidates(text)
        if (candidates.isEmpty()) { layout.error = getString(R.string.err_invalid); return }

        setBusy(true)
        executor.execute {
            var lastError: Server.CheckException? = null
            var ok: String? = null
            for (base in candidates) {
                try {
                    Server.check(base)
                    ok = base
                    break
                } catch (e: Server.CheckException) {
                    lastError = e
                } catch (e: Exception) {
                    lastError = Server.CheckException(e.localizedMessage ?: e.javaClass.simpleName)
                }
            }
            runOnUiThread {
                if (isFinishing || isDestroyed) return@runOnUiThread
                setBusy(false)
                if (ok != null) {
                    Server.save(this, ok)
                    openMain()
                } else {
                    val err = lastError
                    layout.error = if (err?.notDjsr == true) getString(R.string.err_not_djsr)
                    else getString(R.string.err_unreachable, err?.message ?: "?")
                }
            }
        }
    }

    private fun setBusy(busy: Boolean) {
        button.isEnabled = !busy
        input.isEnabled = !busy
        button.text = getString(if (busy) R.string.setup_checking else R.string.setup_connect)
        progress.visibility = if (busy) View.VISIBLE else View.GONE
    }

    private fun openMain() {
        startActivity(Intent(this, MainActivity::class.java))
        finish()
    }

    /** Auf Tablets das Formular nicht über die volle Breite ziehen. */
    private fun limitWidth(card: View) {
        val maxPx = (440 * resources.displayMetrics.density).toInt()
        card.post {
            val parentWidth = (card.parent as View).width
            if (parentWidth > maxPx) {
                card.layoutParams = card.layoutParams.apply { width = maxPx }
            }
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        executor.shutdownNow()
    }
}

/** Inhalt nicht unter Status-/Navigationsleiste oder Tastatur legen (Edge-to-Edge ab Android 15). */
fun applyInsets(view: View) {
    ViewCompat.setOnApplyWindowInsetsListener(view) { v, insets ->
        val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
        val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
        v.updatePadding(left = bars.left, top = bars.top, right = bars.right, bottom = maxOf(bars.bottom, ime.bottom))
        WindowInsetsCompat.CONSUMED
    }
}

