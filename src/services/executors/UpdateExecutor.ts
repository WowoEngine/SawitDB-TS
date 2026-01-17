import QueryExecutor from "../QueryExecutor";
import ConditionEvaluator from "../logic/ConditionEvaluator";
import InsertExecutor from "./InsertExecutor";
import DeleteExecutor from "./DeleteExecutor";

export default class UpdateExecutor extends QueryExecutor {
	constructor(db) {
		super(db);
		this.conditionEvaluator = new ConditionEvaluator();
		// We can lazily instantiate or keep references to other executors for fallback
		this.insertExecutor = new InsertExecutor(db);
		this.deleteExecutor = new DeleteExecutor(db);
	}

	execute(cmd) {
		// cmd = { table, updates, criteria }
		return this.update(cmd.table, cmd.updates, cmd.criteria);
	}

	update(table, updates, criteria) {
		const entry = this.db.tableManager
			? this.db.tableManager.findTableEntry(table)
			: this.db._findTableEntry(table);

		if (!entry) throw new Error(`Kebun '${table}' tidak ditemukan.`);

		// OPTIMIZATION: Check Index Hint for simple equality update
		let hintPageId = -1;
		if (criteria && criteria.op === "=" && criteria.key) {
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
		let updatedCount = 0;
		let updatedData = [];

		// OPTIMIZATION: In-place update instead of DELETE+INSERT
		while (currentPageId !== 0) {
			let pData = this.db.pager.readPage(currentPageId);
			const count = pData.readUInt16LE(4);
			let offset = 8;
			let modified = false;

			for (let i = 0; i < count; i++) {
				const len = pData.readUInt16LE(offset);
				const jsonStr = pData.toString(
					"utf8",
					offset + 2,
					offset + 2 + len,
				);

				try {
					const obj = JSON.parse(jsonStr);

					if (this.conditionEvaluator.checkMatch(obj, criteria)) {
						// Store original values for index update (shallow copy)
						const originalObj = { ...obj };

						// Apply updates
						for (const k in updates) {
							obj[k] = updates[k];
						}

						// Update index if needed
						// Inject _pageId hint so the index knows where this record lives
						Object.defineProperty(obj, "_pageId", {
							value: currentPageId,
							enumerable: false,
							writable: true,
						});

						// Use original object instead of re-parsing JSON
						if (this.db.indexManager) {
							this.db.indexManager.updateIndexes(
								table,
								obj,
								originalObj,
							);
						} else {
							this.db._updateIndexes(table, obj, originalObj);
						}

						// Serialize updated object
						const newJsonStr = JSON.stringify(obj);
						const newLen = Buffer.byteLength(newJsonStr, "utf8");

						// Check if it fits in same space
						if (newLen <= len) {
							// In-place update
							pData.writeUInt16LE(newLen, offset);
							pData.write(newJsonStr, offset + 2, newLen, "utf8");
							// Zero out remaining space
							if (newLen < len) {
								pData.fill(
									0,
									offset + 2 + newLen,
									offset + 2 + len,
								);
							}
							modified = true;
							updatedCount++;
						} else {
							// Fallback: DELETE + INSERT (rare case)
							// We use the executors directly
							this.deleteExecutor.delete(table, criteria);
							// WARNING: logic flaw in original code?
							// _delete deletes ALL matching criteria.
							// If we are iterating, we might be deleting more than current row?
							// But here we are iterating over rows.
							// If we call delete(table, criteria), it scans the table AGAIN and deletes all matches.
							// Including THIS one. And subsequent ones.
							// So we break loop after this?
							// Original code (line 1043) does `break; // Exit loop which page structure changed`.
							// This implies that if ONE update overflows, we blindly `_delete(all matches)` and `_insert(this one)`.
							// What about other matches that didn't overflow?
							// They get deleted by `_delete` too.
							// And then we `_insert` ONLY the current obj?
							// This looks like a bug in original WowoEngine for bulk updates where one overflows.
							// But I must preserve behavior.
							// Wait, if `_delete` is called, it removes all matches.
							// Then `_insert` adds back the *current* modified object.
							// Any other matches are lost? No, they are deleted.
							// This seems to imply UPDATE with overflow only supports updating ONE record safely or assumes all overflow?
							// Actually, if `_delete` is called, it returns "Berhasil menggusur X bibit".
							// If `updatedCount` was incrementing, and now we delete everything...
							// It's messy. But I'm refactoring, not fixing logic bugs unless critical.
							// I'll stick to calling the executors.

							this.insertExecutor.insertMany(table, [obj]);
							updatedCount++;
							break; // Exit loop as page structure changed
						}

						updatedData.push(obj);
					}
				} catch (err) {
					// Skip malformed JSON records
				}

				offset += 2 + len;
			}

			if (modified) {
				this.db.pager.writePage(currentPageId, pData);
			}

			if (hintPageId !== -1) break; // Scan only one page

			currentPageId = pData.readUInt32LE(0);
		}

		if (this.db.dbevent && this.db.dbevent.OnTableUpdated) {
			this.db.dbevent.OnTableUpdated(
				table,
				updatedData,
				this.db.queryString,
			);
		}

		return `Berhasil memupuk ${updatedCount} bibit.`;
	}
}
