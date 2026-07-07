/**
 * Local storage for browser/device-login session tokens
 * (~/.langapi/credentials.json). This is the only credential the CLI uses.
 */

import { readFile, writeFile, mkdir, rm } from "fs/promises";
import { existsSync } from "fs";
import { homedir } from "os";
import { join, dirname } from "path";

export interface StoredCredentials {
  access_token: string;
  refresh_token: string;
  /** Epoch milliseconds */
  expires_at: number;
}

const CREDENTIALS_PATH = join(homedir(), ".langapi", "credentials.json");

export function credentialsFileExists(): boolean {
  return existsSync(CREDENTIALS_PATH);
}

export async function readCredentials(): Promise<StoredCredentials | null> {
  try {
    const raw = await readFile(CREDENTIALS_PATH, "utf-8");
    return JSON.parse(raw) as StoredCredentials;
  } catch {
    return null;
  }
}

export async function writeCredentials(creds: StoredCredentials): Promise<void> {
  await mkdir(dirname(CREDENTIALS_PATH), { recursive: true });
  await writeFile(CREDENTIALS_PATH, JSON.stringify(creds, null, 2), { mode: 0o600 });
}

export async function clearCredentials(): Promise<void> {
  await rm(CREDENTIALS_PATH, { force: true });
}
