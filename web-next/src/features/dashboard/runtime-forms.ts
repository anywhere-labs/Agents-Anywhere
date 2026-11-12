import Ajv2020 from "ajv/dist/2020"
export type AgentConfigOption = { _meta?: { aa?: { modelInputModalities?: Record<string, string[]> } }; id?: string; configId?: string; name: string; category?: string; type: "select" | "boolean"; currentValue: string | boolean; options?: ({ value: string; name: string } | { name: string; options: { value: string; name: string }[] })[] }
export type AgentConfiguration = { revision: number; options: AgentConfigOption[] }
export type FormProperty = { type?: string; title?: string; description?: string; default?: unknown; enum?: string[]; enumNames?: string[]; items?: { type?: string; enum?: string[] }; minLength?: number; maxLength?: number; minimum?: number; maximum?: number; minItems?: number; maxItems?: number }
export type FormSchema = { type?: string; properties?: Record<string, FormProperty>; required?: string[] }
export function formDefaults(schema: FormSchema): Record<string, unknown> {
  return Object.fromEntries(Object.entries(schema.properties ?? {}).flatMap(([key, field]) => {
    if (field.default !== undefined) return [[key, field.default]]
    if (!schema.required?.includes(key)) return []
    return field.type === "boolean" ? [[key, false]] : field.type === "string" && !field.enum ? [[key, ""]] : field.type === "array" ? [[key, []]] : []
  }))
}
const formValidator = new Ajv2020({ allErrors: true, strict: false, validateFormats: false })
const formValidators = new Map<string, ReturnType<typeof formValidator.compile>>()
export function formErrors(schema: FormSchema, values: Record<string, unknown>): Record<string, "required" | "invalid" | "invalidSchema"> {
  try {
    const key = JSON.stringify(schema)
    let validate = formValidators.get(key)
    if (!validate) {
      validate = formValidator.compile(schema)
      if (formValidators.size >= 64) formValidators.delete(formValidators.keys().next().value!)
      formValidators.set(key, validate)
    }
    if (validate(values)) return {}
    return Object.fromEntries((validate.errors ?? []).map(error => {
      const field = error.keyword === "required" ? String(error.params.missingProperty) : error.instancePath.split("/")[1]?.replace(/~1/g, "/").replace(/~0/g, "~") || "_form"
      return [field, error.keyword === "required" ? "required" : "invalid"]
    }))
  } catch { return { _form: "invalidSchema" } }
}
export function configSchema(configuration: AgentConfiguration, includeModel = false): FormSchema {
  return { type: "object", properties: Object.fromEntries(configuration.options.filter(option => includeModel || option.category !== "model").map(option => {
    const key = option.configId ?? option.id!
    const choices = (option.options ?? []).flatMap(group => "options" in group ? group.options : [group])
    return [key, { type: option.type === "boolean" ? "boolean" : "string", title: option.name, default: option.currentValue, ...(option.type === "select" ? { enum: choices.map(item => item.value), enumNames: choices.map(item => item.name) } : {}) }]
  })) }
}

/** Model, effort and permission are owned by the composer's selection controls. */
export function creationConfigurationDefaults(configuration: AgentConfiguration): Record<string, unknown> {
  return formDefaults(configSchema({ ...configuration, options: configuration.options.filter(
    option => !["model", "effort", "permission"].includes(option.category ?? ""),
  ) }))
}
