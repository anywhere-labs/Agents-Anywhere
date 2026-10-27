import { APP_IS_DARK_KEY, getColors } from 'common';

export const SESSION_INDICATOR_NONE: string = 'none';
export const SESSION_INDICATOR_BUSY: string = 'busy';
export const SESSION_INDICATOR_WAITING_APPROVAL: string = 'waiting_approval';
export const SESSION_INDICATOR_UNREAD: string = 'unread';

export function sessionListIndicator(status: string, unread: boolean): string {
  if (status === 'waiting_approval') {
    return SESSION_INDICATOR_WAITING_APPROVAL;
  }
  if (status === 'running' || status === 'waiting' || status === 'pending') {
    return SESSION_INDICATOR_BUSY;
  }
  if (status === 'idle' && unread) {
    return SESSION_INDICATOR_UNREAD;
  }
  return SESSION_INDICATOR_NONE;
}

@Component
export struct HomeSessionStatusIndicator {
  @StorageProp(APP_IS_DARK_KEY) themeIsDark: boolean = false;
  @Prop @Watch('onIndicatorChanged') indicator: string = SESSION_INDICATOR_NONE;
  @State spinAngle: number = 0;
  private spinTimerId: number = -1;

  aboutToAppear(): void {
    this.refreshSpinTimer();
  }

  aboutToDisappear(): void {
    this.stopSpinTimer();
  }

  onIndicatorChanged(): void {
    this.refreshSpinTimer();
  }

  private refreshSpinTimer(): void {
    const shouldSpin = this.indicator === SESSION_INDICATOR_BUSY;
    if (shouldSpin && this.spinTimerId < 0) {
      this.spinTimerId = setInterval((): void => {
        this.spinAngle = (this.spinAngle + 30) % 360;
      }, 100);
    } else if (!shouldSpin && this.spinTimerId >= 0) {
      this.stopSpinTimer();
    }
  }

  private stopSpinTimer(): void {
    if (this.spinTimerId >= 0) {
      clearInterval(this.spinTimerId);
      this.spinTimerId = -1;
    }
  }

  build() {
    if (this.indicator === SESSION_INDICATOR_WAITING_APPROVAL) {
      Text($r('app.string.home_session_status_waiting_approval'))
        .fontSize(12.5)
        .fontWeight(FontWeight.Medium)
        .lineHeight(18)
        .maxLines(1)
        .fontColor(getColors().inkSoft)
        .backgroundColor(getColors().raisedSurface)
        .borderRadius(14)
        .padding({ left: 12, right: 12, top: 5, bottom: 5 })
    } else if (this.indicator === SESSION_INDICATOR_BUSY) {
      Stack() {
        Circle()
          .width(20)
          .height(20)
          .fillOpacity(0)
          .stroke(getColors().ink)
          .strokeOpacity(0.16)
          .strokeWidth(2.2)
        Circle()
          .width(20)
          .height(20)
          .fillOpacity(0)
          .stroke(getColors().inkSoft)
          .strokeOpacity(0.78)
          .strokeWidth(2.2)
          .strokeLineCap(LineCapStyle.Round)
          .strokeDashArray([17.5, 63])
          .rotate({ angle: -90 })
      }
      .width(20)
      .height(20)
      .rotate({ angle: this.spinAngle })
    } else if (this.indicator === SESSION_INDICATOR_UNREAD) {
      Stack() {
        Circle()
          .width(9)
          .height(9)
          .fill(getColors().sessionStatusAccent)
      }
      .width(18)
      .height(18)
      .alignContent(Alignment.Center)
    }
  }
}
