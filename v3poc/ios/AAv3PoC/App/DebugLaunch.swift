import Darwin
import Foundation

/// Debug switches for screenshots (simctl has no tap tool). Pass them with the `SIMCTL_CHILD_` prefix.
nonisolated enum DebugLaunch {
    private static let env = ProcessInfo.processInfo.environment

    /// `AA_POC_DRAWER=1`: start with the phone drawer open.
    static var drawerOpen: Bool { env["AA_POC_DRAWER"] == "1" }
    /// `AA_POC_DRAWER_HOLD=0.5`: start with the phone drawer held part-way open, as in the middle of a drag (screenshots).
    static var drawerHold: Double? { env["AA_POC_DRAWER_HOLD"].flatMap(Double.init) }
    /// `AA_POC_CARD_CLIP=layer|config|mask`: how the drawer card is rounded (comparison only; default `layer`).
    static var cardClip: String { env["AA_POC_CARD_CLIP"] ?? "layer" }
    /// `AA_POC_SHEET=options`: open the composer options sheet after launch.
    static var sheet: String? { env["AA_POC_SHEET"] }
    /// `AA_POC_SCHEME=dark|light`.
    static var scheme: String? { env["AA_POC_SCHEME"] }
    /// `AA_POC_AUTO_APPROVE_SECONDS=n`: answer a waiting approval with its first allow option after n seconds.
    static var autoApproveSeconds: Double? { env["AA_POC_AUTO_APPROVE_SECONDS"].flatMap(Double.init) }
    /// `AA_POC_SESSION=<id>`: the session to open first (default: the demo session).
    static var session: String? { env["AA_POC_SESSION"] }
    /// `AA_POC_FOCUS=1`: focus the composer (shows the software keyboard if the simulator has it enabled).
    static var focus: Bool { env["AA_POC_FOCUS"] == "1" }
    /// `AA_POC_RENDERER_PATH=/abs/file.html`: load a renderer from the host file system instead of the bundle.
    static var rendererPath: String? { env["AA_POC_RENDERER_PATH"] }
    /// `AA_POC_SCROLL_UP=n`: after the renderer is ready, scroll the thread up by n points (shows the 到底部 pill).
    static var scrollUp: Double? { env["AA_POC_SCROLL_UP"].flatMap(Double.init) }
    /// `AA_POC_BACKDROP=white|black|image|stripes`: cover the page with a fixed layer of that background (above the
    /// thread, below the native chrome) to check the chrome's contrast over the worst content.
    static var backdrop: String? { env["AA_POC_BACKDROP"].flatMap { $0.isEmpty ? nil : $0 } }
    /// `AA_POC_LAYOUT_CHECK=1`: log the 到底部 pill's and the bottom bar's frames on every chrome layout (`[layout]`).
    static var layoutCheck: Bool { env["AA_POC_LAYOUT_CHECK"] == "1" }
    /// `AA_POC_SWITCH=s-release@5,s-unread@9`: select these sessions n seconds after launch (switching without taps).
    /// `AA_POC_MEMORY_WARNING=60,62`: a system memory warning n seconds after launch (simctl has no command for the
    /// Simulator's Debug → Simulate Memory Warning; this calls the same private UIKit entry point).
    /// `AA_POC_REWATCH=8,14`: n seconds after launch, start the selected session's `watch` again, as after a dropped
    /// connection (its snapshot then goes to the renderer as a delta, or not at all if nothing changed).
    static var rewatches: [Double] {
        (env["AA_POC_REWATCH"] ?? "").split(separator: ",").compactMap { Double($0) }
    }

    static var memoryWarnings: [Double] {
        (env["AA_POC_MEMORY_WARNING"] ?? "").split(separator: ",").compactMap { Double($0) }
    }

    static var switches: [(id: String, seconds: Double)] {
        (env["AA_POC_SWITCH"] ?? "").split(separator: ",").compactMap { entry in
            let parts = entry.split(separator: "@")
            guard parts.count == 2, let seconds = Double(parts[1]) else { return nil }
            return (String(parts[0]), seconds)
        }
    }
}

/// Startup timing, logged to stderr as `[AAv3PoC] +123ms label`.
nonisolated enum LaunchClock {
    /// When the kernel started this process (earlier than any Swift code runs).
    static let processStart: Date = {
        var info = kinfo_proc()
        var size = MemoryLayout<kinfo_proc>.stride
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, getpid()]
        guard sysctl(&mib, 4, &info, &size, nil, 0) == 0 else { return Date() }
        let start = info.kp_proc.p_un.__p_starttime
        return Date(timeIntervalSince1970: Double(start.tv_sec) + Double(start.tv_usec) / 1_000_000)
    }()

    static func milliseconds(since date: Date = processStart) -> Int {
        Int(Date().timeIntervalSince(date) * 1000)
    }

    static func mark(_ label: String) {
        log("+\(milliseconds())ms \(label)")
    }

    static func log(_ message: String) {
        let line = Data("[AAv3PoC] \(message)\n".utf8)
        FileHandle.standardError.write(line)
        logFile?.write(line)
    }

    /// `AA_POC_LOG_PATH=/abs/file.log`: also append the log there (UI-test runs have no stderr capture).
    private static let logFile: FileHandle? = {
        guard let path = ProcessInfo.processInfo.environment["AA_POC_LOG_PATH"] else { return nil }
        // O_APPEND: a UI test appends its own `[test]` marks to the same file; every write lands at the current end.
        let fd = open(path, O_WRONLY | O_CREAT | O_APPEND, 0o644)
        return fd >= 0 ? FileHandle(fileDescriptor: fd, closeOnDealloc: true) : nil
    }()
}
