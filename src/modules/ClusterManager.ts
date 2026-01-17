import cluster from "node:cluster";
import os from "node:os"
import path from "node:path";

export default class ClusterManager {
	static start(ServerClass) {
		// Parse configuration
		const port = process.env.SAWIT_PORT || 7878;
		const host = process.env.SAWIT_HOST || "0.0.0.0";
		const dataDir =
			process.env.SAWIT_DATA_DIR || path.join(__dirname, "../../data");

		// Cluster Configuration
		const clusterMode = process.env.SAWIT_CLUSTER_MODE === "true";
		const workerCount =
			parseInt(process.env.SAWIT_CLUSTER_WORKERS || "0", 10) ||
			os.cpus().length;

		if (clusterMode && cluster.isPrimary) {
			this._startMaster(workerCount);
		} else {
			this._startWorker(ServerClass, port, host, dataDir);
		}
	}

	static _startMaster(workerCount) {
		console.log(`╔══════════════════════════════════════════════════╗`);
		console.log(`║      🌴 SawitDB Cluster Master - v2.6.0          ║`);
		console.log(`╚══════════════════════════════════════════════════╝`);
		console.log(`[Master] PID: ${process.pid}`);
		console.log(`[Master] Spawning ${workerCount} workers...`);

		// Fork workers
		for (let i = 0; i < workerCount; i++) {
			cluster.fork();
		}

		cluster.on("exit", (worker, code, signal) => {
			console.log(
				`[Master] Worker ${worker.process.pid} died. Restarting...`,
			);
			cluster.fork();
		});

		// Master shutdown logic
		const shutdown = () => {
			console.log("\n[Master] shutting down...");
			for (const id in cluster.workers) {
				cluster.workers[id].kill();
			}
			process.exit(0);
		};
		process.on("SIGINT", shutdown);
		process.on("SIGTERM", shutdown);
	}

	static _startWorker(ServerClass, port, host, dataDir) {
		// Worker Process (or Single Thread Mode)
		const server = new ServerClass({
			port,
			host,
			dataDir,
			// Pass worker info for internal logging if needed
			isWorker: cluster.isWorker,
			workerId: cluster.isWorker ? cluster.worker.id : null,
		});

		server.start();

		// Graceful shutdown
		const shutdown = () => {
			const prefix = cluster.isWorker
				? `[Worker ${cluster.worker.id}]`
				: "[Server]";
			console.log(
				`\n${prefix} Received Signal, shutting down gracefully...`,
			);
			server.stop();
			process.exit(0);
		};

		process.on("SIGINT", shutdown);
		process.on("SIGTERM", shutdown);
	}
}
