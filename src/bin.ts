#!/usr/bin/env node
const printWarning = process.listeners("warning")[0];
process.removeAllListeners("warning");
process.on("warning", (warning) => {
  if (warning.name === "ExperimentalWarning" && warning.message.startsWith("SQLite")) return;
  printWarning?.(warning);
});
// Loaded dynamically so node:sqlite's ExperimentalWarning is emitted after the filter above is installed.
await import("./cli.js");
