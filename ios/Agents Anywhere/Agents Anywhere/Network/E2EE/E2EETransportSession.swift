import Foundation

/// 握手完成后的传输层：分片、重组、按帧数或时间 rekey（flag 0x02）、核对 nonce。
/// 不是线程安全的，由持有它的 `ClientSecureChannel`（actor）串行使用。
nonisolated final class E2EETransportSession {
    private let send: NoiseCipherState
    private let receive: NoiseCipherState
    private let now: () -> Date
    private let rekeyFrames: Int
    private let rekeyInterval: TimeInterval
    private var reassembler = E2EEReassembler()
    private var framesSinceRekey = 0
    private var lastRekey: Date
    private(set) var isDestroyed = false
    /// 两个方向各做过几次 rekey（诊断与测试用）。
    private(set) var sentRekeys = 0
    private(set) var receivedRekeys = 0

    init(
        pair: NoiseTransportPair,
        now: @escaping () -> Date = Date.init,
        rekeyFrames: Int = E2EEFormats.rekeyIntervalFrames,
        rekeyInterval: TimeInterval = E2EEFormats.rekeyInterval
    ) {
        send = pair.send
        receive = pair.receive
        self.now = now
        self.rekeyFrames = rekeyFrames
        self.rekeyInterval = rekeyInterval
        lastRekey = now()
    }

    /// 下一帧要用的发送 / 接收计数器。
    var sendNonce: UInt64 { send.nonce }
    var receiveNonce: UInt64 { receive.nonce }

    /// 加密一条通道消息（JSON 字节），按需先插入 rekey 帧。返回的帧必须按顺序发出。
    ///
    /// rekey 只在消息之间做：接收方不接受夹在同一条消息分片之间的 rekey 帧。所以间隔到了以后，
    /// 最多再发完当前这条消息（单条 ≤ 16 MiB，约 257 帧）才 rekey。
    func seal(_ message: Data) throws -> [E2EEChannelItem] {
        try ensureOpen()
        let frames = try E2EEFormats.fragment(message)
        var items: [E2EEChannelItem] = []
        if framesSinceRekey >= rekeyFrames || now().timeIntervalSince(lastRekey) >= rekeyInterval {
            items.append(try sealRekey())
        }
        for frame in frames {
            items.append(try write(frame))
            framesSinceRekey += 1
        }
        return items
    }

    /// 立即对发送方向 rekey：发出 flag 0x02 的空帧，然后 REKEY 自己的发送 CipherState。
    func sealRekey() throws -> E2EEChannelItem {
        try ensureOpen()
        let item = try write(Data([E2EEFormats.frameRekey]))
        try send.rekey()
        sentRekeys += 1
        framesSinceRekey = 0
        lastRekey = now()
        return item
    }

    /// 解密收到的一帧；凑齐一条消息时返回它的字节。`n` 与接收计数器不等时直接报错，不尝试解密。
    func open(_ item: E2EEChannelItem) throws -> Data? {
        try ensureOpen()
        guard item.n == receive.nonce else {
            throw E2EEError(code: E2EEError.protocolError, message: "unexpected frame counter \(item.n), expected \(receive.nonce)")
        }
        let plaintext: Data
        do {
            plaintext = try receive.decrypt(ad: Data(), ciphertext: try E2EEFormats.fromBase64url(item.ct))
        } catch {
            throw E2EEError(code: E2EEError.protocolError, message: "frame failed to decrypt")
        }
        switch try reassembler.push(plaintext) {
        case .rekey:
            try receive.rekey()
            receivedRekeys += 1
            return nil
        case let .message(bytes):
            return bytes
        case nil:
            return nil
        }
    }

    func destroy() {
        isDestroyed = true
        send.destroy()
        receive.destroy()
    }

    private func write(_ plaintext: Data) throws -> E2EEChannelItem {
        let n = send.nonce
        let ciphertext = try send.encrypt(ad: Data(), plaintext: plaintext)
        return E2EEChannelItem(n: n, ct: E2EEFormats.base64url(ciphertext))
    }

    private func ensureOpen() throws {
        guard !isDestroyed else { throw E2EEError(code: E2EEError.closed, message: "transport destroyed") }
    }
}
