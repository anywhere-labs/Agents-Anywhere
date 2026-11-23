import { describe, expect, it } from "vitest"

import { DEFAULT_LOCALE, detectLocale, messages, translate } from "@/lib/i18n"

function placeholders(text: string): string[] {
  return [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()
}

describe("i18n", () => {
  it("keeps identical keys and placeholders between en and zh-CN", () => {
    const enKeys = Object.keys(messages.en).sort()
    const zhKeys = Object.keys(messages["zh-CN"]).sort()
    expect(zhKeys).toEqual(enKeys)

    for (const key of enKeys as (keyof typeof messages.en)[]) {
      expect(placeholders(messages["zh-CN"][key]), `placeholders for ${key}`).toEqual(
        placeholders(messages.en[key])
      )
    }
  })

  it("detects stored preference before browser language", () => {
    expect(detectLocale("zh-CN", ["en-US"])).toBe("zh-CN")
    expect(detectLocale("en", ["zh-CN"])).toBe("en")
    expect(detectLocale(null, ["zh-Hans-CN", "en-US"])).toBe("zh-CN")
    expect(detectLocale(null, ["fr-FR"])).toBe(DEFAULT_LOCALE)
  })

  it("interpolates variables cleanly", () => {
    expect(translate("en", "common.pageOf", { page: 2, pageCount: 5 })).toBe("Page 2 of 5")
    expect(translate("zh-CN", "common.pageOf", { page: 2, pageCount: 5 })).toBe("第 2 / 5 页")
  })
})
