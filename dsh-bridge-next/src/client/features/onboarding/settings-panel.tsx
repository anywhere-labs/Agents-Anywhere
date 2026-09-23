import { translateMessage, type Translate } from '../../locales.js'
import { useEffect, useId, useState } from 'react'
import { Button, Input, Menu, RiskConfirmation, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { ChevronDown, FolderOpen, Power, RotateCw } from 'lucide-react'
import { PYPI_MIRRORS, PYTHON_MIRRORS, SYNC_INTERVALS } from '../../../contracts/connector.js'
import type { OnboardingHostApi, OnboardingSnapshot } from '../../../contracts/index.js'
import { connectorStatus } from './account-panel.js'
import type { OnboardingState } from './state.js'
import css from './settings-panel.module.css'

function Choice({ label, value, options, disabled, onChange }: {
  label: string; value: string; options: { id: string; label: string }[]; disabled: boolean; onChange: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  return <Menu open={open && !disabled} items={options} selectedId={value} align="end"
    onClose={() => setOpen(false)} onSelect={id => { onChange(id); setOpen(false) }}
    anchor={<Button variant="outline" aria-label={label} aria-haspopup="menu" aria-expanded={open && !disabled}
      disabled={disabled} onClick={() => setOpen(value => !value)}>
      {options.find(option => option.id === value)?.label ?? value}<ChevronDown size={14} />
    </Button>} />
}

export function SettingsPanel({ t, host, state, snapshot, onConnection }: {
  t: Translate; host: OnboardingHostApi; state: OnboardingState; snapshot: OnboardingSnapshot; onConnection: () => void
}) {
  const management = snapshot.connector
  const [draft, setDraft] = useState(management?.settings)
  const [saved, setSaved] = useState(false)
  const [reset, setReset] = useState<'normal' | 'force' | null>(null)
  const [acknowledged, setAcknowledged] = useState(false)
  const id = useId()
  const signature = JSON.stringify(management?.settings)
  useEffect(() => { setDraft(management?.settings) }, [signature])
  if (!management || !draft) return <p className={css.hint} role="status">{t('请重启 DSH Host，以加载 Connector 管理接口。')}</p>
  const connecting = ['authorizing', 'pairing', 'starting'].includes(snapshot.stage)
  const busy = state.busy || connecting || Boolean(state.readError)
  const status = connectorStatus(snapshot, state.readError, t)
  const dirty = JSON.stringify(draft) !== signature
  const mirror = PYPI_MIRRORS.find(mirror => mirror.url === draft.uvPypiIndexUrl)?.id ?? 'default'
  const update = <K extends keyof typeof draft>(key: K, value: (typeof draft)[K]) => {
    setDraft({ ...draft, [key]: value }); setSaved(false); state.clearError()
  }
  const confirmReset = async () => {
    const force = reset === 'force'
    let revokeFailed = false
    const success = await state.run(async () => {
      try { await host.resetConnector(force) }
      catch (error) { revokeFailed = error instanceof Error && error.message.startsWith('无法撤销设备连接'); throw error }
    })
    if (success) { setReset(null); onConnection() }
    else if (!force && revokeFailed) { setReset('force'); setAcknowledged(false) }
  }

  return <section className={css.panel} aria-busy={state.busy}>
    <div className={css.section}>
      <div className={css.row}>
        <h3>{management.deviceName || t('此设备')}</h3>
        <span className={css.status}><StateDot state={status.state} />{status.label}</span>
      </div>
      <dl className={css.details}>
        <dt>Connector ID</dt><dd>{snapshot.connectorId ?? t('尚未连接')}</dd>
        <dt>{t('服务器')}</dt><dd>{snapshot.settings.apiBaseUrl}</dd>
      </dl>
      {status.detail ? <p className={css.hint} role="status">{translateMessage(t, status.detail)}</p> : null}
      {!snapshot.account || snapshot.deviceRecovery ? <Button variant="outline" onClick={onConnection}>
        {snapshot.account ? t('前往恢复连接') : t('前往登录')}
      </Button> : <div className={css.actions}>
        {snapshot.connectorRunning ? <>
          <Button variant="outline" icon={<Power size={14} />} disabled={state.busy} onClick={() => void state.run(() => host.controlConnector('stop'))}>{t('停止 Connector')}</Button>
          <Button variant="outline" icon={<RotateCw size={14} />} disabled={busy} onClick={() => void state.run(() => host.controlConnector('restart'))}>{t('重启 Connector')}</Button>
        </> : <Button variant="outline" icon={<Power size={14} />} disabled={busy} onClick={() => void state.run(() => host.controlConnector('start'))}>{t('启动 Connector')}</Button>}
      </div>}
    </div>

    <form className={css.form} onSubmit={event => {
      event.preventDefault()
      if (!busy && dirty) void state.run(() => host.saveConnectorSettings(draft)).then(success => { if (success) setSaved(true) })
    }}>
      <div className={css.section}>
        <h3>{t('运行环境')}</h3>
        <label className={css.field} htmlFor={`${id}-uv`}>{t('uv 路径')}</label>
        <Input id={`${id}-uv`} className={css.input!} disabled={busy} value={draft.uvPath} spellCheck={false}
          placeholder={t('留空使用内置 uv')} autoComplete="off" onChange={event => update('uvPath', event.target.value)} />
        <p className={css.hint}>{t('当前路径：')}<span className={css.path}>{management.resolvedUvPath || t('未找到 uv')}</span></p>
        <div className={css.row}>
          <span>{t('Python 下载镜像')}</span>
          <Choice label={t('Python 下载镜像')} value={PYTHON_MIRRORS.find(item => item.url === draft.uvPythonInstallMirror)?.id ?? 'default'} disabled={busy}
            options={PYTHON_MIRRORS.map(({ id, label }) => ({ id, label: translateMessage(t, label) }))}
            onChange={id => update('uvPythonInstallMirror', PYTHON_MIRRORS.find(item => item.id === id)!.url)} />
        </div>
        <div className={css.row}>
          <span>{t('PyPI 镜像')}</span>
          <Choice label={t('PyPI 镜像')} value={mirror} disabled={busy} options={PYPI_MIRRORS.map(({ id, label }) => ({ id, label: translateMessage(t, label) }))}
            onChange={id => update('uvPypiIndexUrl', PYPI_MIRRORS.find(mirror => mirror.id === id)!.url)} />
        </div>
      </div>

      <div className={css.section}>
        <h3>{t('同步设置')}</h3>
        <div className={css.row}>
          <div><span>{t('同步间隔')}</span><p className={css.hint}>{t('用于定时扫描的 Agent；DSH 消息实时同步')}</p></div>
          <Choice label={t('同步间隔')} disabled={busy} value={String(draft.syncIntervalSeconds)}
            options={[...new Set([...SYNC_INTERVALS, draft.syncIntervalSeconds])].sort((a, b) => a - b).map(value => ({ id: String(value), label: t('{count} 秒', { count: value }) }))}
            onChange={value => update('syncIntervalSeconds', Number(value))} />
        </div>
        <div className={css.save}>
          {saved && !dirty ? <span className={css.hint} role="status">{t('设置已保存')}</span> : null}
          <Button type="submit" variant="primary" disabled={busy || !dirty}>
            {state.busy ? t('正在保存…') : snapshot.connectorRunning ? t('保存并重启') : t('保存设置')}
          </Button>
        </div>
      </div>
    </form>

    <div className={css.section}>
      <h3>{t('维护')}</h3>
      <div className={css.actions}>
        <Button variant="outline" icon={<FolderOpen size={14} />} disabled={state.busy || !management.canOpenFolders}
          onClick={() => void state.run(() => host.openConnectorFolder('data'))}>{t('打开数据目录')}</Button>
        <Button variant="outline" icon={<FolderOpen size={14} />} disabled={state.busy || !management.canOpenFolders}
          onClick={() => void state.run(() => host.openConnectorFolder('logs'))}>{t('打开日志目录')}</Button>
        <Button variant="outline" className={css.danger} disabled={busy}
          onClick={() => { setReset('normal'); setAcknowledged(false); state.clearError() }}>{t('恢复出厂设置')}</Button>
      </div>
      {!management.canOpenFolders ? <p className={css.hint}>{t('当前环境不支持打开本机目录。')}</p> : null}
      <RiskConfirmation open={reset !== null} title={reset === 'force' ? t('无法撤销连接') : t('恢复出厂设置')}
        description={reset === 'force' ? t('服务端撤销失败，本地数据尚未清理。可以取消后重试，或仅清理本地数据；原设备凭据在服务端可能仍有效。')
          : t('将撤销当前设备凭据、停止 Connector，并清除本插件的本地连接数据。DSH 会话和共享的设备记录会保留。')}
        acknowledgeLabel={t('我了解恢复出厂设置的影响')} acknowledged={acknowledged} onAcknowledgedChange={setAcknowledged}
        cancelLabel={t('取消')} closeLabel={t('关闭恢复出厂设置确认')} confirmLabel={reset === 'force' ? t('仅清理本地数据') : t('确认恢复出厂设置')}
        disabled={state.busy} onCancel={() => { if (!state.busy) { setReset(null); state.clearError() } }} onConfirm={() => void confirmReset()} />
    </div>
    {state.error ? <p className={css.error} role="alert">{translateMessage(t, state.error)}</p> : null}
  </section>
}
