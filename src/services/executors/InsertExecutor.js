const termObj = require("../QueryExecutor");
const QueryExecutor = require("../QueryExecutor");
const Pager = require("../../modules/Pager"); // Adjust path to modules/Pager

class InsertExecutor extends QueryExecutor {
	constructor(db) {
		super(db);
	}

	execute(cmd) {
		// cmd = { table, data }
		// data can be single object or array if we support bulk insert command
		// Standard SQL INSERT usually single or VALUES list.
		// SawitDB cmd.data seems to be single object usually, but let's check parse.
		// Assuming cmd.data is what we need to insert.

		const { table, data } = cmd;
		if (!data || Object.keys(data).length === 0) {
			throw new Error(
				"Data kosong / fiktif? Ini melanggar integritas (Korupsi Data).",
			);
		}

		// Wrap in array for insertMany logic
		const dataArray = Array.isArray(data) ? data : [data];
		return this.insertMany(table, dataArray);
	}

	insertMany(table, dataArray) {
		if (!dataArray || dataArray.length === 0)
			return "Tidak ada bibit untuk ditanam.";

		const entry = this.db.tableManager
			? this.db.tableManager.findTableEntry(table)
			: this.db._findTableEntry(table);

		if (!entry) throw new Error(`Kebun '${table}' tidak ditemukan.`);

		let currentPageId = entry.lastPage;
		let pData = this.db.pager.readPage(currentPageId);
		let freeOffset = pData.readUInt16LE(6);
		let count = pData.readUInt16LE(4);
		let startPageChanged = false;

		for (const data of dataArray) {
			const dataStr = JSON.stringify(data);
			const dataBuf = Buffer.from(dataStr, "utf8");
			const recordLen = dataBuf.length;
			const totalLen = 2 + recordLen;

			// Check if fits
			if (freeOffset + totalLen > Pager.PAGE_SIZE) {
				// Write current full page
				pData.writeUInt16LE(count, 4);
				pData.writeUInt16LE(freeOffset, 6);
				this.db.pager.writePage(currentPageId, pData);

				const newPageId = this.db.pager.allocPage();

				// Link old page to new
				pData.writeUInt32LE(newPageId, 0);
				this.db.pager.writePage(currentPageId, pData); // Rewrite link

				currentPageId = newPageId;
				pData = this.db.pager.readPage(currentPageId);
				freeOffset = pData.readUInt16LE(6);
				count = pData.readUInt16LE(4);
				startPageChanged = true;
			}

			pData.writeUInt16LE(recordLen, freeOffset);
			dataBuf.copy(pData, freeOffset + 2);
			freeOffset += totalLen;
			count++;

			// Inject Page Hint for Index
			Object.defineProperty(data, "_pageId", {
				value: currentPageId,
				enumerable: false,
				writable: true,
			});

			// Index update
			if (table !== "_indexes") {
				if (this.db.indexManager) {
					this.db.indexManager.updateIndexes(table, data, null);
				} else {
					// Fallback if indexManager not ready yet (e.g. during refactor transition)
					this.db._updateIndexes(table, data, null);
				}
			}
		}

		// Final write
		pData.writeUInt16LE(count, 4);
		pData.writeUInt16LE(freeOffset, 6);
		this.db.pager.writePage(currentPageId, pData);

		if (startPageChanged) {
			if (this.db.tableManager) {
				this.db.tableManager.updateTableLastPage(table, currentPageId);
			} else {
				this.db._updateTableLastPage(table, currentPageId);
			}
		}

		if (this.db.dbevent && this.db.dbevent.OnTableInserted) {
			this.db.dbevent.OnTableInserted(
				table,
				dataArray,
				this.db.queryString,
			);
		}

		return `${dataArray.length} bibit tertanam.`;
	}
}

module.exports = InsertExecutor;
