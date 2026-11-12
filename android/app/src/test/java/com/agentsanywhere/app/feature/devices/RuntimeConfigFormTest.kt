package com.agentsanywhere.app.feature.devices

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RuntimeConfigFormTest {
    private val gatewaySchema = linkedMapOf<String, Any?>(
        "type" to "object",
        "metadata" to mapOf("i18n" to mapOf("labelKey" to "dashboard.device.runtimeConfigComponents.modelGateway.label")),
        "required" to listOf("baseUrl", "apiKey"),
        "properties" to linkedMapOf(
            "baseUrl" to mapOf("type" to "string", "title" to "Gateway URL", "minLength" to 1, "pattern" to "^https?://"),
            "apiKey" to mapOf("type" to "string", "title" to "Gateway API key", "minLength" to 1),
        ),
        "additionalProperties" to false,
    )

    private val codexSchema = linkedMapOf<String, Any?>(
        "type" to "object",
        "properties" to linkedMapOf(
            "environment" to mapOf(
                "type" to "object",
                "propertyNames" to mapOf("pattern" to "^[^=\\u0000]+$"),
                "additionalProperties" to mapOf("anyOf" to listOf(mapOf("type" to "string"), mapOf("type" to "null"))),
            ),
            "useSystemCodex" to mapOf("type" to "boolean", "default" to true),
            "codexHome" to mapOf("type" to "string", "maxLength" to 8),
            "modelGateway" to gatewaySchema,
            "customModels" to mapOf(
                "type" to "array",
                "items" to mapOf(
                    "type" to "object",
                    "required" to listOf("modelId", "displayName"),
                    "properties" to mapOf(
                        "modelId" to mapOf("type" to "string", "minLength" to 1),
                        "displayName" to mapOf("type" to "string", "minLength" to 1),
                        "efforts" to mapOf("type" to "array"),
                    ),
                ),
            ),
            "idleTimeoutSeconds" to mapOf("type" to "integer", "minimum" to 60, "maximum" to 86400, "default" to 600),
        ),
        "additionalProperties" to false,
    )

    private val codexUi = mapOf(
        "order" to listOf("useSystemCodex", "codexHome", "modelGateway", "environment", "customModels"),
        "codexHome" to mapOf("component" to "path"),
        "modelGateway" to mapOf("component" to "modelGateway"),
        "environment" to mapOf("component" to "keyValue"),
        "customModels" to mapOf("component" to "customModels"),
    )

    private fun codexForm(requiredFields: List<String> = emptyList()) =
        RuntimeConfigForm.from(codexSchema, codexUi, mapOf("useSystemCodex" to true, "environment" to emptyMap<String, Any?>()), requiredFields)!!

    @Test
    fun fieldsFollowTheUiOrderThenTheSchemaOrder() {
        val form = codexForm()

        assertEquals(
            listOf("useSystemCodex", "codexHome", "modelGateway", "environment", "customModels", "idleTimeoutSeconds"),
            form.fields.map { it.id },
        )
        assertEquals(RuntimeConfigFieldKind.Toggle, form.fields[0].kind)
        assertEquals(RuntimeConfigFieldKind.Text(path = true, secure = false), form.fields[1].kind)
        assertTrue(form.fields[2].kind is RuntimeConfigFieldKind.ModelGateway)
        assertEquals("dashboard.device.runtimeConfigComponents.modelGateway.label", form.fields[2].copy.labelKey)
        assertEquals(RuntimeConfigFieldKind.KeyValue, form.fields[3].kind)
        assertEquals(RuntimeConfigFieldKind.CustomModels, form.fields[4].kind)
        assertEquals(RuntimeConfigFieldKind.Number(integer = true), form.fields[5].kind)
    }

    @Test
    fun componentsUnderUiFieldsAndEnumNamesAreUnderstood() {
        val form = RuntimeConfigForm.from(
            schema = mapOf(
                "type" to "object",
                "properties" to linkedMapOf(
                    "executionMode" to mapOf("type" to "string", "enum" to listOf("auto", "local"), "enumNames" to listOf("优先本机 Pi", "本机 Pi")),
                    "modelGateway" to gatewaySchema,
                    "historyDirs" to mapOf("type" to "array", "items" to mapOf("type" to "string")),
                    "defaultAgentPreset" to mapOf("type" to "string"),
                ),
            ),
            uiSchema = mapOf(
                "fields" to mapOf("modelGateway" to mapOf("component" to "modelGateway")),
                "defaultAgentPreset" to mapOf(
                    "component" to "select",
                    "options" to listOf(mapOf("value" to "plan", "label" to "Plan", "disabled" to true, "disabledReason" to "Off")),
                ),
            ),
            defaults = emptyMap(),
        )!!

        val choice = form.fields[0].kind as RuntimeConfigFieldKind.Choice
        assertEquals(listOf("优先本机 Pi", "本机 Pi"), choice.options.map { it.label })
        assertTrue(form.fields[1].kind is RuntimeConfigFieldKind.ModelGateway)
        assertEquals(RuntimeConfigFieldKind.Json, form.fields[2].kind)
        val preset = form.fields[3].kind as RuntimeConfigFieldKind.Choice
        assertEquals(RuntimeConfigOption("plan", "Plan", disabled = true, disabledReason = "Off"), preset.options.single())
    }

    @Test
    fun savedValuesAreEditedAndUnknownKeysAreKept() {
        val form = codexForm()
        val saved = mapOf(
            "useSystemCodex" to false,
            "codexHome" to "~/c",
            "environment" to mapOf("A" to "1", "B" to null),
            "modelGateway" to mapOf("baseUrl" to "https://g", "apiKey" to "k"),
            "customModels" to listOf(mapOf("modelId" to "m", "displayName" to "M", "efforts" to listOf(mapOf("effortId" to "high", "displayName" to "High")))),
            "legacy" to "kept",
        )
        val draft = form.draft(saved)

        val config = (draft.result() as RuntimeConfigResult.Valid).config

        assertEquals(saved + ("idleTimeoutSeconds" to 600L), config)
        assertFalse(draft.hasChanges)
    }

    @Test
    fun emptyOptionalValuesAreLeftOutAndRemovedVariablesAreNull() {
        val draft = codexForm().draft(null)
            .update("environment", RuntimeConfigInput.Environment(listOf(RuntimeEnvironmentRow("PATH", removesInherited = true), RuntimeEnvironmentRow(" "))))
            .update("idleTimeoutSeconds", RuntimeConfigInput.Text(" "))

        val config = (draft.result() as RuntimeConfigResult.Valid).config

        assertEquals(
            mapOf("useSystemCodex" to true, "environment" to mapOf("PATH" to null), "customModels" to emptyList<Any?>()),
            config,
        )
        assertTrue(draft.hasChanges)
    }

    @Test
    fun valuesThatBreakTheSchemaAreReportedPerField() {
        val draft = codexForm().draft(null)
            .update("codexHome", RuntimeConfigInput.Text("/far/too/long"))
            .update("modelGateway", RuntimeConfigInput.Gateway(RuntimeGatewayDraft("ftp://g", "k")))
            .update("idleTimeoutSeconds", RuntimeConfigInput.Text("10"))
            .update("environment", RuntimeConfigInput.Environment(listOf(RuntimeEnvironmentRow("A=B", "1"))))
            .update("customModels", RuntimeConfigInput.Models(listOf(RuntimeCustomModelRow("m", "M"), RuntimeCustomModelRow("m", "Again"))))

        val issues = (draft.result() as RuntimeConfigResult.Invalid).issues

        assertEquals(RuntimeConfigIssue.TooLong, issues["codexHome"])
        assertEquals(RuntimeConfigIssue.InvalidFormat, issues["modelGateway"])
        assertEquals(RuntimeConfigIssue.OutOfRange, issues["idleTimeoutSeconds"])
        assertEquals(RuntimeConfigIssue.InvalidFormat, issues["environment"])
        assertEquals(RuntimeConfigIssue.DuplicateModel, issues["customModels"])
    }

    @Test
    fun typedTextIsCheckedBeforeTheSchema() {
        val draft = codexForm().draft(null)
            .update("idleTimeoutSeconds", RuntimeConfigInput.Text("ten"))
            .update("environment", RuntimeConfigInput.Environment(listOf(RuntimeEnvironmentRow("A"), RuntimeEnvironmentRow("A"))))

        val issues = (draft.result() as RuntimeConfigResult.Invalid).issues

        assertEquals(RuntimeConfigIssue.InvalidNumber, issues["idleTimeoutSeconds"])
        assertEquals(RuntimeConfigIssue.DuplicateVariable, issues["environment"])
    }

    @Test
    fun aNamedInstanceMustFillItsRequiredFieldsAndResetKeepsThem() {
        val form = codexForm(requiredFields = listOf("modelGateway"))
        val missing = (form.draft(null).result() as RuntimeConfigResult.Invalid).issues
        val gateway = RuntimeConfigInput.Gateway(RuntimeGatewayDraft("https://g", "k"))
        val filled = form.draft(mapOf("modelGateway" to mapOf("baseUrl" to "https://g", "apiKey" to "k")))
            .update("codexHome", RuntimeConfigInput.Text("~/x"))

        val reset = filled.resetToDefaults()

        assertEquals(RuntimeConfigIssue.Required, missing["modelGateway"])
        assertTrue(form.fields.single { it.id == "modelGateway" }.required)
        assertEquals(gateway, reset.inputs["modelGateway"])
        assertEquals(RuntimeConfigInput.Text(""), reset.inputs["codexHome"])
    }

    @Test
    fun jsonFieldsAcceptJsonTextOnly() {
        val form = RuntimeConfigForm.from(
            mapOf("type" to "object", "properties" to mapOf("historyDirs" to mapOf("type" to "array", "items" to mapOf("type" to "string")))),
            emptyMap(),
            emptyMap(),
        )!!
        val valid = form.draft(null).update("historyDirs", RuntimeConfigInput.Text("[\"/a\", \"/b\"]"))
        val invalid = form.draft(null).update("historyDirs", RuntimeConfigInput.Text("[/a"))
        val wrongType = form.draft(null).update("historyDirs", RuntimeConfigInput.Text("[1]"))

        assertEquals(mapOf("historyDirs" to listOf("/a", "/b")), (valid.result() as RuntimeConfigResult.Valid).config)
        assertEquals(RuntimeConfigIssue.InvalidJson, (invalid.result() as RuntimeConfigResult.Invalid).issues["historyDirs"])
        assertEquals(RuntimeConfigIssue.UnsupportedValue, (wrongType.result() as RuntimeConfigResult.Invalid).issues["historyDirs"])
    }

    @Test
    fun aRuntimeWithoutASchemaHasNoForm() {
        assertNull(RuntimeConfigForm.from(null, emptyMap(), emptyMap()))
    }
}
