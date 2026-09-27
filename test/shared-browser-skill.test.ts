import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const skill = readFileSync("skills-seed/shared-browser/SKILL.md", "utf8");
const manifest = JSON.parse(readFileSync("skills-seed/shared-browser/extension/manifest.json", "utf8")) as {
  manifest_version: number;
  content_scripts: Array<{ matches: string[]; js: string[] }>;
};

test("shared browser skill makes one-session concurrent Google Forms QA the release gate", () => {
  assert.match(skill, /one shared browser session/i);
  assert.match(skill, /Google Form release gate/);
  assert.match(skill, /exactly two workers/i);
  assert.match(skill, /same Browserbase session id/i);
  assert.match(skill, /real QM worker sessions/i);
  assert.match(skill, /\/v1\/swarm/);
  assert.match(skill, /overlapping worker turns/i);
  assert.match(skill, /Coordinator subprocesses[\s\S]*do not pass/i);
});

test("shared browser extension runs on every top-level page", () => {
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.content_scripts, [
    { matches: ["<all_urls>"], js: ["content.js"], run_at: "document_start", all_frames: false },
  ]);
});

test("shared browser scripts and extension parse", () => {
  execFileSync("python3", ["-m", "py_compile", "skills-seed/shared-browser/scripts/launch.py"]);
  execFileSync("python3", ["-m", "py_compile", "skills-seed/shared-browser/scripts/multi_agent.py"]);
  execFileSync("node", ["--check", "skills-seed/shared-browser/extension/content.js"]);
});
