package dev.agentsanywhere.v3poc.ui

import android.app.Activity
import android.app.Dialog
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.util.TypedValue
import android.view.Gravity
import android.view.WindowManager
import android.widget.TextView
import dev.agentsanywhere.v3poc.LaunchClock

/**
 * Evaluation only (`--es web_glass window`): two separate windows over the thread whose backgrounds SurfaceFlinger
 * blurs (`Window.setBackgroundBlurRadius`, Android 12+), the way iOS composites glass without the app recording the
 * page. Not touchable, not focusable; they only show what cross-window blur looks like over a live WebView.
 */
object WindowGlassSpike {
    private val dialogs = ArrayList<Dialog>()

    fun show(activity: Activity, dark: Boolean, themed: Boolean = true) {
        if (Build.VERSION.SDK_INT < 31) return
        val wm = activity.getSystemService(WindowManager::class.java)
        LaunchClock.log("window glass spike: crossWindowBlurEnabled=${wm.isCrossWindowBlurEnabled}")
        fun dp(v: Float) = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, activity.resources.displayMetrics).toInt()
        fun window(label: String, widthDp: Float, heightDp: Float, place: Int, yDp: Float) {
            val dialog = Dialog(activity, if (themed) dev.agentsanywhere.v3poc.R.style.Theme_AAv3PoC_GlassWindow else 0)
            dialog.setContentView(TextView(activity).apply {
                text = label; gravity = Gravity.CENTER; textSize = 15f
                setTextColor(if (dark) Color.WHITE else Color.BLACK)
            })
            val w = dialog.window ?: return
            w.setFormat(PixelFormat.TRANSLUCENT)
            w.setBackgroundDrawable(GradientDrawable().apply {
                cornerRadius = dp(heightDp / 2).toFloat()
                setColor(if (dark) Color.argb(110, 38, 38, 40) else Color.argb(150, 255, 255, 255))
                setStroke(dp(1f), if (dark) Color.argb(70, 255, 255, 255) else Color.argb(240, 255, 255, 255))
            })
            w.clearFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND)
            w.addFlags(WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE or
                WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL)
            w.setBackgroundBlurRadius(dp(18f))
            w.setLayout(dp(widthDp), dp(heightDp))
            w.setGravity(place)
            w.attributes = w.attributes.apply { y = dp(yDp) }
            dialog.show()
            dialogs += dialog
        }
        window("窗口级模糊 · 顶部", 240f, 48f, Gravity.TOP or Gravity.CENTER_HORIZONTAL, 120f)
        window("窗口级模糊 · 输入框位置", 340f, 48f, Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL, 160f)
    }

    /**
     * Minimal control for the emulator question "can SurfaceFlinger blur at all here?" (`--es web_glass behind` /
     * `bgafter`): `behind` = one transparent dialog with FLAG_BLUR_BEHIND + setBlurBehindRadius (blurs the whole
     * screen behind it); `bgafter` = background blur set after show(), attributes never reassigned afterwards.
     */
    fun control(activity: Activity, kind: String, themed: Boolean = kind.endsWith("t")) {
        if (Build.VERSION.SDK_INT < 31) return
        val wm = activity.getSystemService(WindowManager::class.java)
        fun dp(v: Float) = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, activity.resources.displayMetrics).toInt()
        val dialog = Dialog(activity, if (themed) dev.agentsanywhere.v3poc.R.style.Theme_AAv3PoC_GlassWindow else 0)
        dialog.setContentView(TextView(activity).apply { text = "blur control: $kind"; gravity = Gravity.CENTER; textSize = 15f; setTextColor(Color.BLACK) })
        val w = dialog.window ?: return
        w.setFormat(PixelFormat.TRANSLUCENT)
        w.setBackgroundDrawable(GradientDrawable().apply { cornerRadius = dp(24f).toFloat(); setColor(Color.argb(90, 255, 255, 255)) })
        w.clearFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND)
        w.addFlags(WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL)
        w.setLayout(dp(320f), dp(200f))
        w.setGravity(Gravity.CENTER)
        if (kind == "behind") {
            w.addFlags(WindowManager.LayoutParams.FLAG_BLUR_BEHIND)
            w.attributes = w.attributes.apply { blurBehindRadius = dp(30f); dimAmount = 0f }
        }
        dialog.show()
        if (kind == "bgafter") w.setBackgroundBlurRadius(dp(30f))
        dialogs += dialog
        main.postDelayed({
            val a = w.attributes
            LaunchClock.log("blur control $kind: crossWindowBlurEnabled=${wm.isCrossWindowBlurEnabled} flags=0x${Integer.toHexString(a.flags)} blurBehindRadius=${a.blurBehindRadius} format=${a.format}")
        }, 500)
    }

    private val main = android.os.Handler(android.os.Looper.getMainLooper())

    fun dismiss() { dialogs.forEach { it.dismiss() }; dialogs.clear() }
}
