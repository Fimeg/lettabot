/**
 * Import Megolm session keys from file
 */
import { createClient } from "matrix-js-sdk";
import { readFileSync } from "node:fs";
import { MatrixSessionManager } from "../channels/matrix/session.js";

async function main() {
  const sessionManager = new MatrixSessionManager({
    sessionFile: "./data/matrix-ani/session.json",
  });
  const session = sessionManager.loadSession();

  if (!session?.accessToken) {
    console.error("No session found");
    process.exit(1);
  }

  const client = createClient({
    baseUrl: session.homeserver,
    userId: session.userId,
    accessToken: session.accessToken,
    deviceId: session.deviceId,
  });

  // Initialize Rust crypto
  await client.initRustCrypto({
    useIndexedDB: false,
    storageKey: "import-keys-session",
  });

  // Wait for crypto to be ready
  await new Promise<void>((resolve) => {
    const check = () => {
      if (client.getCrypto()) resolve();
      else setTimeout(check, 100);
    };
    check();
  });

  // Import via crypto API
  const crypto = client.getCrypto();
  if (!crypto) {
    console.error("Crypto not available");
    process.exit(1);
  }

  // Try to restore from key backup
  try {
    const backupInfo = await crypto.getKeyBackupInfo();
    if (backupInfo) {
      console.log("Found key backup version:", backupInfo.version);
      const result = await crypto.restoreKeyBackup({
        backupVersion: backupInfo.version,
      });
      console.log("Key backup restore result:", result);
    } else {
      console.log("No key backup found");
    }
  } catch (err) {
    console.error("Failed to restore key backup:", err);
  }

  await client.stopClient();
}

main();
