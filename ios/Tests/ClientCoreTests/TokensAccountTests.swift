import Foundation
import Testing
@testable import ClientCore

@Suite @MainActor struct TokensAccountTests {
    private func profile(_ offers: [[String: Any]], preferences: [String: Any]? = nil) throws -> V2ModelProfile {
        var object: [String: Any] = ["id": "mpr_tokens", "source": "tokens", "name": "Tokens Anywhere", "originHost": "tokens.example",
            "offers": offers, "state": "active"]
        if let preferences { object["preferences"] = preferences }
        return try decode(object)
    }

    private func model(_ id: String, _ name: String? = nil, vendor: String? = nil) -> TokensModel {
        TokensModel(id: id, originalName: name ?? id, vendor: vendor, contextWindow: nil, maxOutputTokens: nil, image: false)
    }

    @Test func eachModelOnceAcrossProtocols() throws {
        let tokens = try profile([
            ["format": "openai_chat", "baseUrl": "https://t/v1", "models": [
                ["id": "gpt-5", "vendor": "openai"],
                ["id": "claude", "name": "Claude", "input": ["text"]],
            ]],
            ["format": "anthropic", "baseUrl": "https://t", "models": [
                ["id": "claude", "name": "Claude Other", "vendor": "anthropic", "contextWindow": 200_000, "maxOutputTokens": 64_000, "input": ["text", "image"]],
                ["id": "gpt-5", "name": "GPT-5", "contextWindow": 400_000],
                ["id": "odd", "contextWindow": "big"],
            ]],
        ], preferences: ["disabled": ["gpt-5"], "names": ["claude": "Mine"]])
        #expect(tokens.preferences == V2ModelPreferences(disabled: ["gpt-5"], names: ["claude": "Mine"]))
        let models = TokensAccountPresentation.models(tokens)
        #expect(models.map(\.id) == ["gpt-5", "claude", "odd"])
        #expect(models[0] == TokensModel(id: "gpt-5", originalName: "GPT-5", vendor: "openai", contextWindow: 400_000, maxOutputTokens: nil, image: false))
        #expect(models[1] == TokensModel(id: "claude", originalName: "Claude", vendor: "anthropic", contextWindow: 200_000, maxOutputTokens: 64_000, image: true))
        #expect(models[2].contextWindow == nil, "An odd field reads as absent")

        let older = try profile([["format": "openai_chat", "baseUrl": "https://t/v1", "models": [["id": "a"]]]])
        #expect(older.preferences == .empty)
        let encoded = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(V2ModelSpec(id: "a")))
        #expect(encoded == .object(["id": .string("a")]), "Absent fields stay out of requests")
    }

    @Test func groupsByMakerTheBestKnownFirst() {
        #expect(TokensAccountPresentation.vendorLabel("OpenAI") == "OpenAI")
        #expect(TokensAccountPresentation.vendorLabel("gemini") == "Google")
        #expect(TokensAccountPresentation.vendorLabel("z-ai") == "Zhipu")
        #expect(TokensAccountPresentation.vendorLabel("Acme") == "Acme")
        #expect(TokensAccountPresentation.vendorLabel(nil) == nil)
        let groups = TokensAccountPresentation.vendorGroups([
            model("x", vendor: nil), model("acme-1", vendor: "Acme"), model("gpt", vendor: "openai"),
            model("gemini", vendor: "gemini"), model("claude", vendor: "anthropic"), model("palm", vendor: "google"),
            model("beta", vendor: "Beta"),
        ])
        #expect(groups.map(\.label) == ["Anthropic", "OpenAI", "Google", "Acme", "Beta", nil])
        #expect(groups[2].models.map(\.id) == ["gemini", "palm"])
        #expect(groups.last?.key == "")
    }

    @Test func tokenWindowsReadTheWayModelSizesAreSaid() {
        #expect(TokensAccountPresentation.formatTokenWindow(200_000) == "200K")
        #expect(TokensAccountPresentation.formatTokenWindow(128_000) == "128K")
        #expect(TokensAccountPresentation.formatTokenWindow(32_768) == "32.8K")
        #expect(TokensAccountPresentation.formatTokenWindow(1_000_000) == "1M")
        #expect(TokensAccountPresentation.formatTokenWindow(1_048_576) == "1M")
        #expect(TokensAccountPresentation.formatTokenWindow(1_500_000) == "1.5M")
        #expect(TokensAccountPresentation.formatTokenWindow(999) == "999")
    }

    @Test func preferencesCompareAndCleanAsSaved() {
        let models = [model("a", "Alpha"), model("b"), model("c")]
        #expect(TokensAccountPresentation.samePreferences(.init(disabled: ["a", "b"], names: ["c": " C "]), .init(disabled: ["b", "a"], names: ["c": "C", "b": "  "])))
        #expect(!TokensAccountPresentation.samePreferences(.init(disabled: ["a"]), .init(disabled: ["b"])))
        #expect(!TokensAccountPresentation.samePreferences(.init(names: ["a": "x"]), .empty))
        let cleaned = TokensAccountPresentation.cleanPreferences(
            .init(disabled: ["a", "gone"], names: ["a": " Alpha ", "b": " Bee ", "c": "  ", "gone": "x"]), models: models)
        #expect(cleaned == .init(disabled: ["a"], names: ["b": "Bee"]))
        #expect(TokensAccountPresentation.changeCount(.empty, .empty) == 0)
        #expect(TokensAccountPresentation.changeCount(.init(disabled: ["a"], names: ["b": "Bee"]), .init(disabled: ["c"], names: ["b": "Bee", "a": "A"])) == 2)
        #expect(TokensAccountPresentation.changeCount(.init(names: ["b": "Bee"]), .empty) == 1)
    }

    @Test func amountsAddAsTenThousandthsOfAYuan() {
        #expect(TokensAccountPresentation.amountUnits("115.5000") == 1_155_000)
        #expect(TokensAccountPresentation.amountUnits("0.0001") == 1)
        #expect(TokensAccountPresentation.amountUnits(" 2 ") == 20_000)
        #expect(TokensAccountPresentation.amountUnits("-1.5") == -15_000)
        #expect(TokensAccountPresentation.amountUnits("1.23456") == 0)
        #expect(TokensAccountPresentation.amountUnits("1.") == 0)
        #expect(TokensAccountPresentation.amountUnits("+1") == 0)
        #expect(TokensAccountPresentation.amountUnits("abc") == 0)
        #expect(TokensAccountPresentation.amountUnits(nil) == 0)
        // 0.1 + 0.2 is exactly 0.3 here.
        #expect(TokensAccountPresentation.amountUnits("0.1") + TokensAccountPresentation.amountUnits("0.2") == TokensAccountPresentation.amountUnits("0.3"))

        #expect(TokensAccountPresentation.formatYuan(1_155_000) == "¥115.50")
        #expect(TokensAccountPresentation.formatYuan(0) == "¥0.00")
        #expect(TokensAccountPresentation.formatYuan(1) == "¥0.0001")
        #expect(TokensAccountPresentation.formatYuan(99) == "¥0.0099")
        #expect(TokensAccountPresentation.formatYuan(100) == "¥0.01")
        #expect(TokensAccountPresentation.formatYuan(12_345) == "¥1.23")
        #expect(TokensAccountPresentation.formatYuan(12_350) == "¥1.24")
        #expect(TokensAccountPresentation.formatYuan(1_234_567_890_000) == "¥123,456,789.00")
        #expect(TokensAccountPresentation.formatYuan(-15_000) == "¥-1.50")
        #expect(TokensAccountPresentation.formatYuan(-42) == "¥-0.0042")
    }

    @Test func usageFillsQuietDaysAndRanksModelsBySpend() throws {
        let usage: V2TokensUsage = try decode(["from": "2026-02-27", "to": "2026-03-02", "items": [
            ["date": "2026-02-27", "model": "gpt-5", "requests": 2, "inputTokens": 100, "outputTokens": 50, "cacheReadTokens": 10,
             "cacheWrite5mTokens": 1, "cacheWrite1hTokens": 2, "amountCharged": "0.1000"],
            ["date": "2026-03-01", "model": "gpt-5", "requests": 1, "inputTokens": 10, "amountCharged": "0.2000"],
            ["date": "2026-03-01", "model": "claude", "requests": 5, "amountCharged": "0.3000"],
            ["date": "2026-03-02", "model": NSNull(), "requests": 1, "amountCharged": "0.0001"],
            ["date": "2026-03-02", "model": "cheap", "requests": 9, "amountCharged": "0.0001"],
            ["date": 7],
        ]])
        #expect(usage.items.count == 5, "An odd row is dropped, not the report")
        let summary = TokensAccountPresentation.summarizeUsage(usage, model: nil)
        #expect(summary.cost == 6_002 && summary.requests == 18 && summary.tokens == 173)
        #expect(summary.daily == [
            .init(date: "2026-02-27", cost: 1_000), .init(date: "2026-02-28", cost: 0),
            .init(date: "2026-03-01", cost: 5_000), .init(date: "2026-03-02", cost: 2),
        ])
        // A tie on spend goes to the model with more requests.
        #expect(summary.models.map(\.model) == ["claude", "gpt-5", "cheap", ""])
        #expect(summary.models[1] == .init(model: "gpt-5", requests: 3, tokens: 173, cost: 3_000))

        let one = TokensAccountPresentation.summarizeUsage(usage, model: "claude")
        #expect(one.cost == 3_000 && one.requests == 5 && one.daily.count == 4 && one.models.map(\.model) == ["claude"])
        #expect(TokensAccountPresentation.usageModelIDs(usage) == ["cheap", "claude", "gpt-5"])
        #expect(TokensAccountPresentation.datesBetween("2026-03-02", "2026-03-01").isEmpty)
        #expect(TokensAccountPresentation.datesBetween("2026-01-01", "2027-12-31").count == 400)
        #expect(TokensAccountPresentation.shortDate("2026-03-01") == "03-01")
        #expect(TokensAccountPresentation.shortDate("today") == "today")
    }

    @Test func accountInfoReadsBalanceAndLinks() throws {
        let info: V2TokensAccountInfo = try decode([
            "account": ["id": "u1", "displayName": NSNull(), "email": "a@example.com"],
            "balance": ["balance": "115.5000", "available": "100.0000", "held": "0.0000", "bonus": "15.5000"],
            "links": ["console": "https://t/console", "billing": "https://t/billing", "usage": "https://t/usage"],
        ])
        #expect(info.account.label == "a@example.com")
        #expect(TokensAccountPresentation.amountUnits(info.balance.balance) == 1_155_000)
        #expect(info.links.billing == "https://t/billing")
        let sparse: V2TokensAccountInfo = try decode(["balance": ["balance": 3], "links": ["console": "c", "billing": "b", "usage": "u"]])
        #expect(sparse.balance.balance == nil && sparse.account.id == "")
    }

    @Test func modelChoicesSaveForEveryRuntimeAndKeepOneOn() async throws {
        let transport = TestHTTPTransport()
        transport.respond = { call in
            switch call.path {
            case "/integrations/tokens/models": Data(#"{"applying":true}"#.utf8)
            case "/integrations/tokens/usage": Data(#"{"from":"2026-03-01","to":"2026-03-07","items":[]}"#.utf8)
            default: throw HTTPError.invalidResponse
            }
        }
        let account = TokensAccountModel(api: .init(transport: transport))
        var reports: [ModelConfigFeedback] = []
        account.report = { reports.append($0) }
        let tokens = try profile([["format": "openai_chat", "baseUrl": "https://t/v1", "models": [
            ["id": "a", "name": "Alpha"], ["id": "b"],
        ]]], preferences: ["disabled": ["b"], "names": [String: String]()])
        account.reconcile(profile: tokens)
        #expect(account.models.count == 2 && account.enabledCount == 1 && account.changes == 0 && !account.isDefault)
        #expect(account.expandedGroups == [""], "A short list starts open")

        account.setEnabled(["b"], true)
        account.rename(account.models[0], to: "  My Alpha  ")
        account.rename(account.models[1], to: "b")
        #expect(account.changes == 2 && account.enabledCount == 2)
        // The same push keeps the edits; new saved choices replace them.
        account.reconcile(profile: tokens)
        #expect(account.changes == 2)
        await account.saveDraft()
        let call = try #require(transport.calls.last)
        #expect(call.method == .put && call.path == "/integrations/tokens/models")
        #expect(call.body == .object(["disabled": .array([]), "names": .object(["a": .string("My Alpha")])]))
        #expect(reports.last == .success(String(localized: "Saved. Applying to the runtimes using Tokens Anywhere.")))
        #expect(account.changes == 0)

        account.setEnabled(["a", "b"], false)
        #expect(account.enabledCount == 0)
        await account.saveDraft()
        #expect(transport.calls.count == 1)
        #expect(reports.last == .error(String(localized: "Keep at least one model.")))
        account.discard()
        #expect(account.enabledCount == 2)

        transport.respond = { _ in throw HTTPError.server(statusCode: 503, message: "down", detail: .object(["code": .string("tokens_unavailable")])) }
        await account.restoreDefaults()
        #expect(transport.calls.last?.body == .object(["disabled": .array([]), "names": .object([:])]))
        #expect(reports.last == .error(String(localized: "Tokens Anywhere is unavailable right now.")))
    }

    @Test func usageReadsTheChosenDays() async throws {
        let transport = TestHTTPTransport()
        transport.respond = { _ in Data(#"{"from":"2026-03-01","to":"2026-03-02","items":[{"date":"2026-03-01","model":"m","requests":1,"amountCharged":"1.0000"}]}"#.utf8) }
        let account = TokensAccountModel(api: .init(transport: transport))
        account.usageDays = 30
        await account.loadUsage()
        #expect(transport.calls.last?.path == "/integrations/tokens/usage")
        #expect(transport.calls.last?.query == [URLQueryItem(name: "days", value: "30")])
        #expect(account.usageSummary?.cost == 10_000 && account.usageSummary?.daily.count == 2)
        account.usageModel = "gone"
        #expect(account.usageModelIDs == ["m", "gone"])
        #expect(account.usageSummary?.cost == 0)

        transport.respond = { _ in throw HTTPError.invalidResponse }
        await account.loadUsage()
        #expect(account.usageFailed && account.usage == nil)
        await account.loadInfo()
        #expect(account.infoFailed && account.info == nil)
        account.reset()
        #expect(!account.usageFailed && account.tab == nil && account.usageModel == nil)
    }
}
