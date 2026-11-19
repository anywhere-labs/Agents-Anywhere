import CryptoKit
import Foundation
import UniformTypeIdentifiers

struct StagedAttachment: Equatable {
    let reference: JSON
    let key: JSON
}

nonisolated struct LocalChatFile: Sendable {
    static let maxBytes = 25 * 1024 * 1024

    let name: String
    let contentType: String
    let bytes: Data

    static func read(_ url: URL) throws -> Self {
        let access = url.startAccessingSecurityScopedResource()
        defer { if access { url.stopAccessingSecurityScopedResource() } }
        let file = try FileHandle(forReadingFrom: url)
        defer { try? file.close() }
        guard let bytes = try file.read(upToCount: maxBytes + 1), (1...maxBytes).contains(bytes.count) else {
            throw NativeAccountError.invalidResponse
        }
        let type = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
        return Self(name: url.lastPathComponent, contentType: type, bytes: bytes)
    }
}

nonisolated struct SealedChatFile: Sendable {
    let name: String
    let contentType: String
    let size: Int
    let digest: String
    private let key: Data
    private let sealed: Data

    init(_ file: LocalChatFile) throws {
        guard (1...LocalChatFile.maxBytes).contains(file.bytes.count) else { throw NativeAccountError.invalidResponse }
        self.name = file.name
        self.contentType = file.contentType
        self.size = file.bytes.count
        let hash = SHA256.hash(data: file.bytes).map { String(format: "%02x", $0) }.joined()
        self.digest = hash
        let symmetric = SymmetricKey(size: .bits256)
        self.key = symmetric.withUnsafeBytes { Data($0) }
        let chunkBytes = 64 * 1024
        let count = (file.bytes.count + chunkBytes - 1) / chunkBytes
        var output = Data(capacity: file.bytes.count + 16 * count)
        for index in 0..<count {
            let offset = index * chunkBytes
            let chunk = file.bytes[offset..<min(offset + chunkBytes, file.bytes.count)]
            let nonce = withUnsafeBytes(of: UInt64(index).bigEndian) { Data(repeating: 0, count: 4) + Data($0) }
            let aad = Data(["aa-e2ee/1.0", "attachment", hash, String(index)].joined(separator: "\u{0}").utf8)
                + Data([0, index == count - 1 ? 1 : 0])
            let box = try AES.GCM.seal(chunk, using: symmetric, nonce: .init(data: nonce), authenticating: aad)
            output.append(box.ciphertext)
            output.append(box.tag)
        }
        self.sealed = output
    }

    func multipart(boundary: String) -> Data {
        let head = "--\(boundary)\r\nContent-Disposition: form-data; name=\"files\"; filename=\"attachment.bin\"\r\nContent-Type: application/octet-stream\r\n\r\n"
        return Data(head.utf8) + sealed + Data("\r\n--\(boundary)--\r\n".utf8)
    }

    @MainActor
    func staged(reference: JSON) throws -> StagedAttachment {
        guard let id = reference["fileId"]?.string else { throw NativeAccountError.invalidResponse }
        let secret = key.base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
        return StagedAttachment(reference: reference, key: .object([
            "fileId": .string(id), "name": .string(name), "mimeType": .string(contentType),
            "size": .number(Double(size)), "sha256": .string(digest), "key": .string(secret),
        ]))
    }
}
