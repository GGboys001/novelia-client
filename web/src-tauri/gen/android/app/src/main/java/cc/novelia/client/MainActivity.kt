package cc.novelia.client

import android.os.Bundle
import android.util.Log
import androidx.activity.enableEdgeToEdge
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
}
