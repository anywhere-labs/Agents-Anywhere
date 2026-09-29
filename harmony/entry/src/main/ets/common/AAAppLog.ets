import { hilog } from '@kit.PerformanceAnalysisKit';

const DOMAIN: number = 0x0000;
const TAG: string = 'AgentsAnywhere';

/**
 * Thin hilog wrapper so every layer logs through one tag and one domain.
 *
 * hilog requires an explicit format string plus arguments; passing a composed
 * string as the format would let a "%" inside log data be interpreted, so the
 * format is always a literal and the message is passed as a parameter.
 */
export class AALog {
  static debug(message: string): void {
    hilog.debug(DOMAIN, TAG, '%{public}s', message);
  }

  static info(message: string): void {
    hilog.info(DOMAIN, TAG, '%{public}s', message);
  }

  static warn(message: string): void {
    hilog.warn(DOMAIN, TAG, '%{public}s', message);
  }

  static error(message: string): void {
    hilog.error(DOMAIN, TAG, '%{public}s', message);
  }
}
