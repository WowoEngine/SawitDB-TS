class ClientSession {
	constructor(socket, clientId) {
		this.socket = socket;
		this.clientId = clientId;
		this.authenticated = false;
		this.currentDatabase = null;
		this.connectedAt = Date.now();
	}

	setAuth(isAuthenticated) {
		this.authenticated = isAuthenticated;
	}

	setDatabase(databaseName) {
		this.currentDatabase = databaseName;
	}
}

module.exports = ClientSession;
