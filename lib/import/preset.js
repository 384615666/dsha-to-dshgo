// agentPreset mapping (plan §7.2 D2): a source session's preset is kept when
// the target actually has that preset installed; a missing custom preset maps
// the output header to the target's default standard mode — never installing
// or importing the source's preset storage to mask the gap. Every mapped
// session records sourcePreset / targetPreset / reason, shown per session in
// preview and reports.
//
// The target's own preset resolution decides the actual default at runtime;
// the caller passes the target's installed preset list (or null when the
// target's preset service is unavailable — an environment error reported
// separately, not silently treated as "no presets").

export const STANDARD_PRESET = 'standard'

/**
 * Resolve the preset mapping for one session.
 * @param {string|null} sourcePreset - the source header's agentPreset.
 * @param {string[]|null} availablePresets - the target's installed presets,
 *   or null when the target preset service is unavailable.
 * @param {string} [defaultPreset] - the target-resolved default; the
 *   baseline is 'standard' until the target resolves differently.
 * @returns {{ sourcePreset: string|null, targetPreset: string, reason: string }}
 *   reason: 'kept' | 'missing-custom-preset' | 'absent-source-preset' |
 *   'unavailable-presets-assumed-standard' (presets could not be read).
 */
export function resolvePresetMapping(sourcePreset, availablePresets, defaultPreset = STANDARD_PRESET) {
  const fallback = { sourcePreset: sourcePreset ?? null, targetPreset: defaultPreset, reason: 'absent-source-preset' }
  if (sourcePreset == null || sourcePreset === '') return fallback
  if (availablePresets == null) {
    // The mapping to standard is applied WITHOUT knowledge of the target's
    // preset list — recorded honestly so the preview can surface it.
    return { sourcePreset, targetPreset: sourcePreset === defaultPreset ? sourcePreset : defaultPreset, reason: 'unavailable-presets-assumed-standard' }
  }
  if (availablePresets.includes(sourcePreset)) {
    return { sourcePreset, targetPreset: sourcePreset, reason: 'kept' }
  }
  return { sourcePreset, targetPreset: defaultPreset, reason: 'missing-custom-preset' }
}

/** Apply a resolved mapping to an output header (returns a new header). */
export function applyPresetMapping(header, mapping) {
  return { ...header, agentPreset: mapping.targetPreset }
}
