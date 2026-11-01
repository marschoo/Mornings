// One-off backfill: retroactively finds an image for the most recent N
// Library entries that don't already have one, using the same source
// functions as the daily fetch (scripts/fact-sources.mjs). Run manually via
// .github/workflows/backfill-images.yml (workflow_dispatch only — this never
// runs on a schedule).
//
// Only Wikipedia On This Day and NASA (date-keyed sources) can be reliably
// matched back to a specific past entry. Wikipedia DYK exposes no historical
// archive, so it's only a best-effort check of whether the exact same hook
// happens to still be live right now — usually not, and that's expected.
// Our World in Data, Smithsonian, and the offline fallback have no images
// to find at all, so entries from those sources are skipped outright.

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { findOnThisDayImage, findNasaImage, findDykImageIfStillLive } from "./fact-sources.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH = path.join(__dirname, "..", "data", "facts-history.json");

const BACKFILL_COUNT = Number(process.env.BACKFILL_IMAGES_COUNT || 15);

async function loadHistory() {
    const raw = await readFile(DATA_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error(`${DATA_PATH} does not contain a JSON array`);
    return parsed;
}

async function main() {
    const history = await loadHistory();
    const candidates = history.filter(entry => !entry.imageUrl).slice(-BACKFILL_COUNT);

    console.log(`Checking the ${candidates.length} most recent entries without an image.`);

    let found = 0;
    let noImageAvailable = 0;
    let notPossible = 0;

    for (const entry of candidates) {
        const targetDate = new Date(`${entry.date}T00:00:00Z`);
        try {
            if (entry.source === "Wikipedia — On This Day") {
                const imageUrl = await findOnThisDayImage(targetDate, entry.text);
                if (imageUrl) {
                    entry.imageUrl = imageUrl;
                    found++;
                    console.log(`${entry.date}: found an image (On This Day).`);
                } else {
                    noImageAvailable++;
                    console.log(`${entry.date}: matched the event, but it has no image.`);
                }
            } else if (entry.source?.startsWith("NASA — ")) {
                const imageUrl = await findNasaImage(targetDate);
                if (imageUrl) {
                    entry.imageUrl = imageUrl;
                    found++;
                    console.log(`${entry.date}: found an image (NASA APOD).`);
                } else {
                    noImageAvailable++;
                    console.log(`${entry.date}: APOD for that date was a video, not a photo.`);
                }
            } else if (entry.source === "Wikipedia — Did You Know") {
                const imageUrl = await findDykImageIfStillLive(entry.text);
                if (imageUrl) {
                    entry.imageUrl = imageUrl;
                    found++;
                    console.log(`${entry.date}: hook is still live and has an image.`);
                } else {
                    notPossible++;
                    console.log(`${entry.date}: DYK hook is no longer live (expected — no historical archive) or has no image.`);
                }
            } else {
                notPossible++;
                console.log(`${entry.date}: ${entry.source} has no images to find, skipping.`);
            }
        } catch (err) {
            notPossible++;
            console.warn(`${entry.date}: lookup failed — ${err.message || err}`);
        }
    }

    await writeFile(DATA_PATH, JSON.stringify(history, null, 2) + "\n", "utf8");

    console.log(`\nBackfill complete: added images to ${found} of ${candidates.length} checked entries.`);
    console.log(`No image available for the matched content: ${noImageAvailable}. Not possible for this source: ${notPossible}.`);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
