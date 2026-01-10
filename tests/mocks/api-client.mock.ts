/**
 * Mock LangAPIClient for testing sync functionality
 *
 * Returns predictable translations by appending "-{lang}" suffix
 * Example: "Hello" + "de" = "Hello-de"
 */

import { vi } from "vitest";
import type {
  SyncRequest,
  SyncResponse,
  SyncDryRunResponse,
  SyncExecuteResponse,
} from "../../src/api/types.js";

/**
 * Creates a mock translation by appending language suffix
 * Example: mockTranslate("Hello", "de") => "Hello-de"
 */
export function mockTranslate(value: string, targetLang: string): string {
  return `${value}-${targetLang}`;
}

/**
 * Creates a mock sync function that returns predictable translations
 */
export function createMockSyncFn() {
  return vi.fn(async (request: SyncRequest): Promise<SyncResponse> => {
    if (request.dry_run) {
      // Return dry run response
      const response: SyncDryRunResponse = {
        success: true,
        delta: {
          newKeys: request.content.map((c) => c.key),
          changedKeys: [],
          unchangedKeys: [],
          totalKeysToSync: request.content.length,
        },
        cost: {
          wordsToTranslate: request.content.reduce(
            (acc, c) => acc + c.value.split(/\s+/).length,
            0
          ),
          creditsRequired: request.content.length * 10,
          currentBalance: 10000,
          balanceAfterSync: 10000 - request.content.length * 10,
        },
      };
      return response;
    }

    // Return execute response with mock translations
    const response: SyncExecuteResponse = {
      success: true,
      results: request.target_langs.map((lang) => ({
        language: lang,
        translatedCount: request.content.length,
        translations: request.content.map((c) => ({
          key: c.key,
          value: mockTranslate(c.value, lang),
        })),
      })),
      cost: {
        creditsUsed: request.content.length * 10,
        balanceAfterSync: 10000 - request.content.length * 10,
      },
    };
    return response;
  });
}

/**
 * Creates a mock LangAPIClient instance
 */
export function createMockLangAPIClient() {
  const mockSyncFn = createMockSyncFn();

  return {
    sync: mockSyncFn,
    _mockSyncFn: mockSyncFn,
  };
}

/**
 * Mock for the LangAPIClient class
 */
export class MockLangAPIClient {
  private static instance: ReturnType<typeof createMockLangAPIClient> | null = null;

  static create() {
    if (!MockLangAPIClient.instance) {
      MockLangAPIClient.instance = createMockLangAPIClient();
    }
    return MockLangAPIClient.instance;
  }

  static canCreate(): boolean {
    return true;
  }

  static reset() {
    MockLangAPIClient.instance = null;
  }

  static getInstance() {
    return MockLangAPIClient.instance;
  }
}
