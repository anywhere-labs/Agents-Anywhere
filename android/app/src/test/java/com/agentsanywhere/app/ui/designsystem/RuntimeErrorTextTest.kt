package com.agentsanywhere.app.ui.designsystem

import com.agentsanywhere.app.R
import com.agentsanywhere.app.api.ApiException
import com.agentsanywhere.app.feature.sessiondetail.NativeHistoryRejected
import com.agentsanywhere.app.feature.sessions.RuntimeOperationFailure
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class RuntimeErrorTextTest {
    @Test
    fun knownCodesMapToResourcesAndUnknownCodesFallBack() {
        assertEquals(R.string.runtime_error_pi_source_ambiguous, runtimeErrorRes("pi_source_ambiguous"))
        assertEquals(R.string.runtime_error_runtime_not_running, runtimeErrorRes("runtime_not_running"))
        assertNull(runtimeErrorRes("brand_new_code"))
        assertNull(runtimeErrorRes(null))
    }

    @Test
    fun failuresKeepTheirStableCode() {
        assertEquals("runtime_not_running", runtimeErrorCode(ApiException("请先启动 Runtime。", 409, errorCode = "runtime_not_running")))
        assertEquals("pi_resume_failed", runtimeErrorCode(NativeHistoryRejected("pi_resume_failed", "x")))
        assertEquals("native_history_recovery_unconfirmed", runtimeErrorCode(RuntimeOperationFailure("native_history_recovery_unconfirmed", "x")))
        assertNull(runtimeErrorCode(IllegalStateException("plain")))
        val upgrade = ApiException("Upgrade Agents Anywhere on this device to use this.", 409, errorCode = "device_upgrade_required")
        assertEquals("device_upgrade_required", runtimeErrorCode(IllegalStateException("Could not load files.", upgrade)))
    }
}
