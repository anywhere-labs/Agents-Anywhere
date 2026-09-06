import { useEffect, useState, useCallback, useRef, type CSSProperties } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, Card, StatusPill, inputBase, codeSurface } from './Card.js'
import type {
  ConnectorActions,
  ConnectorState,
  MobileLoginQrData,
  MobileLoginStatusInfo,
} from '../stores/connector-store.js'

const LOCALE_NS = 'dsh-aa-gateway'

interface OnboardingWizardProps {
  state: ConnectorState
  actions: ConnectorActions
  onFinish?: () => void
  t: TranslateNS<typeof LOCALE_NS>
}

type OnboardingStep = 1 | 2 | 3 | 4

export function OnboardingWizard({ state, actions, onFinish, t }: OnboardingWizardProps): JSX.Element {
  const [currentStep, setCurrentStep] = useState<OnboardingStep>(() => (state.account ? 2 : 1))
  const [serverDraft, setServerDraft] = useState(state.oauth?.serverUrl || 'https://api.anywhere.app.com')

  // Automatically advance to Step 2 when logged in from Step 1
  useEffect(() => {
    if (state.account && currentStep === 1) {
      setCurrentStep(2)
    }
  }, [state.account, currentStep])

  return (
    <div style={wizardContainerStyle}>
      <header style={wizardHeaderStyle}>
        <div>
          <h2 style={wizardTitleStyle}>{t('onboarding.title')}</h2>
          <p style={wizardSubtitleStyle}>{t('onboarding.subtitle')}</p>
        </div>
        {onFinish && (
          <Button variant="ghost" onClick={onFinish} style={{ fontSize: 13 }}>
            {t('action.cancel')}
          </Button>
        )}
      </header>

      {/* Stepper Navigation */}
      <nav style={stepperNavStyle} aria-label="Onboarding Progress">
        <StepNavItem
          step={1}
          label={t('onboarding.step1.nav')}
          active={currentStep === 1}
          completed={!!state.account || currentStep > 1}
          onClick={() => setCurrentStep(1)}
        />
        <div style={stepperDividerStyle} />
        <StepNavItem
          step={2}
          label={t('onboarding.step2.nav')}
          active={currentStep === 2}
          completed={currentStep > 2}
          onClick={() => setCurrentStep(2)}
        />
        <div style={stepperDividerStyle} />
        <StepNavItem
          step={3}
          label={t('onboarding.step3.nav')}
          active={currentStep === 3}
          completed={currentStep > 3}
          onClick={() => setCurrentStep(3)}
        />
        <div style={stepperDividerStyle} />
        <StepNavItem
          step={4}
          label={t('onboarding.step4.nav')}
          active={currentStep === 4}
          completed={currentStep === 4 && state.runtime === 'running'}
          onClick={() => setCurrentStep(4)}
        />
      </nav>

      {/* Step Content */}
      <main style={stepCardWrapperStyle}>
        {currentStep === 1 && (
          <Step1WebLogin
            state={state}
            actions={actions}
            serverDraft={serverDraft}
            setServerDraft={setServerDraft}
            onNext={() => setCurrentStep(2)}
            onCancel={onFinish}
            t={t}
          />
        )}
        {currentStep === 2 && (
          <Step2DownloadApp
            state={state}
            actions={actions}
            onNext={() => setCurrentStep(3)}
            onCancel={onFinish}
            t={t}
          />
        )}
        {currentStep === 3 && (
          <Step3MobileQrLogin
            state={state}
            actions={actions}
            onNext={() => setCurrentStep(4)}
            onCancel={onFinish}
            t={t}
          />
        )}
        {currentStep === 4 && (
          <Step4AllReady
            state={state}
            onFinish={onFinish}
            onBack={() => setCurrentStep(3)}
            t={t}
          />
        )}
      </main>
    </div>
  )
}

// ─── Step 1: Web Login & Auto Device Registration ──────────────────────────

function Step1WebLogin({
  state,
  actions,
  serverDraft,
  setServerDraft,
  onNext,
  onCancel,
  t,
}: {
  state: ConnectorState
  actions: ConnectorActions
  serverDraft: string
  setServerDraft: (val: string) => void
  onNext: () => void
  onCancel?: (() => void) | undefined
  t: TranslateNS<typeof LOCALE_NS>
}) {
  const isAuthorizing =
    state.oauth?.status === 'opening_browser' ||
    state.oauth?.status === 'waiting_callback' ||
    state.oauth?.status === 'registering_device'

  const isLoggedIn = !!state.account

  return (
    <Card
      title={t('onboarding.step1.title')}
      description={t('onboarding.step1.desc')}
    >
      <div style={formStackStyle}>
        <div style={inputGroupStyle}>
          <label style={labelStyle} htmlFor="aa-oauth-server-input">
            {t('onboarding.step1.serverLabel')}
          </label>
          <input
            id="aa-oauth-server-input"
            type="url"
            spellCheck={false}
            autoComplete="off"
            value={serverDraft}
            placeholder="https://api.anywhere.app.com"
            onChange={(e) => setServerDraft(e.target.value)}
            disabled={isAuthorizing}
            style={{ ...inputBase, width: '100%' }}
          />
        </div>

        {state.oauth?.lastError && (
          <div style={errorBannerStyle}>
            <span>✕ {state.oauth.lastError}</span>
          </div>
        )}

        {isLoggedIn ? (
          <div style={successBannerStyle}>
            <div style={badgeSuccessStyle}>✓</div>
            <div>
              <p style={{ margin: 0, fontWeight: 600 }}>{t('account.title')}: {state.account?.userId}</p>
              <p style={{ margin: 0, fontSize: 12, opacity: 0.85 }}>{t('account.server')}: {state.account?.serverUrl}</p>
            </div>
          </div>
        ) : null}

        <div style={buttonRowStyle}>
          {isAuthorizing ? (
            <>
              <Button disabled variant="secondary">
                <span style={spinnerStyle}>⏳</span> {t('onboarding.step1.waiting')}
              </Button>
              <Button variant="ghost" onClick={() => void actions.cancelOAuthLogin()}>
                {t('onboarding.step1.cancel')}
              </Button>
            </>
          ) : isLoggedIn ? (
            <>
              <Button variant="primary" onClick={onNext}>
                {t('onboarding.step2.nextBtn')} →
              </Button>
              <Button variant="ghost" onClick={() => void actions.startOAuthLogin(serverDraft)}>
                {t('account.relogin')}
              </Button>
              {onCancel && (
                <Button variant="ghost" onClick={onCancel}>
                  {t('action.cancel')}
                </Button>
              )}
            </>
          ) : (
            <>
              <Button
                variant="primary"
                onClick={() => void actions.startOAuthLogin(serverDraft)}
              >
                {t('onboarding.step1.loginBtn')}
              </Button>
              {onCancel && (
                <Button variant="ghost" onClick={onCancel}>
                  {t('action.cancel')}
                </Button>
              )}
            </>
          )}
        </div>
      </div>
    </Card>
  )
}

// ─── Step 2: Download Mobile App ────────────────────────────────────────────

function Step2DownloadApp({
  state,
  actions,
  onNext,
  onCancel,
  t,
}: {
  state: ConnectorState
  actions: ConnectorActions
  onNext: () => void
  onCancel?: (() => void) | undefined
  t: TranslateNS<typeof LOCALE_NS>
}) {
  const [iosQr, setIosQr] = useState<string | null>(null)
  const [androidQr, setAndroidQr] = useState<string | null>(null)

  useEffect(() => {
    const serverUrl = state.account?.serverUrl || state.oauth?.serverUrl || 'https://api.anywhere.app.com'
    void actions.getAppDownloadQr(serverUrl).then((res) => {
      if (res) {
        setIosQr(res.iosQr)
        setAndroidQr(res.androidQr)
      }
    })
  }, [state.account, state.oauth, actions])

  return (
    <Card
      title={t('onboarding.step2.title')}
      description={t('onboarding.step2.desc')}
    >
      <div style={downloadGridStyle}>
        <div style={downloadCardStyle}>
          <span style={downloadCardTitleStyle}>{t('onboarding.step2.ios')}</span>
          {iosQr ? (
            <img src={iosQr} alt="iOS Download QR" style={qrImageStyle} width={140} height={140} />
          ) : (
            <div style={qrPlaceholderStyle}>App Store</div>
          )}
          <span style={hintTextStyle}>扫码下载 iOS App</span>
        </div>

        <div style={downloadCardStyle}>
          <span style={downloadCardTitleStyle}>{t('onboarding.step2.android')}</span>
          {androidQr ? (
            <img src={androidQr} alt="Android Download QR" style={qrImageStyle} width={140} height={140} />
          ) : (
            <div style={qrPlaceholderStyle}>Android APK</div>
          )}
          <span style={hintTextStyle}>扫码下载 Android App</span>
        </div>
      </div>

      <div style={buttonRowStyle}>
        <Button variant="primary" onClick={onNext}>
          {t('onboarding.step2.nextBtn')} →
        </Button>
        {onCancel && (
          <Button variant="ghost" onClick={onCancel}>
            {t('action.cancel')}
          </Button>
        )}
      </div>
    </Card>
  )
}

// ─── Step 3: Mobile QR Scan & Login ─────────────────────────────────────────

function Step3MobileQrLogin({
  state,
  actions,
  onNext,
  onCancel,
  t,
}: {
  state: ConnectorState
  actions: ConnectorActions
  onNext: () => void
  onCancel?: (() => void) | undefined
  t: TranslateNS<typeof LOCALE_NS>
}) {
  const [qrData, setQrData] = useState<MobileLoginQrData | null>(null)
  const [qrImage, setQrImage] = useState<string | null>(null)
  const [statusInfo, setStatusInfo] = useState<MobileLoginStatusInfo | null>(null)
  const [loading, setLoading] = useState(false)
  const mountedRef = useRef(true)

  const generateQr = useCallback(async () => {
    setLoading(true)
    try {
      const data = await actions.createMobileLoginQr()
      if (!mountedRef.current) return
      if (data) {
        setQrData(data)
        setQrImage(data.qrImage)
        setStatusInfo(null)
      }
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }, [actions])

  useEffect(() => {
    mountedRef.current = true
    void generateQr()
    return () => {
      mountedRef.current = false
    }
  }, [generateQr])

  // Poll status while QR is active
  useEffect(() => {
    if (!qrData?.loginToken) return
    let cancelled = false

    const timer = setInterval(async () => {
      const status = await actions.getMobileLoginStatus(qrData.loginToken)
      if (cancelled || !status) return
      setStatusInfo(status)

      if (status.status === 'approved' || status.status === 'consumed') {
        clearInterval(timer)
        // Auto advance after 1 second
        setTimeout(() => {
          if (!cancelled) onNext()
        }, 1200)
      }
    }, 1500)

    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [qrData, actions, onNext])

  const isConfirmed = statusInfo?.status === 'approved' || statusInfo?.status === 'consumed'
  const isExpired = statusInfo?.status === 'expired'

  return (
    <Card
      title={t('onboarding.step3.title')}
      description={t('onboarding.step3.desc')}
    >
      <div style={qrBoxContainerStyle}>
        {loading ? (
          <div style={qrLoadingStyle}>
            <span style={spinnerStyle}>⏳</span>
            <p style={hintTextStyle}>{t('onboarding.step3.qrGenerating')}</p>
          </div>
        ) : isConfirmed ? (
          <div style={qrConfirmedBoxStyle}>
            <div style={bigCheckStyle}>✓</div>
            <p style={{ margin: 0, fontWeight: 600 }}>{t('onboarding.step3.confirmed')}</p>
          </div>
        ) : qrImage ? (
          <div style={qrCardStyle}>
            <div style={qrWhiteWrapperStyle}>
              <img src={qrImage} alt={t('onboarding.step3.qrAlt')} width={180} height={180} style={{ display: 'block' }} />
            </div>
            {isExpired ? (
              <div style={expiredNoteStyle}>
                <p style={{ margin: 0, color: 'var(--dsw-alias-state-error-primary)', fontSize: 13 }}>
                  {t('onboarding.step3.expired')}
                </p>
                <Button variant="secondary" onClick={() => void generateQr()}>
                  {t('onboarding.step3.refresh')}
                </Button>
              </div>
            ) : (
              <div style={{ textAlign: 'center', marginTop: 8 }}>
                <p style={hintTextStyle}>
                  {statusInfo?.status === 'pending_web_confirm'
                    ? t('onboarding.step3.pendingConfirm')
                    : t('onboarding.step3.waitingScan')}
                </p>
              </div>
            )}
          </div>
        ) : (
          <Button variant="secondary" onClick={() => void generateQr()}>
            {t('onboarding.step3.refresh')}
          </Button>
        )}
      </div>

      <div style={buttonRowStyle}>
        <Button variant="primary" onClick={onNext}>
          {t('onboarding.step3.nextBtn')} →
        </Button>
        {onCancel && (
          <Button variant="ghost" onClick={onCancel}>
            {t('action.cancel')}
          </Button>
        )}
      </div>
    </Card>
  )
}

// ─── Step 4: Device Paired & All Ready ──────────────────────────────────────

function Step4AllReady({
  state,
  onFinish,
  onBack,
  t,
}: {
  state: ConnectorState
  onFinish?: (() => void) | undefined
  onBack: () => void
  t: TranslateNS<typeof LOCALE_NS>
}) {
  const isRunning = state.runtime === 'running'

  return (
    <Card
      title={t('onboarding.step4.title')}
      description={t('onboarding.step4.desc')}
    >
      <div style={readyCardGridStyle}>
        <div style={readyItemCardStyle}>
          <div style={readyCheckCircleStyle}>✓</div>
          <div>
            <h4 style={readyItemTitleStyle}>{t('onboarding.step4.deviceReady')}</h4>
            <p style={readyItemDescStyle}>
              {state.device?.deviceName || 'Desktop Connector'} • <span style={codeSurface}>{state.runtime}</span>
            </p>
          </div>
        </div>

        <div style={readyItemCardStyle}>
          <div style={readyCheckCircleStyle}>✓</div>
          <div>
            <h4 style={readyItemTitleStyle}>{t('onboarding.step4.mobileReady')}</h4>
            <p style={readyItemDescStyle}>
              {state.account?.userId || 'User'} @ {state.account?.serverUrl || 'AA Server'}
            </p>
          </div>
        </div>
      </div>

      <div style={buttonRowStyle}>
        <Button variant="primary" onClick={() => onFinish?.()}>
          {t('onboarding.step4.finishBtn')} 🎉
        </Button>
        {onFinish && (
          <Button variant="ghost" onClick={() => onFinish()}>
            {t('action.cancel')}
          </Button>
        )}
      </div>
    </Card>
  )
}

// ─── Navigation Item ────────────────────────────────────────────────────────

function StepNavItem({
  step,
  label,
  active,
  completed,
  onClick,
}: {
  step: number
  label: string
  active: boolean
  completed: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        ...stepNavButtonStyle,
        ...(active ? stepNavButtonActiveStyle : completed ? stepNavButtonCompletedStyle : {}),
      }}
    >
      <span
        style={{
          ...stepCircleStyle,
          ...(active ? stepCircleActiveStyle : completed ? stepCircleCompletedStyle : {}),
        }}
      >
        {completed && !active ? '✓' : step}
      </span>
      <span style={stepNavLabelStyle}>{label}</span>
    </button>
  )
}

// ─── Styles ─────────────────────────────────────────────────────────────────

const wizardContainerStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 18,
}

const wizardHeaderStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
}

const wizardTitleStyle: CSSProperties = {
  margin: 0,
  fontSize: 16,
  fontWeight: 600,
  color: 'var(--dsw-alias-label-primary)',
}

const wizardSubtitleStyle: CSSProperties = {
  margin: '4px 0 0 0',
  fontSize: 13,
  color: 'var(--dsw-alias-label-secondary)',
}

const stepperNavStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 4,
  padding: '6px 10px',
  borderRadius: 8,
  background: 'var(--dsw-alias-bg-layer-2)',
  border: '1px solid var(--dsw-alias-border-l2)',
  boxSizing: 'border-box',
  width: '100%',
}

const stepperDividerStyle: CSSProperties = {
  flex: 1,
  height: 1,
  background: 'var(--dsw-alias-border-l2)',
  minWidth: 4,
  maxWidth: 20,
  flexShrink: 1,
}

const stepNavButtonStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 6,
  background: 'transparent',
  border: 'none',
  padding: '4px 6px',
  borderRadius: 6,
  cursor: 'pointer',
  font: 'inherit',
  color: 'var(--dsw-alias-label-tertiary)',
  transition: 'all 120ms ease',
  whiteSpace: 'nowrap',
  flexShrink: 0,
}

const stepNavButtonActiveStyle: CSSProperties = {
  color: 'var(--dsw-alias-brand-primary)',
  fontWeight: 600,
}

const stepNavButtonCompletedStyle: CSSProperties = {
  color: 'var(--dsw-alias-label-primary)',
}

const stepCircleStyle: CSSProperties = {
  width: 20,
  height: 20,
  minWidth: 20,
  minHeight: 20,
  maxWidth: 20,
  maxHeight: 20,
  aspectRatio: '1 / 1',
  borderRadius: '50%',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: 11,
  fontWeight: 600,
  lineHeight: 1,
  flexShrink: 0,
  boxSizing: 'border-box',
  background: 'var(--dsw-alias-bg-layer-3)',
  color: 'var(--dsw-alias-label-secondary)',
}

const stepCircleActiveStyle: CSSProperties = {
  background: 'var(--dsw-alias-brand-primary)',
  color: 'var(--dsw-alias-label-primary-inverted)',
  boxShadow: '0 0 0 2px var(--dsw-alias-bg-layer-2), 0 0 0 3px var(--dsw-alias-brand-primary)',
}

const stepCircleCompletedStyle: CSSProperties = {
  background: 'var(--dsw-alias-state-success-tertiary)',
  color: 'var(--dsw-alias-state-success-primary)',
  border: '1px solid var(--dsw-alias-state-success-primary)',
}

const stepNavLabelStyle: CSSProperties = {
  fontSize: 12,
  whiteSpace: 'nowrap',
}

const stepCardWrapperStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 16,
}

const formStackStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 16,
}

const inputGroupStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
}

const labelStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 500,
  color: 'var(--dsw-alias-label-secondary)',
}

const buttonRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  marginTop: 8,
}

const errorBannerStyle: CSSProperties = {
  padding: '10px 14px',
  borderRadius: 8,
  background: 'var(--dsw-alias-state-error-secondary)',
  color: 'var(--dsw-alias-state-error-primary)',
  fontSize: 13,
}

const successBannerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  padding: '12px 16px',
  borderRadius: 8,
  background: 'var(--dsw-alias-state-success-tertiary)',
  color: 'var(--dsw-alias-state-success-primary)',
}

const badgeSuccessStyle: CSSProperties = {
  width: 28,
  height: 28,
  borderRadius: '50%',
  background: 'var(--dsw-alias-state-success-primary)',
  color: 'white',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontWeight: 700,
}

const downloadGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
  gap: 16,
  margin: '12px 0',
}

const downloadCardStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  padding: '18px 14px',
  borderRadius: 10,
  border: '1px solid var(--dsw-alias-border-l2)',
  background: 'var(--dsw-alias-bg-layer-2)',
  gap: 10,
}

const downloadCardTitleStyle: CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  color: 'var(--dsw-alias-label-primary)',
}

const qrImageStyle: CSSProperties = {
  borderRadius: 8,
  background: 'white',
  padding: 4,
}

const qrPlaceholderStyle: CSSProperties = {
  width: 140,
  height: 140,
  borderRadius: 8,
  background: 'var(--dsw-alias-bg-layer-3)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: 12,
  color: 'var(--dsw-alias-label-tertiary)',
}

const hintTextStyle: CSSProperties = {
  fontSize: 12,
  color: 'var(--dsw-alias-label-secondary)',
}

const qrBoxContainerStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '24px 0',
}

const qrCardStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 12,
}

const qrWhiteWrapperStyle: CSSProperties = {
  padding: 12,
  background: 'white',
  borderRadius: 12,
  boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
}

const qrLoadingStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 8,
  padding: 32,
}

const qrConfirmedBoxStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 12,
  padding: 24,
  color: 'var(--dsw-alias-state-success-primary)',
}

const bigCheckStyle: CSSProperties = {
  width: 48,
  height: 48,
  borderRadius: '50%',
  background: 'var(--dsw-alias-state-success-tertiary)',
  border: '2px solid var(--dsw-alias-state-success-primary)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: 24,
  fontWeight: 700,
}

const expiredNoteStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 8,
}

const readyCardGridStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  margin: '12px 0',
}

const readyItemCardStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 14,
  padding: '14px 18px',
  borderRadius: 10,
  border: '1px solid var(--dsw-alias-border-l2)',
  background: 'var(--dsw-alias-bg-layer-2)',
}

const readyCheckCircleStyle: CSSProperties = {
  width: 32,
  height: 32,
  borderRadius: '50%',
  background: 'var(--dsw-alias-state-success-tertiary)',
  color: 'var(--dsw-alias-state-success-primary)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontWeight: 700,
  fontSize: 16,
}

const readyItemTitleStyle: CSSProperties = {
  margin: 0,
  fontSize: 13,
  fontWeight: 600,
  color: 'var(--dsw-alias-label-primary)',
}

const readyItemDescStyle: CSSProperties = {
  margin: '3px 0 0 0',
  fontSize: 12,
  color: 'var(--dsw-alias-label-secondary)',
}

const spinnerStyle: CSSProperties = {
  display: 'inline-block',
}
