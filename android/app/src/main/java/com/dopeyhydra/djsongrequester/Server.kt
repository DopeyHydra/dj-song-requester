package com.dopeyhydra.djsongrequester

import android.content.Context
import androidx.core.content.edit
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL

/** Gespeicherte Server-Adresse und Verbindungsprüfung. */
object Server {
    private const val PREFS = "server"
    private const val KEY_URL = "url"

    fun saved(context: Context): String? =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_URL, null)

    fun save(context: Context, url: String?) =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit {
            if (url == null) remove(KEY_URL) else putString(KEY_URL, url)
        }

    /**
     * Macht aus einer Eingabe wie "songs.example.com", "192.168.1.10:3000/admin" oder
     * "https://songs.example.com/" eine Liste von Basis-URLs, die nacheinander probiert werden.
     * Ohne Protokoll: lokale Adressen zuerst per http, alles andere zuerst per https.
     */
    fun candidates(input: String): List<String> {
        var s = input.trim()
        if (s.isEmpty()) return emptyList()
        s = s.replace(Regex("/+$"), "")
            .replace(Regex("/admin/?$", RegexOption.IGNORE_CASE), "")
            .replace(Regex("/+$"), "")

        val hasScheme = Regex("^https?://", RegexOption.IGNORE_CASE).containsMatchIn(s)
        val list = if (hasScheme) {
            listOf(s)
        } else {
            val host = s.substringBefore('/').substringBefore(':')
            val local = host == "localhost" || host.endsWith(".local") ||
                Regex("^\\d{1,3}(\\.\\d{1,3}){3}$").matches(host)
            if (local) listOf("http://$s", "https://$s") else listOf("https://$s", "http://$s")
        }
        return list.filter { isValid(it) }
    }

    private fun isValid(url: String): Boolean = try {
        val u = URI(url)
        (u.scheme == "http" || u.scheme == "https") && !u.host.isNullOrBlank()
    } catch (e: Exception) {
        false
    }

    class CheckException(message: String, val notDjsr: Boolean = false) : Exception(message)

    /** Prüft, ob unter [base] ein DJ Song Requester antwortet. Läuft blockierend – nicht im UI-Thread aufrufen. */
    fun check(base: String) {
        val health = get("$base/healthz")
        if (health.first != 200 || !health.second.contains("\"ok\"")) {
            throw CheckException("HTTP ${health.first}", notDjsr = health.first in 200..499)
        }
        val auth = get("$base/api/admin/auth-config")
        val json = try { JSONObject(auth.second) } catch (e: Exception) { null }
        if (auth.first != 200 || json == null || !json.has("password")) {
            throw CheckException("Unerwartete Antwort", notDjsr = true)
        }
    }

    private fun get(url: String): Pair<Int, String> {
        val conn = URL(url).openConnection() as HttpURLConnection
        conn.connectTimeout = 6000
        conn.readTimeout = 6000
        conn.instanceFollowRedirects = true
        conn.setRequestProperty("Accept", "application/json")
        try {
            val code = conn.responseCode
            val body = (if (code < 400) conn.inputStream else conn.errorStream)
                ?.bufferedReader()?.use { it.readText().take(4096) } ?: ""
            return code to body
        } finally {
            conn.disconnect()
        }
    }
}
