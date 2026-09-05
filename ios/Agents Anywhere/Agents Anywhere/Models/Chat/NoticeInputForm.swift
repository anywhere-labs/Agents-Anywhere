import Foundation

struct NoticeInputQuestion: Identifiable {
    struct Option: Identifiable { let id: String; let label: String; let detail: String? }
    let id: String
    let prompt: String
    let multiple: Bool
    let allowCustom: Bool
    let options: [Option]
}

struct NoticeInputForm {
    let actionID: String
    let questions: [NoticeInputQuestion]

    init?(_ notice: V2RuntimeNotice) {
        guard notice.interactionType == "input_request",
              let action = notice.actions.first(where: {
                  $0.input.uiSchema?["component"]?.stringValue == "inputRequest"
                    && $0.input.uiSchema?["version"] == .number(1)
              }), let raw = action.input.uiSchema?["questions"]?.arrayValue, !raw.isEmpty else { return nil }
        var questions: [NoticeInputQuestion] = []
        for item in raw {
            guard let id = item["id"]?.stringValue, !id.isEmpty,
                  let prompt = item["prompt"]?.stringValue, !prompt.isEmpty,
                  let options = item["options"]?.arrayValue else { return nil }
            var parsed: [NoticeInputQuestion.Option] = []
            for option in options {
                guard let id = option["id"]?.stringValue, !id.isEmpty,
                      let label = option["label"]?.stringValue, !label.isEmpty else { return nil }
                parsed.append(.init(id: id, label: label, detail: option["description"]?.stringValue))
            }
            guard Set(parsed.map(\.id)).count == parsed.count else { return nil }
            questions.append(.init(id: id, prompt: prompt, multiple: item["multiple"]?.boolValue == true,
                allowCustom: item["allowCustom"]?.boolValue != false, options: parsed))
        }
        guard Set(questions.map(\.id)).count == questions.count else { return nil }
        self.actionID = action.id; self.questions = questions
    }

    func payload(choices: [String: Set<String>], custom: [String: String]) -> JSONValue? {
        var answers: [String: JSONValue] = [:]
        for question in questions {
            let selected = choices[question.id] ?? []
            guard selected.isSubset(of: Set(question.options.map(\.id))), question.multiple || selected.count <= 1 else { return nil }
            let text = question.allowCustom ? (custom[question.id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines) : ""
            guard !selected.isEmpty || !text.isEmpty else { return nil }
            var answer: [String: JSONValue] = ["optionIds": .array(question.options.filter { selected.contains($0.id) }.map { .string($0.id) })]
            if !text.isEmpty { answer["customText"] = .string(text) }
            answers[question.id] = .object(answer)
        }
        return .object(["answers": .object(answers)])
    }
}
