/**
 * API request/response types for LangAPI
 * These types match the langapi-api sync endpoint
 */

// Key-value pair for translation content
export interface KeyValue {
  key: string;
  value: string;
}

// Sync request body
export interface SyncRequest {
  source_lang: string;
  target_langs: string[];
  content: KeyValue[];
  dry_run: boolean;
}

// Delta information showing what changed
export interface SyncDelta {
  newKeys: string[];
  changedKeys: string[];
  unchangedKeys: string[];
  totalKeysToSync: number;
}

// Cost estimation
export interface SyncCostEstimate {
  wordsToTranslate: number;
  creditsRequired: number;
  currentBalance: number;
  balanceAfterSync: number;
}

// Response for dry_run: true
export interface SyncDryRunResponse {
  success: true;
  delta: SyncDelta;
  cost: SyncCostEstimate;
}

// Result per language after sync
export interface SyncLanguageResult {
  language: string;
  translatedCount: number;
  translations: KeyValue[];
}

// Response for dry_run: false
export interface SyncExecuteResponse {
  success: true;
  results: SyncLanguageResult[];
  cost: {
    creditsUsed: number;
    balanceAfterSync: number;
  };
}

// Error response
export interface SyncErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    currentBalance?: number;
    requiredCredits?: number;
    topUpUrl?: string;
  };
}

// Union type for all sync responses
export type SyncResponse =
  | SyncDryRunResponse
  | SyncExecuteResponse
  | SyncErrorResponse;
