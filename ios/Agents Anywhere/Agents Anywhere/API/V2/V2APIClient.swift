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
    /// Port preview (`/api/v3/previews`).
    let previews: V3PreviewAPI
    let e2ee: V2E2EEAPI
    /// Session event streams: the session WebSocket, or the secure channel's `subscribe`.
    let sessionRealtime: E2EERoutingRealtimeAPI
    /// Routes content requests through `V2E2EEService` once it is attached.
    let routing: E2EERoutingHTTPTransport
    /// Shared with the E2EE tunnel WebSocket.
    let urlSession: URLSession
    private let ownedURLSession: URLSession?

    init(
        serverURL: URL,
        tokenProvider: any AuthTokenProvider,
        urlSession: URLSession? = nil
    ) {
        let session = urlSession ?? URLSession(configuration: V2MobileNetworking.configuration())
        ownedURLSession = urlSession == nil ? session : nil
        self.urlSession = session
        self.serverURL = serverURL.normalizedV2ServerURL()
        let transport = URLSessionHTTPTransport(
            serverURL: serverURL,
            urlSession: session,
            tokenProvider: tokenProvider
        )
        // Content requests choose plaintext or the device's secure channel per request;
        // account and E2EE bookkeeping always use plain HTTP.
        let routing = E2EERoutingHTTPTransport(plain: transport)
        self.routing = routing
        account = V2AccountAPI(transport: transport)
        connectors = V2ConnectorAPI(transport: routing)
        projects = V2ProjectAPI(transport: routing)
        sessions = V2SessionAPI(transport: routing)
        runtime = V2RuntimeAPI(transport: routing)
        goals = V2GoalAPI(transport: routing)
        planning = V2PlanningAPI(transport: routing)
        attachments = V2AttachmentAPI(transport: routing)
        modelConfig = V2ModelConfigAPI(transport: routing)
        previews = V3PreviewAPI(transport: routing)
        e2ee = V2E2EEAPI(transport: transport)
        realtime = V2RealtimeAPI(
            serverURL: serverURL,
            transport: routing,
            webSocketTransport: URLSessionWebSocketTransport(urlSession: session)
        )
        sessionRealtime = E2EERoutingRealtimeAPI(inner: realtime, routing: routing)
    }

    func cancelOutstandingRequests() { ownedURLSession?.invalidateAndCancel() }
}
