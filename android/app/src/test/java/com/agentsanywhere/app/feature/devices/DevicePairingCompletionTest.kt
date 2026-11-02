package com.agentsanywhere.app.feature.devices

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DevicePairingCompletionTest {
    @Test
    fun inventoryFailureDoesNotRetryAnAlreadyConsumedPairingCode() = runBlocking {
        val completion = DevicePairingCompletion()
        var claims = 0
        var checks = 0
        val claim: suspend () -> Unit = {
            claims++
            check(claims == 1) { "pairing code is not claimable" }
        }
        val inventory: suspend () -> Boolean = {
            checks++
            if (checks == 1) error("inventory temporarily unavailable")
            true
        }

        assertTrue(runCatching { completion.complete(claim, inventory) }.isFailure)
        assertTrue(completion.claimed)
        assertTrue(completion.complete(claim, inventory))
        assertEquals(1, claims)
        assertEquals(2, checks)
    }

    @Test
    fun aFailedClaimIsRetriedBeforeTheInventoryCheck() = runBlocking {
        val completion = DevicePairingCompletion()
        var claims = 0
        var checks = 0
        val claim: suspend () -> Unit = {
            claims++
            if (claims == 1) error("claim failed")
        }
        val inventory: suspend () -> Boolean = { checks++; false }

        assertTrue(runCatching { completion.complete(claim, inventory) }.isFailure)
        assertFalse(completion.claimed)
        assertEquals(0, checks)
        assertFalse(completion.complete(claim, inventory))
        assertEquals(2, claims)
        assertEquals(1, checks)
    }

    @Test
    fun cancellationAfterClaimDoesNotDiscardTheSuccessfulClaim() = runBlocking {
        val completion = DevicePairingCompletion()
        var claims = 0
        val claim: suspend () -> Unit = { claims++ }
        val failure = runCatching {
            completion.complete(claim) { throw CancellationException("check cancelled") }
        }.exceptionOrNull()

        assertTrue(failure is CancellationException)
        assertTrue(completion.complete(claim) { true })
        assertEquals(1, claims)
    }
}
