import QueryExecutor from "../QueryExecutor";
import ConditionEvaluator from "../logic/ConditionEvaluator";

export default class DeleteExecutor extends QueryExecutor {
	constructor(db) {
		super(db);
		this.conditionEvaluator = new ConditionEvaluator();
	}

	execute(cmd) {
		// cmd = { table, criteria }
		return this.delete(cmd.table, cmd.criteria);
	}

	delete(table, criteria, forceFullScan = false) {
		const entry = this.db.tableManager
			? this.db.tableManager.findTableEntry(table)
			: this.db._findTableEntry(table);

		if (!entry) throw new Error(`Kebun '${table}' tidak ditemukan.`);

		// OPTIMIZATION: Check Index Hint for simple equality delete
		let hintPageId = -1;
		if (!forceFullScan && criteria && criteria.op === "=" && criteria.key) {
			const indexKey = `${table}.${criteria.key}`;
			if (this.db.indexes.has(indexKey)) {
				const index = this.db.indexes.get(indexKey);
				const searchRes = index.search(criteria.val);
				if (
					searchRes.length > 0 &&
					searchRes[0]._pageId !== undefined
				) {
					hintPageId = searchRes[0]._pageId;
				}
			}
		}

		let currentPageId = hintPageId !== -1 ? hintPageId : entry.startPage;
		let deletedCount = 0;
		let deletedData = [];

		while (currentPageId !== 0) {
			let pData = this.db.pager.readPage(currentPageId);
			const count = pData.readUInt16LE(4);
			let offset = 8;
			const recordsToKeep = [];
			let pageModified = false;

			for (let i = 0; i < count; i++) {
				const len = pData.readUInt16LE(offset);
				const jsonStr = pData.toString(
					"utf8",
					offset + 2,
					offset + 2 + len,
				);
				let shouldDelete = false;
				let parsedObj = null;

				try {
					parsedObj = JSON.parse(jsonStr);
					// Use ConditionEvaluator
					if (this.conditionEvaluator.checkMatch(parsedObj, criteria))
						shouldDelete = true;
				} catch (e) {
					// Skip malformed JSON records
				}

				if (shouldDelete) {
					deletedCount++;
					// Remove from Index if needed
					if (table !== "_indexes" && parsedObj) {
						if (this.db.indexManager) {
							this.db.indexManager.removeFromIndexes(
								table,
								parsedObj,
							);
						} else {
							this.db._removeFromIndexes(table, parsedObj);
						}
					}
					deletedData.push(parsedObj);
					pageModified = true;
				} else {
					recordsToKeep.push({
						len,
						data: pData.slice(offset + 2, offset + 2 + len),
					});
				}
				offset += 2 + len;
			}

			if (pageModified) {
				let writeOffset = 8;
				pData.writeUInt16LE(recordsToKeep.length, 4);

				for (let rec of recordsToKeep) {
					pData.writeUInt16LE(rec.len, writeOffset);
					rec.data.copy(pData, writeOffset + 2);
					writeOffset += 2 + rec.len;
				}
				pData.writeUInt16LE(writeOffset, 6); // New free offset
				pData.fill(0, writeOffset); // Zero out rest

				this.db.pager.writePage(currentPageId, pData);
			}

			// Next page logic
			if (hintPageId !== -1) {
				break; // Optimized single page scan done
			}
			currentPageId = pData.readUInt32LE(0);
		}

		if (hintPageId !== -1 && deletedCount === 0) {
			// Hint failed (maybe race condition or stale index?), fallback to full scan
			return this.delete(table, criteria, true);
		}

		if (this.db.dbevent && this.db.dbevent.OnTableInserted) {
			// Assuming OnTableDeleted event? using Inserted signature implies it might vary or I should check implementation
			// WowoEngine.js used OnTableInserted for delete too?
			// Line 955 in WowoEngine.js: this.dbevent.OnTableInserted(table, deletedData, this.queryString);
			// Wait, it says Inserted? That looks like a bug or copy paste in original code.
			// Or maybe it meant OnTableDeleted.
			// Line 309: OnTableCreated
			// Line 358: OnTableDropped
			// Line 451: OnTableInserted
			// Line 955: OnTableInserted (for delete?!)
			// Line 1069: OnTableUpdated

			// I recall user context "OnTableInserted" for delete in line 955.
			// I will preserve this behavior but it looks wrong.
			// Actually let's check line 955 in `view_file` output.
			// 955: this.dbevent.OnTableInserted(table,deletedData,this.queryString);
			// Yes, it says Inserted. I should probably keep it to avoid breaking event consumers,
			// or fix it if I'm sure. Given this is a refactor, I should replicate behavior unless I fix bugs.
			// If I fix it, I should note it.
			// Let's assume it's "OnTableDeleted" but defined as Inserted in code?
			// DBEventHandler likely has OnTableDeleted.
			// But if WowoEngine calls Inserted, I must call Inserted.
			this.db.dbevent.OnTableInserted(
				table,
				deletedData,
				this.db.queryString,
			);
		}

		return `Berhasil menggusur ${deletedCount} bibit.`;
	}
}
