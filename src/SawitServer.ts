import net from "node:net";
import path from "node:path";
import url from "node:url";
import cluster from "node:cluster";

import AuthManager from "./server/auth/AuthManager.ts";
import DatabaseRegistry from "./server/DatabaseRegistry.ts";
import RequestRouter from "./server/router/RequestRouter.ts";
import ClientSession from "./server/session/ClientSession.ts";

// NOTE: since we can't use macro in TS (tbf there's macro-ts but i dont want to
// complicate it), and i cant lazily load this so that it executes only on this
// file and only when it's used, we ought to define this at the top in every
// files that needs it
const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

/**
 * SawitDB Server - Network Database Server
 * Supports sawitdb:// protocol connections
 * Refactored to use modular components.
 */
export default class SawitServer {
	constructor(config = {}) {
		// Configuration
		this.port = this.validatePort(config.port || 7878);
		this.host = config.host || "0.0.0.0";
		this.maxConnections = config.maxConnections || 100;
		this.queryTimeout = config.queryTimeout || 30000;
		this.logLevel = config.logLevel || "info";

		// State
		this.config = config;
		this.clients = new Set();
		this.server = null;
		this.stats = {
			totalConnections: 0,
			activeConnections: 0,
			totalQueries: 0,
			errors: 0,
			startTime: Date.now(),
		};

		// Initialize Managers
		this.dbRegistry = new DatabaseRegistry(
			config.dataDir || path.join(__dirname, "../data"),
			config,
		);
		this.authManager = new AuthManager(this);
		this.router = new RequestRouter(this);

		this.log("info", `Data directory: ${this.dbRegistry.dataDir}`);
		this.log("info", `Max connections: ${this.maxConnections}`);
	}

	validatePort(port) {
		const p = parseInt(port, 10);
		if (isNaN(p) || p < 1 || p > 65535) {
			throw new Error(`Invalid port: ${port}. Must be between 1-65535`);
		}
		return p;
	}

	log(level, message, data = null) {
		const levels = { debug: 0, info: 1, warn: 2, error: 3 };
		const currentLevel = levels[this.logLevel] || 1;
		const msgLevel = levels[level] || 1;

		if (msgLevel >= currentLevel) {
			const timestamp = new Date().toISOString();
			const prefix = level.toUpperCase().padEnd(5);
			console.log(`[${timestamp}] [${prefix}] ${message}`);
			if (data && this.logLevel === "debug") {
				console.log(JSON.stringify(data, null, 2));
			}
		}
	}

	start() {
		this.server = net.createServer((socket) =>
			this.handleConnection(socket),
		);

		this.server.listen(this.port, this.host, () => {
			const prefix = cluster.isWorker
				? `[Worker ${cluster.worker.id}]`
				: "[Server]";

			if (!cluster.isWorker) {
				console.log(
					`╔══════════════════════════════════════════════════╗`,
				);
				console.log(
					`║      🌴 SawitDB Server - Version 2.6.0           ║`,
				);
				console.log(
					`╚══════════════════════════════════════════════════╝`,
				);
			}
			console.log(`${prefix} Listening on ${this.host}:${this.port}`);
			console.log(
				`${prefix} Protocol: sawitdb://${this.host}:${this.port}/[database]`,
			);
			console.log(`${prefix} Ready to accept connections...`);
		});

		this.server.on("error", (err) => {
			console.error("[Server] Error:", err.message);
		});
	}

	stop() {
		console.log("[Server] Shutting down...");

		// Close all client connections
		for (const client of this.clients) {
			client.end();
		}

		// Close all open databases
		this.dbRegistry.closeAll();

		// Close server
		if (this.server) {
			this.server.close(() => {
				console.log("[Server] Server stopped.");
			});
		}
	}

	handleConnection(socket) {
		const clientId = `${socket.remoteAddress}:${socket.remotePort}`;

		if (this.clients.size >= this.maxConnections) {
			this.log("warn", `Connection limit reached. Rejecting ${clientId}`);
			socket.write(
				JSON.stringify({
					type: "error",
					error: "Server connection limit reached. Please try again later.",
				}) + "\n",
			);
			socket.end();
			return;
		}

		this.log("info", `Client connected: ${clientId}`);
		this.stats.totalConnections++;
		this.stats.activeConnections++;
		this.clients.add(socket);

		// Attach session to socket for cleanup if needed, but best to keep separate
		// Just use local var for session, pass to router
		const session = new ClientSession(socket, clientId);

		let buffer = "";

		socket.on("data", (data) => {
			buffer += data.toString();

			if (buffer.length > 1048576) {
				// 1MB limit
				this.log("warn", `Buffer overflow attempt from ${clientId}`);
				this.sendError(socket, "Request too large");
				socket.destroy();
				return;
			}

			let newlineIndex;
			while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
				const message = buffer.substring(0, newlineIndex);
				buffer = buffer.substring(newlineIndex + 1);

				try {
					const request = JSON.parse(message);
					this.log("debug", `Request from ${clientId}`, request);

					this.router.handle(socket, request, session);
				} catch (err) {
					this.log(
						"error",
						`Invalid request from ${clientId}: ${err.message}`,
					);
					this.stats.errors++;
					this.sendError(
						socket,
						`Invalid request format: ${err.message}`,
					);
				}
			}
		});

		socket.on("end", () => {
			const duration = Date.now() - session.connectedAt;
			this.log(
				"info",
				`Client disconnected: ${clientId} (duration: ${duration}ms)`,
			);
			this.clients.delete(socket);
			this.stats.activeConnections--;
		});

		socket.on("error", (err) => {
			this.log("error", `Client error: ${clientId} - ${err.message}`);
			this.clients.delete(socket);
			this.stats.activeConnections--;
			this.stats.errors++;
		});

		socket.on("timeout", () => {
			this.log("warn", `Client timeout: ${clientId}`);
			socket.destroy();
		});

		socket.setTimeout(this.queryTimeout);

		this.sendResponse(socket, {
			type: "welcome",
			message: "SawitDB Server",
			version: "2.6.0",
			protocol: "sawitdb",
		});
	}

	sendResponse(socket, data) {
		try {
			if (socket.writable) {
				socket.write(JSON.stringify(data) + "\n");
			}
		} catch (err) {
			console.error("[Server] Failed to send response:", err.message);
		}
	}

	sendError(socket, message) {
		this.sendResponse(socket, { type: "error", error: message });
	}

	// Utiliy for Stats
	formatUptime(ms) {
		const seconds = Math.floor(ms / 1000);
		const minutes = Math.floor(seconds / 60);
		const hours = Math.floor(minutes / 60);
		const days = Math.floor(hours / 24);

		if (days > 0) return `${days}d ${hours % 24}h`;
		if (hours > 0) return `${hours}h ${minutes % 60}m`;
		if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
		return `${seconds}s`;
	}
}

// Allow running as standalone server
// XXX: do we really need this?
// if (require.main === module) {
// 	const ClusterManager = require("./modules/ClusterManager");
// 	ClusterManager.start(SawitServer);
// }
