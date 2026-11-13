package com.agentsanywhere.app.feature.sessions

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class NewSessionTitleTest {
    @Test
    fun untouchedPlaceholderIsNotSentAsTitle() {
        assertNull(explicitSessionTitle("新建会话", placeholder = "新建会话"))
        assertNull(explicitSessionTitle("  New Session ", placeholder = "New Session"))
    }

    @Test
    fun blankTitleIsNotSent() {
        assertNull(explicitSessionTitle("   ", placeholder = "New Session"))
    }

    @Test
    fun userTypedTitleIsTrimmedAndSent() {
        assertEquals("Fix login bug", explicitSessionTitle("  Fix login bug ", placeholder = "New Session"))
    }
}
