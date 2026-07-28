---
status: accepted
---

# 使用原生系统凭据库保存百炼 API Key

百炼 API Key 作为独立凭据条目保存在 macOS 钥匙串或 Windows 凭据管理器中，应用只通过主进程执行保存、读取和移除。渲染进程只能获得“是否已配置”、固定掩码和凭据库名称，不能读取密钥原文。Workspace ID 与地域属于非敏感连接设置，可原子写入 Electron 的 `userData`；API Key 不进入订单数据库、所选数据目录、日志、错误、备份或导出。

Electron `safeStorage` 在 Windows 上使用 DPAPI 保护应用自行保存的密文，并不创建 Windows 凭据管理器条目，因此不满足本项目已经确认的字面安全边界。应用选择基于 N-API 的 `@napi-rs/keyring`，以换取两个平台一致的系统凭据语义；代价是便携版必须外置并解包对应平台的原生模块，CI 也必须分别验证 macOS 与 Windows 产物包含可加载的 `.node` 文件。

系统凭据与业务数据不共同迁移。恢复备份、移动便携程序或换电脑时，订单数据仍可使用，但目标系统需要重新填写 API Key。应用使用稳定的服务名和 bundle ID，使同一系统用户替换便携程序目录后仍能访问原凭据。
