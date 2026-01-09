/**
 * Utilities for detecting and preserving JSON file formatting
 */

export interface JsonFormat {
  /** Indentation string (spaces or tab) */
  indent: string;
  /** Whether file ends with newline */
  trailingNewline: boolean;
  /** Key structure: flat (keys contain dots) or nested (keys map to objects) */
  keyStructure: "flat" | "nested";
  /** Original key order for preserving order when writing */
  keyOrder?: string[];
}

/**
 * Detect if a JSON object uses flat keys (keys containing dots at root level)
 */
function detectKeyStructure(data: Record<string, unknown>): "flat" | "nested" {
  for (const key of Object.keys(data)) {
    // If any root-level key contains a dot and maps to a non-object value, it's flat
    if (key.includes(".") && typeof data[key] !== "object") {
      return "flat";
    }
  }
  return "nested";
}

/**
 * Get all keys from an object recursively (flattened with dot notation)
 */
function getAllKeysInOrder(
  obj: Record<string, unknown>,
  prefix = ""
): string[] {
  const keys: string[] = [];
  for (const key of Object.keys(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    const value = obj[key];
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      keys.push(...getAllKeysInOrder(value as Record<string, unknown>, fullKey));
    } else {
      keys.push(fullKey);
    }
  }
  return keys;
}

/**
 * Detect the formatting used in a JSON file
 */
export function detectJsonFormat(
  content: string,
  data?: Record<string, unknown>
): JsonFormat {
  const lines = content.split("\n");

  // Detect indent by finding first indented line
  let indent = "  "; // default: 2 spaces
  for (const line of lines) {
    const match = line.match(/^(\s+)/);
    if (match) {
      const whitespace = match[1];
      // Check if it's tabs or spaces
      if (whitespace.includes("\t")) {
        indent = "\t";
      } else {
        // Use the detected indent size
        indent = whitespace;
      }
      break;
    }
  }

  // Detect trailing newline
  const trailingNewline = content.endsWith("\n");

  // Detect key structure and order if data is provided
  let keyStructure: "flat" | "nested" = "nested";
  let keyOrder: string[] | undefined;

  if (data) {
    keyStructure = detectKeyStructure(data);
    keyOrder = keyStructure === "flat"
      ? Object.keys(data) // For flat files, use root keys directly
      : getAllKeysInOrder(data); // For nested, flatten to get all keys
  }

  return { indent, trailingNewline, keyStructure, keyOrder };
}

/**
 * Reorder object keys to match the specified order
 */
function reorderKeys(
  obj: Record<string, unknown>,
  keyOrder: string[],
  isFlat: boolean
): Record<string, unknown> {
  if (isFlat) {
    // For flat structure, just reorder root keys
    const result: Record<string, unknown> = {};
    // First add keys in order
    for (const key of keyOrder) {
      if (key in obj) {
        result[key] = obj[key];
      }
    }
    // Then add any new keys not in the original order
    for (const key of Object.keys(obj)) {
      if (!(key in result)) {
        result[key] = obj[key];
      }
    }
    return result;
  } else {
    // For nested structure, recursively reorder
    return reorderNestedKeys(obj, keyOrder);
  }
}

/**
 * Recursively reorder nested object keys based on flattened key order
 */
function reorderNestedKeys(
  obj: Record<string, unknown>,
  flatKeyOrder: string[]
): Record<string, unknown> {
  // Build a map of prefix -> order index (use first occurrence)
  const prefixOrder = new Map<string, number>();
  for (let i = 0; i < flatKeyOrder.length; i++) {
    const key = flatKeyOrder[i];
    const parts = key.split(".");
    // Add all prefixes to maintain hierarchy order
    for (let j = 1; j <= parts.length; j++) {
      const prefix = parts.slice(0, j).join(".");
      if (!prefixOrder.has(prefix)) {
        prefixOrder.set(prefix, i);
      }
    }
  }

  // Sort root keys by their order in the flattened key list
  const sortedKeys = Object.keys(obj).sort((a, b) => {
    const orderA = prefixOrder.get(a) ?? Infinity;
    const orderB = prefixOrder.get(b) ?? Infinity;
    return orderA - orderB;
  });

  const result: Record<string, unknown> = {};
  for (const key of sortedKeys) {
    const value = obj[key];
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      // Recursively reorder nested objects
      result[key] = reorderNestedKeys(
        value as Record<string, unknown>,
        flatKeyOrder.map((k) =>
          k.startsWith(key + ".") ? k.slice(key.length + 1) : k
        )
      );
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Stringify a JSON object with specific formatting
 */
export function stringifyWithFormat(
  obj: unknown,
  format: JsonFormat
): string {
  let objToStringify = obj;

  // Reorder keys if keyOrder is provided
  if (format.keyOrder && typeof obj === "object" && obj !== null && !Array.isArray(obj)) {
    objToStringify = reorderKeys(
      obj as Record<string, unknown>,
      format.keyOrder,
      format.keyStructure === "flat"
    );
  }

  let result = JSON.stringify(objToStringify, null, format.indent);

  if (format.trailingNewline && !result.endsWith("\n")) {
    result += "\n";
  }

  return result;
}

/**
 * Read JSON file content and detect its format
 */
export function parseJsonWithFormat(content: string): {
  data: Record<string, unknown>;
  format: JsonFormat;
} | null {
  try {
    const data = JSON.parse(content);
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      return null;
    }
    const format = detectJsonFormat(content, data as Record<string, unknown>);
    return { data: data as Record<string, unknown>, format };
  } catch {
    return null;
  }
}
