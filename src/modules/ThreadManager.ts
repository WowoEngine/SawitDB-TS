const {
	Worker,
	isMainThread,
	parentPort,
	workerData,
} = require("worker_threads");
const net = require("net");
const os = require("os");
const path = require("path");

class ThreadManager {
	static start(serverScriptPath) {
		if (isMainThread) {
			this._startMain(serverScriptPath);
		} else {
			// This method is called inside the worker thread
			// But actually, the worker thread executes the file passed to 'new Worker()'
			// So this logic might sit better inside SawitServer.js or a small bootstrap wrapper.
			// For simplicity, we assume SawitServer.js calls this module.
			// If we are in a worker, we do nothing here, the SawitServer logic takes over via 'parentPort'.
		}
	}

	static _startMain(serverScriptPath) {
		// Configuration
		const port = parseInt(process.env.SAWIT_PORT || 7878);
		const host = process.env.SAWIT_HOST || "0.0.0.0";
		const numWorkers =
			parseInt(process.env.SAWIT_CLUSTER_WORKERS || "0", 10) ||
			os.cpus().length;

		console.log(`╔══════════════════════════════════════════════════╗`);
		console.log(`║   ⚡ SawitDB Multi-Threaded Server - v2.6.0      ║`);
		console.log(`╚══════════════════════════════════════════════════╝`);
		console.log(`[Main] PID: ${process.pid}`);
		console.log(`[Main] Spawning ${numWorkers} worker threads...`);

		const workers = [];
		let curWorker = 0;

		// Spawn Workers
		for (let i = 0; i < numWorkers; i++) {
			const worker = new Worker(serverScriptPath, {
				env: {
					...process.env,
					SAWIT_IS_THREAD_WORKER: "true",
					SAWIT_WORKER_ID: i + 1,
				},
			});

			worker.on("message", (msg) => {
				if (msg === "ready") {
					// Worker ready
				}
			});

			worker.on("exit", (code) => {
				if (code !== 0)
					console.error(
						`[Main] Worker ${i + 1} stopped with exit code ${code}`,
					);
			});

			workers.push(worker);
		}

		// Create Load Balancer Server
		const server = net.createServer({ pauseOnConnect: true }, (socket) => {
			// Round Robin Dispatch
			const worker = workers[curWorker];
			curWorker = (curWorker + 1) % workers.length;

			// Pass the socket to the worker
			worker.postMessage({ type: "new_connection" }, [socket]);
		});

		server.listen(port, host, () => {
			console.log(
				`[Main] Ready to accept connections on ${host}:${port}`,
			);
			console.log(`[Main] Dispatching to ${workers.length} threads.`);
		});

		// Shutdown Logic
		const shutdown = () => {
			console.log("\n[Main] Shutting down...");
			server.close();
			for (const w of workers) w.terminate();
			process.exit(0);
		};
		process.on("SIGINT", shutdown);
		process.on("SIGTERM", shutdown);
	}
}

module.exports = ThreadManager;
