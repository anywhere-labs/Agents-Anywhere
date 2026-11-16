import Foundation
#if canImport(UIKit)
import UIKit
#endif

@MainActor
final class V2ClientServices {
    private let api: V2APIClient
    let connectivity = V2ConnectivityMonitor()
    var onCreationBound: ((String, String) -> Void)?
    var onSelectPage: ((ChatShellSelection) -> Void)?
    var onConnectivityChange: ((V2NetworkStatus) -> Void)?
    let localStore: V2LocalStore
    let scope: V2ClientScope
    let sessionRepository: V2SessionRepository
    let sessionPreparation: V2SessionPreparationService
    let account: V2AccountService
    let dashboard: V2DashboardService
    let dashboardRepository: V2DashboardRepository
    let sessionReads: V2SessionReadCoordinator
    let sessionDetail: V2SessionDetailService
    let sessionCreation: V2SessionCreationService
    let attachments: V2AttachmentService
    let interactions: V2RuntimeInteractionService
    let devicePairing: V2DevicePairingService
    let agentSetup: AgentSetupCoordinator
    private var agentModels: [String: DeviceAgentModel] = [:]
    let deviceManagement: V2DeviceManagementService
    let workspaceFiles: V2WorkspaceFilesService
    let runtimeWorkflows: V2RuntimeWorkflowAPI
    let modelConfigAPI: V2ModelConfigAPI
    let newSession: NewSessionModel
    /// Port preview actions; the instance's availability lasts for this app run.
    let portPreviews: PortPreviewStore
    /// Optional end-to-end encryption: client trust, secure channels and per-device transport choice.
    let e2ee: V2E2EEService
    /// Opens session display envelopes with the directory keys in `e2ee.trust`.
    let sessionDisplay: V2SessionDisplayResolver
    private var trustObserver: UUID?

    /// Parent of every account's offline directory (one per server + account).
    nonisolated static let defaultOfflineRoot = URL.applicationSupportDirectory.appendingPathComponent("AgentsAnywhere/Offline/v1")
    let offlineRoot: URL
    /// This account's directory name below `offlineRoot`.
    var offlineScopeKey: String { V2RestorationStore.scopeKey(scope) }

    init(api: V2APIClient, accountID: String, offlineRoot: URL = V2ClientServices.defaultOfflineRoot) {
        self.api = api
        self.offlineRoot = offlineRoot
        runtimeWorkflows = V2RuntimeWorkflowAPI(transport: api.sessions.transport)
        modelConfigAPI = api.modelConfig
        portPreviews = PortPreviewStore(api: api.previews)
        scope = V2ClientScope(serverURL: api.serverURL, accountID: accountID)
        let cacheDirectory = offlineRoot.appendingPathComponent(V2RestorationStore.scopeKey(scope))
        localStore = V2LocalStore(directory: cacheDirectory)
        sessionPreparation = V2SessionPreparationService(connectorAPI: api.connectors)
        account = V2AccountService(accountAPI: api.account)
        dashboard = V2DashboardService(
            connectorAPI: api.connectors,
            projectAPI: api.projects,
            sessionAPI: api.sessions,
            realtimeAPI: api.realtime
        )
        dashboardRepository = V2DashboardRepository(service: dashboard, localStore: localStore, scope: scope)
        sessionReads = V2SessionReadCoordinator { id in
            let response = try await api.sessions.markRead(sessionIds: [id])
            guard let receipt = response.sessions.first(where: { $0.id == id }) else { throw HTTPError.invalidResponse }
            return receipt
        }
        sessionDetail = V2SessionDetailService(
            sessionAPI: api.sessions,
            runtimeAPI: api.runtime,
            realtimeAPI: api.sessionRealtime
        )
        sessionCreation = V2SessionCreationService(sessionAPI: api.sessions)
        attachments = V2AttachmentService(attachmentAPI: api.attachments)
        interactions = V2RuntimeInteractionService(runtimeAPI: api.runtime)
        sessionRepository = V2SessionRepository(scope: scope, detail: sessionDetail, interactions: interactions, planningAPI: api.planning, goalAPI: api.goals, localStore: localStore)
        devicePairing = V2DevicePairingService(connectorAPI: api.connectors)
        agentSetup = AgentSetupCoordinator(service: devicePairing)
        deviceManagement = V2DeviceManagementService(connectorAPI: api.connectors)
        workspaceFiles = V2WorkspaceFilesService(
            connectorAPI: api.connectors,
            serverURL: api.serverURL
        )
        let trust = ClientTrustStore(storage: E2EEKeychainStorage(), scope: "e2ee." + V2RestorationStore.scopeKey(scope))
        let e2eeAPI = api.e2ee
        e2ee = V2E2EEService(
            trust: trust,
            tunnel: URLSessionE2EETunnel(serverURL: api.serverURL, urlSession: api.urlSession) {
                try await e2eeAPI.tunnelTicket(clientId: try trust.clientId()).ticket
            },
            api: e2eeAPI,
            clientLabel: Self.clientLabel
        )
        sessionDisplay = V2SessionDisplayResolver(trust: trust)
        dashboardRepository.displayResolver = sessionDisplay
        sessionRepository.displayResolver = sessionDisplay
        // Session content follows its device: the dashboard knows most sessions' devices,
        // otherwise the (always plaintext) directory entry is read once.
        let sessionsAPI = api.sessions
        let dashboard = dashboardRepository
        api.routing.attach(service: e2ee) { sessionId in
            if sessionId.hasPrefix("local:") { return nil }
            if let known = await MainActor.run(body: { dashboard.sessions.first { $0.id == sessionId }?.connectorId }) {
                return known
            }
            return try await sessionsAPI.sessionMeta(sessionId: sessionId).session.connectorId
        }
        newSession = NewSessionModel(scope: scope, devices: deviceManagement,
            preparation: sessionPreparation, creation: sessionCreation, projectAPI: api.projects, workflowAPI: V2RuntimeWorkflowAPI(transport: api.sessions.transport))
        newSession.onProjectResolved = { [weak self] in self?.dashboardRepository.upsertProject($0) }
        newSession.onStaged = { [weak self] submission in
            guard let self else { return }
            sessionRepository.stageCreation(submission)
            dashboardRepository.upsert([submission.session])
            onSelectPage?(.session(submission.session.id))
            await flushCache()
        }
        newSession.onFailed = { [weak self] submission in
            var meta = submission.session; meta.status = .error
            self?.dashboardRepository.upsert([meta])
            self?.sessionRepository.localWorkDidChange(sessionID: meta.id)
        }
        newSession.onBound = { [weak self] submission, response in
            guard let self else { return }
            sessionRepository.bindCreation(submission, response: response)
            dashboardRepository.removeLocalSession(submission.session.id)
            dashboardRepository.upsert([response.session])
            onCreationBound?(submission.session.id, response.session.id)
        }
        Task { [account, e2ee] in
            // Older servers have no `e2ee` field (off); a failed read keeps the mode unchanged,
            // and each device's own "requires encryption" record applies regardless.
            await e2ee.loadServerConfig { try await account.authConfig().e2ee }
        }
        sessionReads.updateConnectivity(.init(availability: .offline))
        connectivity.onChange = { [weak self] status in
            self?.sessionRepository.updateConnectivity(status)
            self?.newSession.updateNetwork(status)
            self?.dashboardRepository.updateNetwork(status)
            self?.agentSetup.updateNetwork(status)
            self?.updateAgentConnections()
            self?.sessionReads.updateConnectivity(self?.dashboardRepository.isFresh == true ? status : .init(availability: .offline))
            self?.onConnectivityChange?(status)
        }
        connectivity.start()
        // `e2ee.directory_key`, pairing again or forgetting a device: retry the envelopes.
        trustObserver = trust.observeDevices { [weak self] in
            Task { @MainActor in self?.redisplaySessions() }
        }
    }

    private func redisplaySessions() {
        dashboardRepository.redisplay()
        sessionRepository.redisplay()
    }

    func agents(on connectorID: String) -> DeviceAgentModel {
        if let model = agentModels[connectorID] { return model }
        let model = DeviceAgentModel(connectorID: connectorID, service: deviceManagement)
        agentModels[connectorID] = model
        updateAgentConnections()
        return model
    }

    func updateAgentConnections() {
        let online = Set(dashboardRepository.connectors.filter { $0.status == .online }.map(\.id))
        for (id, model) in agentModels { model.updateConnection(dashboardRepository.isFresh && online.contains(id) && connectivity.status.availability != .offline) }
        if dashboardRepository.isFresh { agentSetup.updateConnectors(dashboardRepository.connectors) }
    }

    func editCreation(_ session: V2SessionModel, pending: V2PendingMessage) {
        guard let meta = session.metadata else { return }
        newSession.restoreCreationDraft(meta: meta, pending: pending)
        onSelectPage?(.newSession)
    }
    func discardCreation(_ id: String) {
        guard id.hasPrefix("local:") else { return }
        sessionRepository.remove(sessionIds: [id]); dashboardRepository.removeLocalSession(id)
        onSelectPage?(.newSession)
    }

    func restoreCache(selection: ChatShellSelection) async {
        await dashboardRepository.restoreCache()
        if case .session(let id) = selection { await sessionRepository.restoreCachedSession(id: id) }
    }

    func flushCache() async {
        newSession.saveDraft()
        await dashboardRepository.flushCache()
        await sessionRepository.flushCache()
    }

    /// Signing out or switching accounts passes `removingCache`: the account's
    /// offline directory is deleted and nothing from a closing page can write it back.
    func shutdown(removingCache: Bool = false) {
        onSelectPage = nil; onCreationBound = nil
        newSession.onStaged = nil; newSession.onBound = nil; newSession.onFailed = nil; newSession.onProjectResolved = nil
        // Refuse writes now; the actor deletes the directory after any write in progress.
        if removingCache { localStore.invalidate() }
        Task { await localStore.close(removing: removingCache) }
        agentSetup.invalidate()
        agentModels.values.forEach { $0.invalidate() }; agentModels = [:]
        dashboardRepository.invalidate()
        sessionReads.invalidate()
        newSession.invalidate()
        connectivity.stop()
        onConnectivityChange = nil
        sessionRepository.reset()
        api.routing.detach()
        if let trustObserver { e2ee.trust.removeObserver(trustObserver); self.trustObserver = nil }
        Task { [e2ee] in await e2ee.shutdown() }
        api.cancelOutstandingRequests()
    }

    private static var clientLabel: String {
        #if canImport(UIKit)
        UIDevice.current.model
        #else
        "iOS"
        #endif
    }
}
