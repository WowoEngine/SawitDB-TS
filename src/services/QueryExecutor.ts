export default class QueryExecutor {
	constructor(db) {
		this.db = db;
	}

	execute(cmd) {
		throw new Error("Method 'execute' must be implemented");
	}
}
