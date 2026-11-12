import SwiftUI

struct SessionGoalPanel: View {
  let chat: SessionChatModel
  @State private var resuming = false
  @State private var editing = false
  @State private var objective = ""
  var body: some View {
    VStack(spacing: 0) {
      if let state = chat.session.goalState, let goal = state.goal {
        let actions =
          state.freshness == "fresh" && chat.goalUsable && chat.session.metadata?.takeover == true
          ? state.capabilities?.actions ?? [] : []
        HStack(spacing: 8) {
          Image(systemName: "target").accessibilityHidden(true)
          Text(status(goal.status)).font(.caption)
          Button {
            objective = goal.objective
            editing = true
          } label: {
            Text(goal.objective).lineLimit(1).frame(maxWidth: .infinity, alignment: .leading)
          }.disabled(chat.isWorking || !actions.contains("edit"))
          if let budget = goal.tokenBudget, let used = goal.tokensUsed,
            ["active", "budgetLimited"].contains(goal.status)
          {
            Text("\(used) / \(budget)").font(.caption).monospacedDigit()
          } else if let seconds = goal.timeUsedSeconds {
            Text(Duration.seconds(seconds).formatted(.time(pattern: .hourMinuteSecond))).font(
              .caption
            ).monospacedDigit()
          }
          if goal.status == "active", actions.contains("pause") {
            Button {
              Task { _ = await chat.goalAction("pause") }
            } label: {
              Image(systemName: "pause")
            }.accessibilityLabel(String(localized: "暂停目标"))
          }
          if ["paused", "blocked", "usageLimited"].contains(goal.status), actions.contains("resume")
          {
            Button {
              resuming = true
            } label: {
              Image(systemName: "play")
            }.accessibilityLabel(String(localized: "恢复目标"))
          }
          if actions.contains("clear") {
            Button {
              Task { _ = await chat.goalAction("clear") }
            } label: {
              Image(systemName: "xmark")
            }.accessibilityLabel(String(localized: "清除目标"))
          }
        }.buttonStyle(.plain).padding(.horizontal, 16).padding(.vertical, 8).disabled(
          chat.isWorking)
      }
      if chat.goalMode {
        HStack {
          Text(String(localized: "目标"))
          Button {
            chat.goalMode = false
          } label: {
            Image(systemName: "xmark")
          }.accessibilityLabel(String(localized: "退出目标输入"))
          Spacer()
        }.font(.caption).padding(.horizontal, 16)
      }
    }
    .sheet(isPresented: $editing) {
      NavigationStack {
        TextEditor(text: $objective).padding().navigationTitle(String(localized: "编辑目标")).toolbar {
          ToolbarItem(placement: .cancellationAction) {
            Button(String(localized: "取消")) { editing = false }
          }
          ToolbarItem(placement: .confirmationAction) {
            Button(String(localized: "保存")) {
              Task {
                if await chat.goalAction(
                  "edit", objective: objective.trimmingCharacters(in: .whitespacesAndNewlines))
                {
                  editing = false
                }
              }
            }.disabled(
              chat.isWorking || objective.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                || objective == chat.session.goalState?.goal?.objective)
          }
        }
      }
    }
    .confirmationDialog(
      String(localized: "恢复此目标？"), isPresented: $resuming, titleVisibility: .visible
    ) {
      Button(String(localized: "恢复目标")) { Task { _ = await chat.goalAction("resume") } }
      Button(String(localized: "取消"), role: .cancel) {}
    } message: {
      Text(chat.session.goalState?.goal?.objective ?? "")
    }
    .alert(
      String(localized: "替换当前目标？"),
      isPresented: Binding(
        get: { chat.goalReplacementText != nil }, set: { if !$0 { chat.goalReplacementText = nil } }
      )
    ) {
      Button(String(localized: "取消"), role: .cancel) { chat.goalReplacementText = nil }
      Button(String(localized: "替换目标")) {
        let text = chat.goalReplacementText
        chat.goalReplacementText = nil
        if let text { Task { await chat.sendGoal(text, confirmed: true) } }
      }
    } message: {
      Text(chat.goalReplacementText ?? "")
    }
    .task(id: chat.session.id) {
      while !Task.isCancelled {
        await chat.repository.refreshGoal(sessionId: chat.session.id)
        try? await Task.sleep(for: .seconds(3))
      }
    }
  }
  private func status(_ value: String) -> String {
    switch value {
    case "active": return String(localized: "目标进行中")
    case "paused": return String(localized: "目标已暂停")
    case "blocked": return String(localized: "目标受阻")
    case "usageLimited": return String(localized: "目标用量受限")
    case "budgetLimited": return String(localized: "目标预算受限")
    default: return String(localized: "目标")
    }
  }
}
