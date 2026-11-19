#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
sh "$root/vendor/meshcall/prepare-mobile-sdk.sh"
cd "$root/vendor/meshcall/sdk/meshcall-router"
contract="$root/contracts/device-meshcall/1.0/device.meshcall.json"
control="$root/contracts/device-meshcall/1.0/mobile-control.meshcall.json"
swift="$root/v3poc/ios/AAv3PoC/Generated"
android="$root/v3poc/android/app/src/main/java/dev/agentsanywhere/v3poc/generated"

go run ./cmd/meshcall generate "$contract" --service aa.device.v1.Content --language swift --single-file --output "$swift"
go run ./cmd/meshcall generate "$control" --language swift --single-file --output "$swift"
# The PoC defaults to MainActor. Wire DTOs must be encodable and decodable from the SDK's concurrency domain.
for source in "$swift/ContentClient.swift" "$swift/MobileControlClient.swift"; do
    sed 's/^public struct /public nonisolated struct /' "$source" > "$source.tmp"
    mv "$source.tmp" "$source"
done
go run ./cmd/meshcall generate "$contract" --service aa.device.v1.Content --language kotlin --single-file \
    --package-name dev.agentsanywhere.v3poc.generated --output "$android"
go run ./cmd/meshcall generate "$control" --language kotlin --single-file \
    --package-name dev.agentsanywhere.v3poc.generated --output "$android"

native_android="$root/android/app/src/main/java/com/agentsanywhere/app/api/e2ee/generated"
go run ./cmd/meshcall generate "$contract" --service aa.device.v1.Content --language kotlin --single-file \
    --package-name com.agentsanywhere.app.api.e2ee.generated --output "$native_android"
go run ./cmd/meshcall generate "$control" --language kotlin --single-file \
    --package-name com.agentsanywhere.app.api.e2ee.generated --output "$native_android"

native_ios="$root/ios/Agents Anywhere/Agents Anywhere/Network/E2EE/Generated"
mkdir -p "$native_ios"
# The main iOS target has its own JSONValue used by API business models.
sed 's/JSONValue/MeshCall.JSONValue/g' "$swift/ContentClient.swift" > "$native_ios/ContentClient.swift"
sed 's/JSONValue/MeshCall.JSONValue/g' "$swift/MobileControlClient.swift" > "$native_ios/MobileControlClient.swift"
