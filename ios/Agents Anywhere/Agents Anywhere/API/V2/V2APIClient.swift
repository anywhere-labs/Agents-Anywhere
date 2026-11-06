import Foundation

struct V2APIClient {
    let serverURL: URL
    let account: V2AccountAPI
    let connectors: V2ConnectorAPI
    let projects: V2ProjectAPI
    let sessions: V2SessionAPI
    let goals: V2GoalAPI
    let planning: V2PlanningAPI
    let runtime: V2RuntimeAPI
    let attachments: V2AttachmentAPI
    let modelConfig: V2ModelConfigAPI
    let realtime: V2RealtimeAPI
    private let ownedURLSession: URLSession?

    init(
        serverURL: URL,
        tokenProvider: any AuthTokenProvider,
        urlSession: URLSession? = nil
    ) {
        let session = urlSession ?? URLSession(configuration: V2MobileNetworking.configuration())
        ownedURLSession = urlSession == nil ? session : nil
        self.serverURL = serverURL.normalizedV2ServerURL()
        let transport = URLSessionHTTPTransport(
            serverURL: serverURL,
            urlSession: session,
            tokenProvider: tokenProvider
        )
        account = V2AccountAPI(transport: transport)
        connectors = V2ConnectorAPI(transport: transport)
        projects = V2ProjectAPI(transport: transport)
        sessions = V2SessionAPI(transport: transport)
        runtime = V2RuntimeAPI(transport: transport)
        goals = V2GoalAPI(transport: transport)
        planning = V2PlanningAPI(transport: transport)
        attachments = V2AttachmentAPI(transport: transport)
        modelConfig = V2ModelConfigAPI(transport: transport)
        realtime = V2RealtimeAPI(
            serverURL: serverURL,
            transport: transport,
            webSocketTransport: URLSessionWebSocketTransport(urlSession: session)
        )
    }

    func cancelOutstandingRequests() { ownedURLSession?.invalidateAndCancel() }
}
