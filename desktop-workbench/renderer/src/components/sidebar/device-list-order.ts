const deviceNameOrder = new Intl.Collator("zh-Hans-CN-u-co-pinyin", {
  usage: "sort",
  sensitivity: "base",
  numeric: true,
})

/** Fixed locale and an ID tie-breaker keep polling and presence changes from moving devices. */
export function sortDevicesByName<T extends { id: string; name: string }>(devices: readonly T[]): T[] {
  return [...devices].sort((left, right) => (
    deviceNameOrder.compare(left.name.trim(), right.name.trim())
    || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
  ))
}
