import { readFileSync } from "node:fs";
const OPENAI_API_URL = "https://api.openai.com/v1/responses";
const GITHUB_API_URL = process.env.GITHUB_API_URL || "https://api.github.com";
function getInput(name, options = {}) {
    const envName = `INPUT_${name.replace(/ /g, "_").toUpperCase()}`;
    const value = process.env[envName]?.trim() || "";
    if (options.required && !value) {
        throw new Error(`Missing required input: ${name}`);
    }
    return value;
}
function parsePositiveInteger(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
function requireEnv(name) {
    const value = process.env[name];
    if (!value) {
        throw new Error(`Missing required environment variable: ${name}`);
    }
    return value;
}
function readEvent() {
    const eventPath = requireEnv("GITHUB_EVENT_PATH");
    const event = JSON.parse(readFileSync(eventPath, "utf8"));
    if (!event.pull_request?.number) {
        throw new Error("Codex PR Review Bot only runs on pull_request events.");
    }
    return event;
}
async function githubRequest(path, token, options = {}) {
    const response = await fetch(`${GITHUB_API_URL}${path}`, {
        ...options,
        headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${token}`,
            "User-Agent": "codex-pr-review-bot",
            "X-GitHub-Api-Version": "2022-11-28",
            ...(options.headers || {})
        }
    });
    const bodyText = await response.text();
    const body = bodyText ? JSON.parse(bodyText) : null;
    if (!response.ok) {
        throw new Error(`GitHub API ${response.status}: ${body?.message || bodyText}`);
    }
    return body;
}
async function fetchPullRequestFiles({ owner, repo, pullNumber, token, maxFiles }) {
    const files = [];
    let page = 1;
    while (files.length < maxFiles) {
        const batch = await githubRequest(`/repos/${owner}/${repo}/pulls/${pullNumber}/files?per_page=100&page=${page}`, token);
        files.push(...batch);
        if (batch.length < 100)
            break;
        page += 1;
    }
    return files.slice(0, maxFiles);
}
function formatPatch(files, maxPatchChars) {
    const chunks = [];
    let totalChars = 0;
    for (const file of files) {
        const patch = file.patch || "[binary file or patch unavailable]";
        const chunk = [
            `File: ${file.filename}`,
            `Status: ${file.status}`,
            `Additions: ${file.additions}, deletions: ${file.deletions}`,
            "Patch:",
            patch
        ].join("\n");
        if (totalChars + chunk.length > maxPatchChars) {
            const remaining = maxPatchChars - totalChars;
            if (remaining > 500) {
                chunks.push(`${chunk.slice(0, remaining)}\n[truncated]`);
            }
            break;
        }
        chunks.push(chunk);
        totalChars += chunk.length;
    }
    return chunks.join("\n\n---\n\n");
}
function extractOutputText(response) {
    if (typeof response.output_text === "string" && response.output_text.trim()) {
        return response.output_text.trim();
    }
    const text = [];
    for (const item of response.output || []) {
        for (const content of item.content || []) {
            if (content.type === "output_text" && content.text) {
                text.push(content.text);
            }
        }
    }
    return text.join("\n").trim();
}
async function createReview({ openaiApiKey, model, event, files, maxPatchChars }) {
    const patch = formatPatch(files, maxPatchChars);
    const pullRequest = event.pull_request;
    const response = await fetch(OPENAI_API_URL, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${openaiApiKey}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            model,
            store: false,
            max_output_tokens: 1800,
            instructions: [
                "You are Codex performing a pull request review.",
                "Prioritize concrete bugs, security issues, regressions, data loss risks, and missing tests.",
                "Do not nitpick style unless it creates a real maintainability or behavior problem.",
                "Return concise Markdown with: Findings, Tests, and Residual risk.",
                "If no material issues are found, say that clearly."
            ].join("\n"),
            input: [
                `Repository: ${event.repository.full_name}`,
                `Pull request: #${pullRequest.number} ${pullRequest.title}`,
                `Author: ${pullRequest.user?.login || "unknown"}`,
                `Base: ${pullRequest.base?.ref}`,
                `Head: ${pullRequest.head?.ref}`,
                "",
                "Changed files and patches:",
                patch || "No patch content was available."
            ].join("\n")
        })
    });
    const bodyText = await response.text();
    const body = bodyText ? JSON.parse(bodyText) : null;
    if (!response.ok) {
        throw new Error(`OpenAI API ${response.status}: ${body?.error?.message || bodyText}`);
    }
    if (!body) {
        throw new Error("OpenAI returned an empty response body.");
    }
    const review = extractOutputText(body);
    if (!review) {
        throw new Error("OpenAI returned an empty review.");
    }
    return review;
}
async function postPullRequestReview({ owner, repo, pullNumber, token, body }) {
    return githubRequest(`/repos/${owner}/${repo}/pulls/${pullNumber}/reviews`, token, {
        method: "POST",
        body: JSON.stringify({
            event: "COMMENT",
            body
        })
    });
}
async function main() {
    const openaiApiKey = getInput("openai_api_key", { required: true });
    const githubToken = getInput("github_token", { required: true });
    const model = getInput("model") || "gpt-5";
    const maxFiles = parsePositiveInteger(getInput("max_files"), 40);
    const maxPatchChars = parsePositiveInteger(getInput("max_patch_chars"), 60000);
    const event = readEvent();
    const pullRequest = event.pull_request;
    if (!pullRequest) {
        throw new Error("Codex PR Review Bot only runs on pull_request events.");
    }
    const [owner, repo] = event.repository.full_name.split("/");
    if (!owner || !repo) {
        throw new Error(`Invalid repository full name: ${event.repository.full_name}`);
    }
    const files = await fetchPullRequestFiles({
        owner,
        repo,
        pullNumber: pullRequest.number,
        token: githubToken,
        maxFiles
    });
    const review = await createReview({
        openaiApiKey,
        model,
        event: { ...event, pull_request: pullRequest },
        files,
        maxPatchChars
    });
    const body = [
        "## Codex Review",
        "",
        review,
        "",
        "<sub>Generated by Codex PR Review Bot using this repository's configured OpenAI API key.</sub>"
    ].join("\n");
    await postPullRequestReview({ owner, repo, pullNumber: pullRequest.number, token: githubToken, body });
    console.log(`Posted Codex review for ${event.repository.full_name}#${pullRequest.number}`);
}
main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
});
