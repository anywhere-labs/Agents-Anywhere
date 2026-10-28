import { ApiException } from './ApiException';

export function parseJsonRecord(text: string): Record<string, Object> {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    const empty: Record<string, Object> = {};
    return empty;
  }
  let parsed: Object;
  try {
    parsed = JSON.parse(text) as Object;
  } catch (error) {
    throw new ApiException('The server returned an invalid response.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ApiException('The server returned an invalid response.');
  }
  return parsed as Record<string, Object>;
}

export function recordOrNull(value: Object): Record<string, Object> | null {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, Object>;
  }
  return null;
}

export function recordsFromArray(values: Object[]): Record<string, Object>[] {
  const records: Record<string, Object>[] = [];
  for (const value of values) {
    const record = recordOrNull(value);
    if (record !== null) {
      records.push(record);
    }
  }
  return records;
}

export function objGetRecord(obj: Record<string, Object>, key: string): Record<string, Object> | null {
  return recordOrNull(obj[key]);
}

export function objGetArray(obj: Record<string, Object>, key: string): Object[] {
  const value = obj[key];
  if (Array.isArray(value)) {
    return value as Object[];
  }
  return [];
}

export function requireRecord(obj: Record<string, Object>, key: string): Record<string, Object> {
  const record = objGetRecord(obj, key);
  if (record === null) {
    throw new Error('The server returned an invalid response.');
  }
  return record;
}

export function objGetString(obj: Record<string, Object>, key: string, fallback: string): string {
  const value = obj[key];
  if (typeof value === 'string') {
    return value;
  }
  return fallback;
}

export function objGetOptString(obj: Record<string, Object>, key: string): string | null {
  const value = obj[key];
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  return null;
}

export function objGetNumber(obj: Record<string, Object>, key: string, fallback: number): number {
  const value = obj[key];
  if (typeof value === 'number') {
    return value;
  }
  return fallback;
}

export function objGetOptNumber(obj: Record<string, Object>, key: string): number | null {
  const value = obj[key];
  if (typeof value === 'number') {
    return value;
  }
  return null;
}

export function objGetBool(obj: Record<string, Object>, key: string, fallback: boolean): boolean {
  const value = obj[key];
  if (typeof value === 'boolean') {
    return value;
  }
  return fallback;
}
