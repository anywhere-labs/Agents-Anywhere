package com.agentsanywhere.app.api

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RuntimeIdentityTest {
    @Test
    fun `extension provider types and dynamic instance ids are accepted`() {
        assertTrue("codex".isValidRuntimeType())
        assertTrue("opencode".isValidRuntimeType())
        assertTrue("vendor.runtime-v2".isValidRuntimeType())
        assertTrue("rti_work_01".isValidRuntimeInstanceId("codex"))
        assertTrue("vendor.runtime-v2".isValidRuntimeInstanceId("vendor.runtime-v2"))
    }

    @Test
    fun `runtime identity rejects reserved types and malformed instance ids`() {
        assertFalse("rti_reserved".isValidRuntimeType())
        assertFalse("Codex".isValidRuntimeType())
        assertFalse("bad runtime".isValidRuntimeType())
        assertFalse("codex:work".isValidRuntimeInstanceId("codex"))
        assertFalse("claude".isValidRuntimeInstanceId("codex"))
    }
}
