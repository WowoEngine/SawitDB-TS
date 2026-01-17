/**
 * JoinProcessor
 * Handles complex join logic (INNER, LEFT, RIGHT, FULL, CROSS)
 * Extracted from WowoEngine.js
 */
export default class JoinProcessor {
	constructor(db) {
		this.db = db; // Needs db for _scanTable and TableManager lookup
	}

	process(mainTable, initialRows, joins) {
		if (!joins || joins.length === 0) return initialRows;

		// 1. Prefix columns of main table
		let currentRows = initialRows.map((row) => {
			const newRow = { ...row };
			for (const k in row) {
				newRow[`${mainTable}.${k}`] = row[k];
			}
			return newRow;
		});

		// 2. Perform Joins
		for (const join of joins) {
			// Use TableManager if available, fallback to db internal
			const joinEntry = this.db.tableManager
				? this.db.tableManager.findTableEntry(join.table)
				: this.db._findTableEntry(join.table);

			if (!joinEntry)
				throw new Error(`Kebun '${join.table}' tidak ditemukan.`);

			const joinType = join.type || "INNER";
			// Use scanTable from db (assuming it's still there or exposed)
			// We pass null for criteria to get all rows, logic filters them later
			// Note: Optimizing this to push down predicates is a future task
			const joinRows = this.db._scanTable
				? this.db._scanTable(joinEntry, null)
				: [];

			// Prefix right table rows
			const prefixRightRow = (row) => {
				const prefixed = {};
				for (const k in row) {
					prefixed[k] = row[k];
					prefixed[`${join.table}.${k}`] = row[k];
				}
				return prefixed;
			};

			// Create null row for outer joins
			const createNullRightRow = () => {
				const nullRow = {};
				if (joinRows.length > 0) {
					for (const k in joinRows[0]) {
						nullRow[k] = null;
						nullRow[`${join.table}.${k}`] = null;
					}
				}
				return nullRow;
			};

			const createNullLeftRow = () => {
				const nullRow = {};
				if (currentRows.length > 0) {
					for (const k in currentRows[0]) {
						nullRow[k] = null;
					}
				}
				return nullRow;
			};

			const nextRows = [];

			// CROSS JOIN - Cartesian product (no ON clause)
			if (joinType === "CROSS") {
				for (const leftRow of currentRows) {
					for (const rightRow of joinRows) {
						nextRows.push({
							...leftRow,
							...prefixRightRow(rightRow),
						});
					}
				}
				currentRows = nextRows;
				continue;
			}

			// For other joins, we need the ON condition
			const matchRows = (leftRow, rightRow) => {
				const lVal = leftRow[join.on.left];
				// Handle right key being potentially prefixed or not in definition
				const rKey = join.on.right.startsWith(join.table + ".")
					? join.on.right.substring(join.table.length + 1)
					: join.on.right;
				const rVal = rightRow[rKey];

				switch (join.on.op) {
					case "=":
						return lVal == rVal;
					case "!=":
					case "<>":
						return lVal != rVal;
					case ">":
						return lVal > rVal;
					case "<":
						return lVal < rVal;
					case ">=":
						return lVal >= rVal;
					case "<=":
						return lVal <= rVal;
					default:
						return false;
				}
			};

			// Build hash map for equi-joins (optimization)
			const useHashJoin = join.on.op === "=";
			let joinMap = null;

			if (useHashJoin) {
				joinMap = new Map();
				for (const row of joinRows) {
					let rightKey = join.on.right;
					if (rightKey.startsWith(join.table + ".")) {
						rightKey = rightKey.substring(join.table.length + 1);
					}
					const val = row[rightKey];
					if (val === undefined || val === null) continue;

					// Handle numeric vs string type loose matching for hash join key?
					// JS Map keys are strict. matchRows used ==.
					// If we want strict optimization, we assume types match or key is normalized.
					// For safety, let's stringify if loose or just ensure types.
					// Existing code used direct value. Let's stick to it but be aware.

					if (!joinMap.has(val)) joinMap.set(val, []);
					joinMap.get(val).push(row);
				}
			}

			// Track matched right rows for FULL OUTER JOIN
			const matchedRightRows = new Set();

			// Process LEFT/INNER/FULL joins
			if (
				joinType === "INNER" ||
				joinType === "LEFT" ||
				joinType === "FULL"
			) {
				for (const leftRow of currentRows) {
					let hasMatch = false;

					if (useHashJoin) {
						const lVal = leftRow[join.on.left];
						if (joinMap.has(lVal)) {
							const matches = joinMap.get(lVal);
							for (let ri = 0; ri < matches.length; ri++) {
								const rightRow = matches[ri];
								nextRows.push({
									...leftRow,
									...prefixRightRow(rightRow),
								});
								hasMatch = true;
								if (joinType === "FULL") {
									// Track by index in original joinRows
									const origIdx = joinRows.indexOf(rightRow);
									if (origIdx !== -1)
										matchedRightRows.add(origIdx);
								}
							}
						}
					} else {
						for (let ri = 0; ri < joinRows.length; ri++) {
							const rightRow = joinRows[ri];
							if (matchRows(leftRow, rightRow)) {
								nextRows.push({
									...leftRow,
									...prefixRightRow(rightRow),
								});
								hasMatch = true;
								if (joinType === "FULL")
									matchedRightRows.add(ri);
							}
						}
					}

					// LEFT or FULL: include unmatched left rows with NULL right
					if (
						!hasMatch &&
						(joinType === "LEFT" || joinType === "FULL")
					) {
						nextRows.push({ ...leftRow, ...createNullRightRow() });
					}
				}
			}

			// RIGHT JOIN: swap logic - iterate right rows, find matching left
			if (joinType === "RIGHT") {
				const leftMap = useHashJoin ? new Map() : null;
				if (useHashJoin) {
					for (const row of currentRows) {
						const val = row[join.on.left];
						if (val === undefined || val === null) continue;
						if (!leftMap.has(val)) leftMap.set(val, []);
						leftMap.get(val).push(row);
					}
				}

				for (const rightRow of joinRows) {
					let hasMatch = false;
					const prefixedRight = prefixRightRow(rightRow);

					if (useHashJoin) {
						let rightKey = join.on.right;
						if (rightKey.startsWith(join.table + ".")) {
							rightKey = rightKey.substring(
								join.table.length + 1,
							);
						}
						const rVal = rightRow[rightKey];
						if (leftMap.has(rVal)) {
							const matches = leftMap.get(rVal);
							for (const leftRow of matches) {
								nextRows.push({ ...leftRow, ...prefixedRight });
								hasMatch = true;
							}
						}
					} else {
						for (const leftRow of currentRows) {
							if (matchRows(leftRow, rightRow)) {
								nextRows.push({ ...leftRow, ...prefixedRight });
								hasMatch = true;
							}
						}
					}

					// RIGHT: include unmatched right rows with NULL left
					if (!hasMatch) {
						nextRows.push({
							...createNullLeftRow(),
							...prefixedRight,
						});
					}
				}
			}

			// FULL OUTER: add unmatched right rows
			if (joinType === "FULL") {
				for (let ri = 0; ri < joinRows.length; ri++) {
					if (!matchedRightRows.has(ri)) {
						nextRows.push({
							...createNullLeftRow(),
							...prefixRightRow(joinRows[ri]),
						});
					}
				}
			}

			currentRows = nextRows;
		}

		return currentRows;
	}
}
