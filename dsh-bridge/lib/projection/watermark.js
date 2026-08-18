/**
 * Build the checkpoint candidate for a returned contiguous event suffix.
 * @param events - Exact returned event prefix, already limited for one response.
 * @param fromSeq - Requested suffix start when no event was returned.
 * @param revision - Current opaque persistence revision when available.
 * @returns Candidate the Connector may commit only after Server ingest succeeds.
 */
export function timelineWatermark(events, fromSeq, revision) {
    return {
        seq: events.at(-1)?.seq ?? fromSeq - 1,
        ...(revision === undefined ? {} : { revision }),
    };
}
//# sourceMappingURL=watermark.js.map