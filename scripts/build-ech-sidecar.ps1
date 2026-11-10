# 构建 ECH 侧车
#
# `web/src-tauri/binaries/` 被 .gitignore 排除，所以克隆后该目录是空的。
# `tauri.conf.json` 的 `bundle.externalBin` 指向 `binaries/ech-proxy`，
# 缺少带 target triple 后缀的文件时 `tauri build` 会失败；即使跳过打包，
# 安装出来的程序也会因为找不到 ech-proxy.exe 而在 ECH 模式下返回 502。
#
# 用法（在仓库根目录）：
#   pwsh ./scripts/build-ech-sidecar.ps1
#
# 需要 Go 1.27+。

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$echDir = Join-Path $repoRoot 'web/src-tauri/ech'
$binDir = Join-Path $repoRoot 'web/src-tauri/binaries'

New-Item -ItemType Directory -Force -Path $binDir | Out-Null

Push-Location $echDir
try {
    # 裸名：供 Rust 运行时按 ech_binary_path() 的候选路径查找，也便于手工放置。
    Write-Host '构建 ech-proxy.exe ...'
    go build -trimpath -ldflags '-s -w' -o (Join-Path $binDir 'ech-proxy.exe') ./cmd/novelia-ech-proxy
    if ($LASTEXITCODE -ne 0) { throw "go build 失败：$LASTEXITCODE" }

    # 带 target triple 后缀：Tauri externalBin 要求的命名。
    $target = 'x86_64-pc-windows-msvc'
    $suffixed = Join-Path $binDir "ech-proxy-$target.exe"
    Copy-Item (Join-Path $binDir 'ech-proxy.exe') $suffixed -Force

    $info = Get-Item $suffixed
    Write-Host "完成：$($info.FullName) ($([math]::Round($info.Length / 1MB, 2)) MB)"
} finally {
    Pop-Location
}
