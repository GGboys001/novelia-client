# Novelia Client

基于 [Tauri 2](https://tauri.app/) + Vue 3 的轻小说机翻机器人（Novelia）跨平台客户端，支持 Windows 桌面端与 Android 手机端。

## 下载

前往 [Releases](https://github.com/GGboys001/novelia-client/releases) 下载安装包：

| 平台 | 文件 | 说明 |
| --- | --- | --- |
| Windows x64 | `Novelia-Setup-0.1.5-x64.exe` | 安装到 `%LOCALAPPDATA%\Novelia`，自动创建桌面与开始菜单快捷方式，可在「应用和功能」中卸载 |
| Android arm64 | `Novelia-0.1.5-arm64.apk` | 直接覆盖安装，应用包名为 `cc.novelia.client.debug` |

Windows 端依赖系统自带的 WebView2 运行时（Windows 11 与较新的 Windows 10 默认已安装）。Android 端当前为 arm64 调试签名包，未适配 armeabi-v7a 与 x86。

## 特性

- 复用官方 Web 端的布局、组件和样式，保持与网页版一致的操作体验
- Windows 使用 ECH 侧车，Android 使用进程内 Go ECH 桥接，DoH + 加密 SNI 直连，不依赖外部代理
- 内置本地反向代理，统一处理 API/认证的同源、Cookie 与 CORS
- 支持账号登录、收藏、阅读历史、搜索、排行榜和双语阅读
- 网络模式支持 ECH 直连、系统代理、直连和手动 HTTP/SOCKS5 代理
- 支持 Windows 安装包与 Android arm64 APK
- Android 端适配 edge-to-edge：由原生层把状态栏与手势条高度写入 CSS 变量，顶部导航不会被系统栏遮挡
- 论坛在应用内打开：跳转时带上登录态，并按同一套安全区规则避让状态栏（其它外站仍走系统浏览器）

## 源码结构

```text
web/                     前端与 Tauri 外壳
  src/                   Vue 前端源码
  src-tauri/             Rust 客户端
    src/lib.rs           本地 API/认证代理、网络设置、ECH 调度
    ech/                 ECH 传输引擎（Go）
      cmd/               Windows ECH 侧车
      mobile/            Android gomobile AAR 桥接
      third_party/       jissr-bypass（Apache-2.0）
    gen/android/         Android Studio 工程（含客户端补丁）
packages/crawler/        网络小说抓取公共库
packages/translator/     翻译器公共库
```

## 构建 Windows 端

环境要求：Node.js 22+、pnpm 11、Rust stable（MSVC）、WebView2。

```bash
pnpm install
pnpm build

# 开发模式
pnpm tauri dev

# 正式 exe
cd web
pnpm tauri build --no-bundle
```

ECH 侧车需要 Go 1.27.1。`web/src-tauri/binaries/` 被 gitignore 排除，克隆后是空的，
而 `tauri.conf.json` 的 `bundle.externalBin` 依赖该目录，请先运行构建脚本：

```powershell
pwsh ./scripts/build-ech-sidecar.ps1
```

脚本会生成 `ech-proxy.exe` 和 `ech-proxy-x86_64-pc-windows-msvc.exe`（后者是
`externalBin` 要求的命名）。正式运行时 `ech-proxy.exe` 必须和 `Novelia.exe`
放在同一目录；`tauri build` 打包 NSIS 安装包时会自动把侧车一起装进去。

缺少侧车时，默认的 ECH 模式会因为找不到 `ech-proxy.exe` 而让所有 API 请求返回 502。

## 构建 Android 端

环境要求：JDK 21、Android SDK Platform 37、Build-Tools 37、NDK 28.2、Go 1.27.1。

```bash
pnpm install
pnpm build

cd web
pnpm tauri android init --ci
cd ..

# 恢复仓库中已提交的 Android 补丁（init 可能覆盖它们）
git checkout -- web/src-tauri/gen/android

# 生成 Android ECH 桥接 AAR
cd web/src-tauri/ech
gomobile bind -target=android/arm64 -androidapi 24 -o ../gen/android/app/libs/echbridge.aar ./mobile
```

Windows 主机没有符号链接权限时，`tauri android build` 会在编译完 Rust 后失败。此时手动打包：

```powershell
# 1. 先执行一次，允许它在链接步骤失败（此时 Rust 已编译完成）
cd web
pnpm tauri android build --debug --apk --target aarch64

# 2. 复制并裁剪 Rust 动态库
#    target/aarch64-linux-android/debug/libnovelia_lib.so
#    -> gen/android/app/src/main/jniLibs/arm64-v8a/libnovelia_lib.so
#    使用 NDK 的 llvm-strip --strip-debug 裁剪

# 3. 用 Gradle 打包
cd src-tauri/gen/android
.\gradlew.bat assembleArm64Debug -x rustBuildArm64Debug -x rustBuildUniversalDebug --no-daemon
```

APK 输出：`web/src-tauri/gen/android/app/build/outputs/apk/arm64/debug/app-arm64-debug.apk`

Android 工程已包含仓库内网速优化：阿里云 Maven 镜像、腾讯 Gradle 镜像和中文路径兼容配置。

## 网络模式

- **ECH 直连**：默认模式，DoH 解析 + ECH 加密 SNI，TLS 1.3 校验
- **系统代理**：读取环境变量或 Windows 系统代理
- **直连**：普通 HTTPS
- **手动代理**：支持 `http://`、`https://`、`socks5://`、`socks5h://`

Windows 端 ECH 通过侧车进程实现；Android 端通过 gomobile AAR 在应用进程内启动 `127.0.0.1:43111` 的 ECH 代理，Rust 侧复用同一套 `/fetch` 协议。

## 说明

本项目为非官方客户端，小说内容与账号服务均由原站提供。前端与公共库来源于 GPL-3.0 的 `auto-novel/auto-novel`，本仓库整体以 GPL-3.0 发布。第三方来源与角色素材说明见 [NOTICE.md](NOTICE.md)。

Android 端当前为 arm64 调试签名包，正式签名包与 iOS 尚未适配。
