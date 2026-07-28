---
status: accepted
---

# 使用 Electron、React 与 Node 内置 SQLite 交付本机网页应用

系统使用固定版本的 Electron 作为桌面壳、React 与 TypeScript 构建工作界面，并通过 Electron 所带 Node 运行时的 `node:sqlite` 保存结构化数据。Electron 将 Chromium 与 Node 一起打包，Mac 与 Windows 便携版不依赖用户预装浏览器内核、开发环境或数据库动态库；代价是程序包比系统 WebView 方案更大。

渲染进程保持沙箱和上下文隔离，只能通过 preload 暴露的窄接口请求选择目录、选择截图、操作订单工作流及管理不可读取原文的 OCR 凭据。数据库和来源截图只写入用户选择的数据目录；Electron 的 `userData` 目录只保存最近数据目录的启动指针和 Workspace ID、地域等非敏感本机设置。API Key 不写入 `userData`，而由操作系统凭据库保存。数据目录使用独立 SQLite 锁事务维持单写实例，异常退出时由操作系统释放锁。

应用依赖与 Electron 版本精确锁定，打包工具链固定为 Node 24.18.x。Forge 7 间接依赖的 ZIP 读取器固定为 `yauzl` 3.3.1，避免 Node 24.16 中已知的解压流回归造成“命令成功但没有产物”。CI 在 Mac 与 Windows 上除运行测试外，还显式检查可执行文件、`app.asar` 和系统凭据原生模块确实存在。便携发布使用 ZIP，而不是要求管理员权限的安装器。
