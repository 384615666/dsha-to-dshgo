# DSHA 迁移 / dsha-to-dshgo

[中文](#中文) | [English](#english)

---

## 中文

把 **DSHA**（DeepSeek Harness Android 端）「一键备份」导出的会话备份，迁移到 **dsh-Go** 的 DSH bundle 插件。迁移完成后，会话出现在 dsh-Go 的工作区中：正文、工具历史、preset 与时间线保留，可继续对话。

- 不改 APK、不 Root、不 ADB 私有目录拷贝、不以电脑端工具作为最终产品。
- 只处理用户明确选择的备份文件；**解析、暂存与写入都在设备本机完成**，不联网上传聊天数据。
- 备份内的 `.credentials.yaml` 等敏感配置**只做完整性校验，不迁移、不写报告、不打印内容**。
- 源备份只读；不覆盖目标已有会话 ID；导入使用独立的新工作区，不改既有工作区。

### 当前状态

已实现并通过桌面隔离引擎与真实备份验证：

- **输入**：DSHA v5 一键备份（gzip magic 识别，接受 `..gz` 等扩展名）；系统 files 选择器（≤8 MiB）路径。
- **解析/恢复**：整包校验、白名单暂存、官方历史迁移链（v0–v3 → v4）、父子 catalog 绑定、官方 locate 位置校验。
- **写入（A 路径）**：官方 `sessionPersistence.create/append/flush/close` + 全量语义读回；保留源会话 ID。
- **附件**：附件先行发布（图片逐字节、文件 verbatim），官方读回后才创建会话；借用对象不撤回。
- **安全**：G6 工作区完整单元快照、批准计划内容门禁、journal 持久化、受保护撤回回滚、用户改名/追加/新增引用保留并 pending。
- **原生面板**：选择备份 → 校验进度 → 分页选择会话 → preset/cwd 映射 → 确认计划 → 开始/取消 → 结果与恢复。P0 探针收在「开发工具」里。
- **重复导入**：相同备份重跑会重新核验目标；一致显示「已完成」，目标被修改则要求恢复判断，不会静默追加。

验证基线：`168` 项自动化测试（隔离 rc.4 引擎与真实备份夹具；三组环境分别运行）；SDK 清单/半宿主加载/中英文面板通过；npm 包门禁通过。旧代（v0–v3）只有合成夹具证据，**未在真实用户旧数据上验证**。

**尚未完成/未放行**：真机上的原生列表标题、重启后读取、真实续聊与真实模型验收；B 路径仍是实验入口，未接入统一作业；npm 发布与市场真实安装未执行。当前版本不要作为唯一数据副本使用。

### 开发期安装（dsh-Go，无需 Root）

```sh
# 桌面 web profile
dsh plugin --profile web add /path/to/dsh-dsha-migrator

# 手机本机引擎（App 终端内执行；插件文件夹先放到手机存储）
cp -r /sdcard/Download/dsh-dsha-migrator /root/.dsh/dsh-go/plugins/
dsh plugin --profile web add /root/.dsh/dsh-go/plugins/dsh-dsha-migrator
# 然后在 App 的「引擎」页重启内核
```

### 数据与隐私

- 作业数据保存在 `<DSH_HOME>/dsha-migrator/`（journal、冻结计划、内容寻址快照、隔离区），文件 0600 / 目录 0700。
- 导入成功后删除私有输入副本与候选暂存；journal/快照作为恢复点保留。
- 失败/取消按 G6 与受保护撤回补偿；无法判定的对象保持 pending 并保留最小证据。
- 卸载插件不影响已导入的会话。

### 开发探针环境变量（仅隔离实验）

| 变量 | 用途 |
|---|---|
| `DSHA_MIGRATOR_P0_DIR` | 探针报告输出目录（默认 `<DSH_HOME>/migrations/dsha-migrator/p0`） |
| `DSHA_MIGRATOR_P0_CWD` | 探针会话使用的 cwd |
| `DSHA_MIGRATOR_P0_EVENTS` | 预验证 v4 事件集 JSON（A 路径 append 对照） |
| `DSHA_MIGRATOR_P0_B_MANIFEST` / `DSHA_MIGRATOR_P0_B_BYTES` / `DSHA_MIGRATOR_P0_B_MODE` | B 路径落位实验 |
| `DSHA_MIGRATOR_P0_SCAN_DIR` | 输入通道扫描目录（默认 `/sdcard/Download/DSHA`） |
| `DSHA_MIGRATOR_P0_AUTOWRITE=1` / `DSHA_MIGRATOR_P0_AUTOB=1` / `DSHA_MIGRATOR_P0_AUTOG6=1` | 启动时自动执行对应探针（仅隔离环境） |

### 兼容性

- 目标引擎：`>=0.2.1-rc.4 <0.3.0-0`（证据基线为 rc.4）；App `minApp 1.0.4`（1.0.7 实测）。
- 输入：DSHA 一键备份 v5；会话格式 v0–v4 经 dsh-Go 自带迁移链升级为 v4。

### 许可

[MIT](./LICENSE)

---

## English

A DSH bundle plugin that migrates sessions from a **DSHA** one-click backup into **dsh-Go**. Migrated sessions live in a dedicated workspace with their message/tool history, preset and timeline; they can be continued after import.

- No APK modification, no root, no private ADB pulls, and no desktop-only final product.
- Only the backup the user selects is read; parsing, staging and writing happen **on the device**, with no upload of chat data.
- Sensitive files inside the backup (`.credentials.yaml` etc.) are integrity-checked only: never migrated, reported or printed.

### Status

Implemented and verified against an isolated rc.4 engine with a real backup:

- **Input**: DSHA v5 backup (gzip magic, accepts `..gz`); system files picker path (≤8 MiB).
- **Parsing/restore**: full archive verification, allowlisted staging, official historical chain (v0–v3 → v4), parent/child catalog binding, official `locate()` location verification.
- **A-path write**: official `create/append/flush/close` plus full semantic readback; source session IDs preserved.
- **Attachments**: published before sessions (images byte-for-byte, files verbatim), official readback before create; borrowed objects are never withdrawn.
- **Safety**: complete G6 workspace-unit snapshot, approved-plan content gate, durable journal, protected withdrawal rollback, user edits/additions/new references preserved as pending.
- **Native panel**: pick backup → verify progress → paginated session selection → preset/cwd mapping → approve plan → start/cancel → result and recovery. P0 probes remain under Dev tools.
- **Repeat import**: the same backup re-verifies the target; identical content reports done, a changed target requires recovery instead of silent appends.

Baseline: `168` automated tests across three environments; SDK manifest/half-host load/zh-en panels pass; the npm package gate passes. Historical generations (v0–v3) have synthetic fixtures only — **not validated against real user legacy data**.

**Not released yet**: native list titles, restart, real chat continuation and real-model acceptance on a physical device; B path remains an experimental entry and is not wired into the job; npm publishing and market installation are not done. Do not use this version as the only copy of your data.

### Development install (no root)

```sh
# desktop web profile
dsh plugin --profile web add /path/to/dsh-dsha-migrator

# on-device engine (run in the App terminal; copy the plugin folder to phone storage first)
cp -r /sdcard/Download/dsh-dsha-migrator /root/.dsh/dsh-go/plugins/
dsh plugin --profile web add /root/.dsh/dsh-go/plugins/dsh-dsha-migrator
# then restart the kernel from the App engine page
```

### Data and privacy

- Job data lives under `<DSH_HOME>/dsha-migrator/` (journal, frozen plan, content-addressed snapshot, quarantine), files 0600 / directories 0700.
- On success the private input copy and candidate staging are removed; the journal/snapshot stay as the recovery point.
- Failure/cancel compensates through G6 and protected withdrawal; undecidable objects stay pending with minimal evidence.
- Uninstalling the plugin does not affect imported sessions.

### License

[MIT](./LICENSE)
