import { cpSync } from "node:fs";
import { resolve } from "node:path";

cpSync(resolve(import.meta.dir, "../../packages/store/migrations"), resolve(import.meta.dir, "dist/migrations"), { recursive: true });
