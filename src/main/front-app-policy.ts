const OWN_BUNDLE_IDS = new Set([
  'com.novavoice.app',
])

const OWN_PROCESS_NAMES = new Set([
  'electron',
  'voicetype',
  'novavoice',
])

function normalizeProcessName(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_-]+/g, '')
}

export function shouldRememberFrontApp(processName: string, bundleId: string): boolean {
  const normalizedName = normalizeProcessName(processName)
  const normalizedBundleId = bundleId.trim().toLowerCase()
  if (!normalizedName) return false
  if (normalizedBundleId && OWN_BUNDLE_IDS.has(normalizedBundleId)) return false
  return !OWN_PROCESS_NAMES.has(normalizedName)
}
