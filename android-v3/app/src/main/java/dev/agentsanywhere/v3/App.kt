package dev.agentsanywhere.v3

import android.app.Application
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import dev.agentsanywhere.v3.bridge.RenderBridge
import dev.agentsanywhere.v3.design.GlassSettings
import dev.agentsanywhere.v3.model.AppGraph
import dev.agentsanywhere.v3.model.AppModel

/**
 * Process-wide objects: services ([AppGraph]), the account model, the glass settings and the one WebView (created on
 * the first Activity start and kept across Activity recreation and screen changes). Streams run only while the app
 * is in the foreground (ProcessLifecycleOwner).
 */
class App : Application() {
    lateinit var graph: AppGraph; private set
    lateinit var model: AppModel; private set
    lateinit var glass: GlassSettings; private set
    lateinit var bridge: RenderBridge; private set

    override fun onCreate() {
        super.onCreate()
        graph = AppGraph(this)
        model = AppModel(graph)
        glass = GlassSettings(this)
        bridge = RenderBridge(this)
        ProcessLifecycleOwner.get().lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onStart(owner: LifecycleOwner) = model.onForeground()
            override fun onStop(owner: LifecycleOwner) = model.onBackground()
        })
    }
}
