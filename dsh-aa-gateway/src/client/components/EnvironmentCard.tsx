import type { CSSProperties } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import {
  Button,
  Card,
  KeyValueRow,
  StatusPill,
  inputBase,
} from './Card.js'
import {
  type ConnectorActions,
  type ConnectorState,
  type PythonStatus,
  type UvSource,
} from '../stores/connector-store.js'

const PYPI_MIRROR_OPTIONS: ReadonlyArray<{ id: string; label: string; url: string }> = [
  { id: 'tsinghua', label: '清华大学开源软件镜像', url: 'https://pypi.tuna.tsinghua.edu.cn/simple' },
  { id: 'aliyun', label: '阿里云 PyPI 镜像', url: 'https://mirrors.aliyun.com/pypi/simple/' },
  { id: 'tencent', label: '腾讯云 PyPI 镜像', url: 'https://mirrors.cloud.tencent.com/pypi/simple/' },
  { id: 'official', label: 'PyPI 官方源', url: 'https://pypi.org/simple' },
]

const LOCALE_NS = 'dsh-aa-gateway'

interface EnvironmentCardProps {
  state: ConnectorState
  actions: ConnectorActions
  t: TranslateNS<typeof LOCALE_NS>
}

/**
 * Settings card for autostart, uv/Python diagnostics, PyPI mirror selection,
 * and a shortcut to open the persisted config directory.
 */
export function EnvironmentCard({ state, actions, t }: EnvironmentCardProps): JSX.Element {
  const env = state.environment

  return (
    <>
      <Card title={t('environment.autostart.title')} description={t('environment.autostart.description')}>
        <label style={toggleRowStyle}>
          <input
            type="checkbox"
            checked={env.autoStart}
            onChange={(event) => { void actions.updateEnvironment({ autoStart: event.target.checked }) }}
            style={checkboxStyle}
          />
          <span style={toggleLabelStyle}>{t('environment.autostart.label')}</span>
        </label>
        <p style={hintStyle}>{t('environment.autostart.hint')}</p>
      </Card>

      <Card title={t('environment.uv.title')} description={t('environment.uv.description')}>
        <KeyValueRow
          label={t('environment.uv.source')}
          value={
            <StatusPill tone={uvToneOf(env.uvSource)}>
              {uvSourceLabel(env.uvSource, t)}
            </StatusPill>
          }
          hint={uvSourceHint(env.uvSource, t)}
        />
        <KeyValueRow
          label={t('environment.uv.path')}
          value={env.uvPath ?? t('environment.uv.pathDefault')}
        />
        <KeyValueRow
          label={t('environment.uv.version')}
          value={env.uvVersion ?? '—'}
        />
      </Card>

      <Card title={t('environment.python.title')} description={t('environment.python.description')}>
        <KeyValueRow
          label={t('environment.python.status')}
          value={
            <StatusPill tone={pythonToneOf(env.pythonStatus)}>
              {pythonStatusLabel(env.pythonStatus, t)}
            </StatusPill>
          }
        />
        <KeyValueRow
          label={t('environment.python.version')}
          value={env.pythonVersion ?? '—'}
          hint={env.pythonStatus === 'pending' ? t('environment.python.pendingHint') : undefined}
        />
      </Card>

      <Card title={t('environment.mirror.title')} description={t('environment.mirror.description')}>
        <label style={mirrorLabelStyle} htmlFor="aa-pypi-mirror">{t('environment.mirror.label')}</label>
        <select
          id="aa-pypi-mirror"
          style={{ ...inputBase, appearance: 'none', cursor: 'pointer' }}
          value={env.pypiMirror}
          onChange={(event) => { void actions.updateEnvironment({ pypiMirror: event.target.value }) }}
        >
          {PYPI_MIRROR_OPTIONS.map((option: { id: string; label: string; url: string }) => (
            <option key={option.id} value={option.url}>{option.label}</option>
          ))}
          {!PYPI_MIRROR_OPTIONS.some((option: { id: string; label: string; url: string }) => option.url === env.pypiMirror) && (
            <option value={env.pypiMirror}>{env.pypiMirror}</option>
          )}
        </select>
        <p style={hintStyle}>{env.pypiMirror}</p>
      </Card>

      <Card title={t('environment.data.title')} description={t('environment.data.description')}>
        <KeyValueRow
          label={t('environment.data.dir')}
          value={<code style={codeStyle}>{state.dataDir}</code>}
        />
        <div style={dataActionRowStyle}>
          <Button variant="secondary" onClick={() => copyToClipboard(state.dataDir, t)}>
            {t('environment.data.copy')}
          </Button>
          <Button variant="ghost" onClick={() => undefined}>
            {t('environment.data.open')}
          </Button>
        </div>
      </Card>
    </>
  )
}

function uvToneOf(source: UvSource): 'success' | 'info' | 'warn' | 'neutral' {
  switch (source) {
    case 'npm-bundled':
      return 'success'
    case 'system':
      return 'info'
    case 'downloaded':
      return 'info'
    case 'custom':
      return 'warn'
    case 'unresolved':
      return 'warn'
  }
}

function uvSourceLabel(source: UvSource, t: EnvironmentCardProps['t']): string {
  switch (source) {
    case 'npm-bundled':
      return t('environment.uv.sourceNpmBundled')
    case 'system':
      return t('environment.uv.sourceSystem')
    case 'downloaded':
      return t('environment.uv.sourceDownloaded')
    case 'custom':
      return t('environment.uv.sourceCustom')
    case 'unresolved':
      return t('environment.uv.sourceUnresolved')
  }
}

function uvSourceHint(source: UvSource, t: EnvironmentCardProps['t']): string {
  switch (source) {
    case 'npm-bundled':
      return t('environment.uv.hintNpmBundled')
    case 'system':
      return t('environment.uv.hintSystem')
    case 'downloaded':
      return t('environment.uv.hintDownloaded')
    case 'custom':
      return t('environment.uv.hintCustom')
    case 'unresolved':
      return t('environment.uv.hintUnresolved')
  }
}

function pythonToneOf(status: PythonStatus): 'success' | 'warn' | 'error' {
  switch (status) {
    case 'ready':
      return 'success'
    case 'pending':
      return 'warn'
    case 'error':
      return 'error'
  }
}

function pythonStatusLabel(status: PythonStatus, t: EnvironmentCardProps['t']): string {
  switch (status) {
    case 'ready':
      return t('environment.python.statusReady')
    case 'pending':
      return t('environment.python.statusPending')
    case 'error':
      return t('environment.python.statusError')
  }
}

function copyToClipboard(value: string, t: EnvironmentCardProps['t']): void {
  if (typeof navigator !== 'undefined' && navigator.clipboard !== undefined) {
    void navigator.clipboard.writeText(value).catch(() => undefined)
  }
  void t
}

const toggleRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
}

const toggleLabelStyle: CSSProperties = {
  fontSize: 13,
  color: 'var(--dsw-alias-label-primary, #1f1f1f)',
}

const checkboxStyle: CSSProperties = {
  margin: 0,
  width: 16,
  height: 16,
}

const hintStyle: CSSProperties = {
  margin: 0,
  fontSize: 11,
  lineHeight: 1.5,
  color: 'var(--dsw-alias-label-tertiary, #9a9a9a)',
}

const mirrorLabelStyle: CSSProperties = {
  fontSize: 12,
  color: 'var(--dsw-alias-label-secondary, #6b6b6b)',
}

const codeStyle: CSSProperties = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 12,
  padding: '1px 6px',
  borderRadius: 4,
  background: 'var(--dsw-alias-bg-layer-2, rgba(127, 127, 127, 0.08))',
}

const dataActionRowStyle: CSSProperties = {
  display: 'flex',
  gap: 8,
  flexWrap: 'wrap',
}
