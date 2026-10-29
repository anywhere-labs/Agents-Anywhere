/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { APP_IS_DARK_KEY, getColors } from 'common';
import { RadiusTokens } from 'common';

/**
 * A read-only diff viewer for unified / git-style diff text.
 *
 * It is intentionally independent of AgentMarkdownView (which is not modified):
 * SessionDetailPage routes any markdown `code` block whose language is `diff`
 * (or whose content starts with the conventional diff markers) here instead of
 * the generic code panel.
 *
 * Color is sourced entirely from the design-system tokens so it adapts to the
 * active light/dark theme.
 */
@Component
export struct DiffCodeView {
  @StorageProp(APP_IS_DARK_KEY) themeIsDark: boolean = false;
  @Prop codeText: string = '';
  // Absolute content width cap in vp, -1 disables (see AgentMarkdownView).
  @Prop contentMaxWidthVp: number = -1;

  private contentWidthCap(): number {
    return this.contentMaxWidthVp > 0 ? this.contentMaxWidthVp : 100000;
  }

  @State private lines: string[] = [];

  aboutToAppear(): void {
    this.parseLines();
  }

  aboutToUpdate(): void {
    this.parseLines();
  }

  private parseLines(): void {
    if (this.codeText.length === 0) {
      this.lines = [];
      return;
    }
    this.lines = this.codeText.split('\n');
  }

  private lineKind(line: string): 'added' | 'removed' | 'hunk' | 'context' {
    if (line.startsWith('+')) {
      return 'added';
    }
    if (line.startsWith('-')) {
      return 'removed';
    }
    if (line.startsWith('@@') || line.startsWith('diff ') ||
      line.startsWith('---') || line.startsWith('+++') ||
      line.startsWith('index ') || line.startsWith('===') ||
      line.startsWith('***')) {
      return 'hunk';
    }
    return 'context';
  }

  build() {
    Column() {
      Column() {
        ForEach(this.lines, (line: string, index: number) => {
          this.diffRow(line, index);
        }, (line: string, index: number) => `${index}`)
      }
      .width('100%')
      .constraintSize({ maxWidth: this.contentWidthCap() })
    }
    .width('100%')
    .constraintSize({ maxWidth: this.contentWidthCap() })
    .padding({ left: 8, right: 8, top: 8, bottom: 8 })
    .borderRadius(RadiusTokens.codePanel)
    .backgroundColor(getColors().sessionCodeSurface)
    .border({ width: 1, color: getColors().border })
  }

  @Builder
  private diffRow(line: string, index: number) {
    Row() {
      Text(this.linePrefix(line, this.lineKind(line)))
        .fontSize(12)
        .fontFamily('monospace')
        .fontColor(this.lineTextColor(this.lineKind(line)))
        .padding({ left: 6, right: 4 })
      Text(line)
        .fontSize(12)
        .fontFamily('monospace')
        .fontColor(this.lineTextColor(this.lineKind(line)))
        .width('100%')
        .constraintSize({ maxWidth: this.contentWidthCap() })
        .copyOption(CopyOptions.LocalDevice)
    }
    .width('100%')
    .constraintSize({ maxWidth: this.contentWidthCap() })
    .padding({ top: 1, bottom: 1 })
    .borderRadius(4)
    .backgroundColor(this.lineSurface(this.lineKind(line)))
  }

  private linePrefix(line: string, kind: 'added' | 'removed' | 'hunk' | 'context'): string {
    if (kind === 'added') {
      return '+';
    }
    if (kind === 'removed') {
      return '-';
    }
    return ' ';
  }

  private lineSurface(kind: 'added' | 'removed' | 'hunk' | 'context'): string {
    const colors = getColors();
    if (kind === 'added') {
      return colors.diffAddedSurface;
    }
    if (kind === 'removed') {
      return colors.diffRemovedSurface;
    }
    if (kind === 'hunk') {
      return colors.diffHunkHeaderSurface;
    }
    return colors.sessionCodeSurface;
  }

  private lineTextColor(kind: 'added' | 'removed' | 'hunk' | 'context'): string {
    const colors = getColors();
    if (kind === 'added') {
      return colors.diffAddedText;
    }
    if (kind === 'removed') {
      return colors.diffRemovedText;
    }
    if (kind === 'hunk') {
      return colors.diffHunkHeaderText;
    }
    return colors.diffContextText;
  }
}
