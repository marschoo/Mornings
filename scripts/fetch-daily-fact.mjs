// Fetches one new fact for "today" (UTC) and appends it to data/facts-history.json.
// Runs once a day via .github/workflows/daily-fact.yml, so the fact is the same
// for every visitor and shows up whether or not anyone opens the app that day.

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH = path.join(__dirname, "..", "data", "facts-history.json");

const FACT_API_URL = "https://uselessfacts.jsph.pl/api/v2/facts/random?language=en";
const HISTORY_LIMIT = 400;
const RECENT_REPEAT_WINDOW = 60;
const API_ATTEMPTS = 8;

// Small offline backup list, used only if the live fact service can't be reached at all.
const FALLBACK_FACTS = [
    "Neutron stars are so incredibly dense that a single teaspoon of their matter would weigh approximately 6 billion tons on Earth.",
    "The giant Pacific octopus has three hearts, nine brains, and beautiful blue blood.",
    "Trees can communicate and support each other through an underground web of fungi, often called the 'Wood Wide Web'.",
    "Honey never spoils. Archeologists have uncovered pots of honey in ancient Egyptian tombs that are over 3,000 years old and perfectly edible.",
    "A day on Venus is longer than a Venusian year. It takes Venus 243 Earth days to rotate once, but only 225 Earth days to circle the Sun.",
    "Light traveling from the Sun takes precisely 8 minutes and 20 seconds to reach our eyes on Earth.",
    "The dot above the lowercase letters 'i' and 'j' has an official name: it is called a 'tittle'.",
    "Wombat droppings are perfectly cube-shaped, which stops them from rolling off rocks and markers used to map out their territory.",
    "Glass is not actually a liquid; it is an amorphous solid.",
    "Sunflowers are hyperaccumulators, meaning they can absorb toxic waste and radiation from the soil.",
    "Footprints left by astronauts on the Moon will likely persist for at least 100 million years, since there is no wind or water to erode them.",
    "Every single oxygen atom currently in our lungs was once forged inside the core of a dying, massive supergiant star.",
    "Bamboo is the fastest-growing plant on the planet. Some species can grow up to 35 inches in a single 24-hour period.",
    "Our Milky Way galaxy is on a slow-motion collision course with the neighboring Andromeda galaxy, set to merge in about 4.5 billion years.",
    "A child's laugh is infectious, but science shows laughing actually boosts your immune system by releasing protective T-cells and endorphins.",
    "Canada has more lake area than the rest of the world's lakes combined, housing over 60% of all lakes on our planet.",
    "The oldest living tree on Earth is a Great Basin bristlecone pine in California named Methuselah, estimated to be over 4,850 years old.",
    "Nothing with mass can travel at the speed of light, because it would require an infinite amount of energy to do so.",
    "Apples, pears, cherries, and peaches all belong to the Rosaceae family, making them close botanical cousins of the rose flower.",
    "The majestic monarch butterfly travels up to 3,000 miles during its annual migration, guided entirely by an internal solar compass."
];

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

function isRecentlySeen(text, history) {
    return history.slice(-RECENT_REPEAT_WINDOW).some(entry => entry.text === text);
}

async function fetchFreshFact(history) {
    let lastGood = null;
    for (let i = 0; i < API_ATTEMPTS; i++) {
        const response = await fetch(FACT_API_URL);
        if (!response.ok) throw new Error(`Fact API returned ${response.status}`);
        const data = await response.json();
        if (!data || !data.text) continue;
        lastGood = { text: data.text, source: data.source || null, sourceUrl: data.source_url || null, offline: false };
        if (!isRecentlySeen(data.text, history)) return lastGood;
    }
    // Every attempt collided with recent history — accept the last valid response rather than fail.
    if (lastGood) return lastGood;
    throw new Error("Fact API returned no usable facts");
}

function pickFallbackFact(history) {
    const unseen = FALLBACK_FACTS.filter(text => !isRecentlySeen(text, history));
    const pool = unseen.length > 0 ? unseen : FALLBACK_FACTS;
    const text = pool[Math.floor(Math.random() * pool.length)];
    return { text, source: "Mornings offline backup", sourceUrl: null, offline: true };
}

async function main() {
    const todayStr = getTodayDateString();
    const history = await loadHistory();

    if (history.some(entry => entry.date === todayStr)) {
        console.log(`Already have a fact for ${todayStr}, nothing to do.`);
        return;
    }

    let fact;
    try {
        fact = await fetchFreshFact(history);
    } catch (err) {
        console.warn("Live fact API failed, using offline backup:", err.message);
        fact = pickFallbackFact(history);
    }

    history.push({ date: todayStr, text: fact.text, source: fact.source, sourceUrl: fact.sourceUrl, offline: fact.offline });
    const trimmed = history.slice(-HISTORY_LIMIT);

    await writeFile(DATA_PATH, JSON.stringify(trimmed, null, 2) + "\n", "utf8");
    console.log(`Added fact for ${todayStr}${fact.offline ? " (offline backup)" : ""}.`);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
