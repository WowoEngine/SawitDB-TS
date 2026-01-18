import { Worker } from "node:worker_threads";
import os from "node:os";
import path from "node:path";

export default class ThreadPool {
	constructor(workerCount = 0) {
		this.workerCount = workerCount || os.cpus().length;
		this.workers = new Array(this.workerCount);
		this.workerScript = path.join(__dirname, "../SawitWorker.js");

		// State
		this.isReady = false;
		this.pendingRequests = new Map(); // id -> { resolve, reject, timeout, workerIndex }
		this.requestIdCounter = 0;

		// Stats & Load Balancing
		this.workerStats = new Array(this.workerCount).fill(0); // Total processed
		this.activeTasks = new Array(this.workerCount).fill(0); // Current load
	}

	start() {
		console.log(
			`[ThreadPool] Spawning ${this.workerCount} worker threads...`,
		);
		for (let i = 0; i < this.workerCount; i++) {
			this._spawnWorker(i);
		}
		this.isReady = true;
	}

	_spawnWorker(index) {
		const worker = new Worker(this.workerScript, {
			workerData: { workerId: index + 1 },
		});

		worker.on("message", (msg) => this._handleMessage(msg));
		worker.on("error", (err) =>
			console.error(`[ThreadPool] Worker ${index + 1} error:`, err),
		);
		worker.on("exit", (code) => {
			if (code !== 0) {
				console.error(
					`[ThreadPool] Worker ${index + 1} crashed (code ${code}). Restarting...`,
				);
				this._cleanupTasks(index); // Reject pending tasks for this dead worker
				this.activeTasks[index] = 0;
				this._spawnWorker(index);
			}
		});

		this.workers[index] = worker;
	}

	_cleanupTasks(workerIndex) {
		for (const [id, req] of this.pendingRequests.entries()) {
			if (req.workerIndex === workerIndex) {
				clearTimeout(req.timeout);
				this.pendingRequests.delete(id);
				// Decrement global load? worker activeTasks is reset anyway.
				req.reject(new Error(`Worker ${workerIndex + 1} crashed`));
			}
		}
	}

	_getBestWorker() {
		// Least Busy Strategy
		let minLoad = Infinity;
		let bestIndex = 0;

		for (let i = 0; i < this.workerCount; i++) {
			// Check if worker exists (might be restarting)
			if (this.workers[i]) {
				const load = this.activeTasks[i];
				if (load < minLoad) {
					minLoad = load;
					bestIndex = i;
				}
			}
		}
		return bestIndex;
	}

	async execute(dbPath, sql, config = {}) {
		if (!this.isReady) throw new Error("ThreadPool not started");

		const workerIndex = this._getBestWorker();
		const worker = this.workers[workerIndex];

		// Safety check if worker is restarting
		if (!worker) throw new Error("Worker unavailable (restarting)");

		// Update Stats & Load
		this.workerStats[workerIndex]++;
		this.activeTasks[workerIndex]++;

		const id = ++this.requestIdCounter;

		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				if (this.pendingRequests.has(id)) {
					this.pendingRequests.delete(id);
					// Decrement load on timeout?
					// Arguably yes, effectively "stopped waiting".
					// But worker might still be crunching.
					// Let's assume leakage is acceptable for now or handle cleanup strictly.
					// Ideally we should keep count high until worker dies or returns, handling "zombie" tasks is hard.
					// Simply decrementing here might lead to overloading a stuck worker.
					// Better to NOT decrement activeTasks on timeout (assume it's still busy).
					reject(
						new Error("Query execution timed out in thread pool"),
					);
				}
			}, 30000);

			this.pendingRequests.set(id, {
				resolve,
				reject,
				timeout,
				workerIndex,
			});

			worker.postMessage({
				id,
				action: "query",
				dbPath,
				sql,
				config,
			});
		});
	}

	_handleMessage(msg) {
		// msg: { id, status, data, error }
		const req = this.pendingRequests.get(msg.id);
		if (!req) return; // Timed out or unknown

		clearTimeout(req.timeout);
		this.pendingRequests.delete(msg.id);

		// LB: Task finished, decrement load
		if (this.activeTasks[req.workerIndex] > 0) {
			this.activeTasks[req.workerIndex]--;
		}

		if (msg.status === "ok") {
			req.resolve(msg.data);
		} else {
			req.reject(new Error(msg.error));
		}
	}

	shutdown() {
		console.log("[ThreadPool] Terminating workers...");
		this.workers.forEach((w) => w && w.terminate());
		this.workers = [];
	}

	getStats() {
		return this.workerStats.map((count, index) => ({
			id: index + 1,
			queries: count,
			active: this.activeTasks[index],
		}));
	}
}
