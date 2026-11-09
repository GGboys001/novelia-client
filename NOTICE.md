# 来源与许可说明

本仓库是非官方客户端，不包含小说内容、账号服务或服务端实现。

## 上游项目

- **auto-novel/auto-novel**（GPL-3.0-only）
  - 来源：https://github.com/auto-novel/auto-novel
  - 使用范围：`web/` 前端源码、`packages/crawler`、`packages/translator`，以及在其基础上添加的 Tauri 外壳与客户端适配代码。
- **auto-novel/web-kit**（GPL-3.0-only）
  - 来源：https://github.com/auto-novel/web-kit
  - 通过 `web/package.json` 的 GitHub 依赖引入，未在本仓库内复制源码。
- **nobYoQ/novelia**（GPL-3.0-only）
  - 来源：https://github.com/nobYoQ/novelia
  - 使用范围：`web/src-tauri/ech` 中的 ECH 传输与 DoH 解析实现（移植自其 `native/ech`）。
- **jissr-bypass**（Apache-2.0）
  - 来源：https://github.com/inqadh/jissr-bypass
  - 以源码形式位于 `web/src-tauri/ech/third_party/jissr-bypass`，遵循其原始许可证。

## 角色素材

应用图标中的 Q 版角色素材取自 `nobYoQ/novelia` 仓库的启动图标资源，相关角色与美术作品的权利归原作者所有，本仓库不对其进行再授权。

## 许可证

除第三方素材和依赖外，本仓库原创代码与文档以 GPL-3.0-only 发布，详见根目录 `LICENSE`。
