import SwiftUI
import AppKit

// 静态设计稿渲染：用基础容器拼出与 SpecRuneTasksView 相同的视觉，
// 规避 ImageRenderer 在 CLI 下对 NavigationSplitView/List 的不支持。
// 仅用于评审视觉，不参与真实实现。

struct MockTask: Identifiable {
    let id = UUID(); let title: String; let statusText: String; let statusColor: Color
    let priority: String?; let done: Int; let total: Int; let assignee: String; let time: String
    let note: String?
}

let projects: [(String,Int,Int)] = [("Agents Anywhere",3,1),("SpecRune",1,1),("web-next",1,0)]

let tasks: [MockTask] = [
    .init(title:"SpecRune 看板上手机", statusText:"进行中", statusColor:.blue, priority:"P1", done:1,total:4, assignee:"dae", time:"2 分钟前", note:"1/4 子任务"),
    .init(title:"同步上游 92 提交（2.2.0）", statusText:"已完成", statusColor:.green, priority:"P0", done:6,total:6, assignee:"dae", time:"2 天前", note:"6/6 实施清单"),
    .init(title:"iPhone Duo 原始壳", statusText:"进行中", statusColor:.blue, priority:"P2", done:2,total:5, assignee:"dae", time:"5 天前", note:"2/5 子任务"),
    .init(title:"附件上传优化", statusText:"规划中", statusColor:.gray, priority:"P2", done:0,total:0, assignee:"kai", time:"9 天前", note:nil),
]

func secondary() -> Color { Color.black.opacity(0.58) }

@MainActor func renderImpl(_ duo: Bool) {
    let w: CGFloat = duo ? 900 : 393
    let h: CGFloat = duo ? 1200 : 852
    let root = HStack(spacing: 0) {
        if duo {
            // 项目侧栏
            VStack(alignment:.leading, spacing:0) {
                Text("SpecRune").font(.title3.weight(.bold)).padding(.horizontal,16).padding(.vertical,14)
                ForEach(Array(projects.enumerated()), id:\.offset) { i,p in
                    HStack {
                        VStack(alignment:.leading, spacing:3) {
                            Text(p.0).font(.body.weight(.medium))
                            Text("\(p.1) 进行中 · \(p.2) 已完成").font(.caption).foregroundStyle(secondary())
                        }
                        Spacer()
                    }
                    .padding(.horizontal,16).padding(.vertical,9)
                    .background(i==0 ? Color.black.opacity(0.08) : Color.clear)
                }
                Spacer()
            }.frame(width:240).background(Color.black.opacity(0.03))
            Divider()
        }
        // 任务列
        VStack(alignment:.leading, spacing:0) {
            Text(duo ? "Agents Anywhere" : "任务").font(.title2.weight(.bold)).padding(16)
            VStack(spacing:0) {
                HStack { Text("进行中 · 3").font(.footnote.weight(.semibold)).foregroundStyle(secondary()); Spacer() }.padding(.horizontal,16).padding(.top,8)
                ForEach(tasks) { t in taskRow(t, compact: !duo) }
                Spacer()
            }
        }
        .frame(maxWidth:.infinity)
        .background(Color.white)
        if duo {
            Divider()
            detailPane().frame(width:330)
        }
    }
        .frame(width:w, height:h)
        .background(Color.white)
        .clipped()
    let renderer = ImageRenderer(content: root.environment(\.colorScheme,.light))
    renderer.scale = 2
    if let img = renderer.nsImage, let tiff = img.tiffRepresentation, let rep = NSBitmapImageRep(data:tiff), let png = rep.representation(using:.png, properties:[:]) {
        let name = duo ? "mock_duo_inner" : "mock_iphone"
        try? png.write(to: URL(fileURLWithPath:"/tmp/specrune_render/\(name).png"))
        print("wrote", name)
    } else { print("fail") }
}

func taskRow(_ t: MockTask, compact: Bool) -> some View {
    VStack(alignment:.leading, spacing:7) {
        HStack(spacing:8) {
            Circle().fill(t.statusColor).frame(width:8,height:8)
            Text(t.title).font(.subheadline.weight(.medium)).lineLimit(2)
            Spacer(minLength:4)
            if let p = t.priority {
                Text(p).font(.caption2.weight(.semibold))
                    .padding(.horizontal,6).padding(.vertical,2)
                    .background(p=="P0" ? Color.red.opacity(0.16) : Color.black.opacity(0.05), in: .rect(cornerRadius:5))
                    .foregroundStyle(p=="P0" ? Color.red : secondary())
            }
        }
        HStack(spacing:10) {
            if t.total>0 {
                ZStack(alignment:.leading) {
                    Capsule().fill(Color.black.opacity(0.06)).frame(width:70,height:4)
                    Capsule().fill(t.statusColor.opacity(0.7)).frame(width:90*CGFloat(t.done)/CGFloat(t.total),height:4)
                }
                Text(t.note ?? "").font(.caption2).foregroundStyle(secondary()).lineLimit(1).fixedSize()
            }
            if t.priority != nil || t.total>0 {}
            Label(t.assignee, systemImage:"person.crop.circle").font(.caption2).foregroundStyle(secondary()).lineLimit(1).fixedSize()
            Spacer(minLength:0)
            Text(t.time).font(.caption2).foregroundStyle(secondary()).lineLimit(1).fixedSize()
        }
    }
    .padding(.horizontal,16).padding(.vertical,10)
    .overlay(alignment:.bottom){ Divider().padding(.leading,16) }
}

func detailPane() -> some View {
    VStack(alignment:.leading, spacing:20) {
            HStack(spacing:10) {
                Text("进行中").font(.caption.weight(.semibold)).padding(.horizontal,9).padding(.vertical,4)
                    .background(Color.black.opacity(0.05), in:.capsule)
                Text("P1").font(.caption.weight(.semibold)).foregroundStyle(secondary())
                Spacer()
                Text("11-16-specrune-mobile").font(.caption.monospaced()).foregroundStyle(secondary())
            }
            VStack(alignment:.leading, spacing:6) {
                HStack { Text("子任务").font(.subheadline.weight(.medium)); Spacer(); Text("1 / 4").font(.subheadline.monospacedDigit()).foregroundStyle(secondary()) }
                ProgressView(value:1,total:4)
            }
            HStack(spacing:16) {
                Label("dae", systemImage:"person.crop.circle")
                Label("2026/11/16 01:00", systemImage:"clock")
            }.font(.footnote).foregroundStyle(secondary())
            Divider()
            VStack(alignment:.leading, spacing:10) {
                Text("验收清单").font(.headline)
                Text("（原型示例；接入 implement.md 后由 parseChecklist 解析）").font(.caption).foregroundStyle(secondary())
                Label("契约字段核对完成", systemImage:"square").font(.subheadline)
                Label("Connector 只读 RPC 落地", systemImage:"square").font(.subheadline)
                Label("手机端只读看板 MVP", systemImage:"square").font(.subheadline)
            }
            Divider()
            VStack(alignment:.leading, spacing:10) {
                Text("规范引用").font(.headline)
                HStack { Image(systemName:"chevron.right").font(.caption); Text("backend/runtime-commands.md").font(.subheadline.monospaced()); Spacer() }
            }
    }
    .padding(20)
    .frame(maxWidth:.infinity, alignment:.top)
    .background(Color.white)
}


// top-level
Task { @MainActor in
    try? FileManager.default.createDirectory(atPath:"/tmp/specrune_render", withIntermediateDirectories:true)
    renderImpl(true)
    renderImpl(false)
    exit(0)
}
dispatchMain()
