const QueryExecutor = require("../QueryExecutor");
const JoinProcessor = require("../logic/JoinProcessor");
const ConditionEvaluator = require("../logic/ConditionEvaluator");

class SelectExecutor extends QueryExecutor {
	constructor(db) {
		super(db);
		this.joinProcessor = new JoinProcessor(db);
		this.conditionEvaluator = new ConditionEvaluator();
	}

	execute(cmd) {
		// cmd: { table, criteria, sort, limit, offset, joins, cols, distinct ... }

		// 1. Get Rows (Scan or Join)
		let rows = this._getRows(cmd);

		// 2. Column Projection
		if (cmd.cols && !(cmd.cols.length === 1 && cmd.cols[0] === "*")) {
			rows = rows.map((r) => {
				const newRow = {};
				cmd.cols.forEach(
					(c) => (newRow[c] = r[c] !== undefined ? r[c] : null),
				);
				return newRow;
			});
		}

		// 3. Apply DISTINCT (after projection)
		if (cmd.distinct) {
			const seen = new Set();
			rows = rows.filter((row) => {
				const key = JSON.stringify(row);
				if (seen.has(key)) return false;
				seen.add(key);
				return true;
			});
		}

		// Notify selection
		if (this.db.dbevent && this.db.dbevent.OnTableSelected) {
			this.db.dbevent.OnTableSelected(
				cmd.table,
				rows,
				this.db.queryString,
			);
		}

		return rows;
	}

	_getRows(cmd) {
		const { table, criteria, sort, limit, offset, joins } = cmd;

		let results = [];

		if (joins && joins.length > 0) {
			// Complex Path: Joins
			const entry = this.db.tableManager
				? this.db.tableManager.findTableEntry(table)
				: this.db._findTableEntry(table);

			if (!entry) throw new Error(`Kebun '${table}' tidak ditemukan.`);

			// Scan main table
			// Use db._scanTable for now (it's the low level data access)
			const initialRows = this.db._scanTable
				? this.db._scanTable(entry, null)
				: [];

			// Process Joins
			results = this.joinProcessor.process(table, initialRows, joins);

			// Filter (WHERE) after joins
			if (criteria) {
				// Use ConditionEvaluator
				results = results.filter((r) =>
					this.conditionEvaluator.checkMatch(r, criteria),
				);
			}

			// Note: Join path doesn't optimize sort/limit pushdown yet
		} else {
			// Simple Path: Single Table
			const entry = this.db.tableManager
				? this.db.tableManager.findTableEntry(table)
				: this.db._findTableEntry(table);

			if (!entry) throw new Error(`Kebun '${table}' tidak ditemukan.`);

			// OPTIMIZATION: Index Usage logic
			// Check if we can use index (Equality on indexed field and no sort or sort matches index?)
			// For now, implementing exact logic from WowoEngine.js

			if (criteria && criteria.op === "=" && !sort) {
				const indexKey = `${table}.${criteria.key}`;
				if (this.db.indexes.has(indexKey)) {
					const index = this.db.indexes.get(indexKey);
					results = index.search(criteria.val);
				} else {
					const scanLimit = sort ? null : limit;
					results = this.db._scanTable(entry, criteria, scanLimit);
				}
			} else {
				const scanLimit = sort ? null : limit;
				results = this.db._scanTable(entry, criteria, scanLimit);
			}
		}

		// Sorting
		if (sort) {
			results.sort((a, b) => {
				const valA = a[sort.key];
				const valB = b[sort.key];
				if (valA < valB) return sort.dir === "asc" ? -1 : 1;
				if (valA > valB) return sort.dir === "asc" ? 1 : -1;
				return 0;
			});
		}

		// Limit & Offset
		let start = 0;
		let end = results.length;
		const offsetCount = offset; // cmd.offset might be undefined

		if (offsetCount) start = offsetCount;
		if (limit) end = start + limit;
		if (end > results.length) end = results.length;
		if (start > results.length) start = results.length;

		// Optimization: if start 0 and end is length, slice is fast but unnecessary if strict
		if (start !== 0 || end !== results.length) {
			results = results.slice(start, end);
		}

		return results;
	}
}

module.exports = SelectExecutor;
