// Generates one grammar lesson per language for "today" (UTC) and appends it
// to data/learn-history.json, using the Gemini API (free tier). Runs once a
// day via .github/workflows/daily-fact.yml, alongside the daily fact fetch,
// so the lesson is the same for every visitor and ready whether or not
// anyone opens the app that day.
//
// Requires the GEMINI_API_KEY secret to be set on the repository (Settings
// -> Secrets and variables -> Actions), using a free key from Google AI
// Studio (aistudio.google.com/apikey). The workflow skips this step
// entirely if that secret isn't configured yet.

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { GoogleGenAI } from "@google/genai";
import { z } from "zod";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH = path.join(__dirname, "..", "data", "learn-history.json");

const LANGUAGES = [
    { code: "de", name: "German" },
    { code: "da", name: "Danish" }
];

// Rolling alias for Gemini's current flash-tier model — fast, free-tier
// friendly, and well suited to a bounded structured-JSON task like this.
const MODEL = "gemini-flash-latest";

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

const LESSON_JSON_SCHEMA = z.toJSONSchema(LessonSchema);

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

async function generateLesson(ai, languageName, coveredTopics) {
    const instructions =
        "You are teaching a structured, ongoing beginner-to-intermediate " +
        languageName +
        " grammar curriculum to an adult learner, one lesson per day. This is a learning path, not a " +
        "random trivia feed: sequence topics so foundational concepts come before the ones that depend " +
        "on them (e.g. basic sentence structure before subordinate-clause word order, present tense " +
        "before compound past tenses, singular forms before plural exceptions). Given the list of topics " +
        "already taught, in the order they were taught, choose the single most logical next topic to " +
        "introduce. Only revisit an earlier topic when it meaningfully deepens or extends what was " +
        "already covered (e.g. a new exception or a harder case of the same rule), and say explicitly in " +
        "the explanation how it builds on the earlier lesson — never repeat a topic as filler. " +
        "For each lesson: explain the grammar point simply in English; give exactly three example " +
        "sentences in " +
        languageName +
        " with natural English translations that clearly demonstrate the rule; then write one " +
        "fill-in-the-blank exercise — a sentence in " +
        languageName +
        " with a single blank marked as ___ that tests the same rule — with its correct answer, a short " +
        "hint that doesn't give the answer away, and a brief explanation of why that answer is correct.";

    const progressNote =
        coveredTopics.length > 0
            ? ` Topics already taught, oldest first: ${coveredTopics.join(" -> ")}.`
            : " No topics have been taught yet — start with the most foundational concept.";

    const prompt =
        instructions +
        `\n\nCreate today's ${languageName} grammar lesson, continuing the curriculum.${progressNote}`;

    const response = await ai.models.generateContent({
        model: MODEL,
        contents: prompt,
        config: {
            responseMimeType: "application/json",
            responseJsonSchema: LESSON_JSON_SCHEMA
        }
    });

    if (!response.text) {
        throw new Error(`Empty response for ${languageName} (finishReason: ${response.candidates?.[0]?.finishReason})`);
    }

    // The response is schema-guided but not schema-guaranteed — validate
    // before trusting it, same as every other external input.
    return LessonSchema.parse(JSON.parse(response.text));
}

async function main() {
    const todayStr = getTodayDateString();
    const history = await loadHistory();
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

    let changed = false;
    const failures = [];

    for (const { code, name } of LANGUAGES) {
        if (history.some(entry => entry.date === todayStr && entry.language === code)) {
            console.log(`Already have a ${name} lesson for ${todayStr}, skipping.`);
            continue;
        }

        const coveredTopics = history
            .filter(entry => entry.language === code)
            .map(entry => entry.rule_title);

        try {
            const lesson = await generateLesson(ai, name, coveredTopics);
            history.push({ date: todayStr, language: code, ...lesson });
            changed = true;
            console.log(`Added ${name} lesson for ${todayStr}: ${lesson.rule_title}`);
        } catch (err) {
            console.error(`Failed to generate ${name} lesson:`, err.message || err);
            failures.push(name);
        }
    }

    if (changed) {
        // No trimming here, unlike the facts file: this history is the
        // curriculum's memory of what's already been taught, and generateLesson()
        // depends on all of it to sequence topics sensibly — cutting it short
        // would make the app "forget" grammar it already covered.
        await writeFile(DATA_PATH, JSON.stringify(history, null, 2) + "\n", "utf8");
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
