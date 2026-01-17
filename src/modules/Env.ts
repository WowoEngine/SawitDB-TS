import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

export class Env {
	LoadEnv(file = ".env") {
		console.log(path.join(__dirname, file));
		const envPath = path.resolve(process.cwd(), path.join(__dirname, file));

		if (!fs.existsSync(envPath)) {
			throw new Error(`File ${file} tidak ditemukan`);
		}

		const data = fs.readFileSync(envPath, "utf8");

		data.split("\n").forEach((line) => {
			line = line.trim();

			// skip kosong & komentar
			if (!line || line.startsWith("#")) return;

			const [key, ...values] = line.split("=");
			const value = values.join("=").trim();

			// jangan overwrite env yang sudah ada
			if (!process.env[key]) {
				process.env[key] = value;
			}
		});
	}
}

// XXX: should we really do this?
const env = new Env();
export default env;
