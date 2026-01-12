const SawitDB = require("../src/WowoEngine");
const SawitClient = require("../src/SawitClient");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

// Configuration
const args = process.argv.slice(2);
const IS_SPAWN = args.includes("--spawn");
const IS_REMOTE = args.includes("--remote") || IS_SPAWN; // Spawn implies remote access
const IS_CLUSTER = args.includes("--cluster");

// Parsing Arguments
const getArg = (name, def) => {
	const found = args.find((a) => a.startsWith(name + "="));
	return found ? parseInt(found.split("=")[1]) : def;
};

const WORKER_COUNT = getArg("--workers", 1); // Server Workers
const CLIENT_COUNT = getArg("--clients", 1); // Benchmark Clients (Concurrency)

// Connection Settings
const REMOTE_HOST = process.env.SAWIT_HOST || "127.0.0.1";
const REMOTE_PORT = IS_SPAWN ? 7979 : process.env.SAWIT_PORT || 7878; // Use custom port if spawning to avoid conflict

// Local/Temp Paths
const DB_PATH = "./data/accurate_benchmark.sawit";
const SPAWN_DATA_DIR = path.join(__dirname, "../data_bench_temp");

console.log("=".repeat(80));
console.log(
	`BENCHMARK - ${IS_SPAWN ? "AUTO-SPAWNED SERVER" : IS_REMOTE ? "REMOTE MODE" : "LOCAL EMBEDDED MODE"}`,
);
if (IS_SPAWN)
	console.log(
		`Server Mode: ${IS_CLUSTER ? "CLUSTER" : "SINGLE THREAD"} (Workers: ${WORKER_COUNT})`,
	);
console.log(`Load: ${CLIENT_COUNT} concurrent client(s)`);
console.log("=".repeat(80));

const TARGET_TPS = 3000;
const N = 10000;

let serverProcess = null;

async function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function startServer() {
	console.log("[Setup] Spawning temporary server...");

	// Cleanup temp dir
	if (fs.existsSync(SPAWN_DATA_DIR)) {
		fs.rmSync(SPAWN_DATA_DIR, { recursive: true, force: true });
	}
	fs.mkdirSync(SPAWN_DATA_DIR, { recursive: true });

	const serverPath = path.join(__dirname, "../src/SawitServer.js");

	return new Promise((resolve, reject) => {
		serverProcess = spawn("node", [serverPath], {
			env: {
				...process.env,
				SAWIT_PORT: REMOTE_PORT,
				SAWIT_HOST: REMOTE_HOST,
				SAWIT_CLUSTER_MODE: IS_CLUSTER.toString(),
				SAWIT_CLUSTER_WORKERS: WORKER_COUNT.toString(),
				SAWIT_DATA_DIR: SPAWN_DATA_DIR,
				SAWIT_LOG_LEVEL: "info",
			},
			stdio: ["ignore", "pipe", "inherit"], // pipe stdout to check readiness
		});

		let ready = false;
		serverProcess.stdout.on("data", (data) => {
			const out = data.toString();
			// console.log('[SERVER]', out.trim()); // Debug
			if (out.includes("Ready to accept connections")) {
				if (!ready) {
					ready = true;
					console.log("[Setup] Server Ready!");
					resolve();
				}
			}
		});

		serverProcess.on("error", (err) => reject(err));

		// Timeout safety
		setTimeout(() => {
			if (!ready) {
				console.error("[Setup] Server timed out starting.");
				if (serverProcess) serverProcess.kill();
				reject(new Error("Server startup timeout"));
			}
		}, 10000);
	});
}

async function main() {
	let db;
	let clients = [];

	// --- SETUP ---
	if (IS_SPAWN) {
		await startServer();
		// Give it a tiny bit more grace period for workers to settle
		await sleep(1000);
	}

	console.log("Setting up...");

	if (IS_REMOTE) {
		// Init remote clients
		for (let i = 0; i < CLIENT_COUNT; i++) {
			const client = new SawitClient(
				`sawitdb://${REMOTE_HOST}:${REMOTE_PORT}/benchmark_db`,
			);
			await client.connect();
			// Use same DB for standard benchmark
			try {
				await client.query(`BUKA WILAYAH benchmark_db`);
			} catch (e) {} // Exists
			await client.use("benchmark_db");
			clients.push(client);
		}
		db = clients[0]; // Primary for setup
	} else {
		// Local Setup
		if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
		if (fs.existsSync(DB_PATH + ".wal")) fs.unlinkSync(DB_PATH + ".wal");

		db = new SawitDB(DB_PATH, {
			wal: {
				enabled: process.env.WAL !== "false",
				syncMode: process.env.WAL_MODE || "normal",
				checkpointInterval: 10000,
			},
		});
	}

	// Cleanup & Init
	try {
		if (IS_REMOTE) await query(db, "DROP TABLE products");
	} catch (e) {}

	await query(db, "CREATE TABLE products");

	console.log("Populating initial data...");
	for (let i = 0; i < N; i++) {
		const price = Math.floor(Math.random() * 1000) + 1;
		await query(
			db,
			`INSERT INTO products (id, price) VALUES (${i}, ${price})`,
		);
	}
	await query(db, "CREATE INDEX ON products (id)");
	console.log("✓ Setup complete\n");

	// --- PREPARE DATA ---
	const selectQueries = [];
	const updateQueries = [];
	for (let i = 0; i < 1000; i++) {
		const id = Math.floor(Math.random() * N);
		selectQueries.push(`SELECT * FROM products WHERE id = ${id}`);
		updateQueries.push(
			`UPDATE products SET price = ${Math.floor(Math.random() * 1000)} WHERE id = ${id}`,
		);
	}

	const insertQueries = [];
	for (let i = 0; i < 1000; i++) {
		insertQueries.push(
			`INSERT INTO products (id, price) VALUES (${N + i}, 999)`,
		);
	}

	const deleteQueries = [];
	for (let i = 0; i < 500; i++) {
		deleteQueries.push(`DELETE FROM products WHERE id = ${N + i}`);
	}

	// --- RUN BENCHMARKS ---
	const results = [];

	// Helper to distribute work
	async function runParallel(name, queryList, targetTps) {
		// Warmup
		await query(db, queryList[0]);

		const start = Date.now();
		const totalOps = queryList.length;

		// Chunk queries for workers
		const chunkSize = Math.ceil(totalOps / (IS_REMOTE ? CLIENT_COUNT : 1));
		const promises = [];

		if (IS_REMOTE) {
			for (let i = 0; i < CLIENT_COUNT; i++) {
				const client = clients[i];
				const startIdx = i * chunkSize;
				const endIdx = Math.min(startIdx + chunkSize, totalOps);
				const workerQueries = queryList.slice(startIdx, endIdx);

				if (workerQueries.length === 0) continue;

				promises.push(
					(async () => {
						for (const q of workerQueries) await client.query(q);
					})(),
				);
			}
		} else {
			promises.push(
				(async () => {
					for (const q of queryList) await query(db, q);
				})(),
			);
		}

		await Promise.all(promises);

		const time = Date.now() - start;
		const tps = Math.round(totalOps / (time / 1000));
		const avg = (time / totalOps).toFixed(3);
		const status = tps >= targetTps ? "✅ PASS" : "❌ FAIL";
		const pct = Math.round((tps / targetTps) * 100);

		return { name, tps, avg, target: targetTps, status, pct };
	}

	results.push(await runParallel("INSERT", insertQueries, TARGET_TPS));

	// Cleanup inserts for delete test consistency?
	// Actually we keep them for SELECT/UPDATE test?
	// Benchmark sequence: INSERT -> SELECT -> UPDATE -> DELETE

	results.push(
		await runParallel("SELECT (indexed)", selectQueries, TARGET_TPS),
	);
	results.push(
		await runParallel("UPDATE (indexed)", updateQueries, TARGET_TPS),
	);

	// Prepare data for delete (need to ensure rows exist)
	// We inserted 1000 new rows in INSERT test (id N to N+999).
	// DELETE test removes 500 of them.
	results.push(
		await runParallel("DELETE (indexed)", deleteQueries, TARGET_TPS),
	);

	// --- REPORT ---
	console.log("=".repeat(100));
	console.log("RESULTS");
	console.log("=".repeat(100));
	console.log(
		"┌────────────────────────────┬──────────┬──────────┬────────┬─────────┬────────┐",
	);
	console.log(
		"│ Operation                  │   TPS    │ Avg (ms) │ Target │   %     │ Status │",
	);
	console.log(
		"├────────────────────────────┼──────────┼──────────┼────────┼─────────┼────────┤",
	);

	let passCount = 0;
	for (const r of results) {
		const name = r.name.padEnd(26);
		const tps = r.tps.toString().padStart(8);
		const avg = r.avg.padStart(8);
		const target = r.target.toString().padStart(6);
		const pct = (r.pct + "%").padStart(7);
		const status = r.status.padEnd(6);
		if (r.status.includes("PASS")) passCount++;
		console.log(
			`│ ${name} │ ${tps} │ ${avg} │ ${target} │ ${pct} │ ${status} │`,
		);
	}
	console.log(
		"└────────────────────────────┴──────────┴──────────┴────────┴─────────┴────────┘",
	);

	// TEARDOWN
	if (IS_REMOTE) {
		// Fetch Worker Stats
		try {
			const adminClient = clients[0];
			const stats = await adminClient.stats();

			if (stats && stats.workers) {
				console.log("\nWORKER STATS (Load Balance Check)");
				console.log("=".repeat(50));
				console.log("┌───────────┬────────────────────┬──────────┐");
				console.log("│ Worker ID │ Queries Processed  │ Active   │");
				console.log("├───────────┼────────────────────┼──────────┤");

				let total = 0;
				for (const w of stats.workers) {
					const id = w.id.toString().padEnd(9);
					const count = w.queries.toString().padEnd(18);
					const active = (w.active || 0).toString().padEnd(8);
					console.log(`│ ${id} │ ${count} │ ${active} │`);
					total += w.queries;
				}
				console.log("├───────────┼────────────────────┼──────────┤");
				console.log(
					`│ TOTAL     │ ${total.toString().padEnd(18)} │ -        │`,
				);
				console.log("└───────────┴────────────────────┴──────────┘\n");
			}
		} catch (e) {
			console.log("Failed to fetch worker stats:", e.message);
		}

		for (const c of clients) {
			// Silence errors during teardown (prevents ECONNRESET logs when server is killed)
			if (c.socket) {
				c.socket.removeAllListeners("error");
				c.socket.on("error", () => {}); // Catch-all for teardown errors
			}
			c.disconnect();
		}
	} else {
		db.close();
		if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
	}

	if (serverProcess) {
		console.log("Stopping server...");
		serverProcess.kill();
		await sleep(500);
		// Cleanup temp dir
		try {
			if (fs.existsSync(SPAWN_DATA_DIR))
				fs.rmSync(SPAWN_DATA_DIR, { recursive: true, force: true });
		} catch (e) {}
	}
}

// Wrapper for async/sync agnostic call
async function query(dbInst, q) {
	if (dbInst.query.constructor.name === "AsyncFunction") {
		return await dbInst.query(q);
	} else {
		// Check if remote client (SawitClient has async query)
		if (IS_REMOTE) return await dbInst.query(q);
		return dbInst.query(q);
	}
}

main().catch((err) => {
	console.error(err);
	if (serverProcess) serverProcess.kill();
	process.exit(1);
});
