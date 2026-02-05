import SawitDB from "../src/WowoEngine";
import { join } from "path";
import { existsSync, unlinkSync } from "fs";
import { LoadEnv } from "../src/modules/Env";

import DBEventHandlerExample from "./dbeventHandlerExample";

const dbPath = join(import.meta.dirname, "example.sawit");
if (existsSync(dbPath)) unlinkSync(dbPath);

LoadEnv("../../.env.example");

const db = new SawitDB(dbPath, { dbevent: new DBEventHandlerExample() });

console.log("Generating example.sawit...");

// 1. Create Tables
console.log(db.query("LAHAN sawit"));

// 2. Insert Data
console.log(
	db.query("TANAM KE sawit (id, bibit, umur) BIBIT (101, 'Dura', 2)"),
);
console.log(
	db.query("TANAM KE sawit (id, bibit, umur) BIBIT (102, 'Tenera', 5)"),
);
console.log(
	db.query("TANAM KE sawit (id, bibit, umur) BIBIT (103, 'Tenera', 1)"),
);

console.log("\n--- VERIFICATION TEST ---");
//console.log("Sawit:", JSON.stringify(db.query("PANEN * DARI sawit")));
console.log(
	"Sawit:",
	JSON.stringify(
		db.query("PUPUK sawit DENGAN bibit='Dura' DIMANA bibit='Tenera' "),
	),
);
console.log("Sawit:", JSON.stringify(db.query("PANEN * DARI sawit")));
console.log(
	"Sawit:",
	JSON.stringify(db.query("GUSUR DARI sawit DIMANA id=101")),
);
console.log("Sawit:", JSON.stringify(db.query("BAKAR LAHAN sawit")));
