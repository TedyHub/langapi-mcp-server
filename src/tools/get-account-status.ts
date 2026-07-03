/**
 * get_account_status MCP Tool
 *
 * Reports the LangAPI credit balance and subscription plan for the configured
 * credentials — parity with the dashboard's primary view so an agent doesn't
 * have to run a dry-run sync to learn its balance (finding #21).
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { LangAPIClient } from "../api/client.js";

const GetAccountStatusSchema = z.object({});

function textResult(payload: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

export function registerGetAccountStatus(server: McpServer): void {
  server.tool(
    "get_account_status",
    "Get the current LangAPI account status: credit balance and whether an unlimited subscription plan is active. Use this to check remaining credits before syncing translations.",
    GetAccountStatusSchema.shape,
    async (): Promise<{ content: Array<{ type: "text"; text: string }> }> => {
      if (!LangAPIClient.canCreate()) {
        return textResult({
          success: false,
          error: {
            code: "NOT_AUTHENTICATED",
            message:
              "Not authenticated. Run `npx @langapi/mcp-server login`, or set LANGAPI_API_KEY for CI.",
          },
        });
      }

      const client = await LangAPIClient.create();
      const result = await client.getAccountStatus();

      if (!result.success) {
        return textResult({ success: false, error: result.error });
      }

      return textResult({
        success: true,
        credits: result.account.credits,
        plan: result.account.plan,
        unlimited_plan: result.account.unlimitedPlan ?? false,
        subscription_expires_at: result.account.subscriptionExpiresAt ?? null,
      });
    }
  );
}
