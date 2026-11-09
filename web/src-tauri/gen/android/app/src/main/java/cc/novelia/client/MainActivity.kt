package cc.novelia.client

import android.os.Bundle
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.ScriptHandler
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import mobile.Mobile

class MainActivity : TauriActivity() {
  private var webView: WebView? = null
  private var insetScript: ScriptHandler? = null
  private var lastTop = -1f
  private var lastBottom = -1f

  override fun onCreate(savedInstanceState: Bundle?) {
    Thread {
      try {
        val port = Mobile.start()
        Log.i("NoveliaEch", "ECH bridge port=$port")
      } catch (error: Throwable) {
        Log.e("NoveliaEch", "ECH bridge start failed", error)
      }
    }.start()

    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    watchWindowInsets()
  }

  /** WryActivity.setWebView 会回调这里，可稳定拿到 Rust 侧创建的 WebView。 */
  override fun onWebViewCreate(webView: WebView) {
    Log.i("NoveliaInsets", "onWebViewCreate")
    this.webView = webView
    val root = window.decorView
    ViewCompat.getRootWindowInsets(root)?.let { applyInsets(webView, it) }
    root.post {
      ViewCompat.getRootWindowInsets(root)?.let { applyInsets(webView, it) }
    }
  }

  private fun watchWindowInsets() {
    val root = window.decorView

    ViewCompat.setOnApplyWindowInsetsListener(root) { _, insets ->
      webView?.let { applyInsets(it, insets) }
      insets
    }
    ViewCompat.requestApplyInsets(root)

    // WebView 由 Rust 侧异步创建，这里再兜底遍历视图树。
    var attempts = 0
    fun attach() {
      val target = webView ?: findWebView(root)
      if (target == null) {
        if (attempts++ < 100) root.postDelayed({ attach() }, 100)
        return
      }
      webView = target
      Log.i("NoveliaInsets", "WebView ready")
      ViewCompat.getRootWindowInsets(root)?.let { applyInsets(target, it) }
      // 首次注入可能早于页面加载完成，短时间内重复下发。
      for (delay in longArrayOf(300, 800, 1500, 2500, 4000, 6000)) {
        root.postDelayed({
          ViewCompat.getRootWindowInsets(root)?.let { applyInsets(target, it) }
        }, delay)
      }
    }
    root.post { attach() }
  }

  private fun applyInsets(webView: WebView, insets: WindowInsetsCompat) {
    val bars = insets.getInsets(
      WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
    )
    // Android WebView 的 CSS px 等于 dp，需要按 density 换算。
    val density = resources.displayMetrics.density.takeIf { it > 0f } ?: 1f
    val top = bars.top / density
    val bottom = bars.bottom / density

    val script = "(()=>{var r=document.documentElement;if(!r)return;" +
      "r.style.setProperty('--novelia-inset-top','${top}px');" +
      "r.style.setProperty('--novelia-inset-bottom','${bottom}px');})()"

    if (top != lastTop || bottom != lastBottom) {
      lastTop = top
      lastBottom = bottom
      // 注册 document-start 脚本，页面重载后仍会自动写入变量。
      if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
        try {
          insetScript?.remove()
          insetScript = WebViewCompat.addDocumentStartJavaScript(webView, script, setOf("*"))
        } catch (error: Throwable) {
          Log.w("NoveliaInsets", "addDocumentStartJavaScript failed", error)
        }
      }
      Log.i("NoveliaInsets", "top=$top bottom=$bottom")
    }

    webView.evaluateJavascript(script, null)
  }

  private fun findWebView(view: View): WebView? {
    if (view is WebView) return view
    if (view is ViewGroup) {
      for (index in 0 until view.childCount) {
        findWebView(view.getChildAt(index))?.let { return it }
      }
    }
    return null
  }
}
