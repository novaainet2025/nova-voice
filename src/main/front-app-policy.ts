const OWN_BUNDLE_IDS = new Set([
  'com.novavoice.app',
])

// Last-resort match, used only when the foreground process id is unavailable.
// These names are ambiguous: every unpackaged Electron app reports "Electron",
// so matching on them alone treats other Electron apps as if they were us and
// silently refuses to dictate into them.
const OWN_PROCESS_NAMES = new Set([
  'electron',
  'voicetype',
  'novavoice',
])

function normalizeProcessName(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_-]+/g, '')
}

export interface FrontAppIdentity {
  processName: string
  bundleId: string
  /** Foreground process id as reported by System Events, 0 when unknown. */
  pid?: number
}

/**
 * Decides whether a foreground application may become the dictation target.
 *
 * Only NOVA VOICE itself is excluded. The process id is the authoritative test
 * because it distinguishes this app from every other Electron app on the
 * machine, including ones running unpackaged under the shared name "Electron".
 */
export function shouldRememberFrontApp(
  processName: string,
  bundleId: string,
  pid?: number,
): boolean {
  const normalizedName = normalizeProcessName(processName)
  const normalizedBundleId = bundleId.trim().toLowerCase()
  if (!normalizedName) return false
  if (normalizedBundleId && OWN_BUNDLE_IDS.has(normalizedBundleId)) return false
  if (typeof pid === 'number' && Number.isFinite(pid) && pid > 0) {
    return pid !== process.pid
  }
  return !OWN_PROCESS_NAMES.has(normalizedName)
}
