/** Browser entry for the Agents Anywhere bridge status surface. */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client';
/** Client services required by the status entry. */
export declare const inject: string[];
/** Register a visible AA Bridge status control in the global Web shell. */
export declare function apply(ctx: ClientContext): void;
