import { createHash } from 'node:crypto';

// JSON with every object's keys sorted, so {"a":1,"b":2} and {"b":2,"a":1} read the same.
// Arrays keep their order: [41, 42] and [42, 41] are different requests.
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    const members = Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`);
    return `{${members.join(',')}}`;
  }
  // undefined (no body at all) reads as null.
  return JSON.stringify(value) ?? 'null';
}

// What a repeated key is compared by (FR-IDEM-4): SHA-256 of the method, the path and the
// canonical body.
export function hashRequest(method: string, path: string, body: unknown): string {
  return createHash('sha256')
    .update(`${method.toUpperCase()}\n${path}\n${canonicalJson(body)}`)
    .digest('hex');
}
