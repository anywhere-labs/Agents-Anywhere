import { useEffect, useId, useState } from 'react'
import { Button, DisclosureRow, Input, Menu, RiskConfirmation, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { ChevronDown, FolderOpen, Power, RotateCw, Settings2 } from 'lucide-react'
import { PYPI_MIRRORS, SYNC_INTERVALS } from '../../../contracts/connector.js'
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

export function SettingsPanel({ host, state, snapshot, onConnection }: {
  host: OnboardingHostApi; state: OnboardingState; snapshot: OnboardingSnapshot; onConnection: () => void
}) {
  const management = snapshot.connector
  const [draft, setDraft] = useState(management?.settings)
  const [advanced, setAdvanced] = useState(false)
  const [saved, setSaved] = useState(false)
  const [reset, setReset] = useState<'normal' | 'force' | null>(null)
  const [acknowledged, setAcknowledged] = useState(false)
  const id = useId()
  const signature = JSON.stringify(management?.settings)
  useEffect(() => { setDraft(management?.settings) }, [signature])
  if (!management || !draft) return <p className={css.hint} role="status">请重启 DSH Host，以加载 Connector 管理接口。</p>
  const connecting = ['authorizing', 'pairing', 'starting'].includes(snapshot.stage)
  const busy = state.busy || connecting || Boolean(state.readError)
  const status = connectorStatus(snapshot, state.readError)
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
        <h3>{management.deviceName || '此设备'}</h3>
        <span className={css.status}><StateDot state={status.state} />{status.label}</span>
      </div>
      <dl className={css.details}>
        <dt>Connector ID</dt><dd>{snapshot.connectorId ?? '尚未连接'}</dd>
        <dt>服务器</dt><dd>{snapshot.settings.apiBaseUrl}</dd>
      </dl>
      {status.detail ? <p className={css.hint} role="status">{status.detail}</p> : null}
      {!snapshot.account || snapshot.deviceRecovery ? <Button variant="outline" onClick={onConnection}>
        {snapshot.account ? '前往恢复连接' : '前往登录'}
      </Button> : <div className={css.actions}>
        {snapshot.connectorRunning ? <>
          <Button variant="outline" icon={<Power size={14} />} disabled={state.busy} onClick={() => void state.run(() => host.controlConnector('stop'))}>停止 Connector</Button>
          <Button variant="outline" icon={<RotateCw size={14} />} disabled={busy} onClick={() => void state.run(() => host.controlConnector('restart'))}>重启 Connector</Button>
        </> : <Button variant="outline" icon={<Power size={14} />} disabled={busy} onClick={() => void state.run(() => host.controlConnector('start'))}>启动 Connector</Button>}
      </div>}
    </div>

    <form className={css.form} onSubmit={event => {
      event.preventDefault()
      if (!busy && dirty) void state.run(() => host.saveConnectorSettings(draft)).then(success => { if (success) setSaved(true) })
    }}>
      <div className={css.section}>
        <h3>运行环境</h3>
        <label className={css.field} htmlFor={`${id}-uv`}>uv 路径</label>
        <Input id={`${id}-uv`} className={css.input!} disabled={busy} value={draft.uvPath} spellCheck={false}
          placeholder="留空自动查找 uv" autoComplete="off" onChange={event => update('uvPath', event.target.value)} />
        <p className={css.hint}>当前路径：<span className={css.path}>{management.resolvedUvPath || '未找到 uv'}</span></p>
        <div className={css.row}>
          <span>PyPI 镜像</span>
          <Choice label="PyPI 镜像" value={mirror} disabled={busy} options={PYPI_MIRRORS.map(({ id, label }) => ({ id, label }))}
            onChange={id => update('uvPypiIndexUrl', PYPI_MIRRORS.find(mirror => mirror.id === id)!.url)} />
        </div>
        <div className={css.row}>
          <div><span>随插件启动 Connector</span><p className={css.hint}>已登录时自动恢复本机连接</p></div>
          <Button variant="outline" disabled={busy} aria-pressed={draft.autoStart} aria-label="随插件启动 Connector"
            onClick={() => update('autoStart', !draft.autoStart)}>{draft.autoStart ? '开启' : '关闭'}</Button>
        </div>
      </div>

      <div className={css.section}>
        <h3>同步设置</h3>
        <div className={css.row}>
          <div><span>同步间隔</span><p className={css.hint}>用于定时扫描的 Agent；DSH 消息实时同步</p></div>
          <Choice label="同步间隔" disabled={busy} value={String(draft.syncIntervalSeconds)}
            options={[...new Set([...SYNC_INTERVALS, draft.syncIntervalSeconds])].sort((a, b) => a - b).map(value => ({ id: String(value), label: `${value} 秒` }))}
            onChange={value => update('syncIntervalSeconds', Number(value))} />
        </div>
        <DisclosureRow title="高级参数" icon={<Settings2 size={14} />} open={advanced} expandable expandOnRowClick onToggle={() => setAdvanced(!advanced)}>
          <div className={css.advanced}>
            <label className={css.field} htmlFor={`${id}-heartbeat`}>心跳间隔（秒）</label>
            <Input id={`${id}-heartbeat`} type="number" min={1} max={300} step={1} required disabled={busy}
              value={draft.heartbeatSeconds} onChange={event => update('heartbeatSeconds', Number(event.target.value))} />
            <label className={css.field} htmlFor={`${id}-reconnect`}>重连间隔（秒）</label>
            <Input id={`${id}-reconnect`} type="number" min={1} max={300} step={1} required disabled={busy}
              value={draft.reconnectSeconds} onChange={event => update('reconnectSeconds', Number(event.target.value))} />
            <div className={css.row}>
              <span>连接时同步已有会话</span>
              <Button variant="outline" disabled={busy} aria-pressed={draft.syncExistingOnConnect} aria-label="连接时同步已有会话"
                onClick={() => update('syncExistingOnConnect', !draft.syncExistingOnConnect)}>{draft.syncExistingOnConnect ? '开启' : '关闭'}</Button>
            </div>
          </div>
        </DisclosureRow>
        <div className={css.save}>
          {saved && !dirty ? <span className={css.hint} role="status">设置已保存</span> : null}
          <Button type="submit" variant="primary" disabled={busy || !dirty}>
            {state.busy ? '正在保存…' : snapshot.connectorRunning ? '保存并重启' : '保存设置'}
          </Button>
        </div>
      </div>
    </form>

    <div className={css.section}>
      <h3>维护</h3>
      <div className={css.actions}>
        <Button variant="outline" icon={<FolderOpen size={14} />} disabled={state.busy || !management.canOpenFolders}
          onClick={() => void state.run(() => host.openConnectorFolder('data'))}>打开数据目录</Button>
        <Button variant="outline" icon={<FolderOpen size={14} />} disabled={state.busy || !management.canOpenFolders}
          onClick={() => void state.run(() => host.openConnectorFolder('logs'))}>打开日志目录</Button>
      </div>
      <p className={css.hint}>数据：<span className={css.path}>{management.dataPath}</span></p>
      <p className={css.hint}>日志：<span className={css.path}>{management.logsPath}</span></p>
      {!management.canOpenFolders ? <p className={css.hint}>当前为无图形界面环境，可使用上面的路径访问目录。</p> : null}
      <div className={css.row}>
        <div><span>重置本机连接</span><p className={css.hint}>清除插件账号、设备凭据、同步缓存和设置</p></div>
        <Button variant="outline" className={css.danger} disabled={busy} onClick={() => { setReset('normal'); setAcknowledged(false); state.clearError() }}>重置</Button>
      </div>
      <RiskConfirmation open={reset !== null} title={reset === 'force' ? '无法撤销连接' : '重置本机连接'}
        description={reset === 'force' ? '服务端撤销失败，本地数据尚未清理。可以取消后重试，或仅清理本地数据；原设备凭据在服务端可能仍有效。'
          : '将撤销当前设备凭据、停止 Connector，并清除本插件的本地连接数据。DSH 会话和共享的设备记录会保留。'}
        acknowledgeLabel="我了解重置的影响" acknowledged={acknowledged} onAcknowledgedChange={setAcknowledged}
        cancelLabel="取消" closeLabel="关闭重置确认" confirmLabel={reset === 'force' ? '仅清理本地数据' : '确认重置'}
        disabled={state.busy} onCancel={() => { if (!state.busy) { setReset(null); state.clearError() } }} onConfirm={() => void confirmReset()} />
    </div>
    {state.error ? <p className={css.error} role="alert">{state.error}</p> : null}
  </section>
}
