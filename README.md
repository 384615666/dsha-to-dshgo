# DSHA 迁移 / dsha-to-dshgo

[中文](#中文) | [English](#english)

---

## 中文

把 **DSHA**（DeepSeek Harness Android 端）「一键备份」导出的会话备份，迁移到 **dsh-Go** 的 DSH bundle 插件。迁移完成后，会话直接出现在 dsh-Go 原生会话列表中：正文、工具历史、标题可读，重启后仍在，可继续发消息。

- 不改 APK、不 Root、不 ADB 私有目录拷贝、不用电脑端工具作为最终方案。
- 插件只处理用户明确选择的备份文件；**所有解析、暂存与写入都发生在设备本机**，不联网上传任何聊天数据。
- 备份内包含的 `.credentials.yaml` 等敏感配置**默认不迁移**，不写入报告，不打印内容。

### 当前状态：P0（能力验证原型）

本仓库当前是 P0 纵向原型，已验证并附真实证据（桌面隔离 Host + 真机 Android/ARM64 PRoot，引擎 `0.2.1-rc.4`）：

- 运行时能力检查：`session-persistence-jsonl` 后端、`locate()` 可用（文件落位路径可行）。
- **A 路径**（服务重放）：`create/append/flush/close → open(read)` 完整读回哈希一致；改用新 session ID 会被 delivery-marker 校验拒绝（因此迁移保留源 ID）。
- **B 路径**（文件落位）：由实例自身 `locate()` 计算路径落位，运行中 `list()` 即时可见，重启后仍可读。
- G6 最小快照/回滚：通过 workspace registry 自身 API 补偿可恢复到导入前状态。
- 真机输入通道：系统 files 选择器（≤8 MiB）与 `/sdcard` 流式读取（>8 MiB）均通过，SHA-256 与原件一致。

尚未实现：完整备份解析（P1）、端到端迁移与回滚（P2）、正式 UI（P3）、npm 发布（P4/P5）。开发路线与验收标准见内部规划文档（不含于本仓库）。

### 开发期安装（dsh-Go，无需 Root）

```sh
# 桌面 web profile
dsh plugin --profile web add /path/to/dsh-dsha-migrator

# 手机本机引擎（App 终端内执行；插件文件夹先放到手机存储）
cp -r /sdcard/Download/dsh-dsha-migrator /root/.dsh/dsh-go/plugins/
dsh plugin --profile web add /root/.dsh/dsh-go/plugins/dsh-dsha-migrator
# 然后在 App 的「引擎」页重启内核
```

### P0 探针专用环境变量（仅隔离实验使用）

| 变量 | 用途 |
|---|---|
| `DSHA_MIGRATOR_P0_DIR` | 探针报告输出目录（默认 `<DSH_HOME>/migrations/dsha-migrator/p0`） |
| `DSHA_MIGRATOR_P0_CWD` | 探针会话使用的 cwd |
| `DSHA_MIGRATOR_P0_EVENTS` | 预验证 v4 事件集 JSON（A 路径 append 对照） |
| `DSHA_MIGRATOR_P0_B_MANIFEST` / `DSHA_MIGRATOR_P0_B_BYTES` / `DSHA_MIGRATOR_P0_B_MODE` | B 路径落位实验 |
| `DSHA_MIGRATOR_P0_SCAN_DIR` | 输入通道扫描目录（默认 `/sdcard/Download/DSHA`） |
| `DSHA_MIGRATOR_P0_AUTOWRITE=1` / `DSHA_MIGRATOR_P0_AUTOB=1` / `DSHA_MIGRATOR_P0_AUTOG6=1` | 启动时自动执行对应探针（仅隔离环境） |

面板提供能力检查 / A / B / G6 探针与两个输入通道动作；所有探针结果以 JSON 报告落盘（0600/0700），不打印聊天内容。

### 兼容性

- 目标引擎：`>=0.2.1-rc.4 <0.3.0-0`（证据基线为 rc.4）；App `minApp 1.0.4`（已在 1.0.7 实测）。
- 输入：DSHA 一键备份 v5（按 gzip magic 识别，接受 `..gz` 等非常规扩展名）；会话格式 v0–v4 直接支持在路线图中（旧代经 dsh-Go 自带迁移链升级为 v4）。

### 数据与隐私

- 插件运行数据保存在 `<DSH_HOME>/migrations/dsha-migrator/`（文件 0600 / 目录 0700）。
- 源备份只读；迁移不修改 DSHA 数据。
- 卸载插件不影响已导入的会话。

### 许可

[MIT](./LICENSE)

---

## English

A DSH bundle plugin that migrates sessions from a **DSHA** one-click backup into **dsh-Go**. Migrated sessions appear in the native dsh-Go session list with full message/tool history, survive restarts, and can continue chatting.

**Status: P0 prototype.** Verified against a real isolated rc.4 Host and a real Android (ARM64 PRoot) device: runtime capability check (`locate` available), A-path service replay (full readback hash match; renaming session IDs is rejected by delivery-marker validation — the migration preserves source IDs), B-path file placement (immediately visible in `list()`, readable after restart), minimal G6 snapshot/rollback, and both input channels (system files picker ≤8 MiB and `/sdcard` streaming >8 MiB, SHA-256 verified).

Not yet implemented: full backup parsing (P1), end-to-end migration with rollback (P2), production UI (P3), npm publishing (P4/P5).

Everything runs on-device: chat data is never uploaded. Sensitive files inside the backup (`.credentials.yaml` etc.) are never migrated or logged. See [LICENSE](./LICENSE) (MIT).
