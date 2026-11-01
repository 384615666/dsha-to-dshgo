// Resolve the P0 report directory. Preference order:
// 1. $DSHA_MIGRATOR_P0_DIR (explicit lab override)
// 2. <DSH_HOME>/migrations/dsha-migrator/p0, derived from the persistence root
//    (root is <home>/sessions for the JSONL backend), never the plugin install dir.
export async function p0ReportDir(persistenceRoot) {
  const override = process.env.DSHA_MIGRATOR_P0_DIR
  if (override) return override
  if (persistenceRoot) {
    const { join, dirname } = await import('node:path')
    return join(dirname(persistenceRoot), 'migrations', 'dsha-migrator', 'p0')
  }
  return null
}
