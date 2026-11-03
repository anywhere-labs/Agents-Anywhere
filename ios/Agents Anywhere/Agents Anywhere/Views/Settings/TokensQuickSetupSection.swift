import SwiftUI

/// One-click Tokens Anywhere setup: tick the runtimes, confirm once in the
/// browser, and the Server syncs the models and applies them. Progress comes
/// with the snapshot, so every client shows the same step.
struct TokensQuickSetupSection: View {
    let model: ModelConfigModel
    let tokens: V2TokensLinkStatus
    let linker: TokensLinkCoordinator
    @Binding var confirmsUnlink: Bool
    @Binding var unlinkAllowsInterrupt: Bool

    var body: some View {
        Group {
            switch model.quickPhase {
            case .setup: setupSection
            case .progress: progressSection
            case .done:
                TokensAccountSections(model: model, tokens: tokens) {
                    devicesSection
                } unlink: {
                    unlinkRows
                }
            }
        }
        .task(id: model.quickCandidatesKey) { await model.loadQuickCandidates() }
    }

    // MARK: Choose

    private var setupSection: some View {
        Section {
            choiceRows
            unlinkRows
        } header: {
            Text(String(localized: "Tokens Anywhere quick setup"))
        } footer: {
            Text(tokens.link?.isLinked == false
                ? String(localized: "The authorization expired. Link again.")
                : String(localized: "Set up models on all your devices in one step with your Tokens Anywhere account."))
        }
    }

    /// The runtimes to tick and the button that starts the setup.
    @ViewBuilder private var choiceRows: some View {
        Text(String(localized: "These runtimes will be set up:")).font(.footnote).foregroundStyle(.secondary)
        if let candidates = model.quickCandidates {
            if candidates.isEmpty {
                Text(String(localized: "No runtimes take a model connection yet.")).font(.subheadline).foregroundStyle(.secondary)
            }
            ForEach(candidates) { item in candidateRow(item) }
        } else {
            HStack { Spacer(); ProgressView(); Spacer() }.padding(.vertical, 8)
        }
        Button {
            start()
        } label: {
            HStack {
                Label(String(localized: "pages.settings.modelConfigs.quick.start"), appSymbol: "link")
                Spacer()
                if model.quickBusy { ProgressView() }
            }
        }
        .disabled(model.quickBusy || !tokens.secretConfigured || !model.canWrite || model.quickRequest.targets.isEmpty)
        if model.quickChoosing {
            Button(String(localized: "Cancel")) { model.quickChoosing = false }
        }
    }

    private func candidateRow(_ item: V2ModelPreviewTarget) -> some View {
        let enabled = item.decision == "apply"
        return Toggle(isOn: Binding(
            get: { enabled && model.effectiveQuickSelection.contains(item.id) },
            set: { model.toggleQuick(item, $0) }
        )) {
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(verbatim: "\(model.deviceName(item.connectorId)) · \(item.name ?? item.runtimeId)")
                        .font(.body.weight(.medium)).lineLimit(2)
                    RuntimeMaturityBadge(maturity: item.capabilityMaturity ?? item.maturity)
                }
                Text(QuickSetupPresentation.candidateNote(item)).font(.footnote).foregroundStyle(.secondary)
            }
        }
        .tint(.green)
        .disabled(!enabled || model.quickBusy)
        .opacity(enabled ? 1 : 0.6)
    }

    // MARK: Progress

    private var progressSection: some View {
        let steps = model.quickSteps
        let progress = tokens.quickSetup
        let failure = QuickSetupPresentation.failureText(progress)
        return Section {
            stepRow(steps.authorize, String(localized: "Authorize in the browser"),
                detail: steps.authorize == .done
                    ? String(localized: "Linked: \(tokens.link?.account.label ?? "")")
                    : String(localized: "Confirm on the page that opened, then come back here."))
            stepRow(steps.sync, String(localized: "Sync models"),
                detail: steps.sync == .active ? String(localized: "Reading the available models…") : steps.sync == .failed ? failure : nil)
            stepRow(steps.apply, String(localized: "Apply to \(progress?.request.targets.count ?? 0) runtimes"),
                detail: steps.apply == .active ? String(localized: "Writing to your devices…") : steps.apply == .failed ? failure : nil)
            if progress?.state == "failed" {
                Button {
                    start(retrying: progress?.request)
                } label: {
                    HStack {
                        Label(String(localized: "Retry"), appSymbol: "arrow.clockwise")
                        Spacer()
                        if model.quickBusy { ProgressView() }
                    }
                }
                .disabled(model.quickBusy || !model.canWrite)
            } else if steps.authorize == .active {
                Button(String(localized: "Cancel")) {
                    model.finishAuthorizing()
                    linker.cancel()
                }
            }
        } header: {
            Text(String(localized: "Tokens Anywhere quick setup"))
        } footer: {
            Text(String(localized: "Setting up; this updates when it finishes."))
        }
    }

    private func stepRow(_ status: QuickStepStatus, _ label: String, detail: String?) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Group {
                switch status {
                case .done: AppSymbol("checkmark", size: 16).foregroundStyle(.green)
                case .active: ProgressView().controlSize(.small)
                case .failed: AppSymbol("xmark", size: 16).foregroundStyle(.red)
                case .pending: AppSymbol("circle", size: 12).foregroundStyle(.secondary)
                }
            }
            .frame(width: 20, height: 20)
            VStack(alignment: .leading, spacing: 2) {
                Text(label).font(.subheadline)
                    .foregroundStyle(status == .pending ? AnyShapeStyle(.secondary) : AnyShapeStyle(.primary))
                if let detail {
                    Text(detail).font(.footnote)
                        .foregroundStyle(status == .failed ? AnyShapeStyle(.red) : AnyShapeStyle(.secondary))
                }
            }
            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .combine)
    }

    // MARK: Devices tab

    /// The account page's Devices tab: the runtime choices until one uses
    /// Tokens (or while choosing new ones), then where it is set up.
    private var devicesSection: some View {
        let fresh = model.freshQuickCandidates
        let results = tokens.quickSetup?.results ?? []
        return Section {
            if model.showsQuickChoices {
                choiceRows
            } else {
                if !fresh.isEmpty {
                    HStack {
                        Text(String(localized: "\(fresh.count) new runtimes can be set up")).font(.subheadline)
                        Spacer()
                        Button(String(localized: "pages.settings.modelConfigs.quick.configureNew")) { model.chooseNewQuickCandidates() }
                            .buttonStyle(.borderless)
                    }
                }
                if tokens.link?.relinkSoon == true {
                    Text(String(localized: "The authorization is almost a year old. Link again soon.")).font(.footnote).foregroundStyle(.orange)
                }
                ForEach(model.tokenAssignments) { item in
                    resultRow(title: "\(model.deviceName(item.connectorId)) · \(model.runtimeName(item.target))",
                        detail: QuickSetupPresentation.assignmentNote(status: item.status, createdRuntime: item.createdRuntime),
                        warning: false)
                }
                ForEach(results.filter(\.isProblem)) { item in
                    resultRow(title: "\(model.deviceName(item.connectorId)) · \(model.runtimeName(item.target))",
                        detail: QuickSetupPresentation.reasonText(item.reason), warning: true)
                }
                if results.contains(where: { ($0.modelsTrimmed ?? 0) > 0 }) {
                    Text(String(localized: "Some runtimes had more than 64 models; only the first 64 were imported."))
                        .font(.footnote).foregroundStyle(.secondary)
                }
            }
        }
    }

    private func resultRow(title: String, detail: String, warning: Bool) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(verbatim: title).font(.subheadline).lineLimit(2)
            Text(detail).font(.footnote)
                .foregroundStyle(warning ? AnyShapeStyle(.orange) : AnyShapeStyle(.secondary))
        }
        .accessibilityElement(children: .combine)
    }

    // MARK: Shared

    @ViewBuilder private var unlinkRows: some View {
        if tokens.link != nil {
            Button(role: .destructive) {
                confirmsUnlink = true
            } label: {
                HStack {
                    Label(String(localized: "Unlink"), appSymbol: "bolt.horizontal.circle")
                    Spacer()
                    if model.tokensBusy == .unlink { ProgressView() }
                }
            }
            .disabled(model.tokensBusy != nil || !model.canWrite)
            if !model.tokenAssignments.isEmpty {
                Toggle(String(localized: "Allow interrupting running tasks"), isOn: $unlinkAllowsInterrupt)
                    .tint(.green).disabled(model.tokensBusy != nil)
            }
        }
    }

    /// Starts the setup; when the account has to link first, opens the
    /// authorization page, which closes itself once the snapshot shows the link.
    private func start(retrying request: V2QuickSetupRequest? = nil) {
        let current = tokens.link
        Task {
            guard let url = await model.startQuickSetup(retrying: request) else { return }
            let started = linker.start(url: url, current: current) { model.finishAuthorizing() }
            if !started {
                model.finishAuthorizing()
                model.feedback = .error(String(localized: "That did not finish. Try again later."))
            }
        }
    }
}
