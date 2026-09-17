// Generates one grammar lesson per language for "today" (UTC) and appends it
// to data/learn-history.json, using the Claude API. Runs once a day via
// .github/workflows/daily-fact.yml, alongside the daily fact fetch, so the
// lesson is the same for every visitor and ready whether or not anyone opens
// the app that day.
//
// Requires the ANTHROPIC_API_KEY secret to be set on the repository
// (Settings -> Secrets and variables -> Actions). The workflow skips this
// step entirely if that secret isn't configured yet.

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH = path.join(__dirname, "..", "data", "learn-history.json");

const LANGUAGES = [
    { code: "de", name: "German" },
    { code: "da", name: "Danish" }
];

const MODEL = "claude-opus-5";
const HISTORY_LIMIT = 500; // per file, across both languages
const RECENT_TOPICS_WINDOW = 20; // how many past rule titles (per language) to avoid repeating

const LessonSchema = z.object({
    rule_title: z.string().describe("Short name of the grammar rule, e.g. 'Definite articles in the plural'"),
    rule_explanation: z.string().describe("Clear explanation of the rule in English, 2-4 sentences, beginner/intermediate level"),
    examples: z
        .array(
            z.object({
                sentence: z.string().describe("Example sentence in the target language"),
                translation: z.string().describe("English translation of the sentence")
            })
        )
        .length(3)
        .describe("Exactly three example sentences that demonstrate the rule"),
    exercise: z.object({
        prompt: z.string().describe("A sentence in the target language with a blank marked as ___"),
        answer: z.string().describe("The word or short phrase that correctly fills the blank"),
        hint: z.string().describe("A short hint, without giving the answer away"),
        explanation: z.string().describe("Why this answer is correct, referencing the rule")
    })
});

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

async function generateLesson(client, languageName, recentTopics) {
    const system =
        "You write a single daily grammar lesson for an adult beginner-to-intermediate learner of " +
        languageName +
        " as a foreign language. Pick exactly one clear, useful grammar point " +
        "(e.g. word order, articles and gender, noun cases, verb conjugation and tense, adjective endings, " +
        "pronouns, prepositions, plural forms, modal verbs, negation). Explain it simply in English. " +
        "Give exactly three example sentences in " +
        languageName +
        " with natural English translations that clearly demonstrate the rule. " +
        "Then write one fill-in-the-blank exercise: a sentence in " +
        languageName +
        " with a single blank marked as ___ that tests the same rule, its correct answer, a short hint " +
        "that doesn't give the answer away, and a brief explanation of why that answer is correct.";

    const avoidNote =
        recentTopics.length > 0
            ? ` Avoid repeating these topics covered in recent days: ${recentTopics.join("; ")}.`
            : "";

    const message = await client.beta.messages.parse({
        model: MODEL,
        max_tokens: 16000,
        output_config: { effort: "medium" },
        output_format: betaZodOutputFormat(LessonSchema),
        system,
        messages: [
            {
                role: "user",
                content: `Create today's ${languageName} grammar lesson.${avoidNote}`
            }
        ]
    });

    if (!message.parsed_output) {
        throw new Error(`Model response for ${languageName} did not parse against the lesson schema`);
    }
    return message.parsed_output;
}

async function main() {
    const todayStr = getTodayDateString();
    const history = await loadHistory();
    const client = new Anthropic();

    let changed = false;
    const failures = [];

    for (const { code, name } of LANGUAGES) {
        if (history.some(entry => entry.date === todayStr && entry.language === code)) {
            console.log(`Already have a ${name} lesson for ${todayStr}, skipping.`);
            continue;
        }

        const recentTopics = history
            .filter(entry => entry.language === code)
            .slice(-RECENT_TOPICS_WINDOW)
            .map(entry => entry.rule_title);

        try {
            const lesson = await generateLesson(client, name, recentTopics);
            history.push({ date: todayStr, language: code, ...lesson });
            changed = true;
            console.log(`Added ${name} lesson for ${todayStr}: ${lesson.rule_title}`);
        } catch (err) {
            console.error(`Failed to generate ${name} lesson:`, err.message || err);
            failures.push(name);
        }
    }

    if (changed) {
        const trimmed = history.slice(-HISTORY_LIMIT);
        await writeFile(DATA_PATH, JSON.stringify(trimmed, null, 2) + "\n", "utf8");
    }

    if (failures.length > 0) {
        // Exit non-zero so the workflow step is visibly flagged, but only after
        // writing whatever languages did succeed above.
        throw new Error(`Failed to generate lessons for: ${failures.join(", ")}`);
    }
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
