package com.agentsanywhere.app.feature.sessiondetail

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SessionSteerCapabilityTest {
    @Test
    fun steerCapabilityIdMatchesTheRuntimeProtocol() {
        assertEquals("session.steer", SESSION_STEER_CAPABILITY)
    }

    @Test
    fun onlyRunningTurnsAcceptSteering() {
        assertTrue(SessionRuntimeStatus.Running.acceptsSteer())
        assertFalse(SessionRuntimeStatus.Waiting.acceptsSteer())
        assertFalse(SessionRuntimeStatus.Pending.acceptsSteer())
        assertFalse(SessionRuntimeStatus.Stopping.acceptsSteer())
        assertFalse(SessionRuntimeStatus.WaitingApproval.acceptsSteer())
        assertFalse(SessionRuntimeStatus.Blocked.acceptsSteer())
        assertFalse(SessionRuntimeStatus.Idle.acceptsSteer())
        assertFalse(SessionRuntimeStatus.Error.acceptsSteer())
        assertFalse(SessionRuntimeStatus.Disconnected.acceptsSteer())
        assertFalse(SessionRuntimeStatus.Unknown.acceptsSteer())
    }

    @Test
    fun workingStatusesCoverEveryTurnInFlight() {
        assertTrue(SessionRuntimeStatus.Waiting.isWorking())
        assertTrue(SessionRuntimeStatus.Pending.isWorking())
        assertTrue(SessionRuntimeStatus.Running.isWorking())
        assertTrue(SessionRuntimeStatus.Stopping.isWorking())
        assertTrue(SessionRuntimeStatus.WaitingApproval.isWorking())
        assertTrue(SessionRuntimeStatus.Blocked.isWorking())
        assertFalse(SessionRuntimeStatus.Idle.isWorking())
        assertFalse(SessionRuntimeStatus.Error.isWorking())
        assertFalse(SessionRuntimeStatus.Disconnected.isWorking())
        assertFalse(SessionRuntimeStatus.Unknown.isWorking())
    }

    @Test
    fun steeringKeepsTheComposerEditableWithoutTheSendCapability() {
        assertTrue(
            sessionComposerEnabled(
                takeoverEnabled = true,
                capabilityFactsFresh = true,
                canSendMessage = false,
                canUseCommands = false,
                canSteer = true,
            ),
        )
    }

    @Test
    fun queueingKeepsTheComposerEditableWithoutLiveSendAvailability() {
        assertTrue(
            sessionComposerEnabled(
                takeoverEnabled = true,
                capabilityFactsFresh = true,
                canSendMessage = false,
                canUseCommands = false,
                canQueueMessage = true,
            ),
        )
    }

    @Test
    fun composerStaysDisabledWithoutTakeoverOrFreshFacts() {
        assertFalse(
            sessionComposerEnabled(
                takeoverEnabled = false,
                capabilityFactsFresh = true,
                canSendMessage = false,
                canUseCommands = false,
                canSteer = true,
                canQueueMessage = true,
            ),
        )
        assertFalse(
            sessionComposerEnabled(
                takeoverEnabled = true,
                capabilityFactsFresh = false,
                canSendMessage = false,
                canUseCommands = false,
                canSteer = true,
                canQueueMessage = true,
            ),
        )
    }
}
