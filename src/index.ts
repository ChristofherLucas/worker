import { messageWorker } from "./worker";

async function main() {
  try {
    console.log("[worker]: starting worker...");
    await messageWorker.run();
  } catch (err) {
    console.error("[worker]: fatal error", err);
    process.exit(1);
  }
}

main();
