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

/**
 * Design-system type / spacing / radius tokens for the HarmonyOS client.
 *
 * Each type token mirrors the (fontSize, fontWeight, lineHeight) combination
 * the Android client actually renders for that role: values come from the
 * hand-written `fontSize = N.sp` / `FontWeight.*` / `lineHeight = N.sp`
 * call sites in `android/ui/screens/**` plus the Material3 defaults for the
 * single `MaterialTheme.typography.*` level in use (`bodySmall`).
 *
 * `TYPE_TOKEN_QUICK_REF` is a plain-text cheat sheet for the page-sweep
 * batches, e.g. `'navTitle = 17fp/600 (lineHeight 22)'`.
 */

export interface TypeToken {
  fontSize: number;
  fontWeight: number;
  lineHeight: number;
}

export interface AATypeScale {
  displayTitle: TypeToken;
  sectionTitle: TypeToken;
  pageTitle: TypeToken;
  sheetTitle: TypeToken;
  navTitle: TypeToken;
  listTitle: TypeToken;
  listBody: TypeToken;
  fieldText: TypeToken;
  noteText: TypeToken;
  captionText: TypeToken;
  captionSmall: TypeToken;
  microText: TypeToken;
}

export const TypeTokens: AATypeScale = {
  displayTitle: { fontSize: 24, fontWeight: 800, lineHeight: 29 },
  sectionTitle: { fontSize: 22, fontWeight: 800, lineHeight: 29 },
  pageTitle: { fontSize: 20, fontWeight: 600, lineHeight: 24 },
  sheetTitle: { fontSize: 18, fontWeight: 600, lineHeight: 24 },
  navTitle: { fontSize: 17, fontWeight: 600, lineHeight: 22 },
  listTitle: { fontSize: 16, fontWeight: 600, lineHeight: 20 },
  listBody: { fontSize: 15, fontWeight: 600, lineHeight: 21 },
  fieldText: { fontSize: 14, fontWeight: 500, lineHeight: 20 },
  noteText: { fontSize: 13, fontWeight: 400, lineHeight: 18 },
  captionText: { fontSize: 12.5, fontWeight: 500, lineHeight: 17 },
  captionSmall: { fontSize: 12, fontWeight: 400, lineHeight: 16 },
  microText: { fontSize: 11, fontWeight: 500, lineHeight: 14 }
};

export const TYPE_TOKEN_QUICK_REF: string[] = [
  'displayTitle = 24fp/800 (lineHeight 29)',
  'sectionTitle = 22fp/800 (lineHeight 29)',
  'pageTitle = 20fp/600 (lineHeight 24)',
  'sheetTitle = 18fp/600 (lineHeight 24)',
  'navTitle = 17fp/600 (lineHeight 22)',
  'listTitle = 16fp/600 (lineHeight 20)',
  'listBody = 15fp/600 (lineHeight 21)',
  'fieldText = 14fp/500 (lineHeight 20)',
  'noteText = 13fp/400 (lineHeight 18)',
  'captionText = 12.5fp/500 (lineHeight 17)',
  'captionSmall = 12fp/400 (lineHeight 16, Material3 bodySmall)',
  'microText = 11fp/500 (lineHeight 14)'
];

export interface AASpacing {
  screenEdge: number;
  sheetContent: number;
  cardPadding: number;
  listItem: number;
  compact: number;
  tight: number;
}

export const SpacingTokens: AASpacing = {
  screenEdge: 16,
  sheetContent: 16,
  cardPadding: 14,
  listItem: 12,
  compact: 8,
  tight: 4
};

export interface AARadius {
  sheetTop: number;
  codePanel: number;
  noticeCard: number;
  card: number;
}

export const RadiusTokens: AARadius = {
  sheetTop: 28,
  codePanel: 20,
  noticeCard: 16,
  card: 14
};

export interface AAIconSize {
  backButton: number;
  glyphLarge: number;
  glyphMedium: number;
  glyphSmall: number;
  glyphTiny: number;
}

export const IconSizeTokens: AAIconSize = {
  backButton: 40,
  glyphLarge: 22,
  glyphMedium: 20,
  glyphSmall: 18,
  glyphTiny: 16
};
