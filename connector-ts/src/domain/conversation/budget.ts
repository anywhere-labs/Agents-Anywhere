/** Default byte budget of a snapshot or page (06-protocols.md §2.6: `byteBudget` defaults to 1 MiB). */
export const PAGE_BUDGET = 1024 * 1024
/** Count limits from v2: a snapshot shows the latest 100 items; a page holds at most 500. */
export const SNAPSHOT_LIMIT = 100
export const PAGE_LIMIT_MAX = 500
