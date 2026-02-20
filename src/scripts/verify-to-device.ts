/**
 * Initiate device verification from bot to another device
 *
 * This script demonstrates proper E2EE device verification using SAS (emoji).
 */
import Olm from "@matrix-org/olm";
(global as any).Olm = Olm;
await Olm.init();

import { createClient } from "matrix-js-sdk";

// Type aliases from Crypto namespace
type VerificationRequest = typeof import("matrix-js-sdk").Crypto.VerificationRequest;
type VerificationPhase = typeof import("matrix-js-sdk").Crypto.VerificationPhase;
type VerificationRequestEvent = typeof import("matrix-js-sdk").Crypto.VerificationRequestEvent;
type VerifierEvent = typeof import("matrix-js-sdk").Crypto.VerifierEvent;
type Verifier = typeof import("matrix-js-sdk").Crypto.Verifier;

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

  // Start sync
  client.startClient({ initialSyncLimit: 10 });

  // Initialize crypto
  console.log("Initializing crypto...");
  await client.initCrypto();
  console.log("Crypto initialized");

  // Wait for sync
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      console.log("Sync timeout, continuing...");
      resolve();
    }, 10000);

    client.on("sync", (state: unknown) => {
      console.log(`Sync state: ${state}`);
      if (state === "SYNCING" || state === "PREPARED") {
        clearTimeout(timeout);
        setTimeout(() => resolve(), 1000);
      }
    });
  });

  console.log("Sync is ready");

  const targetDeviceId = process.argv[2] || "ZEQLGVPPPG";
  const targetUserId = session.userId; // Verify with our own other devices

  console.log(`Requesting verification with ${targetUserId}:${targetDeviceId}...`);

  try {
    // Get the crypto module
    const crypto = client.getCrypto();
    if (!crypto) {
      console.error("Crypto not available");
      process.exit(1);
    }

    // Request verification with the specific device using the correct API
    const request = await (crypto as any).requestDeviceVerification(targetUserId, targetDeviceId);

    console.log("Verification request sent!");
    console.log("Waiting for response...");

    // Listen to the verification request for phase changes
    request.on("change" as any, () => {
      console.log(`Request phase: ${request.phase}`);

      const phase = request.phase as unknown;
      if (phase === "Ready" || phase === VerificationPhase.Ready) {
        // Request is ready, start SAS verification
        console.log("Starting SAS verification...");

        try {
          const verifier = request.beginKeyVerification("m.sas.v1");
          if (verifier) {
            console.log("SAS verifier created");

            // Listen for ShowSas event (emoji verification)
            verifier.on("show_sas" as any, (sas: any) => {
              console.log("\n*** SHOW SAS (EMOJI VERIFICATION) ***");

              // Get the SAS callbacks which contain the emoji data and confirm method
              const sasData = verifier.getShowSasCallbacks();
              if (sasData?.sas?.emoji) {
                const emojis = sasData.sas.emoji;
                console.log("\nCompare these emojis on both devices:");
                for (let i = 0; i < emojis.length; i++) {
                  console.log(`  ${emojis[i][0]} ${emojis[i][1]}`);
                }

                // Auto-confirm after 2 seconds if not testing manually
                console.log("\nAuto-confirming in 2 seconds...");
                setTimeout(() => {
                  console.log("Confirming verification...");
                  sasData.confirm?.()
                    .then(() => {
                      console.log("Verification confirmed!");
                    })
                    .catch((err: Error) => {
                      console.error("Failed to confirm:", err);
                    });
                }, 2000);
              }
            });

            // Listen for cancel event
            verifier.on("cancel" as any, (err: Error | any) => {
              console.error("Verification cancelled:", err);
              process.exit(1);
            });

            // Start the verification process
            verifier.verify().catch((err: Error) => {
              console.error("Verification failed:", err);
            });
          }
        } catch (err) {
          console.error("Error starting SAS:", err);
        }
      }

      if (phase === "Done" || phase === VerificationPhase.Done) {
        console.log("\n*** VERIFICATION COMPLETE! ***");
        console.log("Device is now verified and can receive encrypted messages.");
        process.exit(0);
      }

      if (phase === "Cancelled" || phase === VerificationPhase.Cancelled) {
        const cancelCode = (request as any).cancellationCode;
        console.error("Verification cancelled. Code:", cancelCode);
        process.exit(1);
      }
    });

    // Handle incoming verification requests (from other devices)
    client.on("toDeviceEvent", (event: any) => {
      const type = event.getType();
      if (type.startsWith("m.key.verification")) {
        console.log(`ToDevice event: ${type} from ${event.getSender()}`);

        // Check for incoming verification requests
        if (type === "m.key.verification.start" || type === "m.key.verification.request") {
          const crypto = client.getCrypto();
          if (crypto) {
            // Get pending requests
            const pendingRequests = (crypto as any).getVerificationRequestsToDeviceInProgress?.(event.getSender());
            if (pendingRequests) {
              for (const req of pendingRequests) {
                if (req !== request && req.canAccept) {
                  console.log("Accepting incoming verification request...");
                  req.accept()
                    .then(() => {
                      console.log("Request accepted, setting up SAS...");
                      setupIncomingSAS(req);
                    })
                    .catch((err: Error) => {
                      console.error("Failed to accept:", err);
                    });
                }
              }
            }
          }
        }
      }
    });

    // Set up SAS for an incoming request
    function setupIncomingSAS(req: any) {
      req.on("change" as any, () => {
        const phase = req.phase as unknown;
        if (phase === "Ready" || phase === VerificationPhase.Ready) {
          console.log("Starting SAS for incoming request...");
          const verifier = req.beginKeyVerification("m.sas.v1");
          if (verifier) {
            verifier.on("show_sas" as any, (sas: any) => {
              console.log("\n*** SHOW SAS (EMOJI VERIFICATION) ***");
              const sasData = verifier.getShowSasCallbacks();
              if (sasData?.sas?.emoji) {
                console.log("\nCompare these emojis:");
                sasData.sas.emoji.forEach((e: [string, string]) => {
                  console.log(`  ${e[0]} ${e[1]}`);
                });

                setTimeout(() => {
                  console.log("Confirming...");
                  sasData.confirm?.()
                    .then(() => console.log("Confirmed!"))
                    .catch((err: Error) => console.error("Failed:", err));
                }, 2000);
              }
            });

            verifier.on("cancel" as any, (err: any) => {
              console.error("Cancelled:", err);
            });

            verifier.verify().catch((err: Error) => {
              console.error("Failed:", err);
            });
          }
        }

        if (phase === "Done" || phase === VerificationPhase.Done) {
          console.log("\n*** VERIFICATION COMPLETE ***");
        }
      });
    }

    // Check for existing ready requests
    const cryptoCheck = client.getCrypto();
    if (cryptoCheck) {
      const pendingRequests = (crypto as any).getVerificationRequestsToDeviceInProgress?.(targetUserId);
      if (pendingRequests) {
        console.log(`Found ${pendingRequests.length} existing verification requests`);
        for (const req of pendingRequests) {
          const phase = req.phase as unknown;
          if (req !== request && (phase === "Ready" || phase === VerificationPhase.Ready)) {
            console.log("Setting up SAS for existing ready request...");
            setupIncomingSAS(req);
          }
        }
      }
    }

    // Keep running
    await new Promise(() => {});

  } catch (err) {
    console.error("Verification failed:", err);
    process.exit(1);
  }
}

main();
