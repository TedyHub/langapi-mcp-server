/**
 * Temp directory management utilities for tests
 */

import { mkdtemp, rm, cp, mkdir } from "fs/promises";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface TempTestDir {
  path: string;
  cleanup: () => Promise<void>;
}

/**
 * Get the path to the fixtures directory
 */
export function getFixturesPath(): string {
  return join(__dirname, "..", "fixtures");
}

/**
 * Create a temporary test directory
 */
export async function createTempTestDir(
  prefix: string = "langapi-test-"
): Promise<TempTestDir> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  return {
    path,
    cleanup: async () => {
      await rm(path, { recursive: true, force: true });
    },
  };
}

/**
 * Copy a fixture directory to a temp directory
 * Returns a temp directory with the fixture copied into it
 */
export async function copyFixtureToTemp(
  fixtureName: string
): Promise<TempTestDir> {
  const tempDir = await createTempTestDir(`langapi-${fixtureName}-`);
  const fixtureSource = join(getFixturesPath(), fixtureName);

  await cp(fixtureSource, tempDir.path, { recursive: true });

  return tempDir;
}

/**
 * Ensure a directory exists
 */
export async function ensureDir(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true });
}
