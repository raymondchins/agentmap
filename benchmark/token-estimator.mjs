#!/usr/bin/env node
import { readFileSync, statSync } from "node:fs";

// To get actual cl100k_base count, you can run: npm install --no-save tiktoken
let tiktoken = null;
try {
  tiktoken = await import("tiktoken");
} catch (e) {
  // tiktoken not available, which is fine since agentmap is zero-dep.
}

const CL100K_REGEX = /'(?:[sdmt]|ll|ve|re)|[^\r\n\p{L}\p{N}]?\p{L}+|\p{N}{1,3}| ?[^\s\p{L}\p{N}]+[\r\n]*|\s*[\r\n]+|\s+(?!\S)|\s+/gui;

function legacyCharsPer4(s) {
  return Math.ceil((s || "").length / 4);
}

function cl100kRegexChunker(s) {
  if (!s) return 0;
  const chunks = s.match(CL100K_REGEX);
  return chunks ? Math.ceil(chunks.length * 1.12) : 0;
}

function actualCl100k(s) {
  if (!tiktoken) return null;
  const enc = tiktoken.get_encoding("cl100k_base");
  const count = enc.encode(s).length;
  enc.free();
  return count;
}

const formatPct = (base, compare) => {
  if (!base) return "N/A";
  const diff = compare - base;
  const pct = (diff / base) * 100;
  return `${pct > 0 ? "+" : ""}${pct.toFixed(2)}%`;
};

async function run() {
  const file = process.argv[2] || "agentmap.mjs";
  
  let content = "";
  try {
    const stat = statSync(file);
    if (!stat.isFile()) throw new Error();
    content = readFileSync(file, "utf8");
  } catch {
    console.error(`Could not read file: ${file}`);
    process.exit(1);
  }

  const chars4 = legacyCharsPer4(content);
  const chunker = cl100kRegexChunker(content);
  const actual = actualCl100k(content);

  console.log(`\n=== Token Estimator Benchmark ===`);
  console.log(`Target File  : ${file}`);
  console.log(`Size (chars) : ${content.length}`);
  console.log(`\nEstimations:`);
  console.log(`1. Legacy chars/4     : ${chars4}`);
  console.log(`2. Regex pre-chunker  : ${chunker}`);
  
  if (actual !== null) {
    console.log(`3. Actual cl100k_base : ${actual}`);
    console.log(`\nAccuracy (vs Actual cl100k_base):`);
    console.log(`- Legacy chars/4      : ${formatPct(actual, chars4)} error`);
    console.log(`- Regex pre-chunker   : ${formatPct(actual, chunker)} error`);
  } else {
    console.log(`\n(Install 'tiktoken' via npm to see actual cl100k_base counts for comparison)`);
    console.log(`Diff (Chunker vs Chars/4): ${formatPct(chars4, chunker)}`);
  }
  console.log("\n=================================");
}

run();
