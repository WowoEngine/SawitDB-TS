import QueryExecutor from "../QueryExecutor";
import SelectExecutor from "./SelectExecutor";

export default class AggregateExecutor extends QueryExecutor {
	constructor(db) {
		super(db);
		// Depends on SelectExecutor logic to get filtered rows
		this.selectExecutor = new SelectExecutor(db);
	}

	execute(cmd) {
		// cmd = { table, func, field, criteria, groupBy, having }
		const { table, func, field, criteria, groupBy, having } = cmd;

		// Reuse select executor logic to get rows matching criteria
		// We construct a select command.
		// If groupBy exists, we need all rows.
		// If no groupBy, we can optimize (e.g. COUNT(*) using metadata?)
		// For now, full scan via select.

		const selectCmd = {
			table,
			criteria,
			// cols: [field] // Optimize projection? If field is *, need all?
			// If func is count(*), we don't need columns.
		};

		const records = this.selectExecutor.execute(selectCmd);

		if (groupBy) {
			return this.groupedAggregate(records, func, field, groupBy, having);
		}

		switch (func.toUpperCase()) {
			case "COUNT":
				return { count: records.length };

			case "SUM":
				if (!field) throw new Error("SUM requires a field");
				const sum = records.reduce(
					(acc, r) => acc + (Number(r[field]) || 0),
					0,
				);
				return { sum, field };

			case "AVG": {
				if (!field) throw new Error("AVG requires a field");
				if (records.length === 0) {
					return { avg: null, field, count: 0 };
				}
				const avgSum = records.reduce(
					(acc, r) => acc + (Number(r[field]) || 0),
					0,
				);
				const avg = avgSum / records.length;
				return { avg, field, count: records.length };
			}

			case "MIN": {
				if (!field) throw new Error("MIN requires a field");
				if (records.length === 0) {
					return { min: null, field };
				}
				let min = Infinity;
				for (const r of records) {
					const val = Number(r[field]);
					if (!isNaN(val) && val < min) min = val;
				}
				return { min: min === Infinity ? null : min, field };
			}

			case "MAX": {
				if (!field) throw new Error("MAX requires a field");
				if (records.length === 0) {
					return { max: null, field };
				}
				let max = -Infinity;
				for (const r of records) {
					const val = Number(r[field]);
					if (!isNaN(val) && val > max) max = val;
				}
				return { max: max === -Infinity ? null : max, field };
			}

			default:
				throw new Error(`Unknown aggregate function: ${func}`);
		}
	}

	groupedAggregate(records, func, field, groupBy, having) {
		const groups = {};
		for (const record of records) {
			const key = record[groupBy];
			if (!groups[key]) groups[key] = [];
			groups[key].push(record);
		}

		const results = [];
		for (const [key, groupRecords] of Object.entries(groups)) {
			const result = { [groupBy]: key };
			switch (func.toUpperCase()) {
				case "COUNT":
					result.count = groupRecords.length;
					break;
				case "SUM":
					result.sum = groupRecords.reduce(
						(acc, r) => acc + (Number(r[field]) || 0),
						0,
					);
					break;
				case "AVG":
					if (groupRecords.length === 0) {
						result.avg = null;
					} else {
						result.avg =
							groupRecords.reduce(
								(acc, r) => acc + (Number(r[field]) || 0),
								0,
							) / groupRecords.length;
					}
					break;
				case "MIN": {
					let min = Infinity;
					for (const r of groupRecords) {
						const val = Number(r[field]);
						if (!isNaN(val) && val < min) min = val;
					}
					result.min = min === Infinity ? null : min;
					break;
				}
				case "MAX": {
					let max = -Infinity;
					for (const r of groupRecords) {
						const val = Number(r[field]);
						if (!isNaN(val) && val > max) max = val;
					}
					result.max = max === -Infinity ? null : max;
					break;
				}
			}
			results.push(result);
		}

		// Apply HAVING filter on aggregated results
		if (having) {
			return results.filter((row) => {
				const val = row[having.field];
				const target = having.val;
				switch (having.op) {
					case "=":
						return val === target;
					case "!=":
					case "<>":
						return val !== target;
					case ">":
						return val > target;
					case "<":
						return val < target;
					case ">=":
						return val >= target;
					case "<=":
						return val <= target;
					default:
						return true;
				}
			});
		}

		return results;
	}
}
