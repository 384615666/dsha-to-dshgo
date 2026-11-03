# DSHA → dsh-Go migration

A DSH bundle plugin that migrates sessions from a **DSHA one-click backup** into **dsh-Go**. Migrated sessions live in a dedicated workspace with their message/tool history, preset and timeline; they can be continued after import.

- No APK modification, no root, no private ADB pulls, and no desktop-only final product.
- Large backups are streamed from the phone's `Download/DSHA` directory after the official “访问手机文件” grant; the system file picker also selects one backup file.
- Only the backup the user selects is read; parsing, staging and writing happen **on the device**, with no upload of chat data.
- Sensitive files inside the backup (`.credentials.yaml` etc.) are integrity-checked only: never migrated, reported or printed.

## Status

Implemented and verified against an isolated rc.4 engine with a real backup:

- **Input**: DSHA v5 backup (gzip magic, accepts `..gz`); scan the phone's `Download/DSHA` (streaming, large files supported), or choose one backup through the system file picker.
- **Parsing/restore**: full archive verification, allowlisted staging, official historical chain (v0–v3 → v4), parent/child catalog binding, official `locate()` location verification; unavailable/ambiguous/non-canonical generations are isolated and reported instead of silently falling back.
- **A-path write**: official `create/append/flush/close` plus full semantic readback; source session IDs preserved.
- **Attachments**: published before sessions (images byte-for-byte, files verbatim), official readback before create; created objects are quarantined (never deleted) on rollback, shared objects stay.
- **Safety**: G6 workspace-unit snapshot, approved-plan content gate, durable journal, protected withdrawal rollback, user edits/additions/new references preserved as pending; stale crash locks/guards are inspectable and explicitly releasable from the recovery panel.
- **Privacy**: task-private data under `$DSH_HOME/dsha-migrator/`, files 0600/directories 0700; explicit task-data deletion; diagnostics stay in the private data directory.
- **Native panel**: browse `Download/DSHA` → verify progress → paginated session selection → preset/cwd mapping → approve plan → start/cancel → result and recovery.

Baseline: 208 automated tests with the isolated engine and real fixtures; SDK manifest/half-host load/zh-en panels pass; the npm package gate passes. Historical generations (v0–v3) have synthetic fixtures only — **not validated against real user legacy data**.

**Release note**: the npm package is `dsha-to-dshgo`; official market indexing may lag—install from npm if the market has not refreshed yet. Real continuation passed on the available `Glm 5.3 Flash` channel; the imported session's original `Flash` channel still needs a DeepSeek API key. Do not use this version as the only copy of your data.

## Development install (no root)

```sh
# desktop web profile
dsh plugin --profile web add /path/to/dsh-dsha-migrator

# on-device engine (run in the App terminal; copy the plugin folder to phone storage first)
cp -r /sdcard/Download/dsh-dsha-migrator /root/.dsh/dsh-go/plugins/
dsh plugin --profile web add /root/.dsh/dsh-go/plugins/dsh-dsha-migrator
# then restart the kernel from the App engine page
```

## Data and privacy

- Job data lives under `<DSH_HOME>/dsha-migrator/` (journal, frozen plan, content-addressed snapshot, quarantine).
- A successful job removes the private input copy and candidate staging; journal/snapshot stay as the recovery point until the user explicitly deletes the task data.
- Failure/cancel compensates through G6 and protected withdrawal; undecidable objects stay pending with minimal evidence.
- Uninstalling the plugin does not affect imported sessions.

## Compatibility

- Target engine: `>=0.2.1-rc.4 <0.3.0-0` (evidence baseline rc.4); App `minApp 1.0.4` (1.0.7 tested).
- Input: DSHA one-click backup v5; session formats v0–v4 are upgraded to v4 by the target's official chain.

## License

[MIT](./LICENSE)
