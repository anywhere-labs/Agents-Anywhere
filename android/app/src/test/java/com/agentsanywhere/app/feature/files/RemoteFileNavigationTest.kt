package com.agentsanywhere.app.feature.files

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RemoteFileNavigationTest {
    @Test
    fun windowsParentPathWalksBackToDriveOverview() {
        assertEquals("C:\\Users", remoteParentPath("C:\\Users\\Admin", "windows"))
        assertEquals("C:\\", remoteParentPath("C:\\Users", "windows"))
        assertEquals("", remoteParentPath("C:\\", "windows"))
        assertNull(remoteParentPath("", "windows"))
    }

    @Test
    fun windowsRequestUsesDriveRootForAbsolutePaths() {
        assertEquals(
            RemoteFileRequest(root = "D:\\", path = "D:\\Projects"),
            remoteFileRequest("D:\\Projects", "windows", "C:\\Users\\Admin"),
        )
        assertEquals(
            RemoteFileRequest(root = "C:\\Users\\Admin", path = ""),
            remoteFileRequest("", "windows", "C:\\Users\\Admin"),
        )
    }

    @Test
    fun posixParentPathStopsAtFilesystemRoot() {
        assertEquals("/Users", remoteParentPath("/Users/admin", "darwin"))
        assertEquals("/", remoteParentPath("/Users", "darwin"))
        assertNull(remoteParentPath("/", "darwin"))
    }

    @Test
    fun windowsDriveOverviewIsNotSelectableAsWorkspace() {
        assertTrue(isWindowsDriveOverview("", "windows"))
        assertFalse(isSelectableRemoteDirectory("", "windows"))
        assertTrue(isSelectableRemoteDirectory("C:\\Users", "windows"))
    }

    @Test
    fun displayPathShowsActualRootInsteadOfFallbackRoot() {
        assertEquals("/", displayRemotePath("/Users/admin", "/", "darwin"))
        assertEquals("This PC", displayRemotePath("C:\\Users\\Admin", "", "windows", "This PC"))
    }

    @Test
    fun canonicalPathKeepsWindowsDriveOverviewStable() {
        assertEquals(
            "",
            canonicalRemoteDirectoryPath(
                request = RemoteFileRequest(root = "C:\\", path = ""),
                returnedPath = "C:\\",
                deviceOs = "windows",
            ),
        )
    }

    @Test
    fun canonicalPathKeepsPosixRootStableWhenBackendReturnsDot() {
        assertEquals(
            "/",
            canonicalRemoteDirectoryPath(
                request = RemoteFileRequest(root = "/Users/admin", path = "/"),
                returnedPath = ".",
                deviceOs = "darwin",
            ),
        )
    }
}
