import SwiftUI

/// The phone drawer needs a navigation host inside its moving card. The iPad
/// detail already has the NavigationSplitView's host; nesting another stack
/// there would duplicate navigation chrome and safe-area handling.
struct ChatDetailNavigation: ViewModifier {
    let insets: EdgeInsets
    @Environment(\.sidebarDrawerPresentation) private var presentation
    @Environment(\.colorScheme) private var colorScheme

    func body(content: Content) -> some View {
        Group {
            if presentation == .drawer {
                NavigationStack { content }
                    .ignoresSafeArea(.keyboard)
                    // Preserve the drawer's stable, untransformed safe area,
                    // including keyboard avoidance. Pages add no other inset.
                    .padding(insets)
            } else {
                content
            }
        }
        .background(Color(uiColor: .systemBackground))
        .tint(AppTheme.primaryControlBackground(colorScheme))
    }
}

/// Duo 横屏右缘竖排注入的动作（ChatShellView 持有，页面级 toolbar 消费
/// ——shell 级 toolbar 项不进竖排，见 ChatPageToolbar.railTrailing）。
struct ChatRailContext {
    let onNewSession: () -> Void
    let onAccount: () -> Void
    /// 真实头像（缓存 UIImage）；竖排容器只收零修饰 label，此处不做
    /// frame/裁剪，交给系统按钮样式。
    var avatarImage: UIImage?
}

private struct ChatRailKey: EnvironmentKey {
    static let defaultValue: ChatRailContext? = nil
}
extension EnvironmentValues {
    var chatRail: ChatRailContext? {
        get { self[ChatRailKey.self] }
        set { self[ChatRailKey.self] = newValue }
    }
}

/// 带身份的 rail 按钮（id 编入头像状态：头像异步就绪后 id 变化强制
/// 系统重建条目——改内容不重画，真机实证 2026-10-28）。
struct ChatRailButton: Identifiable {
    let id: String
    let view: AnyView
}

/// 右缘竖排/顶栏按钮。官方规则（iPhone Duo Tech Talks / Lab Q&A）：
/// 条目要有图标+标题（Label）——竖排显图标、溢出菜单显标题；裸 UIImage
/// 是竖排容器实证可进的头像形态。
func chatRailButtons(_ rail: ChatRailContext) -> [ChatRailButton] {
    [
        ChatRailButton(id: "newSession", view: AnyView(Button(action: rail.onNewSession) {
            Label(String(localized: "新会话"), image: AppSymbolAssets.names["square.and.pencil"] ?? "aa-SquarePen")
        })),
        ChatRailButton(id: rail.avatarImage == nil ? "account-placeholder" : "account-avatar",
            view: AnyView(Button(action: rail.onAccount) {
                Image(uiImage: rail.avatarImage
                    ?? UIImage(named: AppSymbolAssets.names["person.crop.circle"] ?? "aa-CircleUserRound")!)
            }))
    ]
}

/// 系统 "…" 溢出菜单里的动作条目。
struct ChatOverflowAction: Identifiable {
    let id = UUID()
    let title: String
    /// SF Symbol：溢出菜单行左侧图标（上游原 ellipsis 菜单都有，丢了会
    /// 显得功能"消失"了 2026-10-29 用户反馈）。
    var systemImage: String? = nil
    var isDisabled = false
    /// 危险动作（如删除设备）：菜单行红字（等价 Button role: .destructive）。
    var isDestructive = false
    let handler: () -> Void
}

/// Native title/subtitle placements and toolbar items own size, spacing, glass
/// grouping and scroll-edge rendering. No header view sits in the timeline.
struct ChatPageToolbar: ViewModifier {
    let title: String
    var subtitle: String?
    var status: ChatHeaderStatus?
    var alignsTitleLeading = false
    let onMenu: () -> Void
    /// Duo 横屏（宽 detail，系统 toolbar 收编成右缘竖排）时追加的尾部
    /// 按钮。必须挂在页面级——shell 级 toolbar 项不进竖排（2026-10-27
    /// 实证：页面级 folder/… 进竖排，shell 级新会话/头像留顶部）。
    var railTrailing: [ChatRailButton] = []
    /// 页面自己的尾部功能组（folder/设备菜单等）。与 railTrailing 分属
    /// 两个 ToolbarItemGroup、中间以 ToolbarSpacer 断开——相邻同
    /// placement 的组会被系统并成一个大胶囊（真机实证 2026-10-28），
    /// 分开才能在竖排里保持两组独立折叠单位。
    var pageTrailing: [AnyView] = []
    /// 直接进系统 "…" 溢出菜单的动作（官方 ToolbarOverflowMenu，替代
    /// 自造 ellipsis 菜单——后者叠在系统溢出上形成"…"套"…"两层）。
    var overflowActions: [ChatOverflowAction] = []

    /// 抽屉形态下不要隐藏导航栏：隐藏会让 NavigationStack 内容区扩展，
    /// 页面整体上移、抽屉收起再落回（2026-11-21 实测约 80pt）。抽屉动效
    /// 已改为卡片固定、侧栏滑出（导航栏不随卡片位移），保持渲染即可让
    /// 内容位置稳定。细节见 `.specrune/spec/ios/duo-layout.md`
    /// 「合盖外屏外壳 = 原版抽屉」。

    // 位置交给系统分派，不调 toolbarVerticalBehavior：Duo 外屏（合盖）的
    // toolbar 本来就该在侧边竖排，且该开关必须当稳定选择、禁止随方向或
    // 视图状态切换——2026-11-05 按横竖屏切换试过，横屏观感反而怪。
    func body(content: Content) -> some View {
        content
            .navigationTitle(title)
            .navigationSubtitle(alignsTitleLeading ? "" : subtitle ?? "")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar(removing: .sidebarToggle)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    // Label（图标+标题）：官方规则——溢出菜单显示标题，
                    // 纯图标条目在菜单里没名字。
                    Button(action: onMenu) {
                        Label(String(localized: "打开侧栏"), image: AppSymbolAssets.names["sidebar.left"] ?? "aa-PanelLeft")
                    }
                }
                // 页面功能组（folder/…）：默认优先级——键盘压缩竖排时
                // 按官方"自下而上溢出"规则先进系统"…"菜单。
                if !pageTrailing.isEmpty {
                    ToolbarItemGroup(placement: .topBarTrailing) {
                        ForEach(pageTrailing.indices, id: \.self) { index in
                            pageTrailing[index]
                        }
                    }
                }
                if !overflowActions.isEmpty {
                    if #available(iOS 27.0, *) {
                        ToolbarOverflowMenu {
                            ForEach(overflowActions) { action in
                                Button(role: action.isDestructive ? .destructive : nil,
                                    action: action.handler) {
                                    if let systemImage = action.systemImage {
                                        Label(action.title, systemImage: systemImage)
                                    } else {
                                        Text(action.title)
                                    }
                                }
                                .disabled(action.isDisabled)
                            }
                        }
                    }
                }
                // 新会话+头像：高可见优先级（官方 iPhone Duo 规则）——
                // 键盘压缩竖排时保留在栏内，其余项溢出进系统"…"。
                ForEach(railTrailing) { button in
                    RailPinnedItem(placement: .topBarTrailing) { button.view }
                }
                if alignsTitleLeading {
                    // Use the title region's available width. A leading bar
                    // item is sized as a control and can collapse to its minimum
                    // width even when there is space between the buttons.
                    ToolbarItem(placement: .principal) {
                        VStack(alignment: .leading, spacing: 1) {
                            Text(title).font(.headline).lineLimit(1)
                                .accessibilityAddTraits(.isHeader)
                            if subtitle != nil || status != nil {
                                ChatToolbarSubtitle(subtitle: subtitle, status: status)
                            }
                        }
                        .multilineTextAlignment(.leading)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .sharedBackgroundVisibility(.hidden)
                } else if subtitle != nil || status != nil {
                    ToolbarItem(placement: .subtitle) {
                        ChatToolbarSubtitle(subtitle: subtitle, status: status)
                    }
                }
            }
    }
}

private struct ChatToolbarSubtitle: View {
    let subtitle: String?
    let status: ChatHeaderStatus?
    @ScaledMetric(relativeTo: .caption) private var lineHeight: CGFloat = 16

    private var text: String {
        [subtitle, status?.title].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
    }
    var body: some View {
        HStack(spacing: 4) {
            if let status {
                Group {
                    if status.isProgress { ProgressView().controlSize(.mini) }
                    else { AppSymbol(status.symbol, size: 12) }
                }.frame(width: lineHeight, height: lineHeight)
            }
            Text(verbatim: text).lineLimit(1)
        }
        .font(.caption).foregroundStyle(.secondary)
        .frame(height: lineHeight)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel([subtitle, status?.detail].compactMap { $0 }.joined(separator: " · "))
    }
}

struct SidebarMenuIcon: View {
    var body: some View {
        AppSymbol("sidebar.left", size: 22).accessibilityHidden(true)
    }
}

/// 高可见优先级 toolbar 项（官方 iPhone Duo 规则：键盘压缩竖排时高
/// 优先级项保留在栏内）。iOS 27+ API，26 上退回普通项。
private struct RailPinnedItem<Content: View>: ToolbarContent {
    let placement: ToolbarItemPlacement
    @ViewBuilder let content: () -> Content

    var body: some ToolbarContent {
        if #available(iOS 27.0, *) {
            ToolbarItem(placement: placement, content: content)
                .visibilityPriority(.high)
        } else {
            ToolbarItem(placement: placement, content: content)
        }
    }
}
