// Shared fact-source logic used by both the daily fetch
// (scripts/fetch-daily-fact.mjs) and the one-off backfill
// (scripts/backfill-facts.mjs). No AI rewriting here on purpose: for a
// feature explicitly about trustworthy facts, raw extracted text from an
// authoritative source is more trustworthy than letting a model paraphrase
// it, which would just reintroduce the same "can I trust this?" problem
// this exists to fix.
//
// Weights (of 100): Wikipedia "Did You Know" 50, and 10 each for Wikipedia
// On This Day, the CIA World Factbook, NASA's Astronomy Picture of the Day,
// Our World in Data, and the Smithsonian Open Access API.
//
// NASA and Smithsonian need a free API key (NASA_API_KEY / SMITHSONIAN_API_KEY
// repository secrets) to work. Until configured, those two sources fail their
// attempt and the weighted retry naturally falls through to one of the other
// four, which need no key at all.

export const RECENT_REPEAT_WINDOW = 60; // avoid repeating a fact seen in the last N entries
export const FETCH_ATTEMPTS = 10;

// Small offline backup list, used only if every live source fails.
export const FALLBACK_FACTS = [
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

export function isRecentlySeen(text, history) {
    return history.slice(-RECENT_REPEAT_WINDOW).some(entry => entry.text === text);
}

function pick(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}

function stripHtml(html) {
    return html
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, " ")
        .trim();
}

function truncateToSentences(text, maxChars) {
    const sentences = text.match(/[^.!?]+[.!?]+(\s|$)/g) || [text];
    let out = "";
    for (const sentence of sentences) {
        if (out.length > 0 && (out + sentence).length > maxChars) break;
        out += sentence;
    }
    out = out.trim();
    return out.length > 0 ? out : text.slice(0, maxChars).trim();
}

// ---- Source: Wikipedia "Did You Know" (weight 50) ----
// Pulled straight from the Did You Know template transcluded on the Main
// Page — each hook there has already gone through Wikipedia's DYK review
// process, which requires a citation before a hook is allowed to run.
// No historical archive is exposed via this method — it always reflects
// whichever hooks are live right now, regardless of any target date passed
// in elsewhere in this module.
async function fetchWikipediaDYK() {
    const response = await fetch(
        "https://en.wikipedia.org/w/api.php?action=parse&page=Template:Did_you_know&format=json&formatversion=2&prop=text"
    );
    if (!response.ok) throw new Error(`Wikipedia DYK returned ${response.status}`);
    const data = await response.json();
    const html = data?.parse?.text;
    if (!html) throw new Error("Wikipedia DYK: no parse.text in response");

    const items = [...html.matchAll(/<li>([\s\S]*?)<\/li>/g)].map(m => m[1]);
    // The template also renders footer/nav links (e.g. "Nominate an article")
    // as <li> elements alongside the real hooks. Every real DYK hook follows
    // Wikipedia's house style of starting with an ellipsis ("... that ..."),
    // which reliably tells the two apart.
    const hooks = items
        .map(html => ({ html, text: stripHtml(html) }))
        .filter(item => item.text.startsWith("...") && item.text.length >= 25);
    if (hooks.length === 0) throw new Error("Wikipedia DYK: no '...'-prefixed hooks found in template");

    const chosen = pick(hooks);
    const linkMatch = chosen.html.match(/<a[^>]+href="(\/wiki\/[^"#]+)"/);

    return {
        text: /[.!?]$/.test(chosen.text) ? chosen.text : `${chosen.text}.`,
        source: "Wikipedia — Did You Know",
        sourceUrl: linkMatch ? `https://en.wikipedia.org${linkMatch[1]}` : "https://en.wikipedia.org/wiki/Main_Page"
    };
}

// ---- Source: Wikipedia On This Day (weight 10) ----
// Keyed off month/day only, so it's genuinely accurate for any target date
// passed in (the events repeat the same every year on that month/day).
async function fetchWikipediaOnThisDay(targetDate) {
    const mm = String(targetDate.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(targetDate.getUTCDate()).padStart(2, "0");
    const response = await fetch(`https://api.wikimedia.org/feed/v1/wikipedia/en/onthisday/selected/${mm}/${dd}`);
    if (!response.ok) throw new Error(`Wikipedia On This Day returned ${response.status}`);
    const data = await response.json();
    const events = data?.selected;
    if (!Array.isArray(events) || events.length === 0) throw new Error("Wikipedia On This Day: no events array");

    const event = pick(events);
    if (!event?.text || !event?.year) throw new Error("Wikipedia On This Day: event missing text/year");
    const page = event.pages?.[0];

    return {
        text: `On this day in ${event.year}: ${stripHtml(event.text)}`,
        source: "Wikipedia — On This Day",
        sourceUrl: page?.content_urls?.desktop?.page || "https://en.wikipedia.org/wiki/Main_Page"
    };
}

// ---- Source: CIA World Factbook (weight 10) ----
// Note: the CIA stopped publishing the Factbook in Feb 2026, so this is now
// a frozen archive (github.com/factbook/factbook.json) of the last published
// data rather than a live feed. Still a real government source, just not
// one that will stay current — fine for geography/history-flavored facts,
// less so for anything framed as "currently." Not date-dependent at all.
const FACTBOOK_COUNTRIES = [
    ["north-america", "us"], ["north-america", "ca"], ["north-america", "mx"],
    ["europe", "gm"], ["europe", "fr"], ["europe", "uk"], ["europe", "it"], ["europe", "sp"],
    ["europe", "po"], ["europe", "ne"], ["europe", "sw"], ["europe", "da"], ["europe", "no"],
    ["east-n-southeast-asia", "ja"], ["east-n-southeast-asia", "ch"], ["east-n-southeast-asia", "ks"],
    ["east-n-southeast-asia", "th"], ["east-n-southeast-asia", "vm"], ["east-n-southeast-asia", "rp"],
    ["south-asia", "in"], ["south-asia", "pk"],
    ["australia-oceania", "as"], ["australia-oceania", "nz"],
    ["south-america", "br"], ["south-america", "ar"], ["south-america", "ci"], ["south-america", "co"],
    ["africa", "eg"], ["africa", "sf"], ["africa", "ni"], ["africa", "ke"], ["africa", "mo"],
    ["middle-east", "is"], ["middle-east", "sa"], ["middle-east", "tu"], ["middle-east", "ir"]
];
const FACTBOOK_CATEGORIES = ["Introduction", "Geography", "People and Society", "Government", "Economy"];
// Filters out dry administrative/tabular fields (diplomatic addresses, trade
// figures, budget line items) that are accurate but read nothing like a fact.
const FACTBOOK_LABEL_BLOCKLIST = [
    "Diplomatic representation", "Imports", "Exports", "budget", "chancery", "consulate",
    "Fiscal year", "Currency", "Exchange rates", "GDP", "Debt", "Inflation", "Unemployment",
    "Labor force", "Industrial production", "Public debt", "Taxes", "Stock of"
];

function collectTextLeaves(node, labels = []) {
    const results = [];
    if (node == null || typeof node !== "object") return results;
    if (typeof node.text === "string" && node.text.trim().length > 0) {
        results.push({ label: labels.map(l => l.trim()).join(" — "), text: node.text });
    }
    for (const [key, value] of Object.entries(node)) {
        if (key === "text") continue;
        if (value && typeof value === "object") {
            results.push(...collectTextLeaves(value, [...labels, key]));
        }
    }
    return results;
}

async function fetchCIAFactbook() {
    const [region, code] = pick(FACTBOOK_COUNTRIES);
    const url = `https://raw.githubusercontent.com/factbook/factbook.json/master/${region}/${code}.json`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`CIA Factbook returned ${response.status} for ${region}/${code}`);
    const country = await response.json();

    const category = pick(FACTBOOK_CATEGORIES);
    const leaves = collectTextLeaves(country[category])
        .map(leaf => ({ ...leaf, text: stripHtml(leaf.text) }))
        .filter(leaf => leaf.text.length >= 25) // no upper bound — truncateToSentences() handles long entries below
        .filter(leaf => !FACTBOOK_LABEL_BLOCKLIST.some(term => leaf.label.includes(term)));
    if (leaves.length === 0) throw new Error(`CIA Factbook: no usable text in ${category} for ${region}/${code}`);

    const leaf = pick(leaves);
    const countryName = country?.Government?.["Country name"]?.["conventional short form"]?.text || code.toUpperCase();

    return {
        text: truncateToSentences(`${countryName} — ${leaf.label}: ${leaf.text}`, 400),
        source: "CIA World Factbook",
        sourceUrl: url.replace("raw.githubusercontent.com", "github.com").replace("/master/", "/blob/master/")
    };
}

// ---- Source: NASA Astronomy Picture of the Day (weight 10) ----
// Genuinely date-accurate: NASA's API accepts a `date` param for any past day.
async function fetchNASA(targetDate) {
    const apiKey = process.env.NASA_API_KEY;
    if (!apiKey) throw new Error("NASA_API_KEY not configured");
    const dateParam = targetDate.toISOString().slice(0, 10);
    const response = await fetch(
        `https://api.nasa.gov/planetary/apod?api_key=${encodeURIComponent(apiKey)}&date=${dateParam}`
    );
    if (!response.ok) throw new Error(`NASA APOD returned ${response.status}`);
    const data = await response.json();
    if (!data?.explanation || !data?.date) throw new Error("NASA APOD: missing explanation/date");

    const [y, m, d] = data.date.split("-");
    const permalink = `https://apod.nasa.gov/apod/ap${y.slice(2)}${m}${d}.html`;

    return {
        text: truncateToSentences(stripHtml(data.explanation), 350),
        source: `NASA — ${data.title || "Astronomy Picture of the Day"}`,
        sourceUrl: permalink
    };
}

// ---- Source: Our World in Data (weight 10) ----
// Not date-dependent — always reflects the latest published data point,
// regardless of which day this entry is filed under in the app.
const OWID_INDICATORS = [
    { slug: "life-expectancy", label: "global life expectancy at birth" },
    { slug: "co2-emissions-per-capita", label: "global CO2 emissions per person" },
    { slug: "share-of-population-urban", label: "the share of the world's population living in urban areas" },
    { slug: "literacy-rate-adults", label: "the global adult literacy rate" },
    { slug: "share-of-individuals-using-the-internet", label: "the share of people worldwide using the internet" }
];

function parseCsv(csvText) {
    const lines = csvText.trim().split("\n");
    const header = lines[0].split(",");
    return lines.slice(1).map(line => {
        const cells = line.split(",");
        const row = {};
        header.forEach((col, i) => { row[col.trim()] = cells[i]; });
        return row;
    });
}

async function fetchOWID() {
    const indicator = pick(OWID_INDICATORS);
    const response = await fetch(`https://ourworldindata.org/grapher/${indicator.slug}.csv?v=1&csvType=full`);
    if (!response.ok) throw new Error(`Our World in Data returned ${response.status} for ${indicator.slug}`);
    const rows = parseCsv(await response.text());
    const valueColumn = Object.keys(rows[0] || {}).find(k => !["Entity", "Code", "Year"].includes(k));
    if (!valueColumn) throw new Error(`Our World in Data: couldn't find a value column for ${indicator.slug}`);

    const worldRows = rows.filter(r => r.Entity === "World" && r[valueColumn] && r.Year);
    if (worldRows.length === 0) throw new Error(`Our World in Data: no World rows for ${indicator.slug}`);
    const latest = worldRows.reduce((a, b) => (Number(b.Year) > Number(a.Year) ? b : a));
    const value = Number(latest[valueColumn]);
    if (!Number.isFinite(value)) throw new Error(`Our World in Data: non-numeric value for ${indicator.slug}`);

    return {
        text: `As of ${latest.Year}, ${indicator.label} stands at ${value.toLocaleString(undefined, { maximumFractionDigits: 1 })}.`,
        source: "Our World in Data",
        sourceUrl: `https://ourworldindata.org/grapher/${indicator.slug}`
    };
}

// ---- Source: Smithsonian Open Access (weight 10) ----
// Not date-dependent.
const SMITHSONIAN_QUERIES = [
    "dinosaur", "space exploration", "ancient egypt", "insect", "meteorite",
    "civil war", "butterfly", "volcano", "ocean", "aircraft", "fossil", "gemstone"
];

async function fetchSmithsonian() {
    const apiKey = process.env.SMITHSONIAN_API_KEY;
    if (!apiKey) throw new Error("SMITHSONIAN_API_KEY not configured");
    const query = pick(SMITHSONIAN_QUERIES);
    const response = await fetch(
        `https://api.si.edu/openaccess/api/v1.0/search?q=${encodeURIComponent(query)}&rows=20&api_key=${encodeURIComponent(apiKey)}`
    );
    if (!response.ok) throw new Error(`Smithsonian API returned ${response.status}`);
    const data = await response.json();
    const rows = data?.response?.rows;
    if (!Array.isArray(rows) || rows.length === 0) throw new Error("Smithsonian: no rows returned");

    const candidates = rows.filter(r => r?.title && r?.content?.freetext?.notes?.[0]?.content);
    if (candidates.length === 0) throw new Error("Smithsonian: no row had both a title and a description");
    const record = pick(candidates);
    const url = record?.content?.descriptiveNonRepeating?.record_link
        || `https://www.si.edu/search?edan_q=${encodeURIComponent(query)}`;

    return {
        text: truncateToSentences(`${record.title}: ${stripHtml(record.content.freetext.notes[0].content)}`, 320),
        source: "Smithsonian Open Access",
        sourceUrl: url
    };
}

function buildSources(targetDate) {
    return [
        { name: "wikipedia_dyk", weight: 50, fetchFn: () => fetchWikipediaDYK() },
        { name: "wikipedia_onthisday", weight: 10, fetchFn: () => fetchWikipediaOnThisDay(targetDate) },
        { name: "cia_factbook", weight: 10, fetchFn: () => fetchCIAFactbook() },
        { name: "nasa_apod", weight: 10, fetchFn: () => fetchNASA(targetDate) },
        { name: "our_world_in_data", weight: 10, fetchFn: () => fetchOWID() },
        { name: "smithsonian", weight: 10, fetchFn: () => fetchSmithsonian() }
    ];
}

function weightedPick(sources) {
    const total = sources.reduce((sum, s) => sum + s.weight, 0);
    let r = Math.random() * total;
    for (const source of sources) {
        if (r < source.weight) return source;
        r -= source.weight;
    }
    return sources[sources.length - 1];
}

// targetDate controls the two date-aware sources (NASA, On This Day); the
// other four are evergreen and ignore it. Defaults to now, for the daily case.
export async function fetchFreshFact(history, targetDate = new Date()) {
    const sources = buildSources(targetDate);
    let lastGood = null;
    const failures = [];
    for (let i = 0; i < FETCH_ATTEMPTS; i++) {
        const source = weightedPick(sources);
        try {
            const fact = await source.fetchFn();
            if (!fact?.text) continue;
            lastGood = { text: fact.text, source: fact.source, sourceUrl: fact.sourceUrl, offline: false };
            if (!isRecentlySeen(fact.text, history)) return lastGood;
        } catch (err) {
            failures.push(`${source.name}: ${err.message || err}`);
        }
    }
    if (lastGood) return lastGood; // every attempt either failed or collided with recent history
    throw new Error(`All ${FETCH_ATTEMPTS} source attempts failed:\n${failures.join("\n")}`);
}

export function pickFallbackFact(history) {
    const unseen = FALLBACK_FACTS.filter(text => !isRecentlySeen(text, history));
    const pool = unseen.length > 0 ? unseen : FALLBACK_FACTS;
    const text = pool[Math.floor(Math.random() * pool.length)];
    return { text, source: "Mornings offline backup", sourceUrl: null, offline: true };
}
