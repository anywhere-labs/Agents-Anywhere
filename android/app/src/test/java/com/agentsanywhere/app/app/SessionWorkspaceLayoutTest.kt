package com.agentsanywhere.app.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SessionWorkspaceLayoutTest {
    @Test
    fun widthUsesAvailableWindowAndClampsSidebar() {
        assertNull(workspaceSidebarWidth(599f))
        assertEquals(240f, workspaceSidebarWidth(600f)!!, 0.01f)
        assertEquals(252f, workspaceSidebarWidth(700f)!!, 0.01f)
        assertEquals(288f, workspaceSidebarWidth(800f)!!, 0.01f)
        assertEquals(320f, workspaceSidebarWidth(1000f)!!, 0.01f)
    }
}
