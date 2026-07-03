import { exec } from "child_process";

/**
 * Best-effort cross-platform "open URL in the default browser", with no
 * extra npm dependency (the project's convention elsewhere is raw
 * fetch/child_process over pulling in small helper packages).
 */
export function openBrowser(url: string): void {
  const command =
    process.platform === "darwin"
      ? `open "${url}"`
      : process.platform === "win32"
        ? `start "" "${url}"`
        : `xdg-open "${url}"`;

  exec(command, (error) => {
    if (error) {
      console.error(`Could not open the browser automatically. Please open this URL manually:\n${url}`);
    }
  });
}
