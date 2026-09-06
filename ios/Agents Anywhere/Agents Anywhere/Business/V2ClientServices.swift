import Foundation

@MainActor
final class V2ClientServices {
    private let api: V2APIClient
    let connectivity = V2ConnectivityMonitor()
    var onConnectivityChange: ((V2NetworkStatus) -> Void)?
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
    let newSession: NewSessionModel

    init(api: V2APIClient, accountID: String) {
        self.api = api
        scope = V2ClientScope(serverURL: api.serverURL, accountID: accountID)
        sessionPreparation = V2SessionPreparationService(connectorAPI: api.connectors)
        account = V2AccountService(accountAPI: api.account)
        dashboard = V2DashboardService(
            connectorAPI: api.connectors,
            projectAPI: api.projects,
            sessionAPI: api.sessions,
            realtimeAPI: api.realtime
        )
        dashboardRepository = V2DashboardRepository(service: dashboard)
        sessionReads = V2SessionReadCoordinator { id in
            let response = try await api.sessions.markRead(sessionIds: [id])
            guard let receipt = response.sessions.first(where: { $0.id == id }) else { throw HTTPError.invalidResponse }
            return receipt
        }
        sessionDetail = V2SessionDetailService(
            sessionAPI: api.sessions,
            runtimeAPI: api.runtime,
            realtimeAPI: api.realtime
        )
        sessionCreation = V2SessionCreationService(sessionAPI: api.sessions)
        attachments = V2AttachmentService(attachmentAPI: api.attachments)
        interactions = V2RuntimeInteractionService(runtimeAPI: api.runtime)
        sessionRepository = V2SessionRepository(scope: scope, detail: sessionDetail, interactions: interactions)
        devicePairing = V2DevicePairingService(connectorAPI: api.connectors)
        agentSetup = AgentSetupCoordinator(service: devicePairing)
        deviceManagement = V2DeviceManagementService(connectorAPI: api.connectors)
        workspaceFiles = V2WorkspaceFilesService(
            connectorAPI: api.connectors,
            serverURL: api.serverURL
        )
        newSession = NewSessionModel(scope: scope, devices: deviceManagement,
            preparation: sessionPreparation, creation: sessionCreation, projectAPI: api.projects)
        connectivity.onChange = { [weak self] status in
            self?.sessionRepository.updateConnectivity(status)
            self?.newSession.updateNetwork(status)
            self?.dashboardRepository.updateNetwork(status)
            self?.agentSetup.updateNetwork(status)
            self?.updateAgentConnections()
            self?.sessionReads.updateConnectivity(status)
            self?.onConnectivityChange?(status)
        }
        connectivity.start()
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
        for (id, model) in agentModels { model.updateConnection(online.contains(id) && connectivity.status.availability != .offline) }
        agentSetup.updateConnectors(dashboardRepository.connectors)
    }

    func shutdown() {
        agentSetup.invalidate()
        agentModels.values.forEach { $0.invalidate() }; agentModels = [:]
        dashboardRepository.invalidate()
        sessionReads.invalidate()
        newSession.invalidate()
        connectivity.stop()
        onConnectivityChange = nil
        sessionRepository.reset()
        api.cancelOutstandingRequests()
    }
}
