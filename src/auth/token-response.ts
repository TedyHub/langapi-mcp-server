/**
 * Shared shape/validator for langapi-api's /api/v1/oauth/token and
 * /api/v1/oauth/refresh responses. Used by both login-flow.ts and
 * token-provider.ts so a malformed response is rejected before being
 * persisted, rather than silently corrupting ~/.langapi/credentials.json
 * (e.g. a missing expires_in would otherwise produce a NaN/null expiry that
 * looks "logged in" but never actually authenticates again).
 */
export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

export function isValidTokenResponse(data: unknown): data is TokenResponse {
  if (typeof data !== "object" || data === null) return false;
  const obj = data as Record<string, unknown>;
  return (
    typeof obj.access_token === "string" &&
    obj.access_token.length > 0 &&
    typeof obj.refresh_token === "string" &&
    obj.refresh_token.length > 0 &&
    typeof obj.expires_in === "number" &&
    Number.isFinite(obj.expires_in) &&
    obj.expires_in > 0
  );
}
