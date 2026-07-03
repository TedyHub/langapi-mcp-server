/**
 * API request/response types for LangAPI.
 * These types match langapi-api's `POST /api/v1/translate-file` contract
 * (hand-duplicated across the two repos — keep in sync manually).
 */

export type FileFormat = "json" | "arb" | "strings" | "stringsdict" | "xcstrings";

// Key-value pair, still used by locale-detection's key counting.
export interface KeyValue {
  key: string;
  value: string;
}

export interface TranslateFileRequest {
  source_lang: string;
  target_lang: string;
  file_format: FileFormat;
  source_file_content: string;
  previous_target_file_content?: string;
  dry_run: boolean;
}

export interface TranslateFileChangeSummary {
  newKeys: string[];
  changedKeys: string[];
  removedKeys: string[];
  reusedFromCacheCount: number;
}

export interface TranslateFileCost {
  wordsToTranslate: number;
  creditsRequired: number;
  currentBalance: number;
  balanceAfterSync: number;
  unlimitedPlan?: boolean;
}

export interface TranslateFileDryRunResponse {
  success: true;
  delta: TranslateFileChangeSummary;
  cost: TranslateFileCost;
}

export interface TranslateFileExecuteResponse {
  success: true;
  translated_file_content: string;
  delta: TranslateFileChangeSummary;
  qaWarnings?: number;
  cost: {
    creditsUsed: number;
    balanceAfterSync: number;
    unlimitedPlan?: boolean;
  };
}

export interface TranslateFileErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    currentBalance?: number;
    requiredCredits?: number;
  };
}

export type TranslateFileResponse =
  | TranslateFileDryRunResponse
  | TranslateFileExecuteResponse
  | TranslateFileErrorResponse;

export interface AccountStatusResponse {
  success: true;
  account: {
    credits: number;
    plan: "unlimited" | "pay-as-you-go";
    unlimitedPlan?: boolean;
    subscriptionExpiresAt?: string;
  };
}

export type AccountStatusResult =
  | AccountStatusResponse
  | { success: false; error: { code: string; message: string } };

export interface GlossaryTermDto {
  _id: string;
  sourceLang: string;
  sourceText: string;
  targetLang: string;
  targetText: string;
  caseSensitive: boolean;
}

export interface AddGlossaryTermRequest {
  sourceLang: string;
  sourceText: string;
  targetLang: string;
  targetText: string;
  caseSensitive?: boolean;
}

export type GlossaryListResult =
  | { success: true; data: GlossaryTermDto[] }
  | { success: false; error: { code: string; message: string } };

export type GlossaryAddResult =
  | { success: true; data: GlossaryTermDto }
  | { success: false; error: { code: string; message: string } };

export type GlossaryDeleteResult =
  | { success: true }
  | { success: false; error: { code: string; message: string } };
