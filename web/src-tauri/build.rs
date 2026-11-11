fn main() {
  // 前端产物更新后必须重新生成内嵌资源，否则 Android 包会继续使用旧界面。
  println!("cargo:rerun-if-changed=../dist");
  println!("cargo:rerun-if-changed=../dist/index.html");
  tauri_build::build()
}
