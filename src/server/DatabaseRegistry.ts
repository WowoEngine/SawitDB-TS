import fs from "node:fs"
import path from "node:path"
import SawitDB from "../WowoEngine";

export default class DatabaseRegistry {
	constructor(dataDir, config) {
		this.dataDir = dataDir;
		this.config = config;
		this.databases = new Map(); // name -> SawitDB instance
		this.walConfig = config.wal || { enabled: false };

		// Ensure data directory exists
		if (!fs.existsSync(this.dataDir)) {
			fs.mkdirSync(this.dataDir, { recursive: true });
		}
	}

	validateName(name) {
		if (!name || typeof name !== "string") {
			throw new Error("Database name required");
		}
		// Prevent Path Traversal and illegal chars
		if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
			throw new Error(
				"Invalid database name. Only alphanumeric, hyphen, and underscore allowed.",
			);
		}
		if (name.includes("..") || name.includes("/") || name.includes("\\")) {
			throw new Error("Invalid database name (Path Traversal attempt).");
		}
		return true;
	}

	get(name) {
		this.validateName(name);
		return this.getOrCreate(name);
	}

	getOrCreate(name) {
		if (!this.databases.has(name)) {
			const dbPath = path.join(this.dataDir, `${name}.sawit`);
			const db = new SawitDB(dbPath, { wal: this.walConfig });
			this.databases.set(name, db);
		}
		return this.databases.get(name);
	}

	exists(name) {
		const dbPath = path.join(this.dataDir, `${name}.sawit`);
		return fs.existsSync(dbPath);
	}

	create(name) {
		this.validateName(name);
		return this.getOrCreate(name);
	}

	drop(name) {
		this.validateName(name);
		const dbPath = path.join(this.dataDir, `${name}.sawit`);
		if (!fs.existsSync(dbPath)) {
			throw new Error(`Database '${name}' does not exist`);
		}

		// Close if open
		if (this.databases.has(name)) {
			this.databases.get(name).close();
			this.databases.delete(name);
		}

		// Delete file
		fs.unlinkSync(dbPath);
	}

	list() {
		return fs
			.readdirSync(this.dataDir)
			.filter((file) => file.endsWith(".sawit"))
			.map((file) => file.replace(".sawit", ""));
	}

	closeAll() {
		for (const [name, db] of this.databases) {
			try {
				console.log(`[Server] Closing database: ${name}`);
				db.close();
			} catch (e) {
				console.error(
					`[Server] Error closing database ${name}:`,
					e.message,
				);
			}
		}
		this.databases.clear();
	}
}
