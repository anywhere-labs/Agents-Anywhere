import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session';
import type { TimelineItem } from '../wire/protocol.js';
/**
 * Project a deterministic allowlist of DSH events into AA timeline items.
 * @param header - Session identity and storage metadata.
 * @param events - Contiguous events in sequence order.
 * @param includeChunks - Whether live assistant deltas should be represented.
 * @returns Stable items ordered by their first source event.
 */
export declare function projectTimeline(header: SessionHeader, events: readonly SessionEvent[], includeChunks?: boolean): TimelineItem[];
