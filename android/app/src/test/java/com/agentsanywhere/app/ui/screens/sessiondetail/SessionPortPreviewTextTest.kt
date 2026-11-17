package com.agentsanywhere.app.ui.screens.sessiondetail

import com.agentsanywhere.app.R
import com.agentsanywhere.app.feature.preview.PortPreviewError
import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.File
import javax.xml.parsers.DocumentBuilderFactory

/**
 * Contract codes read as in runtime-errors 1.1; the rest as on Web. Unit tests
 * have no Android resources, so the string XML is read directly.
 */
class SessionPortPreviewTextTest {
    @Test
    fun previewErrorsUseTheirContractText() {
        val zh = text("values-zh-rCN")
        assertEquals("只能预览本机（127.0.0.1）上已确认的端口。", zh(PortPreviewError.PortNotAllowed))
        assertEquals("这台设备打开的预览已达上限，请先关闭一些。", zh(PortPreviewError.LimitReached))
        assertEquals("这个服务器没有配置预览域名，无法使用端口预览。", zh(PortPreviewError.DomainNotConfigured))
        assertEquals("设备上的预览通道暂时不可用，请稍后重试。", zh(PortPreviewError.PreviewUnavailable))
        assertEquals("设备离线，上线后才能预览。", zh(PortPreviewError.ConnectorOffline))
        assertEquals("无法建立预览，请稍后重试。", zh(PortPreviewError.Failed))

        val en = text("values")
        assertEquals("Only confirmed ports on this computer (127.0.0.1) can be previewed.", en(PortPreviewError.PortNotAllowed))
        assertEquals("This device has reached the limit of open previews. Close some first.", en(PortPreviewError.LimitReached))
        assertEquals(
            "Port preview is unavailable because this server has no preview domain configured.",
            en(PortPreviewError.DomainNotConfigured),
        )
        assertEquals("The device's preview tunnel is unavailable. Try again later.", en(PortPreviewError.PreviewUnavailable))
        assertEquals("The device is offline. Preview is available once it's back.", en(PortPreviewError.ConnectorOffline))
        assertEquals("Couldn't set up the preview. Try again later.", en(PortPreviewError.Failed))
    }

    private fun text(folder: String): (PortPreviewError) -> String {
        val dir = listOf(File("src/main/res/$folder"), File("app/src/main/res/$folder")).first(File::isDirectory)
        val strings = dir.listFiles { file -> file.name.endsWith(".xml") }.orEmpty().flatMap { file ->
            val nodes = DocumentBuilderFactory.newInstance().newDocumentBuilder().parse(file).getElementsByTagName("string")
            (0 until nodes.length).map { index ->
                val node = nodes.item(index)
                node.attributes.getNamedItem("name").nodeValue to node.textContent.replace("\\'", "'")
            }
        }.toMap()
        val names = R.string::class.java.fields.associate { it.getInt(null) to it.name }
        return { error -> strings.getValue(names.getValue(portPreviewErrorText(error))) }
    }
}
