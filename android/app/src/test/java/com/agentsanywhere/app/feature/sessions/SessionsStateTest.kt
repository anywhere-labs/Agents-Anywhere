package com.agentsanywhere.app.feature.sessions

import com.agentsanywhere.app.model.AgentSession
import com.agentsanywhere.app.model.SessionStatus
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.assertThrows
import org.junit.Test

class SessionsStateTest {
    @Test
    fun patchedSessionUsesAuthoritativeArchiveStateAndRejectsOlderResponses() {
        val current = session(id = "one", archived = false, pinned = true, updatedSeq = 8)
        val state = SessionsState(sessions = listOf(current), hasLoaded = true)

        val stale = state.withPatchedSession(current.copy(archived = true, pinned = false, updatedSeq = 7))
        assertEquals(state, stale)

        val request = state.beginSessionRequest(listOf("one"))
        val authoritative = request.state.withPatchedSession(
            current.copy(archived = true, pinned = false, updatedSeq = 9),
            request.generation,
        )
        assertTrue(authoritative.sessions.isEmpty())
        assertEquals(listOf("one"), authoritative.archivedSessions.map { it.id })
        assertFalse(authoritative.archivedSessions.single().pinned)
    }

    @Test
    fun refreshCannotOverwriteNewerSessionMetadata() {
        val initial = SessionsState(
            sessions = listOf(session(id = "one", title = "before", updatedSeq = 10)),
            hasLoaded = true,
        )
        val refresh = initial.beginSessionRequest()
        val mutation = refresh.state.beginSessionRequest(listOf("one"))
        val current = mutation.state.withPatchedSession(
            session(id = "one", title = "new", updatedSeq = 10),
            mutation.generation,
        )
        val loaded = SessionsState(
            sessions = listOf(
                session(id = "one", title = "old", updatedSeq = 9),
                session(id = "two", title = "server", updatedSeq = 2),
            ),
            hasLoaded = true,
        )

        val merged = current.mergedWithRefresh(loaded, refresh.generation)

        assertEquals("new", merged.sessions.first { it.id == "one" }.title)
        assertEquals("server", merged.sessions.first { it.id == "two" }.title)
    }

    @Test
    fun readWatermarkIsMonotonicWhenUpdatedSequenceDoesNotChange() {
        val read = session(
            id = "one",
            updatedSeq = 8,
            unread = false,
            lastReadSeq = 8,
        )
        val staleUnread = read.copy(unread = true, lastReadSeq = 3)

        val merged = mergeObservedSession(read, staleUnread)

        assertFalse(merged.unread)
        assertEquals(8, merged.lastReadSeq)
    }

    @Test
    fun observedRuntimeProgressDoesNotReplaceAuthoritativeMetadata() {
        val current = session(id = "one", title = "renamed", pinned = true, updatedSeq = 8)
        val observed = session(id = "one", title = "stale", pinned = false, updatedSeq = 9)

        val merged = mergeObservedSession(current, observed)

        assertEquals(9, merged.updatedSeq)
        assertEquals("renamed", merged.title)
        assertTrue(merged.pinned)
    }

    @Test
    fun olderMutationResponseCannotOverwriteLatestRequest() {
        val initial = SessionsState(
            sessions = listOf(session(id = "one", title = "before", updatedSeq = 8)),
        )
        val first = initial.beginSessionRequest(listOf("one"))
        val second = first.state.beginSessionRequest(listOf("one"))
        val latest = second.state.withPatchedSession(
            session(id = "one", title = "latest", updatedSeq = 8),
            second.generation,
        )

        val afterOldResponse = latest.withPatchedSession(
            session(id = "one", title = "stale", updatedSeq = 8),
            first.generation,
        )

        assertEquals("latest", afterOldResponse.sessions.single().title)
    }

    @Test
    fun refreshPreservesSessionCreatedAfterRequestStarted() {
        val refresh = SessionsState(hasLoaded = true).beginSessionRequest()
        val create = refresh.state.beginSessionRequest()
        val current = create.state.withPatchedSession(
            session(id = "created", updatedSeq = 1),
            create.generation,
        )

        val merged = current.mergedWithRefresh(
            SessionsState(hasLoaded = true),
            refresh.generation,
        )

        assertEquals(listOf("created"), merged.sessions.map { it.id })
    }

    @Test
    fun laterRefreshCanConvergeExternalMetadata() {
        val current = SessionsState(
            sessions = listOf(session(id = "one", title = "local", updatedSeq = 8)),
            sessionRequestGenerations = mapOf("one" to 2L),
            nextRequestGeneration = 3L,
        )
        val refresh = current.beginSessionRequest()
        val loaded = SessionsState(
            sessions = listOf(session(id = "one", title = "remote", updatedSeq = 8)),
            hasLoaded = true,
        )

        val merged = refresh.state.mergedWithRefresh(loaded, refresh.generation)

        assertEquals("remote", merged.sessions.single().title)
    }

    @Test
    fun partialNotFoundRemovesMissingSessionsWithoutRollingBackSuccesses() {
        val state = SessionsState(
            sessions = listOf(
                session(id = "updated", updatedSeq = 1),
                session(id = "missing", updatedSeq = 1),
                session(id = "untouched", updatedSeq = 1),
            ),
        )

        val request = state.beginSessionRequest(listOf("updated", "missing"))
        val next = request.state
            .withPatchedSessions(
                listOf(session(id = "updated", archived = true, updatedSeq = 2)),
                request.generation,
            )
            .withMissingSessionsRemoved(listOf("missing"), request.generation)

        assertEquals(listOf("untouched"), next.sessions.map { it.id })
        assertEquals(listOf("updated"), next.archivedSessions.map { it.id })
    }

    @Test
    fun mutationIdsAreDeduplicatedInCallerOrderAndLimitedToTwoHundred() {
        assertEquals(listOf("two", "one"), normalizeSessionIds(listOf("two", "one", "two")))
        assertEquals(emptyList<String>(), normalizeSessionIds(emptyList()))

        val ids = List(200) { "session-$it" }
        assertEquals(200, validatedSessionMutationIds(ids).size)
        assertThrows(IllegalArgumentException::class.java) {
            validatedSessionMutationIds(ids + "session-200")
        }
    }

    private fun session(
        id: String,
        title: String = id,
        archived: Boolean = false,
        pinned: Boolean = false,
        updatedSeq: Int,
        unread: Boolean = false,
        lastReadSeq: Int = if (unread) 0 else updatedSeq,
    ): AgentSession {
        return AgentSession(
            id = id,
            connectorId = "connector",
            deviceName = "Device",
            title = title,
            summary = "",
            cwd = "/workspace",
            workspaceLabel = "workspace",
            runtime = "codex",
            runtimeLabel = "Codex",
            status = SessionStatus.Idle,
            statusLabel = "Idle",
            updatedAtLabel = "now",
            metaLabel = "Codex · Device · workspace",
            pinned = pinned,
            archived = archived,
            unread = unread,
            lastReadSeq = lastReadSeq,
            takeover = false,
            connectorOnline = true,
            live = false,
            sortKey = "2026-08-10T00:00:00Z",
            updatedSeq = updatedSeq,
        )
    }
}
