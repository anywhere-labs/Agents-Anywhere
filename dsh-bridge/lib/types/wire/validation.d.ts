import type { InboundFrame } from './types.js';
/** Whether a value is a plain JSON object. */
export declare function isRecord(value: unknown): value is Record<string, unknown>;
/** Require a non-empty string field from process-boundary input. */
export declare function stringField(value: Record<string, unknown>, key: string): string;
/** Read an optional string field from process-boundary input. */
export declare function optionalStringField(value: Record<string, unknown>, key: string): string | undefined;
/** Require an optional positive bounded integer field. */
export declare function limitField(value: Record<string, unknown>, key: string, fallback: number, maximum: number): number;
/** Require a plain object field. */
export declare function objectField(value: Record<string, unknown>, key: string): Record<string, unknown>;
/** Require an array field. */
export declare function arrayField(value: Record<string, unknown>, key: string): unknown[];
/** Require a boolean field when present. */
export declare function optionalBooleanField(value: Record<string, unknown>, key: string): boolean | undefined;
/** Validate one decoded JSON value as a bridge v1 request or notification. */
export declare function validateInboundFrame(value: unknown): InboundFrame;
