#!/usr/bin/env node

/**
 * Start SawitDB Server
 *
 * Usage:
 *   node start_server.js
 *
 * Environment Variables:
 *   SAWIT_PORT - Port to listen on (default: 7878)
 *   SAWIT_HOST - Host to bind to (default: 0.0.0.0)
 *   SAWIT_DATA_DIR - Directory for database files (default: ./data)
 *   SAWIT_AUTH - Enable authentication (format: username:password)
 */

import SawitServer from "../src/SawitServer";
import path from "node:path";
import url from "node:url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

// Parse configuration
const config = {
	port: process.env.SAWIT_PORT || 7878,
	host: process.env.SAWIT_HOST || "0.0.0.0",
	dataDir: process.env.SAWIT_DATA_DIR || path.join(__dirname, "../data"),
	// WAL Configuration
	wal: {
		enabled: process.env.SAWIT_WAL_ENABLED !== "false", // Default true if not explicitly false
		syncMode: process.env.SAWIT_WAL_SYNC_MODE || "normal",
		checkpointInterval:
			parseInt(process.env.SAWIT_WAL_CHECKPOINT_INTERVAL) || 10000,
	},
	// Multi-Threading Configuration
	clusterMode: process.env.SAWIT_CLUSTER_MODE === "true",
	workerCount: parseInt(process.env.SAWIT_CLUSTER_WORKERS) || 0,
};

// Parse authentication if provided
if (process.env.SAWIT_AUTH) {
	const [username, password] = process.env.SAWIT_AUTH.split(":");
	if (username && password) {
		config.auth = { [username]: password };
		console.log(`[Config] Authentication enabled for user: ${username}`);
	}
}

console.log("[Config] Server configuration:");
console.log(`  - Port: ${config.port}`);
console.log(`  - Host: ${config.host}`);
console.log(`  - Data Directory: ${config.dataDir}`);
console.log(`  - Auth: ${config.auth ? "Enabled" : "Disabled"}`);
console.log(
	`  - WAL: ${config.wal.enabled ? "Enabled (" + config.wal.syncMode + ")" : "Disabled"}`,
);
console.log(
	`  - Mode: ${config.clusterMode ? "CLUSTER (Workers: " + (config.workerCount || "Auto") + ")" : "SINGLE THREAD"}`,
);
console.log("");

// Create and start server
const server = new SawitServer(config);
server.start();

// Graceful shutdown
process.on("SIGINT", () => {
	console.log("\n[Server] Received SIGINT, shutting down gracefully...");
	server.stop();
	setTimeout(() => process.exit(0), 1000);
});

process.on("SIGTERM", () => {
	console.log("\n[Server] Received SIGTERM, shutting down gracefully...");
	server.stop();
	setTimeout(() => process.exit(0), 1000);
});

// Handle uncaught errors
process.on("uncaughtException", (err) => {
	console.error("[Server] Uncaught Exception:", err);
	server.stop();
	process.exit(1);
});

process.on("unhandledRejection", (reason, promise) => {
	console.error(
		"[Server] Unhandled Rejection at:",
		promise,
		"reason:",
		reason,
	);
});
