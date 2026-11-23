package dev.agentsanywhere.v3.design

import androidx.compose.runtime.mutableFloatStateOf

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.PowerManager
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.core.content.ContextCompat

/**
 * How glass is drawn, read by every glass component through `LocalGlassMode` (never per component):
 *  - Blur: glass blurs what is under it: the thread (Kyant backdrop over the WebView's hardware layer) or native
 *    content (RenderEffect), Android 12+.
 *  - Off: opaque solid colours + highlight stroke + shadow, same shapes and sizes, and nothing is recorded.
 */
enum class GlassMode { Blur, Off }

/**
 * The 「毛玻璃效果」 setting (SharedPreferences), the API level and power saver combined into the effective mode.
 * Changes apply at once (Compose state).
 */
class GlassSettings(private val context: Context) {
    private val prefs = context.getSharedPreferences("aa.glass", Context.MODE_PRIVATE)
    private val power = context.getSystemService(PowerManager::class.java)

    /** Below Android 12 there is no RenderEffect: the switch is shown disabled. */
    val supported: Boolean = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S

    var enabled by mutableStateOf(prefs.getBoolean("enabled", true)); private set
    var ignorePowerSaver by mutableStateOf(prefs.getBoolean("ignorePowerSaver", false)); private set
    /**
     * How frosted the glass over the thread is, 0…1 (the 「模糊程度」 slider; iOS has the same choice). 0: almost no
     * blur and a faint tint, mostly refraction; 1: the strongest blur and tint (close to iOS's most opaque setting);
     * default the middle.
     */
    private var frostSaved by mutableFloatStateOf(prefs.getFloat("frost", 0.5f).takeIf { it.isFinite() }?.coerceIn(0f, 1f) ?: 0.5f)
    var frostOverride by mutableStateOf<Float?>(null)
    val frost: Float get() = frostOverride ?: frostSaved
    /**
     * Glass on the sheets and menus (「面板和菜单的玻璃」). Separate from the main switch because it costs the most power:
     * the whole screen (sidebar + conversation) is recorded and a sheet-sized area blurred every frame. Off: sheets and
     * menus are opaque and the screen is not recorded; the toolbar, composer and approval dock keep their glass.
     */
    private var sheetGlassSaved by mutableStateOf(prefs.getBoolean("sheetGlass", true))
    /** Debug override (`--es sheet_glass on|off`) for this launch; touching the switch clears it. */
    var sheetGlassOverride by mutableStateOf<Boolean?>(null)
    val sheetGlass: Boolean get() = sheetGlassOverride ?: sheetGlassSaved
    var powerSave by mutableStateOf(power.isPowerSaveMode); private set
    /** Debug override (`--es glass blur|tint`). */
    var debugOverride by mutableStateOf<String?>(null)

    init {
        ContextCompat.registerReceiver(context, object : BroadcastReceiver() {
            override fun onReceive(c: Context, intent: Intent) { powerSave = power.isPowerSaveMode }
        }, IntentFilter(PowerManager.ACTION_POWER_SAVE_MODE_CHANGED), ContextCompat.RECEIVER_NOT_EXPORTED)
    }

    /** System contrast raised (Android 14+) or animations removed: solid colours, like iOS "Reduce Transparency". */
    var accessibilitySolid by mutableStateOf(false); private set

    fun refreshAccessibility() {
        val contrast = if (Build.VERSION.SDK_INT >= 34) context.getSystemService(android.app.UiModeManager::class.java).contrast else 0f
        val animations = android.provider.Settings.Global.getFloat(context.contentResolver, android.provider.Settings.Global.ANIMATOR_DURATION_SCALE, 1f)
        accessibilitySolid = contrast > 0f || animations == 0f
    }

    val pausedForPowerSaver: Boolean get() = supported && enabled && powerSave && !ignorePowerSaver

    val mode: GlassMode get() {
        when (debugOverride) {
            "tint", "off" -> return GlassMode.Off
            "blur" -> return if (supported) GlassMode.Blur else GlassMode.Off
        }
        return if (!supported || !enabled || pausedForPowerSaver || accessibilitySolid) GlassMode.Off else GlassMode.Blur
    }

    fun updateEnabled(value: Boolean) { debugOverride = null; enabled = value; prefs.edit().putBoolean("enabled", value).apply() }
    fun updateSheetGlass(value: Boolean) { sheetGlassOverride = null; sheetGlassSaved = value; prefs.edit().putBoolean("sheetGlass", value).apply() }
    fun updateFrost(value: Float) {
        if (!value.isFinite()) return
        frostOverride = null
        frostSaved = value.coerceIn(0f, 1f)
        prefs.edit().putFloat("frost", frostSaved).apply()
    }
    fun updateIgnorePowerSaver(value: Boolean) { ignorePowerSaver = value; prefs.edit().putBoolean("ignorePowerSaver", value).apply() }
}
