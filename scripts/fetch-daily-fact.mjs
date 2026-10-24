// Fetches "today's fact" using the shared multi-source logic in
// scripts/fact-sources.mjs. Runs once a day via
// .github/workflows/daily-fact.yml.

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { fetchFreshFact, pickFallbackFact } from "./fact-sources.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH = path.join(__dirname, "..", "data", "facts-history.json");

const HISTORY_LIMIT = 400; // keep the library from growing forever

function getTodayDateString() {
    const d = new Date();
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

async function loadHistory() {
    let raw;
    try {
        raw = await readFile(DATA_PATH, "utf8");
    } catch (err) {
        if (err.code === "ENOENT") return []; // first run, no file yet
        throw err; // any other read failure must not be treated as "empty"
    }
    const parsed = JSON.parse(raw); // a parse error here must fail the run, not silently start from []
    if (!Array.isArray(parsed)) throw new Error(`${DATA_PATH} does not contain a JSON array`);
    return parsed;
}

async function main() {
    const todayStr = getTodayDateString();
    const history = await loadHistory();
    const existing = history.find(entry => entry.date === todayStr);
    if (existing) {
        console.log(`Already have a fact for ${todayStr}, nothing to do.`);
        return;
    }

    let fact;
    try {
        fact = await fetchFreshFact(history);
    } catch (err) {
        console.warn("All live sources failed, using offline backup:", err.message || err);
        fact = pickFallbackFact(history);
    }

    history.push({ date: todayStr, text: fact.text, source: fact.source, sourceUrl: fact.sourceUrl, offline: fact.offline });
    const trimmed = history.slice(-HISTORY_LIMIT);

    await writeFile(DATA_PATH, JSON.stringify(trimmed, null, 2) + "\n", "utf8");
    console.log(`Added fact for ${todayStr} from ${fact.source}${fact.offline ? " (offline backup)" : ""}.`);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
