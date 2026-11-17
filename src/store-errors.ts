import type { z } from 'zod';

// Errors the HTTP layer maps to status codes.

export class StoreError extends Error {
  constructor(
    readonly kind: 'validation' | 'conflict' | 'not_found',
    message: string,
    readonly fields?: Record<string, string>,
  ) {
    super(message);
    this.name = 'StoreError';
  }
}

/** Parses with zod; on failure throws a StoreError('validation') with one message per field. */
export function parseOrThrow<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const fields: Record<string, string> = {};
  for (const issue of result.error.issues) {
    const key = issue.path.length ? String(issue.path[0]) : '_';
    fields[key] ??= issue.message;
  }
  throw new StoreError('validation', 'validation failed', fields);
}

