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
    let sessionDetail: V2SessionDetailService
    let sessionCreation: V2SessionCreationService
    let attachments: V2AttachmentService
    let interactions: V2RuntimeInteractionService
    let devicePairing: V2DevicePairingService
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
            sessionAPI: api.sessions,
            realtimeAPI: api.realtime
        )
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
        deviceManagement = V2DeviceManagementService(connectorAPI: api.connectors)
        workspaceFiles = V2WorkspaceFilesService(
            connectorAPI: api.connectors,
            serverURL: api.serverURL
        )
        newSession = NewSessionModel(scope: scope, devices: deviceManagement,
            preparation: sessionPreparation, creation: sessionCreation)
        connectivity.onChange = { [weak self] status in
            self?.sessionRepository.updateConnectivity(status)
            self?.newSession.updateNetwork(status)
            self?.onConnectivityChange?(status)
        }
        connectivity.start()
    }

    func shutdown() {
        newSession.invalidate()
        connectivity.stop()
        onConnectivityChange = nil
        sessionRepository.reset()
        api.cancelOutstandingRequests()
    }
}
