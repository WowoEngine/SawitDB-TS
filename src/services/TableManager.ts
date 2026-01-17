import Pager from "../modules/Pager.ts";

export default class TableManager {
	constructor(db) {
		this.db = db;
		this.pager = db.pager;
	}

	findTableEntry(name) {
		const p0 = this.pager.readPage(0);
		const numTables = p0.readUInt32LE(8);
		let offset = 12;

		for (let i = 0; i < numTables; i++) {
			const tName = p0
				.toString("utf8", offset, offset + 32)
				.replace(/\0/g, "");
			if (tName === name) {
				return {
					index: i,
					offset: offset,
					startPage: p0.readUInt32LE(offset + 32),
					lastPage: p0.readUInt32LE(offset + 36),
				};
			}
			offset += 40;
		}
		return null;
	}

	showTables() {
		const p0 = this.pager.readPage(0);
		const numTables = p0.readUInt32LE(8);
		const tables = [];
		let offset = 12;
		for (let i = 0; i < numTables; i++) {
			const tName = p0
				.toString("utf8", offset, offset + 32)
				.replace(/\0/g, "");
			if (!tName.startsWith("_")) {
				// Hide system tables
				tables.push(tName);
			}
			offset += 40;
		}
		return tables;
	}

	validateName(name, type = "table", allowSystem = false) {
		if (!name || typeof name !== "string") {
			throw new Error(`${type} name tidak boleh kosong`);
		}
		if (name.length > 32) {
			throw new Error(`${type} name max 32 karakter`);
		}
		// Only allow alphanumeric, underscore, and starting with letter or underscore
		if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
			throw new Error(
				`${type} name hanya boleh huruf, angka, underscore, dan harus dimulai dengan huruf atau underscore`,
			);
		}
		// Disallow reserved names for user tables (allow for internal system use)
		if (!allowSystem && type === "table") {
			const reserved = [
				"_indexes",
				"_system",
				"_schema",
				"null",
				"true",
				"false",
			];
			if (reserved.includes(name.toLowerCase())) {
				throw new Error(
					`${type} name '${name}' adalah nama terproteksi`,
				);
			}
		}
		return true;
	}

	createTable(name, isSystemTable = false) {
		this.validateName(name, "table", isSystemTable);
		if (this.findTableEntry(name)) return `Kebun '${name}' sudah ada.`;

		const p0 = this.pager.readPage(0);
		const numTables = p0.readUInt32LE(8);
		let offset = 12 + numTables * 40;
		if (offset + 40 > Pager.PAGE_SIZE)
			throw new Error("Lahan penuh (Page 0 full)");

		const newPageId = this.pager.allocPage();

		const nameBuf = Buffer.alloc(32);
		nameBuf.write(name);
		nameBuf.copy(p0, offset);

		p0.writeUInt32LE(newPageId, offset + 32);
		p0.writeUInt32LE(newPageId, offset + 36);
		p0.writeUInt32LE(numTables + 1, 8);

		this.pager.writePage(0, p0);

		// Notify event handler
		if (this.db.dbevent && this.db.dbevent.OnTableCreated) {
			this.db.dbevent.OnTableCreated(
				name,
				this.findTableEntry(name),
				this.db.queryString,
			);
		}

		return `Kebun '${name}' telah dibuka.`;
	}

	dropTable(name) {
		if (name === "_indexes") return "Tidak boleh membakar catatan sistem.";

		const entry = this.findTableEntry(name);
		if (!entry) return `Kebun '${name}' tidak ditemukan.`;

		// Remove associated indexes
		const toRemove = [];
		for (const key of this.db.indexes.keys()) {
			if (key.startsWith(name + ".")) {
				toRemove.push(key);
			}
		}

		// Remove from memory
		toRemove.forEach((key) => this.db.indexes.delete(key));

		// Remove from _indexes table
		try {
			// Using internal call to avoid circular overhead if possible,
			// but relying on db._delete is safest for now to maintain behavior
			if (this.db._delete) {
				this.db._delete("_indexes", {
					type: "compound",
					logic: "AND",
					conditions: [{ key: "table", op: "=", val: name }],
				});
			}
		} catch (e) {
			/* Ignore if fails */
		}

		const p0 = this.pager.readPage(0);
		const numTables = p0.readUInt32LE(8);

		// Move last entry to this spot to fill gap
		if (numTables > 1 && entry.index < numTables - 1) {
			const lastOffset = 12 + (numTables - 1) * 40;
			const lastEntryBuf = p0.slice(lastOffset, lastOffset + 40);
			lastEntryBuf.copy(p0, entry.offset);
		}

		// Clear last spot
		const lastOffset = 12 + (numTables - 1) * 40;
		p0.fill(0, lastOffset, lastOffset + 40);

		p0.writeUInt32LE(numTables - 1, 8);
		this.pager.writePage(0, p0);

		if (this.db.dbevent && this.db.dbevent.OnTableDropped) {
			this.db.dbevent.OnTableDropped(name, entry, this.db.queryString);
		}

		return `Kebun '${name}' telah dibakar (Drop).`;
	}

	updateTableLastPage(name, newLastPageId) {
		const entry = this.findTableEntry(name);
		if (!entry) throw new Error("Internal Error: Table missing for update");

		// Update Disk/Page 0
		const p0 = this.pager.readPage(0);
		p0.writeUInt32LE(newLastPageId, entry.offset + 36);
		this.pager.writePage(0, p0);
	}
}
