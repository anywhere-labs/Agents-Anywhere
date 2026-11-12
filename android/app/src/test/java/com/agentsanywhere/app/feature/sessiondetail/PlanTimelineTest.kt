package com.agentsanywhere.app.feature.sessiondetail

import com.agentsanywhere.app.api.PlanDocument
import com.agentsanywhere.app.api.PlanDraft
import com.agentsanywhere.app.api.PlanReview
import com.agentsanywhere.app.api.RemotePlanningState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PlanTimelineTest {
    private fun message(id: String, author: MessageAuthor, createdAt: String, text: String = "", role: String? = null) =
        TimelineMessage(id = id, author = author, text = text, createdAt = createdAt, sourceRole = role)

    private fun plan(planId: String, revision: Int, createdAt: String?, markdown: String = "plan $planId:$revision") =
        PlanDocument(planId, revision, "h", "t", markdown, createdAt)

    @Test
    fun approvedPlanSitsDirectlyAboveTheImplementation() {
        val groups = listOf(
            "ask" to listOf(message("u1", MessageAuthor.User, "2026-10-30T10:00:00+00:00")),
            "implement" to listOf(message("u2", MessageAuthor.User, "2026-10-30T10:05:00Z")),
        )
        val placement = placePlanDocuments(listOf(plan("p", 1, "2026-10-30T10:01:30.123456+00:00")), groups)
        assertEquals(listOf("implement"), placement.before.keys.toList())
        assertTrue(placement.end.isEmpty())
    }

    @Test
    fun plansUnderReviewOrWithoutTimeStayAtTheEndInOrder() {
        val groups = listOf("ask" to listOf(message("u1", MessageAuthor.User, "2026-10-30T10:00:00Z")))
        val placement = placePlanDocuments(listOf(plan("q", 1, null), plan("p", 1, "2026-10-30T10:01:00Z")), groups)
        assertTrue(placement.before.isEmpty())
        assertEquals(listOf("p", "q"), placement.end.map { it.planId })
    }

    @Test
    fun systemEchoOfAPlanOrItsDraftIsHidden() {
        val state = RemotePlanningState(
            "s", "plan", "fresh", "e", 1, PlanDraft("d", "draft so far and more", "drafting"), null,
            PlanReview("r", "p", 1, "h", "open"), emptyList(), null,
        )
        val documents = listOf(plan("p", 1, null, "# Plan\n\nbody"))
        assertTrue(isPlanEcho(state, documents, message("s1", MessageAuthor.Agent, "", " # Plan\n\nbody \n", "system")))
        assertTrue(isPlanEcho(state, documents, message("s2", MessageAuthor.Agent, "", "draft so far", "system")))
        assertFalse(isPlanEcho(state, documents, message("s3", MessageAuthor.Agent, "", "unrelated", "system")))
        assertFalse(isPlanEcho(state, documents, message("a1", MessageAuthor.Agent, "", "# Plan\n\nbody", "assistant")))
        assertEquals(mapOf("p" to 2), latestPlanRevisions(listOf(plan("p", 1, null), plan("p", 2, null))))
        val bodiless = PlanDocument("p", 1, planContentHash("old body"), "t", "", null)
        assertTrue(isPlanEcho(null, listOf(bodiless), message("s4", MessageAuthor.Agent, "", "old body", "system")))
        assertEquals("sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824", planContentHash("hello"))
    }
}
