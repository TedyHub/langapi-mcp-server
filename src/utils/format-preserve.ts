/**
 * Utilities for detecting and preserving JSON file formatting
 */

export interface JsonFormat {
  /** Indentation string (spaces or tab) */
  indent: string;
  /** Whether file ends with newline */
  trailingNewline: boolean;
}

/**
 * Detect the formatting used in a JSON file
 */
export function detectJsonFormat(content: string): JsonFormat {
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

  return { indent, trailingNewline };
}

/**
 * Stringify a JSON object with specific formatting
 */
export function stringifyWithFormat(
  obj: unknown,
  format: JsonFormat
): string {
  let result = JSON.stringify(obj, null, format.indent);

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
    const format = detectJsonFormat(content);
    return { data: data as Record<string, unknown>, format };
  } catch {
    return null;
  }
}
