let fallbackCounter = 0

export function createClientId(prefix = "id") {
  const cryptoApi = globalThis.crypto
  if (typeof cryptoApi?.randomUUID === "function") {
    return `${prefix}_${cryptoApi.randomUUID()}`
  }

  if (typeof cryptoApi?.getRandomValues === "function") {
    const bytes = new Uint8Array(16)
    cryptoApi.getRandomValues(bytes)
    return `${prefix}_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`
  }

  fallbackCounter += 1
  return `${prefix}_${Date.now().toString(36)}_${fallbackCounter.toString(36)}_${Math.random().toString(36).slice(2)}`
}
