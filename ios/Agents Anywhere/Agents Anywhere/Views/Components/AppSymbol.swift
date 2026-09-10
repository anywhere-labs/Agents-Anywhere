import SwiftUI

/// Web's Lucide paths rendered as native template vectors. Native controls keep
/// their system drawing; app-owned actions share this mapping across screens.
struct AppSymbol: View {
    let name: String
    @ScaledMetric(relativeTo: .body) private var size: CGFloat = 20

    init(_ name: String, size: CGFloat = 20) {
        self.name = name
        _size = ScaledMetric(wrappedValue: size, relativeTo: .body)
    }

    private var image: Image {
        if let asset = AppSymbolAssets.names[name] { Image(asset) }
        else { Image("aa-CircleHelp") }
    }

    var body: some View {
        image.resizable().scaledToFit().frame(width: size, height: size).accessibilityHidden(true)
    }

    func resizable() -> Image { image.resizable() }
}

extension Label where Title == Text, Icon == AppSymbol {
    init(_ title: String, appSymbol: String) {
        self.init { Text(verbatim: title) } icon: { AppSymbol(appSymbol) }
    }
    init(_ title: LocalizedStringResource, appSymbol: String) {
        self.init { Text(title) } icon: { AppSymbol(appSymbol) }
    }
}

extension Button where Label == SwiftUI.Label<Text, AppSymbol> {
    init(_ title: String, appSymbol: String, role: ButtonRole? = nil, action: @escaping () -> Void) {
        self.init(role: role, action: action) { SwiftUI.Label(title, appSymbol: appSymbol) }
    }
}

extension ContentUnavailableView where Label == SwiftUI.Label<Text, AppSymbol>, Description == Text?, Actions == EmptyView {
    init(_ title: String, appSymbol: String, description: Text? = nil) {
        self.init {
            SwiftUI.Label { Text(verbatim: title) } icon: { AppSymbol(appSymbol, size: 36) }
        } description: { description }
    }
}

enum AppFileSymbol {
    /// Same extension groups as Web's FileTypeIcon.
    static func name(for filename: String) -> String {
        let ext = filename.lowercased().split(separator: ".").last.map(String.init) ?? ""
        if ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico"].contains(ext) { return "doc.text.image" }
        if ["zip", "tar", "gz", "7z", "rar"].contains(ext) { return "doc.zipper" }
        if ["mp3", "wav", "ogg", "aac", "m4a"].contains(ext) { return "music.note" }
        if ["mp4", "mov", "webm", "avi"].contains(ext) { return "video" }
        if ["csv", "xlsx", "xls"].contains(ext) { return "tablecells" }
        if ["ts", "tsx", "js", "jsx", "json", "py", "rs", "go", "java", "c", "cpp", "h", "css", "html", "vue", "sh", "yaml", "yml", "toml", "swift"].contains(ext) { return "doc.text.magnifyingglass" }
        if ["md", "mdx", "txt", "log", "pdf"].contains(ext) { return "doc.text" }
        return "doc"
    }
}
