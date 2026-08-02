import XCTest
@testable import Agents_Anywhere

@MainActor
final class RuntimeConfigContractTests: XCTestCase {
    func testDecodesNestedEffortsAndDefaultFlags() throws {
        let data = Data(
            """
            {
              "value":"gpt-5.6-luna",
              "label":"GPT-5.6 Luna",
              "isDefault":false,
              "efforts":[
                {"value":"low","label":"Low"},
                {"value":"medium","label":"Medium","isDefault":true}
              ]
            }
            """.utf8
        )

        let option = try JSONDecoder().decode(RuntimeConfigOption.self, from: data)

        XCTAssertEqual(option.value.stringValue, "gpt-5.6-luna")
        XCTAssertEqual(option.isDefault, false)
        XCTAssertEqual(option.efforts?.map { $0.value.stringValue }, ["low", "medium"])
        XCTAssertEqual(option.efforts?.first(where: { $0.isDefault == true })?.value.stringValue, "medium")
    }

    func testRuntimeSettingsResponseDecodesDeviceEffectiveSchema() throws {
        let data = Data(
            """
            {
              "runtime":"codex",
              "settings":{"model":"gpt-5.6-luna","effort":"medium"},
              "schema":{
                "runtime":"codex",
                "schemaVersion":4,
                "fields":[
                  {
                    "key":"model",
                    "label":"Model",
                    "type":"enum",
                    "options":[
                      {
                        "value":"gpt-5.6-luna",
                        "label":"GPT-5.6 Luna",
                        "efforts":[{"value":"medium","label":"Medium","isDefault":true}]
                      }
                    ]
                  }
                ]
              },
              "schemaVersion":4,
              "serverTime":"2026-08-02T00:00:00Z"
            }
            """.utf8
        )

        let response = try JSONDecoder().decode(RuntimeSettingsResponse.self, from: data)
        let model = response.schema?.fields.first?.options?.first

        XCTAssertEqual(response.schema?.schemaVersion, 4)
        XCTAssertEqual(model?.value.stringValue, "gpt-5.6-luna")
        XCTAssertEqual(model?.efforts?.first?.value.stringValue, "medium")
    }

    func testFiltersEffortUsingNestedModelConstraintForEveryRuntime() {
        let effortField = RuntimeConfigField(
            key: "effort",
            label: "Effort",
            type: "enum",
            description: nil,
            options: [
                RuntimeConfigOption(value: .string("low"), label: "Low", description: nil, efforts: nil, isDefault: false),
                RuntimeConfigOption(value: .string("medium"), label: "Medium", description: nil, efforts: nil, isDefault: true),
                RuntimeConfigOption(value: .string("ultra"), label: "Ultra", description: nil, efforts: nil, isDefault: false),
            ],
            runtimeOptionsSource: nil,
            visibleWhen: nil,
            allowSessionOverride: true,
            hidden: nil,
            fields: nil
        )
        let modelField = RuntimeConfigField(
            key: "model",
            label: "Model",
            type: "enum",
            description: nil,
            options: [
                RuntimeConfigOption(
                    value: .string("gpt-5.6-luna"),
                    label: "GPT-5.6 Luna",
                    description: nil,
                    efforts: [
                        RuntimeConfigOption(value: .string("low"), label: "Low", description: nil, efforts: nil, isDefault: false),
                        RuntimeConfigOption(value: .string("medium"), label: "Medium", description: nil, efforts: nil, isDefault: true),
                    ],
                    isDefault: false
                ),
            ],
            runtimeOptionsSource: nil,
            visibleWhen: nil,
            allowSessionOverride: true,
            hidden: nil,
            fields: nil
        )

        let schema = RuntimeConfigSchema(runtime: "codex", schemaVersion: 4, fields: [modelField, effortField])
        let filtered = filterRuntimeEffortField(
            runtime: "codex",
            field: effortField,
            modelField: modelField,
            model: .string("gpt-5.6-luna")
        )

        XCTAssertEqual(schema.fields.first?.key, "model")
        XCTAssertEqual(filtered?.options?.map { $0.value.stringValue }, ["low", "medium"])
    }

    func testExplicitEmptyNestedEffortsHidesSelector() {
        let field = RuntimeConfigField(
            key: "effort",
            label: "Effort",
            type: "enum",
            description: nil,
            options: [
                RuntimeConfigOption(value: .string("gpt-no-effort"), label: "No effort", description: nil, efforts: [], isDefault: false),
            ],
            runtimeOptionsSource: nil,
            visibleWhen: nil,
            allowSessionOverride: true,
            hidden: nil,
            fields: nil
        )

        XCTAssertNil(
            filterRuntimeEffortField(
                runtime: "codex",
                field: field,
                modelField: field,
                model: .string("gpt-no-effort")
            )
        )
    }

    func testModelSelectionNormalizesEffortBeforeCreatePayload() {
        let modelField = RuntimeConfigField(
            key: "model",
            label: "Model",
            type: "enum",
            description: nil,
            options: [
                RuntimeConfigOption(
                    value: .string("gpt-5.6-luna"),
                    label: "GPT-5.6 Luna",
                    description: nil,
                    efforts: [
                        RuntimeConfigOption(value: .string("low"), label: "Low", description: nil, efforts: nil, isDefault: false),
                        RuntimeConfigOption(value: .string("medium"), label: "Medium", description: nil, efforts: nil, isDefault: true),
                    ],
                    isDefault: false
                ),
                RuntimeConfigOption(
                    value: .string("gpt-no-effort"),
                    label: "No Effort",
                    description: nil,
                    efforts: [],
                    isDefault: false
                ),
            ],
            runtimeOptionsSource: nil,
            visibleWhen: nil,
            allowSessionOverride: true,
            hidden: nil,
            fields: nil
        )

        let lunaPayload = runtimeSettingsSelectingModel(
            ["model": .string("gpt-5.6-sol"), "effort": .string("ultra")],
            model: .string("gpt-5.6-luna"),
            modelField: modelField
        )
        XCTAssertEqual(lunaPayload["model"], .string("gpt-5.6-luna"))
        XCTAssertEqual(lunaPayload["effort"], .string("medium"))

        let noEffortPayload = runtimeSettingsSelectingModel(
            lunaPayload,
            model: .string("gpt-no-effort"),
            modelField: modelField
        )
        XCTAssertEqual(noEffortPayload["model"], .string("gpt-no-effort"))
        XCTAssertNil(noEffortPayload["effort"])
    }
}
