// One-off migration: removes any existing facts sourced from the CIA World
// Factbook (now dropped from fact-sources.mjs) and regenerates those
// specific dates using the current source pool. Also retroactively applies
// the DYK "..." -> "Did you know ..." rewrite and the stripHtml artifact
// fixes (undecoded &#160;, stray space before punctuation) to every
// remaining entry, since those were only fixed for newly-generated facts,
// not facts already saved before the fix.
//
// Run manually via .github/workflows/migrate-facts.yml (workflow_dispatch
// only — this never runs on a schedule, and is meant to be run once).

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { fetchFreshFact } from "./fact-sources.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH = path.join(__dirname, "..", "data", "facts-history.json");

function cleanText(text) {
    let cleaned = text
        .replace(/&nbsp;|&#160;/g, " ")
        .replace(/\s+/g, " ")
        .replace(/\s+([.,;:!?])/g, "$1")
        .trim();
    if (cleaned.startsWith("...")) {
        cleaned = cleaned.replace(/^\.\.\.\s*/, "Did you know ");
        if (!/[.!?]$/.test(cleaned)) cleaned += ".";
    }
    return cleaned;
}

async function loadHistory() {
    const raw = await readFile(DATA_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error(`${DATA_PATH} does not contain a JSON array`);
    return parsed;
}

async function main() {
    const original = await loadHistory();

    const datesToReplace = original
        .filter(entry => entry.source === "CIA World Factbook")
        .map(entry => entry.date)
        .sort(); // oldest first, so later regenerations see earlier ones for repeat-avoidance

    let history = original
        .filter(entry => entry.source !== "CIA World Factbook")
        .map(entry => ({ ...entry, text: cleanText(entry.text) }));

    console.log(`Cleaned text on ${history.length} remaining entries.`);
    console.log(`Replacing ${datesToReplace.length} CIA World Factbook entries: ${datesToReplace.join(", ")}`);

    const failedDays = [];
    for (const dateStr of datesToReplace) {
        const target = new Date(`${dateStr}T00:00:00Z`);
        let fact;
        try {
            fact = await fetchFreshFact(history, target);
        } catch (err) {
            console.warn(`All live sources failed for ${dateStr}:`, err.message || err);
            failedDays.push(dateStr);
            continue; // leave this day empty rather than fill it with an unrelated offline fallback
        }
        history.push({ date: dateStr, text: fact.text, source: fact.source, sourceUrl: fact.sourceUrl, offline: fact.offline });
        console.log(`Replaced ${dateStr} with a ${fact.source} fact.`);
    }

    history.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    await writeFile(DATA_PATH, JSON.stringify(history, null, 2) + "\n", "utf8");

    console.log(`\nMigration complete: ${history.length} total entries.`);
    if (failedDays.length > 0) {
        console.log(`Could not replace (left empty): ${failedDays.join(", ")}`);
    }
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
