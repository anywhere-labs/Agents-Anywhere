/** Read and validate one JSON metadata value. */
export declare function readJson<T>(path: string): Promise<T>;
/** Read optional JSON metadata, returning undefined only when absent. */
export declare function readOptionalJson<T>(path: string): Promise<T | undefined>;
/** Read every JSON record in one metadata directory. */
export declare function readJsonDirectory<T>(path: string): Promise<T[]>;
/** Atomically replace one human-readable JSON metadata file and fsync its directory. */
export declare function writeJsonAtomic(path: string, value: unknown): Promise<void>;
/** Publish one JSON file without replacing an existing record. */
export declare function writeJsonNoClobber(path: string, value: unknown): Promise<'created' | 'exists'>;
/** Remove one exact metadata file and sync its parent. */
export declare function removeFile(path: string): Promise<void>;
