/**
 * Composer attachments — SKIPPED, and this check proves the skip is honest.
 *
 * Requirement: a module that cannot load standalone is skipped and the exact
 * blocking import is reported, never faked and never made loadable by editing the
 * source. `feature/sessiondetail/PendingAttachment.ets` imports `sha256`/`toHex`
 * from `common/AAEncoding.ets`, which opens with
 *
 *     import { util } from '@kit.ArkTS';
 *     import { cryptoFramework } from '@kit.CryptoArchitectureKit';
 *
 * Those kits are supplied by the HarmonyOS ArkTS toolchain, so Node refuses the
 * bare specifier before any of the module executes:
 *
 *     Invalid module "@kit.ArkTS" is not a valid package name imported from
 *     .generated/common/AAEncoding.ts            (ERR_INVALID_MODULE_SPECIFIER)
 *
 * So this check has no behavioural assertions about `formatBytes`,
 * `attachmentsReady`, `isImageAttachment`, `updateAttachment` or
 * `uploadedAttachmentIds`. What it does instead is pin the reason: the
 * `@kit` import must still be there. If a future change removes it, the first
 * assertion fails and says "now load this module for real" rather than letting
 * the skip quietly outlive its cause.
 *
 * `mirror-loader-hooks.mjs` only rewrites erased type declarations; it leaves bare
 * kit specifiers alone on purpose, precisely so a blocker like this stays visible.
 */
import { register } from 'node:module';
register('./mirror-loader-hooks.mjs', import.meta.url);

const { loadModule, readSource, suite, expect, finish } = await import('./lib.mjs');

const MODULE = 'feature/sessiondetail/PendingAttachment.ets';
const BLOCKER = 'common/AAEncoding.ets';
suite(`${MODULE} (skipped: @kit import in its closure)`);

const source = readSource(MODULE);
const closure = readSource(BLOCKER);

// The import chain that makes the module unrunnable under Node.
expect('the blocked module imports sha256 and toHex from the kit-backed encoding module',
  /import\s*\{[^}]*\bsha256\b[^}]*\btoHex\b[^}]*\}\s*from\s*'\.\.\/\.\.\/common\/AAEncoding';/.test(source),
  true);
expect('the encoding module opens with the two ArkTS kit imports',
  ['@kit.ArkTS', '@kit.CryptoArchitectureKit']
    .map((kit) => closure.includes(`from '${kit}'`)),
  [true, true]);
expect('the barrier is a kit import, not some other missing dependency',
  /^import\s*\{[^}]*\}\s*from\s*'(@kit\.|@ohos\.)/m.test(closure), true);

// The failure is real, and it is the kit specifier that causes it.
const failure = await loadModule(MODULE).then(() => null, (error) => error);
expect('loading the real module fails instead of silently succeeding',
  failure !== null, true);
expect('the failure is Node refusing the kit specifier',
  failure === null ? null : [failure.code, failure.message.includes('"@kit.ArkTS"')],
  ['ERR_INVALID_MODULE_SPECIFIER', true]);
expect('the failure is raised from inside the kit-backed module of the closure',
  failure === null ? null
    : /generated[\\/]common[\\/]AAEncoding\.ts/.test(failure.message),
  true);
expect('the kit API is genuinely used, so stubbing the import would fake the module',
  /\butil\.|new util\./.test(closure) && /cryptoFramework\./.test(closure), true);

// What this skip costs: the pure helpers stay uncovered until the closure loads.
expect('the skipped module is the one holding the attachment helpers',
  ['formatBytes', 'isImageAttachment', 'updateAttachment', 'attachmentsReady', 'uploadedAttachmentIds',
    'localDraftAttachment', 'MAX_ATTACHMENT_FILES', 'MAX_ATTACHMENT_BYTES']
    .every((name) => source.includes(name)), true);
expect('the draft attachment helper this skip hides is still exported',
  /export async function localDraftAttachment\(/.test(source), true);
// The size cap is checked against the number the composer actually enforces.
expect('the file-count cap is still the six the composer enforces',
  /MAX_ATTACHMENT_FILES:\s*number\s*=\s*6;/.test(source), true);
expect('the byte cap is still 25 MiB, expressed as its arithmetic',
  /MAX_ATTACHMENT_BYTES:\s*number\s*=\s*25 \* 1024 \* 1024;/.test(source), true);

finish();
