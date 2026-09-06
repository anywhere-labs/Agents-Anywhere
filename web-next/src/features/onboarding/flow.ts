export type OnboardingStep = 'agents' | 'mobile-choice' | 'mobile' | 'complete'
export interface OnboardingTarget { connectorId: string; flowId: string }

export function readOnboardingTarget(params: { get(name: string): string | null }): OnboardingTarget | null {
  const connectorId = params.get('connectorId') ?? ''
  const flowId = params.get('flowId') ?? ''
  if (params.get('source') !== 'dsh-plugin' || !/^conn_[A-Za-z0-9_-]{1,100}$/.test(connectorId) || !/^[A-Za-z0-9_-]{16,100}$/.test(flowId)) return null
  return { connectorId, flowId }
}

const keyFor = (target: OnboardingTarget, userId: string) => `agents-anywhere.onboarding:${userId}:${target.connectorId}:${target.flowId}`

export function restoreOnboardingStep(target: OnboardingTarget, userId: string, storage: Pick<Storage, 'getItem'>): OnboardingStep {
  try {
    const step = storage.getItem(keyFor(target, userId))
    if (step === 'mobile-choice' || step === 'mobile' || step === 'complete') return step
  } catch { /* A restricted browser can still run the flow without persistence. */ }
  return 'agents'
}

export function saveOnboardingStep(target: OnboardingTarget, userId: string, step: OnboardingStep, storage: Pick<Storage, 'setItem'>): void {
  try { storage.setItem(keyFor(target, userId), step) } catch { /* Best effort. */ }
}
