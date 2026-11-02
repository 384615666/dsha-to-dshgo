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
 *   or null when the target's preset service could not be queried.
 * @param {string} [defaultPreset] - the target-resolved default; the
 *   baseline is 'standard' until the target resolves differently. Only
 *   meaningful together with a queried list.
 * @returns {{ sourcePreset: string|null, targetPreset: string|null, reason: string, writable: boolean }}
 *   - 'kept': source preset is installed on the target.
 *   - 'missing-custom-preset': the list was queried and the source preset is
 *     absent — maps to the target-resolved default; the session stays
 *     importable and the mapping is reported per session.
 *   - 'absent-source-preset': the source header names no preset — target
 *     default applies.
 *   - 'unavailable-presets': the target preset list could not be queried.
 *     targetPreset is null and writable is false — an environment error the
 *     CALLER must block from write admission; guessing a default (e.g.
 *     'standard') would mask an unverified environment. Once the service is
 *     queryable again, the same session can be planned and imported.
 */
export function resolvePresetMapping(sourcePreset, availablePresets, defaultPreset = STANDARD_PRESET) {
  if (sourcePreset == null || sourcePreset === '') {
    if (availablePresets == null) {
      return { sourcePreset: sourcePreset ?? null, targetPreset: null, reason: 'unavailable-presets', writable: false }
    }
    return { sourcePreset: sourcePreset ?? null, targetPreset: defaultPreset, reason: 'absent-source-preset', writable: true }
  }
  if (availablePresets == null) {
    return { sourcePreset, targetPreset: null, reason: 'unavailable-presets', writable: false }
  }
  if (availablePresets.includes(sourcePreset)) {
    return { sourcePreset, targetPreset: sourcePreset, reason: 'kept', writable: true }
  }
  return { sourcePreset, targetPreset: defaultPreset, reason: 'missing-custom-preset', writable: true }
}

/**
 * Apply a resolved mapping to an output header (returns a new header).
 * Throws when the mapping is not writable (unresolved environment) so an
 * unresolved header can never reach write admission.
 */
export function applyPresetMapping(header, mapping) {
  if (!mapping?.writable || typeof mapping.targetPreset !== 'string' || !mapping.targetPreset) {
    throw new Error(`preset mapping is not writable (reason: ${mapping?.reason ?? 'unknown'}) — block write admission until the target preset service is queryable`)
  }
  return { ...header, agentPreset: mapping.targetPreset }
}
