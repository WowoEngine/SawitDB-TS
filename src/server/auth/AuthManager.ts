import crypto from "node:crypto"

export default class AuthManager {
	constructor(server) {
		this.server = server;
		this.authConfig = server.config.auth || null;
	}

	isEnabled() {
		return !!this.authConfig;
	}

	/**
	 * Hash a password using SHA-256 with salt
	 * @param {string} password - Plain text password
	 * @param {string} salt - Optional salt (generated if not provided)
	 * @returns {string} - Format: salt:hash
	 */
	static hashPassword(password, salt = null) {
		salt = salt || crypto.randomBytes(16).toString("hex");
		const hash = crypto
			.createHash("sha256")
			.update(salt + password)
			.digest("hex");
		return `${salt}:${hash}`;
	}

	/**
	 * Verify a password against a stored hash using timing-safe comparison
	 * @param {string} password - Plain text password to verify
	 * @param {string} storedHash - Stored hash in format "salt:hash" or plain text
	 * @returns {boolean}
	 */
	verifyPassword(password, storedHash) {
		// Support both hashed (salt:hash) and legacy plaintext passwords
		if (storedHash.includes(":")) {
			const [salt, hash] = storedHash.split(":");
			const computedHash = crypto
				.createHash("sha256")
				.update(salt + password)
				.digest("hex");
			// Timing-safe comparison to prevent timing attacks
			try {
				return crypto.timingSafeEqual(
					Buffer.from(hash, "hex"),
					Buffer.from(computedHash, "hex"),
				);
			} catch (e) {
				return false;
			}
		} else {
			// Legacy plaintext comparison with timing-safe method
			// Pad both strings to same length to prevent length-based timing attacks
			const maxLen = Math.max(password.length, storedHash.length);
			const paddedInput = password.padEnd(maxLen, "\0");
			const paddedStored = storedHash.padEnd(maxLen, "\0");
			try {
				return crypto.timingSafeEqual(
					Buffer.from(paddedInput),
					Buffer.from(paddedStored),
				);
			} catch (e) {
				return false;
			}
		}
	}

	handleAuth(socket, payload, session) {
		const { username, password } = payload;

		if (!this.isEnabled()) {
			session.setAuth(true);
			return this.server.sendResponse(socket, {
				type: "auth_success",
				message: "No authentication required",
			});
		}

		const storedPassword = this.authConfig[username];
		if (storedPassword && this.verifyPassword(password, storedPassword)) {
			session.setAuth(true);
			this.server.sendResponse(socket, {
				type: "auth_success",
				message: "Authentication successful",
			});
		} else {
			this.server.sendError(socket, "Invalid credentials");
		}
	}
}
