"use client"

// Markdown for replies, thinking and a subagent's words: AI Elements' Message › Markdown, i.e. Streamdown
// (https://streamdown.ai) with its own styles, streaming repair of unterminated Markdown (remend) and word fade-in
// (`animated` + `isAnimating`), and the standard plugins: code (Shiki), math (KaTeX), mermaid, cjk. Fenced code goes
// to AI Elements' Code Block through `components.code`, as Code Block › Markdown shows; mermaid fences stay with
// Streamdown, which draws the diagram. Links never navigate: they go to the host (`open`).
import { memo, useEffect, useMemo, useSyncExternalStore } from 'react'
import type * as React from 'react'
import { cjk } from '@streamdown/cjk'
import { defaultComponents, Streamdown, useIsCodeFenceIncomplete, type ExtraProps, type PluginConfig, type StreamdownTranslations } from 'streamdown'
import { CodeBlock, CodeBlockActions, CodeBlockContent, CodeBlockCopyButton, CodeBlockHeader, CodeBlockLine, CodeBlockTitle } from '@/components/ui/code-block'
import { useHighlightedCode } from '@/hooks/use-highlighted-code'
import { codeHighlighter } from '@/lib/highlighter'
import { cn } from '@/lib/utils'
import { useThreadEnv } from './env'

/**
 * Math (KaTeX) and Mermaid are loaded the first time a reply has a formula or a diagram, not at start-up (they are
 * most of Streamdown's weight and most replies have neither); the reply re-renders with them once they are in.
 */
const lazy: { math?: PluginConfig['math']; mermaid?: PluginConfig['mermaid'] } = {}
const lazyListeners = new Set<() => void>()
let lazyVersion = 0
const loading: Record<string, Promise<void>> = {}
function loadLazy(name: 'math' | 'mermaid') {
  loading[name] ??= (
    name === 'math'
      ? Promise.all([import('@streamdown/math'), import('katex/dist/katex.min.css')]).then(([m]) => {
          lazy.math = m.math
        })
      : import('@streamdown/mermaid').then((m) => {
          lazy.mermaid = m.mermaid
        })
  ).then(() => {
    lazyVersion++
    for (const fn of lazyListeners) fn()
  })
}
const subscribeLazy = (fn: () => void) => {
  lazyListeners.add(fn)
  return () => lazyListeners.delete(fn)
}

function usePlugins(text: string): PluginConfig {
  const needsMath = /\$|\\\(|\\\[/.test(text)
  const needsMermaid = /```\s*mermaid/.test(text)
  useEffect(() => {
    if (needsMath) loadLazy('math')
    if (needsMermaid) loadLazy('mermaid')
  }, [needsMath, needsMermaid])
  const v = useSyncExternalStore(subscribeLazy, () => lazyVersion)
  return useMemo(
    () => ({ code: codeHighlighter, cjk, math: needsMath ? lazy.math : undefined, mermaid: needsMermaid ? lazy.mermaid : undefined }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `v` is the lazy modules' version
    [needsMath, needsMermaid, v],
  )
}

const translations: Partial<StreamdownTranslations> = {
  close: '关闭',
  copied: '已复制',
  copyCode: '复制代码',
  copyLink: '复制链接',
  copyTable: '复制表格',
  copyTableAsCsv: '复制为 CSV',
  copyTableAsMarkdown: '复制为 Markdown',
  copyTableAsTsv: '复制为 TSV',
  downloadDiagram: '下载图表',
  downloadDiagramAsMmd: '下载为 MMD',
  downloadDiagramAsPng: '下载为 PNG',
  downloadDiagramAsSvg: '下载为 SVG',
  downloadFile: '下载文件',
  downloadImage: '下载图片',
  downloadTable: '下载表格',
  downloadTableAsCsv: '下载为 CSV',
  downloadTableAsMarkdown: '下载为 Markdown',
  errorMermaid: '图表渲染失败',
  exitFullscreen: '退出全屏',
  externalLinkWarning: '即将打开外部链接',
  imageNotAvailable: '图片不可用',
  mermaidAriaLabel: 'Mermaid 图表',
  openExternalLink: '打开外部链接',
  openLink: '打开链接',
  resetView: '重置视图',
  viewFullscreen: '全屏查看',
  zoomIn: '放大',
  zoomOut: '缩小',
}

function MarkdownCodeBlock({ code, language }: { code: string; language: string }) {
  // True while the closing fence has not arrived yet.
  const incomplete = useIsCodeFenceIncomplete()
  const env = useThreadEnv()
  const lines = useHighlightedCode(code, language, incomplete)
  return (
    <CodeBlock size="sm">
      <CodeBlockHeader>
        <CodeBlockTitle className="font-mono font-normal text-muted-foreground">{language || 'text'}</CodeBlockTitle>
        <CodeBlockActions>
          <CodeBlockCopyButton value={code} disabled={incomplete} aria-label="复制代码" onClick={() => env.copy(code)} />
        </CodeBlockActions>
      </CodeBlockHeader>
      <CodeBlockContent>
        {lines.map((line, i) => (
          <CodeBlockLine key={i}>{line}</CodeBlockLine>
        ))}
      </CodeBlockContent>
    </CodeBlock>
  )
}

const DefaultCode = defaultComponents.code as React.ComponentType<React.ComponentProps<'code'> & ExtraProps>

function MarkdownCode(props: React.ComponentProps<'code'> & ExtraProps) {
  const { node: _node, className, children, ...rest } = props
  void _node
  // Streamdown marks fenced code with data-block. Everything else is inline.
  if (!('data-block' in rest)) {
    return (
      <code className="rounded-sm bg-muted px-1 py-0.5 font-mono text-[0.9em]" {...rest}>
        {children}
      </code>
    )
  }
  const language = /language-(\S+)/.exec(className ?? '')?.[1] ?? ''
  if (language === 'mermaid') return <DefaultCode {...props} />
  return <MarkdownCodeBlock code={typeof children === 'string' ? children : ''} language={language} />
}

function MarkdownLink({ href, children, node: _node, ...rest }: React.ComponentProps<'a'> & ExtraProps) {
  void _node
  const env = useThreadEnv()
  return (
    <a
      {...rest}
      href={href}
      data-streamdown="link"
      className="wrap-anywhere font-medium text-primary underline"
      onClick={(e) => {
        e.preventDefault()
        if (href) env.open({ kind: 'url', url: href })
      }}
    >
      {children}
    </a>
  )
}

const components = { code: MarkdownCode, a: MarkdownLink }

function MarkdownImpl({ children, streaming = false, className }: { children: string; streaming?: boolean; className?: string }) {
  const env = useThreadEnv()
  const plugins = usePlugins(children)
  return (
    <Streamdown
      className={cn('min-w-0 text-sm', className)}
      plugins={plugins}
      components={components}
      translations={translations}
      animated={!env.reduceMotion}
      isAnimating={streaming}
      lineNumbers={false}
      controls={env.markdownControls ?? true}
    >
      {children}
    </Streamdown>
  )
}

export const Markdown = memo(MarkdownImpl) as (props: { children: string; streaming?: boolean; className?: string }) => React.ReactElement
