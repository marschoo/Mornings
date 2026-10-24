// One-off backfill: fills in facts for the N days before today that don't
// already have an entry, using the same multi-source logic as the daily
// fetch (scripts/fact-sources.mjs). Run manually via
// .github/workflows/backfill-facts.yml (workflow_dispatch only — this never
// runs on a schedule).
//
// Date accuracy varies by source: NASA (real historical `date` param) and
// Wikipedia On This Day (keyed by month/day, so correct regardless of year)
// are genuinely accurate for the day they're filed under. Wikipedia DYK, the
// CIA Factbook, Our World in Data, and Smithsonian are evergreen — picking
// one for a past day doesn't mean that's what the source actually showed on
// that date, just that the fact itself is real and still attributed to its
// real source.

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { fetchFreshFact } from "./fact-sources.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH = path.join(__dirname, "..", "data", "facts-history.json");

const HISTORY_LIMIT = 400;
const BACKFILL_DAYS = Number(process.env.BACKFILL_DAYS || 30);

function dateString(d) {
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

async function loadHistory() {
    let raw;
    try {
        raw = await readFile(DATA_PATH, "utf8");
    } catch (err) {
        if (err.code === "ENOENT") return [];
        throw err;
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error(`${DATA_PATH} does not contain a JSON array`);
    return parsed;
}

async function main() {
    const history = await loadHistory();
    const today = new Date();
    const failedDays = [];
    let added = 0;

    // Oldest first, so later days can see earlier backfilled entries for
    // repeat-avoidance, same as the real day-by-day history would accumulate.
    for (let i = BACKFILL_DAYS; i >= 1; i--) {
        const target = new Date(today);
        target.setUTCDate(target.getUTCDate() - i);
        const dateStr = dateString(target);

        if (history.some(entry => entry.date === dateStr)) {
            console.log(`Already have a fact for ${dateStr}, skipping.`);
            continue;
        }

        let fact;
        try {
            fact = await fetchFreshFact(history, target);
        } catch (err) {
            console.warn(`All live sources failed for ${dateStr}:`, err.message || err);
            failedDays.push(dateStr);
            continue; // don't fill backfill gaps with the offline backup list —
                      // better to leave a day missing than claim a canned fact is from that day
        }

        history.push({ date: dateStr, text: fact.text, source: fact.source, sourceUrl: fact.sourceUrl, offline: fact.offline });
        added++;
        console.log(`Added fact for ${dateStr} from ${fact.source}.`);
    }

    history.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const trimmed = history.slice(-HISTORY_LIMIT);
    await writeFile(DATA_PATH, JSON.stringify(trimmed, null, 2) + "\n", "utf8");

    console.log(`\nBackfill complete: added ${added} of ${BACKFILL_DAYS} requested days.`);
    if (failedDays.length > 0) {
        console.log(`Could not fill: ${failedDays.join(", ")}`);
    }
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
