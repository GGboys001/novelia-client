package cc.novelia.client

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.webkit.JavascriptInterface
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
    installExternalLinks(webView)
    val root = window.decorView
    ViewCompat.getRootWindowInsets(root)?.let { applyInsets(webView, it) }
    root.post {
      ViewCompat.getRootWindowInsets(root)?.let { applyInsets(webView, it) }
    }
  }

  /**
   * 论坛等外部站点交给系统浏览器打开：站内 WebView 不共享其域名的登录态，
   * 且外部页面没有适配状态栏，直接加载会被系统栏遮挡。
   */
  private fun installExternalLinks(webView: WebView) {
    webView.addJavascriptInterface(
      object {
        @JavascriptInterface
        fun open(url: String) {
          val uri = Uri.parse(url)
          if (uri.scheme != "http" && uri.scheme != "https") return
          runOnUiThread {
            try {
              startActivity(Intent(Intent.ACTION_VIEW, uri))
            } catch (error: Throwable) {
              Log.w("NoveliaLinks", "open external failed", error)
            }
          }
        }
      },
      "NoveliaBridge",
    )

    val script = """
      (() => {
        if (window.__noveliaExternalLinks) return;
        window.__noveliaExternalLinks = true;
        const isExternal = (href) => {
          try {
            const url = new URL(href, location.href);
            if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
            if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') return false;
            if (url.hostname === 'tauri.localhost') return false;
            return url.host !== location.host;
          } catch (error) {
            return false;
          }
        };
        const open = (href) => {
          try { NoveliaBridge.open(String(href)); } catch (error) {}
        };
        document.addEventListener('click', (event) => {
          const anchor = event.target && event.target.closest
            ? event.target.closest('a[href]')
            : null;
          if (!anchor || anchor.hasAttribute('download')) return;
          if (!isExternal(anchor.href)) return;
          event.preventDefault();
          event.stopPropagation();
          open(anchor.href);
        }, true);
        const nativeOpen = window.open;
        window.open = function (url, ...rest) {
          if (url && isExternal(String(url))) {
            open(url);
            return null;
          }
          return nativeOpen ? nativeOpen.call(window, url, ...rest) : null;
        };
      })();
    """.trimIndent()

    if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
      try {
        WebViewCompat.addDocumentStartJavaScript(webView, script, setOf("*"))
      } catch (error: Throwable) {
        Log.w("NoveliaLinks", "addDocumentStartJavaScript failed", error)
      }
    }
    webView.evaluateJavascript(script, null)
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
