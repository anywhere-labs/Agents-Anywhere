package com.agentsanywhere.app.feature.files

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class WorkspacePathTest {
    @Test
    fun posixPathsInsideWorkspaceResolve() {
        assertEquals("/ws/shot.png", resolvePathInWorkspace("/ws", "/ws/shot.png"))
        assertEquals("/ws/out/shot.png", resolvePathInWorkspace("/ws/", "out/shot.png"))
        assertEquals("/ws/shot.png", resolvePathInWorkspace("/ws", "./out/../shot.png"))
        assertEquals("/etc/a.png", resolvePathInWorkspace("/", "/etc/a.png"))
    }

    @Test
    fun posixPathsOutsideWorkspaceAreRejected() {
        assertNull(resolvePathInWorkspace("/ws", "/ws/../etc/a.png"))
        assertNull(resolvePathInWorkspace("/ws", "../a.png"))
        assertNull(resolvePathInWorkspace("/ws", "/wsx/a.png"))
        assertNull(resolvePathInWorkspace("/ws", "/a.png"))
        assertNull(resolvePathInWorkspace("/ws", "~/a.png"))
        assertNull(resolvePathInWorkspace("/Ws", "/ws/a.png"))
        assertNull(resolvePathInWorkspace("", "/ws/a.png"))
    }

    @Test
    fun windowsPathsInsideWorkspaceResolve() {
        assertEquals("C:\\ws\\shot.png", resolvePathInWorkspace("C:\\ws", "C:\\ws\\shot.png"))
        assertEquals("C:\\WS\\shot.png", resolvePathInWorkspace("C:\\ws", "c:/WS/shot.png"))
        assertEquals("C:\\ws\\out\\shot.png", resolvePathInWorkspace("/C:/ws", "out\\shot.png"))
        assertEquals("C:\\ws\\shot.png", resolvePathInWorkspace("C:\\ws", "\\ws\\shot.png"))
        assertEquals("\\\\host\\share\\ws\\a.png", resolvePathInWorkspace("\\\\host\\share\\ws", "a.png"))
    }

    @Test
    fun windowsPathsOutsideWorkspaceAreRejected() {
        assertNull(resolvePathInWorkspace("C:\\ws", "C:\\ws\\..\\secret.png"))
        assertNull(resolvePathInWorkspace("C:\\ws", "D:\\ws\\a.png"))
        assertNull(resolvePathInWorkspace("C:\\ws", "C:a.png"))
        assertNull(resolvePathInWorkspace("C:\\ws", "C:\\wsx\\a.png"))
    }
}
