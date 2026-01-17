/**
 * JSON parsing utilities for flattening/unflattening nested objects
 */

import type { KeyValue } from "../api/types.js";

/**
 * Flatten a nested JSON object to dot-notation key-value pairs
 *
 * @example
 * flattenJson({ greeting: { hello: "Hello", bye: "Goodbye" } })
 * // Returns: [{ key: "greeting.hello", value: "Hello" }, { key: "greeting.bye", value: "Goodbye" }]
 */
export function flattenJson(
  obj: Record<string, unknown>,
  prefix = ""
): KeyValue[] {
  const result: KeyValue[] = [];

  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;

    if (Array.isArray(value)) {
      // Flatten array elements with numeric indices
      for (let i = 0; i < value.length; i++) {
        const item = value[i];
        const arrayKey = `${fullKey}.${i}`;
        if (typeof item === "object" && item !== null) {
          result.push(...flattenJson(item as Record<string, unknown>, arrayKey));
        } else {
          result.push({ key: arrayKey, value: String(item) });
        }
      }
    } else if (typeof value === "object" && value !== null) {
      // Recursively flatten nested objects
      result.push(...flattenJson(value as Record<string, unknown>, fullKey));
    } else {
      // Convert primitive value to string
      result.push({ key: fullKey, value: String(value) });
    }
  }

  return result;
}

/**
 * Unflatten dot-notation key-value pairs back to a nested object
 *
 * @example
 * unflattenJson([{ key: "greeting.hello", value: "Hello" }])
 * // Returns: { greeting: { hello: "Hello" } }
 */
export function unflattenJson(items: KeyValue[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const { key, value } of items) {
    const parts = key.split(".");
    let current: Record<string, unknown> | unknown[] = result;

    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      const nextPart = parts[i + 1];
      const nextIsIndex = /^\d+$/.test(nextPart);

      if (Array.isArray(current)) {
        const index = parseInt(part, 10);
        if (current[index] === undefined) {
          current[index] = nextIsIndex ? [] : {};
        }
        current = current[index] as Record<string, unknown> | unknown[];
      } else {
        if (!(part in current)) {
          current[part] = nextIsIndex ? [] : {};
        }
        current = current[part] as Record<string, unknown> | unknown[];
      }
    }

    const lastPart = parts[parts.length - 1];
    if (Array.isArray(current)) {
      current[parseInt(lastPart, 10)] = value;
    } else {
      current[lastPart] = value;
    }
  }

  return result;
}

/**
 * Count the number of translation keys in a JSON object (recursively)
 */
export function countKeys(obj: Record<string, unknown>): number {
  let count = 0;

  for (const value of Object.values(obj)) {
    if (Array.isArray(value)) {
      // Count array elements recursively
      for (const item of value) {
        if (typeof item === "object" && item !== null) {
          count += countKeys(item as Record<string, unknown>);
        } else {
          count++;
        }
      }
    } else if (typeof value === "object" && value !== null) {
      count += countKeys(value as Record<string, unknown>);
    } else {
      count++;
    }
  }

  return count;
}

/**
 * Get all keys from a JSON object (flattened)
 */
export function getAllKeys(obj: Record<string, unknown>): string[] {
  return flattenJson(obj).map((item) => item.key);
}

/**
 * Parse JSON file content safely
 */
export function parseJsonSafe(content: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(content);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}
