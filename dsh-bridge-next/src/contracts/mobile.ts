export type MobileLoginStatus = 'pending_scan' | 'pending_web_confirm' | 'approved' | 'consumed' | 'rejected' | 'expired'

/** The single-use QR is the only credential intentionally displayed; account tokens stay on Host. */
export interface MobileLoginSnapshot {
  id: string
  status: MobileLoginStatus
  qrImage: string | null
  expiresAt: string
  deviceName: string | null
}
