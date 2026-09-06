export const onboarding = {
  agents: ["Codex", "Claude Code", "DeepSeek Harness"],
  downloadsUrl: "https://github.com/anywhere-labs/Agents-Anywhere/releases",
  learnMoreUrl: "https://github.com/anywhere-labs/Agents-Anywhere",
} as const

export const steps = [
  { id: "welcome", label: "认识 Agent" },
  { id: "device", label: "配置设备" },
  { id: "phone", label: "连接手机" },
  { id: "complete", label: "准备就绪" },
] as const

export type DialogKind = "phone" | "skip"

export type SlideProps = {
  onNext: () => void
}
