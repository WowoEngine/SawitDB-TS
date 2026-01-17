export default class RequestRouter {
	constructor(server) {
		this.server = server;
		this.dbRegistry = server.dbRegistry;
		this.authManager = server.authManager;
	}

	handle(socket, request, session) {
		const { type, payload } = request;

		// Authentication check
		if (
			this.authManager.isEnabled() &&
			!session.authenticated &&
			type !== "auth"
		) {
			return this.server.sendError(socket, "Authentication required");
		}

		switch (type) {
			case "auth":
				this.authManager.handleAuth(socket, payload, session);
				break;

			case "use":
				this.handleUseDatabase(socket, payload, session);
				break;

			case "query":
				this.handleQuery(socket, payload, session);
				break;

			case "ping":
				this.server.sendResponse(socket, {
					type: "pong",
					timestamp: Date.now(),
				});
				break;

			case "list_databases":
				this.handleListDatabases(socket);
				break;

			case "drop_database":
				this.handleDropDatabase(socket, payload, session);
				break;

			case "stats":
				this.handleStats(socket);
				break;

			default:
				this.server.sendError(socket, `Unknown request type: ${type}`);
		}
	}

	handleUseDatabase(socket, payload, session) {
		const { database } = payload;

		if (!database || typeof database !== "string") {
			return this.server.sendError(socket, "Invalid database name");
		}

		// Validate database name (alphanumeric, underscore, dash)
		if (!/^[a-zA-Z0-9_-]+$/.test(database)) {
			return this.server.sendError(
				socket,
				"Database name can only contain letters, numbers, underscore, and dash",
			);
		}

		try {
			this.dbRegistry.getOrCreate(database);
			session.setDatabase(database);
			this.server.sendResponse(socket, {
				type: "use_success",
				database,
				message: `Switched to database '${database}'`,
			});
		} catch (err) {
			this.server.sendError(
				socket,
				`Failed to use database: ${err.message}`,
			);
		}
	}

	async handleQuery(socket, payload, session) {
		const { query, params } = payload;
		const startTime = Date.now();

		// --- Intercept Server-Level Commands (Wilayah Management) ---
		const qUpper = query.trim().toUpperCase();

		// 1. LIHAT WILAYAH
		if (qUpper === "LIHAT WILAYAH" || qUpper === "SHOW DATABASES") {
			try {
				const list = this.dbRegistry
					.list()
					.map((f) => `- ${f}`)
					.join("\n");
				const result = `Daftar Wilayah:\n${list}`;

				return this.server.sendResponse(socket, {
					type: "query_result",
					result,
					query,
					executionTime: Date.now() - startTime,
				});
			} catch (err) {
				return this.server.sendError(
					socket,
					`Gagal melihat wilayah: ${err.message}`,
				);
			}
		}

		// 2. BUKA WILAYAH / CREATE DATABASE
		if (
			qUpper.startsWith("BUKA WILAYAH") ||
			qUpper.startsWith("CREATE DATABASE")
		) {
			const parts = query.trim().split(/\s+/);
			// Index 2 is name (BUKA WILAYAH name OR CREATE DATABASE name)
			if (parts.length < 3) {
				return this.server.sendError(
					socket,
					"Syntax: BUKA WILAYAH [nama]",
				);
			}
			const dbName = parts[2];

			try {
				if (!/^[a-zA-Z0-9_-]+$/.test(dbName)) {
					return this.server.sendError(
						socket,
						"Nama wilayah hanya boleh huruf, angka, _ dan -",
					);
				}

				if (this.dbRegistry.exists(dbName)) {
					return this.server.sendResponse(socket, {
						type: "query_result",
						result: `Wilayah '${dbName}' sudah ada.`,
						query,
						executionTime: Date.now() - startTime,
					});
				}

				this.dbRegistry.create(dbName);
				return this.server.sendResponse(socket, {
					type: "query_result",
					result: `Wilayah '${dbName}' berhasil dibuka.`,
					query,
					executionTime: Date.now() - startTime,
				});
			} catch (err) {
				return this.server.sendError(
					socket,
					`Gagal membuka wilayah: ${err.message}`,
				);
			}
		}

		// 3. MASUK WILAYAH / USE
		if (qUpper.startsWith("MASUK WILAYAH") || qUpper.startsWith("USE ")) {
			const parts = query.trim().split(/\s+/);
			const dbName = parts[1] === "WILAYAH" ? parts[2] : parts[1]; // Handle MASUK WILAYAH vs USE

			if (!dbName)
				return this.server.sendError(
					socket,
					"Syntax: MASUK WILAYAH [nama]",
				);

			if (!this.dbRegistry.exists(dbName)) {
				return this.server.sendError(
					socket,
					`Wilayah '${dbName}' tidak ditemukan.`,
				);
			}

			session.setDatabase(dbName);
			return this.server.sendResponse(socket, {
				type: "query_result",
				result: `Selamat datang di wilayah '${dbName}'.`,
				query,
				executionTime: Date.now() - startTime,
			});
		}

		// 4. BAKAR WILAYAH / DROP DATABASE
		if (
			qUpper.startsWith("BAKAR WILAYAH") ||
			qUpper.startsWith("DROP DATABASE")
		) {
			const parts = query.trim().split(/\s+/);
			const dbName =
				parts[1] === "WILAYAH" ? parts[2] : parts[parts.length - 1]; // BAKAR WILAYAH name vs DROP DATABASE name
			// Simple split logic might fail on extra spaces, but good enough for now.
			// Strict parsing:
			const nameIndex = qUpper.startsWith("BAKAR") ? 2 : 2;
			const targetName = parts[nameIndex];

			if (!targetName)
				return this.server.sendError(
					socket,
					"Syntax: BAKAR WILAYAH [nama]",
				);

			try {
				this.dbRegistry.drop(targetName);
				if (session.currentDatabase === targetName) {
					session.setDatabase(null);
				}
				return this.server.sendResponse(socket, {
					type: "query_result",
					result: `Wilayah '${targetName}' telah hangus terbakar.`,
					query,
					executionTime: Date.now() - startTime,
				});
			} catch (err) {
				return this.server.sendError(
					socket,
					`Gagal membakar wilayah: ${err.message}`,
				);
			}
		}

		// --- End Intercept ---

		if (!session.currentDatabase) {
			return this.server.sendError(
				socket,
				"Anda belum masuk wilayah manapun. Gunakan: MASUK WILAYAH [nama]",
			);
		}

		try {
			let result;
			if (this.server.threadPool) {
				// Offload to Worker Thread (assuming ThreadPool interface matches)
				const dbPath = this.dbRegistry.get(session.currentDatabase)
					.pager.filePath; // Hack to get path or use Registry
				// But Registry creates path.
				// Let's rely on Registry.get(name) returning db instance.
				// But ThreadPool needs path.
				const fullPath = require("path").join(
					this.dbRegistry.dataDir,
					`${session.currentDatabase}.sawit`,
				);
				result = await this.server.threadPool.execute(
					fullPath,
					query,
					this.server.dbRegistry.walConfig,
				);
			} else {
				// Local Execution
				const db = this.dbRegistry.get(session.currentDatabase);
				result = await Promise.resolve(db.query(query, params));
			}

			const duration = Date.now() - startTime;
			this.server.stats.totalQueries++;
			this.server.log("debug", `Query: ${query}`, { duration });

			this.server.sendResponse(socket, {
				type: "query_result",
				result,
				query,
				executionTime: duration,
			});
		} catch (err) {
			this.server.log("error", `Query failed: ${err.message}`);
			this.server.stats.errors++;
			this.server.sendError(socket, `Query error: ${err.message}`);
		}
	}

	handleListDatabases(socket) {
		try {
			const databases = this.dbRegistry.list();
			this.server.sendResponse(socket, {
				type: "database_list",
				databases,
				count: databases.length,
			});
		} catch (err) {
			this.server.sendError(
				socket,
				`Failed to list databases: ${err.message}`,
			);
		}
	}

	handleDropDatabase(socket, payload, session) {
		const { database } = payload;
		if (!database)
			return this.server.sendError(socket, "Database name required");

		try {
			this.dbRegistry.drop(database);
			if (session.currentDatabase === database) {
				session.setDatabase(null);
			}
			this.server.sendResponse(socket, {
				type: "drop_success",
				database,
				message: `Database '${database}' has been burned (dropped)`,
			});
		} catch (err) {
			this.server.sendError(
				socket,
				`Failed to drop database: ${err.message}`,
			);
		}
	}

	handleStats(socket) {
		const uptime = Date.now() - this.server.stats.startTime;
		const stats = {
			...this.server.stats,
			uptime,
			uptimeFormatted: this.server.formatUptime(uptime),
			databases: this.dbRegistry.databases.size,
			memoryUsage: process.memoryUsage(),
			workers: this.server.threadPool
				? this.server.threadPool.getStats()
				: null,
		};

		this.server.sendResponse(socket, {
			type: "stats",
			stats,
		});
	}
}
