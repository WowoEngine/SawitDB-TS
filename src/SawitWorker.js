const { parentPort, workerData, threadId } = require("worker_threads");
const SawitDB = require("./WowoEngine");

// Cache of DB instances: { [absolutePath]: SawitDB }
// NOTE: Since threads map to "Database Engines", they must be careful about FILE LOCKING.
// If multiple threads open the SAME file, we have the same corruption risk as processes.
// But this is the requested architecture.
const dbCache = new Map();

parentPort.on("message", async (task) => {
	// task: { id: number, action: 'query', dbPath: string, sql: string, config: object }
	// config can contain WAL settings etc for first open.

	if (task.action === "query") {
		try {
			let db = dbCache.get(task.dbPath);
			if (!db) {
				// Initialize DB if not open in this thread
				const options = task.config || {};
				db = new SawitDB(task.dbPath, options);
				dbCache.set(task.dbPath, db);
				// console.log(`[Thread ${threadId}] Opened DB: ${task.dbPath}`);
			}

			// Execute Query
			// Ensure we handle async queries (SawitDB v2.5+)
			let result;
			if (db.query.constructor.name === "AsyncFunction") {
				result = await db.query(task.sql);
			} else {
				result = db.query(task.sql);
			}

			// Send Success
			parentPort.postMessage({ id: task.id, status: "ok", data: result });
		} catch (err) {
			// Send Error
			parentPort.postMessage({
				id: task.id,
				status: "error",
				error: err.message,
				stack: err.stack,
			});
		}
	} else if (task.action === "close") {
		// Close specific DB or all?
		// Let's support clearing cache
		dbCache.forEach((db) => {
			try {
				db.close();
			} catch (e) {}
		});
		dbCache.clear();
		parentPort.postMessage({ id: task.id, status: "ok" });
	}
});
