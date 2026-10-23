import { APP_IS_DARK_KEY, getColors } from 'common';

export const SESSION_AGENT_KIND_CODEX: string = 'codex';
export const SESSION_AGENT_KIND_CLAUDE: string = 'claude';
export const SESSION_AGENT_KIND_DEEPSEEK: string = 'deepseek';
export const SESSION_AGENT_KIND_BOT: string = 'bot';

// Mirrors Android SessionAgentIcon: prefer the runtime type, strip separators,
// then match the Web sidebar aliases (codex / claude / deepseek, else Bot).
export function sessionAgentIconKind(runtime: string): string {
  const type = runtime.trim().toLowerCase().replace(/[\s_-]/g, '');
  if (type === 'codex') {
    return SESSION_AGENT_KIND_CODEX;
  }
  if (type === 'claude' || type === 'claudecode') {
    return SESSION_AGENT_KIND_CLAUDE;
  }
  if (type === 'dsh' || type === 'deepseek' || type === 'deepseekharness') {
    return SESSION_AGENT_KIND_DEEPSEEK;
  }
  return SESSION_AGENT_KIND_BOT;
}

@Component
export struct SessionAgentIcon {
  @StorageProp(APP_IS_DARK_KEY) themeIsDark: boolean = false;
  @Prop runtime: string = '';
  @Prop iconSize: number = 16;

  build() {
    if (sessionAgentIconKind(this.runtime) === SESSION_AGENT_KIND_CODEX) {
      Image($r('app.media.session_agent_codex'))
        .width(this.iconSize)
        .height(this.iconSize)
        .fillColor(getColors().faint)
    } else if (sessionAgentIconKind(this.runtime) === SESSION_AGENT_KIND_CLAUDE) {
      Image($r('app.media.session_agent_claude'))
        .width(this.iconSize)
        .height(this.iconSize)
        .fillColor(getColors().faint)
    } else if (sessionAgentIconKind(this.runtime) === SESSION_AGENT_KIND_DEEPSEEK) {
      Image($r('app.media.session_agent_deepseek'))
        .width(this.iconSize)
        .height(this.iconSize)
        .fillColor(getColors().faint)
    } else {
      SymbolGlyph($r('sys.symbol.robot'))
        .fontSize(this.iconSize)
        .fontColor([getColors().faint])
    }
  }
}
