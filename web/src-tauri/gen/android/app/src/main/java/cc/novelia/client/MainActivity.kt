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
  // 论坛等外部页面在应用内打开，需要系统返回键能退回 WebView 历史。
  override val handleBackNavigation: Boolean = true

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
    installForumBridge(webView)
    val root = window.decorView
    ViewCompat.getRootWindowInsets(root)?.let { applyInsets(webView, it) }
    root.post {
      ViewCompat.getRootWindowInsets(root)?.let { applyInsets(webView, it) }
    }
  }

  /**
   * 其它外部站点（GitHub、Telegram 等）交给系统浏览器打开，避免在 WebView 内
   * 没有返回入口；novelia.cc 的子站保留在应用内，由 installForumBridge 处理。
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
            // 站内站点（论坛等）继续在应用内打开，交给论坛桥接处理登录态与安全区。
            if (url.hostname === 'novelia.cc' || url.hostname.endsWith('.novelia.cc')) return false;
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

  /**
   * 论坛是独立域名，登录态存在 web-kit 的 localStorage 里，页面本身也没有适配
   * 状态栏。跳转前把登录态放进 URL hash，论坛页加载时写回 localStorage，并补上
   * 与主站一致的顶部安全区样式。
   */
  private fun installForumBridge(webView: WebView) {
    val script = """
      (() => {
        if (window.__noveliaForumBridge) return;
        window.__noveliaForumBridge = true;
        const SESSION_KEY = 'web-kit:session:v1';
        const FORUM_HOST = 'forum.novelia.cc';

        if (location.hostname === FORUM_HOST) {
          try {
            const match = /novelia-session=([^&]+)/.exec(location.hash);
            if (match) {
              localStorage.setItem(SESSION_KEY, decodeURIComponent(match[1]));
              history.replaceState(null, '', location.pathname + location.search);
            }
          } catch (error) {}
          const css = '.web-kit-layout{--web-kit-header-height:calc(50px + var(--novelia-inset-top, 0px));}'
            + '.web-kit-layout>div>header{padding-top:var(--novelia-inset-top, 0px);}';
          const append = () => {
            if (!document.head) return;
            const style = document.createElement('style');
            style.textContent = css;
            document.head.appendChild(style);
          };
          if (document.head) append();
          else document.addEventListener('DOMContentLoaded', append, { once: true });
          return;
        }

        document.addEventListener('click', (event) => {
          const anchor = event.target && event.target.closest
            ? event.target.closest('a[href]')
            : null;
          if (!anchor) return;
          let url;
          try { url = new URL(anchor.href, location.href); } catch (error) { return; }
          if (url.hostname !== FORUM_HOST) return;
          let session = null;
          try { session = localStorage.getItem(SESSION_KEY); } catch (error) {}
          if (!session) return;
          url.hash = 'novelia-session=' + encodeURIComponent(session);
          event.preventDefault();
          event.stopPropagation();
          location.href = url.toString();
        }, true);
      })();
    """.trimIndent()

    if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
      try {
        WebViewCompat.addDocumentStartJavaScript(webView, script, setOf("*"))
      } catch (error: Throwable) {
        Log.w("NoveliaLinks", "forum bridge inject failed", error)
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
