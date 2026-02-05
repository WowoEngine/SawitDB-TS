import SawitDB from "../src/WowoEngine";
import { join } from "path";
import { existsSync, unlinkSync } from "fs";

const dbPath = join(import.meta.dirname, "example.sawit");
if (existsSync(dbPath)) unlinkSync(dbPath);

const db = new SawitDB(dbPath);

console.log("Generating example.sawit...");

// 1. Create Tables
console.log(db.query("LAHAN karet"));
console.log(db.query("LAHAN sawit"));
console.log(db.query("LAHAN kopi"));

// 2. Insert Data
console.log(
	db.query("TANAM KE karet (id, jenis, lokasi) BIBIT (1, 'GT1', 'Blok A')"),
);
console.log(
	db.query("TANAM KE karet (id, jenis, lokasi) BIBIT (2, 'PB260', 'Blok A')"),
);

console.log(
	db.query("TANAM KE sawit (id, bibit, umur) BIBIT (101, 'Dura', 2)"),
);
console.log(
	db.query("TANAM KE sawit (id, bibit, umur) BIBIT (102, 'Tenera', 5)"),
);
console.log(
	db.query("TANAM KE sawit (id, bibit, umur) BIBIT (103, 'Pisifera', 1)"),
);

console.log(
	db.query("TANAM KE kopi (kode, varietas) BIBIT ('K01', 'Robusta')"),
);
console.log(
	db.query("TANAM KE kopi (kode, varietas) BIBIT ('K02', 'Arabika')"),
);

console.log("\n--- VERIFICATION TEST ---");
console.log("Karet:", JSON.stringify(db.query("PANEN * DARI karet")));
console.log("Sawit:", JSON.stringify(db.query("PANEN * DARI sawit")));
console.log("Kopi:", JSON.stringify(db.query("PANEN * DARI kopi")));
