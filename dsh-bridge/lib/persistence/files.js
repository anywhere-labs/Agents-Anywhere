import { link, mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { BridgeError } from '../wire/errors.js';
/** Read and validate one JSON metadata value. */
export async function readJson(path) {
    let text;
    try {
        text = await readFile(path, 'utf8');
    }
    catch (error) {
        throw persistenceFailure('read failed', error);
    }
    try {
        return JSON.parse(text);
    }
    catch (error) {
        throw persistenceFailure('invalid JSON', error);
    }
}
/** Read optional JSON metadata, returning undefined only when absent. */
export async function readOptionalJson(path) {
    try {
        const text = await readFile(path, 'utf8');
        return JSON.parse(text);
    }
    catch (error) {
        if (isNodeError(error, 'ENOENT'))
            return undefined;
        throw persistenceFailure(error instanceof SyntaxError ? 'invalid JSON' : 'read failed', error);
    }
}
/** Read every JSON record in one metadata directory. */
export async function readJsonDirectory(path) {
    let names;
    try {
        names = await readdir(path);
    }
    catch (error) {
        if (isNodeError(error, 'ENOENT'))
            return [];
        throw persistenceFailure('directory read failed', error);
    }
    const records = [];
    for (const name of names.sort()) {
        if (!name.endsWith('.json'))
            continue;
        records.push(await readJson(join(path, name)));
    }
    return records;
}
/** Atomically replace one human-readable JSON metadata file and fsync its directory. */
export async function writeJsonAtomic(path, value) {
    const parent = dirname(path);
    await mkdir(parent, { recursive: true });
    const temporary = join(parent, `.${randomUUID()}.tmp`);
    const handle = await open(temporary, 'wx', 0o600);
    try {
        await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
        await handle.sync();
    }
    finally {
        await handle.close();
    }
    try {
        await rename(temporary, path);
        await fsyncDirectory(parent);
    }
    catch (error) {
        await unlink(temporary).catch(ignoreMissing);
        throw persistenceFailure('atomic publish failed', error);
    }
}
/** Publish one JSON file without replacing an existing record. */
export async function writeJsonNoClobber(path, value) {
    const parent = dirname(path);
    await mkdir(parent, { recursive: true });
    const temporary = join(parent, `.${randomUUID()}.tmp`);
    const handle = await open(temporary, 'wx', 0o600);
    try {
        await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
        await handle.sync();
    }
    finally {
        await handle.close();
    }
    try {
        await link(temporary, path);
        await unlink(temporary);
        await fsyncDirectory(parent);
        return 'created';
    }
    catch (error) {
        await unlink(temporary).catch(ignoreMissing);
        if (isNodeError(error, 'EEXIST'))
            return 'exists';
        throw persistenceFailure('no-clobber publish failed', error);
    }
}
/** Remove one exact metadata file and sync its parent. */
export async function removeFile(path) {
    try {
        await unlink(path);
        await fsyncDirectory(dirname(path));
    }
    catch (error) {
        if (!isNodeError(error, 'ENOENT'))
            throw persistenceFailure('metadata removal failed', error);
    }
}
async function fsyncDirectory(path) {
    const directory = await open(path, 'r');
    try {
        await directory.sync();
    }
    finally {
        await directory.close();
    }
}
function ignoreMissing(error) {
    if (!isNodeError(error, 'ENOENT'))
        throw error;
}
function isNodeError(error, code) {
    return error instanceof Error && 'code' in error && error.code === code;
}
function persistenceFailure(details, cause) {
    return new BridgeError('PERSISTENCE_ERROR', 'Bridge metadata could not be read or written.', {
        retryable: false,
        details,
    }, { cause });
}
//# sourceMappingURL=files.js.map