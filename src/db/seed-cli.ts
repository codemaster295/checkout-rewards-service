import { loadConfig } from "../config";
import { openDatabase } from "./connection";
import { seedProducts } from "./seed";

const config = loadConfig();
const db = openDatabase(config.dbPath);
const inserted = seedProducts(db);
console.log(`Seeded ${inserted} new product(s) into ${config.dbPath}`);
db.close();
