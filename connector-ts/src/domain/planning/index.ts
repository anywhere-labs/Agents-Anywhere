// Planning: an explicit sub-aggregate inside the session aggregate. Every document revision is immutable and carries a contentHash; "approve and execute" must match the current revision.

export * from './plan.js'
