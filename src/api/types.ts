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

/** A glossary term sent inline for one target language (server applies, never stores). */
export interface GlossaryTerm {
  source_text: string;
  target_text: string;
  case_sensitive?: boolean;
}

export interface TranslateFileRequest {
  source_lang: string;
  target_lang: string;
  file_format: FileFormat;
  source_file_content: string;
  previous_target_file_content?: string;
  glossary?: GlossaryTerm[];
  dry_run: boolean;
}

export interface TranslateFileChangeSummary {
  newKeys: string[];
  changedKeys: string[];
  removedKeys: string[];
  reusedFromCacheCount: number;
}

// Monthly word-allowance fields returned by the metered API, additive to the
// legacy credit fields. Mirrors langapi-api's UsageCostFields; all optional so
// an older server (or an older field set) still parses.
export interface UsageCostFields {
  plan?: "pro" | "free";
  monthlyAllowance?: number;
  wordsUsedThisMonth?: number;
  wordsRemaining?: number;
  /** Words beyond the monthly allowance billed as overage (Pro). */
  overageWords?: number;
}

export interface TranslateFileCost extends UsageCostFields {
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
  cost: UsageCostFields & {
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
    // 'pro' | 'free' from the metered API; the older two values are accepted for
    // backward compatibility with a pre-metering server.
    plan: "pro" | "free" | "unlimited" | "pay-as-you-go";
    monthlyAllowance?: number;
    wordsUsedThisMonth?: number;
    wordsRemaining?: number;
    /** ISO timestamp when the monthly allowance resets. */
    periodResetAt?: string;
    unlimitedPlan?: boolean;
    subscriptionExpiresAt?: string;
  };
}

export type AccountStatusResult =
  | AccountStatusResponse
  | { success: false; error: { code: string; message: string } };
