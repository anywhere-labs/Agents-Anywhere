import Foundation

struct V2ClientServices {
    let account: V2AccountService
    let dashboard: V2DashboardService
    let sessionDetail: V2SessionDetailService
    let sessionCreation: V2SessionCreationService
    let attachments: V2AttachmentService
    let interactions: V2RuntimeInteractionService
    let devicePairing: V2DevicePairingService

    init(api: V2APIClient) {
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
        devicePairing = V2DevicePairingService(connectorAPI: api.connectors)
    }
}
