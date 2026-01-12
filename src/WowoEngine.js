const Pager = require("./modules/Pager");
const QueryParser = require("./modules/QueryParser");
const WAL = require("./modules/WAL");
const DBEventHandler = require("./services/event/DBEventHandler");
const DBEvent = require("./services/event/DBEvent");

// Services
const TableManager = require("./services/TableManager");
const IndexManager = require("./services/IndexManager");
const ConditionEvaluator = require("./services/logic/ConditionEvaluator");

// Executors
const SelectExecutor = require("./services/executors/SelectExecutor");
const InsertExecutor = require("./services/executors/InsertExecutor");
const DeleteExecutor = require("./services/executors/DeleteExecutor");
const UpdateExecutor = require("./services/executors/UpdateExecutor");
const AggregateExecutor = require("./services/executors/AggregateExecutor");

/**
 * SawitDB implements the Logic over the Pager
 * Refactored to use modular services and executors.
 */
class SawitDB {
	constructor(filePath, options = {}) {
		// WAL: Optional crash safety (backward compatible - disabled by default)
		this.wal = options.wal ? new WAL(filePath, options.wal) : null;
		this.dbevent = options.dbevent ? options.dbevent : new DBEventHandler();

		if ((!this.dbevent) instanceof DBEvent) {
			console.error(`dbevent is not instanceof DBEvent`);
		}

		// Recovery: Replay WAL if exists
		if (this.wal && this.wal.enabled) {
			const recovered = this.wal.recover();
			if (recovered.length > 0) {
				console.log(
					`[WAL] Recovered ${recovered.length} operations from crash`,
				);
			}
		}

		this.pager = new Pager(filePath, this.wal);
		this.indexes = new Map(); // Map of 'tableName.fieldName' -> BTreeIndex
		this.parser = new QueryParser();

		// CACHE: Simple LRU for Parsed Queries
		this.queryCache = new Map();
		this.queryCacheLimit = 1000;

		// Initialize Services
		this.tableManager = new TableManager(this);
		this.indexManager = new IndexManager(this);
		this.conditionEvaluator = new ConditionEvaluator();

		// Initialize Executors
		this.selectExecutor = new SelectExecutor(this);
		this.insertExecutor = new InsertExecutor(this);
		this.deleteExecutor = new DeleteExecutor(this);
		this.updateExecutor = new UpdateExecutor(this);
		this.aggregateExecutor = new AggregateExecutor(this);

		// PERSISTENCE: Initialize System Tables
		this._initSystem();
	}

	_initSystem() {
		// Check if _indexes table exists, if not create it
		if (!this.tableManager.findTableEntry("_indexes")) {
			try {
				this.tableManager.createTable("_indexes", true); // true = system table
			} catch (e) {
				// Ignore if it effectively exists or concurrency issue
			}
		}

		// Load Indexes
		this.indexManager.loadIndexes();
	}

	close() {
		if (this.wal) {
			this.wal.close();
		}
		if (this.pager) {
			this.pager.close();
			this.pager = null;
		}
	}

	/**
	 * Shallow clone a command object for cache retrieval
	 * Faster than JSON.parse(JSON.stringify()) for simple objects
	 */
	_shallowCloneCmd(cmd) {
		const clone = { ...cmd };
		// Deep clone arrays (criteria, joins, cols, sort)
		if (cmd.criteria) clone.criteria = { ...cmd.criteria };
		if (cmd.joins)
			clone.joins = cmd.joins.map((j) => ({ ...j, on: { ...j.on } }));
		if (cmd.cols) clone.cols = [...cmd.cols];
		if (cmd.sort) clone.sort = { ...cmd.sort };
		if (cmd.values) clone.values = { ...cmd.values };
		return clone;
	}

	query(queryString, params) {
		if (!this.pager) return "Error: Database is closed.";

		// QUERY CACHE - Optimized with shallow clone
		let cmd;
		this.queryString = queryString;
		const cacheKey = queryString;

		if (this.queryCache.has(cacheKey) && !params) {
			const cached = this.queryCache.get(cacheKey);
			cmd = this._shallowCloneCmd(cached);
			this.queryCache.delete(cacheKey);
			this.queryCache.set(cacheKey, cached);
		} else {
			const templateCmd = this.parser.parse(queryString);
			if (templateCmd.type !== "ERROR") {
				if (!params) {
					this.queryCache.set(cacheKey, templateCmd);
					while (this.queryCache.size > this.queryCacheLimit) {
						const firstKey = this.queryCache.keys().next().value;
						this.queryCache.delete(firstKey);
					}
				}
				cmd = templateCmd;
			} else {
				return `Error: ${templateCmd.message}`;
			}

			if (params) {
				this.parser._bindParameters(cmd, params);
			}
		}

		if (cmd.type === "ERROR") return `Error: ${cmd.message}`;

		try {
			switch (cmd.type) {
				case "CREATE_TABLE":
					return this.tableManager.createTable(cmd.table);

				case "SHOW_TABLES":
					return this.tableManager.showTables();

				case "SHOW_INDEXES":
					return this.indexManager.showIndexes(cmd.table);

				case "INSERT":
					return this.insertExecutor.execute(cmd);

				case "SELECT":
					return this.selectExecutor.execute(cmd);

				case "DELETE":
					return this.deleteExecutor.execute(cmd);

				case "UPDATE":
					return this.updateExecutor.execute(cmd);

				case "DROP_TABLE":
					return this.tableManager.dropTable(cmd.table);

				case "CREATE_INDEX":
					return this.indexManager.createIndex(cmd.table, cmd.field);

				case "AGGREGATE":
					return this.aggregateExecutor.execute(cmd);

				case "EXPLAIN":
					return this._explain(cmd.innerCommand);

				default:
					return `Perintah tidak dikenal atau belum diimplementasikan di Engine Refactor.`;
			}
		} catch (e) {
			return `Error: ${e.message}`;
		}
	}

	// --- Core Data Access (Low Level) ---
	// Kept here as it's the fundamental connection between Pager and Logic
	// Could eventually move to TableScanner service

	// Backward compatibility wrapper for old internal calls (if any remain)
	_findTableEntry(name) {
		return this.tableManager.findTableEntry(name);
	}

	// Backward compatibility wrapper for internal calls
	_checkMatch(obj, criteria) {
		return this.conditionEvaluator.checkMatch(obj, criteria);
	}

	// Wrapper for index update/removal if needed by old code (though logic moved to indexManager)
	_updateIndexes(t, n, o) {
		this.indexManager.updateIndexes(t, n, o);
	}
	_removeFromIndexes(t, d) {
		this.indexManager.removeFromIndexes(t, d);
	}
	_insert(t, d) {
		return this.insertExecutor.insertMany(t, [d]);
	}
	_updateTableLastPage(t, p) {
		this.tableManager.updateTableLastPage(t, p);
	}
	_delete(t, c, f) {
		return this.deleteExecutor.delete(t, c, f);
	}

	// Modifiy _scanTable to allow returning extended info (pageId) for internal use
	_scanTable(entry, criteria, limit = null, returnRaw = false) {
		let currentPageId = entry.startPage;
		const results = [];
		const effectiveLimit = limit || Infinity;

		// OPTIMIZATION: Pre-compute condition check for hot path
		const hasSimpleCriteria =
			criteria && !criteria.type && criteria.key && criteria.op;
		const criteriaKey = hasSimpleCriteria ? criteria.key : null;
		const criteriaOp = hasSimpleCriteria ? criteria.op : null;
		const criteriaVal = hasSimpleCriteria ? criteria.val : null;

		while (currentPageId !== 0 && results.length < effectiveLimit) {
			// Returns { next: uint32, items: Array<Object> }
			const pageData = this.pager.readPageObjects(currentPageId);

			for (const obj of pageData.items) {
				if (results.length >= effectiveLimit) break;

				// OPTIMIZATION: Inline simple condition check (hot path)
				let matches = true;
				if (hasSimpleCriteria) {
					const val = obj[criteriaKey];
					// Inline simple checks for speed
					switch (criteriaOp) {
						case "=":
							matches = val == criteriaVal;
							break;
						case ">":
							matches = val > criteriaVal;
							break;
						case "<":
							matches = val < criteriaVal;
							break;
						case ">=":
							matches = val >= criteriaVal;
							break;
						case "<=":
							matches = val <= criteriaVal;
							break;
						case "!=":
							matches = val != criteriaVal;
							break;
						case "LIKE":
							const pattern = criteriaVal
								.replace(/%/g, ".*")
								.replace(/_/g, ".");
							matches = new RegExp("^" + pattern + "$", "i").test(
								val,
							);
							break;
						default:
							matches =
								this.conditionEvaluator.checkSingleCondition(
									obj,
									criteria,
								);
					}
				} else if (criteria) {
					matches = this.conditionEvaluator.checkMatch(obj, criteria);
				}

				if (matches) {
					if (returnRaw) {
						// Inject Page Hint
						Object.defineProperty(obj, "_pageId", {
							value: currentPageId,
							enumerable: false, // Hidden
							writable: true,
						});
						results.push(obj);
					} else {
						results.push(obj);
					}
				}
			}

			currentPageId = pageData.next;
		}
		return results;
	}

	/**
	 * EXPLAIN - Analyze query execution plan
	 * Returns information about how the query would be executed
	 */
	_explain(cmd) {
		const plan = {
			type: cmd.type,
			table: cmd.table,
			steps: [],
		};

		switch (cmd.type) {
			case "SELECT": {
				const entry = this.tableManager.findTableEntry(cmd.table);
				if (!entry) {
					plan.error = `Table '${cmd.table}' not found`;
					return plan;
				}

				// Check if joins are used
				if (cmd.joins && cmd.joins.length > 0) {
					plan.steps.push({
						operation: "SCAN",
						table: cmd.table,
						method: "Full Table Scan",
						reason: "Base table for JOIN",
					});

					for (const join of cmd.joins) {
						const joinType = join.type || "INNER";
						const useHashJoin = join.on && join.on.op === "=";
						plan.steps.push({
							operation: `${joinType} JOIN`,
							table: join.table,
							method: useHashJoin
								? "Hash Join"
								: "Nested Loop Join",
							condition: join.on
								? `${join.on.left} ${join.on.op} ${join.on.right}`
								: "CROSS",
						});
					}
				} else if (cmd.criteria) {
					// Check index usage
					const indexKey = `${cmd.table}.${cmd.criteria.key}`;
					const hasIndex = this.indexes.has(indexKey);

					if (hasIndex && cmd.criteria.op === "=") {
						plan.steps.push({
							operation: "INDEX SCAN",
							table: cmd.table,
							index: indexKey,
							method: "B-Tree Index Lookup",
							condition: `${cmd.criteria.key} ${cmd.criteria.op} ${JSON.stringify(cmd.criteria.val)}`,
						});
					} else {
						plan.steps.push({
							operation: "TABLE SCAN",
							table: cmd.table,
							method: hasIndex
								? "Full Scan (index not usable for this operator)"
								: "Full Table Scan",
							condition: `${cmd.criteria.key} ${cmd.criteria.op} ${JSON.stringify(cmd.criteria.val)}`,
						});
					}
				} else {
					plan.steps.push({
						operation: "TABLE SCAN",
						table: cmd.table,
						method: "Full Table Scan",
						reason: "No WHERE clause",
					});
				}

				// DISTINCT step
				if (cmd.distinct) {
					plan.steps.push({
						operation: "DISTINCT",
						method: "Hash-based deduplication",
					});
				}

				// Sorting step
				if (cmd.sort) {
					plan.steps.push({
						operation: "SORT",
						field: cmd.sort.by,
						direction: cmd.sort.order || "ASC",
					});
				}

				// Limit/Offset step
				if (cmd.limit || cmd.offset) {
					plan.steps.push({
						operation: "LIMIT/OFFSET",
						limit: cmd.limit || "none",
						offset: cmd.offset || 0,
					});
				}

				// Projection step
				if (
					cmd.cols &&
					!(cmd.cols.length === 1 && cmd.cols[0] === "*")
				) {
					plan.steps.push({
						operation: "PROJECT",
						columns: cmd.cols,
					});
				}
				break;
			}

			case "DELETE":
			case "UPDATE": {
				const entry = this.tableManager.findTableEntry(cmd.table);
				if (!entry) {
					plan.error = `Table '${cmd.table}' not found`;
					return plan;
				}

				if (cmd.criteria) {
					const indexKey = `${cmd.table}.${cmd.criteria.key}`;
					const hasIndex = this.indexes.has(indexKey);

					plan.steps.push({
						operation: "SCAN",
						table: cmd.table,
						method:
							hasIndex && cmd.criteria.op === "="
								? "Index-assisted scan"
								: "Full Table Scan",
						condition: `${cmd.criteria.key} ${cmd.criteria.op} ${JSON.stringify(cmd.criteria.val)}`,
					});
				} else {
					plan.steps.push({
						operation: "SCAN",
						table: cmd.table,
						method: "Full Table Scan",
						reason: "No WHERE clause - affects all rows",
					});
				}

				plan.steps.push({
					operation: cmd.type,
					table: cmd.table,
					method: "In-place modification",
				});
				break;
			}

			case "AGGREGATE": {
				plan.steps.push({
					operation: "SCAN",
					table: cmd.table,
					method: cmd.criteria ? "Filtered Scan" : "Full Table Scan",
				});

				if (cmd.groupBy) {
					plan.steps.push({
						operation: "GROUP",
						field: cmd.groupBy,
						method: "Hash-based grouping",
					});
				}

				plan.steps.push({
					operation: "AGGREGATE",
					function: cmd.func,
					field: cmd.field || "*",
				});

				if (cmd.having) {
					plan.steps.push({
						operation: "HAVING",
						condition: `${cmd.having.field} ${cmd.having.op} ${cmd.having.val}`,
					});
				}
				break;
			}
		}

		// Add available indexes info
		const tableIndexes = [];
		for (const [key] of this.indexes) {
			if (key.startsWith(cmd.table + ".")) {
				tableIndexes.push(key);
			}
		}
		if (tableIndexes.length > 0) {
			plan.availableIndexes = tableIndexes;
		}

		return plan;
	}
}

module.exports = SawitDB;
