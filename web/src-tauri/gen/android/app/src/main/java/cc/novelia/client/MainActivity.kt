package cc.novelia.client

import android.os.Bundle
import android.util.Log
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.updatePadding
import mobile.Mobile

class MainActivity : TauriActivity() {
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
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)

    // enableEdgeToEdge 后 WebView 会铺到状态栏下面；按系统栏高度留出安全区，
    // 避免顶部导航被状态栏遮挡、底部被手势条覆盖。
    ViewCompat.setOnApplyWindowInsetsListener(webView) { view, insets ->
      val bars = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
      )
      view.updatePadding(
        left = bars.left,
        top = bars.top,
        right = bars.right,
        bottom = bars.bottom,
      )
      WindowInsetsCompat.CONSUMED
    }
    ViewCompat.requestApplyInsets(webView)
  }
}
