/**
 * Send verification request to a device
 */
import { createClient } from "matrix-js-sdk";
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
    storageKey: "verify-device-session",
  });

  // Wait for crypto
  await new Promise<void>((resolve) => {
    const check = () => {
      if (client.getCrypto()) resolve();
      else setTimeout(check, 100);
    };
    check();
  });

  const crypto = client.getCrypto()!;

  // Get own devices
  const devices = await client.getDevices();
  console.log("Own devices:");
  for (const device of devices.devices || []) {
    console.log(`  ${device.device_id}: ${device.display_name || 'unnamed'}`);
  }

  // Find ZEQLGVPPPG
  const targetDevice = devices.devices?.find(d => d.device_id === "ZEQLGVPPPG");
  if (!targetDevice) {
    console.error("Device ZEQLGVPPPG not found in device list");
    await client.stopClient();
    process.exit(1);
  }

  console.log("\nFound ZEQLGVPPPG, querying device keys...");

  // Query keys for our own user to get device info
  await client.downloadKeys([session.userId], true);
  console.log("Device keys downloaded");

  // Wait a moment for crypto to process
  await new Promise(resolve => setTimeout(resolve, 1000));

  try {
    // Request verification
    console.log("Sending verification request...");
    const request = await crypto.requestDeviceVerification(session.userId, "ZEQLGVPPPG");
    console.log("Verification request sent!");
    console.log("Request ID:", request.transactionId);

    // Listen for verification events
    client.on("crypto.verification.request", (req) => {
      console.log("Verification request received:", req.transactionId);
    });

    client.on("crypto.verification.start", (verifier) => {
      console.log("Verification started!");
      console.log("Method:", verifier.method);
    });

    client.on("crypto.verification.done", () => {
      console.log("Verification completed!");
    });

    // Keep alive for verification
    await new Promise(resolve => setTimeout(resolve, 120000));

  } catch (err) {
    console.error("Failed to request verification:", err);
  }

  await client.stopClient();
}

main();
