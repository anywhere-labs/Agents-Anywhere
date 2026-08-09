import Foundation

struct V2APIClient {
    let account: V2AccountAPI
    let connectors: V2ConnectorAPI
    let sessions: V2SessionAPI
    let runtime: V2RuntimeAPI
    let attachments: V2AttachmentAPI
    let realtime: V2RealtimeAPI

    init(
        serverURL: URL,
        tokenProvider: any AuthTokenProvider,
        urlSession: URLSession = .shared
    ) {
        let transport = URLSessionHTTPTransport(
            serverURL: serverURL,
            urlSession: urlSession,
            tokenProvider: tokenProvider
        )
        account = V2AccountAPI(transport: transport)
        connectors = V2ConnectorAPI(transport: transport)
        sessions = V2SessionAPI(transport: transport)
        runtime = V2RuntimeAPI(transport: transport)
        attachments = V2AttachmentAPI(transport: transport)
        realtime = V2RealtimeAPI(
            serverURL: serverURL,
            transport: transport,
            webSocketTransport: URLSessionWebSocketTransport(urlSession: urlSession)
        )
    }
}
