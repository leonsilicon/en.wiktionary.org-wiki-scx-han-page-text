import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createReadStream } from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as readline from "node:readline";
import type { Readable, Writable } from "node:stream";
import { join } from "desm";

export const ENWIKTIONARY_PAGES_ARTICLES_MULTISTREAM_INDEX_TXT_URL = 'https://dumps.wikimedia.org/enwiktionary/20260501/enwiktionary-20260501-pages-articles-multistream-index.txt.bz2'
export const ENWIKTIONARY_PAGES_ARTICLES_MULTISTREAM_XML_URL = 'https://dumps.wikimedia.org/enwiktionary/20260501/enwiktionary-20260501-pages-articles-multistream.xml.bz2'
export const ENWIKTIONARY_PAGES_ARTICLES_MULTISTREAM_INDEX_TXT_BZ2_FILEPATH = join(import.meta.url, '../data', path.basename(ENWIKTIONARY_PAGES_ARTICLES_MULTISTREAM_INDEX_TXT_URL))
export const ENWIKTIONARY_PAGES_ARTICLES_MULTISTREAM_XML_BZ2_FILEPATH = join(import.meta.url, '../data', path.basename(ENWIKTIONARY_PAGES_ARTICLES_MULTISTREAM_XML_URL))

const HAN_TITLE_RE = /^\p{Script_Extensions=Han}$/u;

const DUMP_FILE =
  process.argv[2] ?? ENWIKTIONARY_PAGES_ARTICLES_MULTISTREAM_XML_BZ2_FILEPATH;
const INDEX_FILE =
  process.argv[3] ??
  ENWIKTIONARY_PAGES_ARTICLES_MULTISTREAM_INDEX_TXT_BZ2_FILEPATH;
const OUT_DIR = process.argv[4] ?? join(import.meta.url, "../unicode");
const INDEX_FILE_PATH = join(import.meta.url, "../index.js");
const INDEX_DTS_PATH = join(import.meta.url, "../index.d.ts");
const OUT_DIR_NAME = path.basename(OUT_DIR);

const normalizeTitle = (s: string): string => s.normalize("NFC");

function xmlUnescape(str: string): string {
  return str
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) =>
      String.fromCodePoint(parseInt(hex, 16)),
    )
    .replace(/&#([0-9]+);/g, (_, dec: string) =>
      String.fromCodePoint(parseInt(dec, 10)),
    )
    .replace(/&amp;/g, "&");
}

type IndexRecord = { offset: number; title: string };

function parseIndexLine(line: string): IndexRecord | null {
  const first = line.indexOf(":");
  if (first < 0) return null;
  const second = line.indexOf(":", first + 1);
  if (second < 0) return null;
  const offset = Number(line.slice(0, first));
  if (!Number.isFinite(offset)) return null;
  return { offset, title: line.slice(second + 1) };
}

function spawnBz2Decompress(
  args: string[],
  stdin: "pipe" | "ignore",
): ChildProcessByStdio<Writable | null, Readable, null> {
  return spawn("bzip2", ["-dc", ...args], {
    stdio: [stdin, "pipe", "inherit"],
  }) as ChildProcessByStdio<Writable | null, Readable, null>;
}

type IndexScan = {
  // offset -> set of Han titles in that compressed stream
  offsetToTitles: Map<number, Set<string>>;
  // offset -> next stream's offset (end of this stream, exclusive)
  offsetToEndOffset: Map<number, number>;
  totalTitles: number;
};

async function scanIndex(indexPath: string): Promise<IndexScan> {
  const offsetToTitles = new Map<number, Set<string>>();
  const offsetToEndOffset = new Map<number, number>();

  const proc = indexPath.endsWith(".bz2")
    ? spawnBz2Decompress([indexPath], "ignore")
    : null;
  const stream: Readable = proc ? proc.stdout : createReadStream(indexPath);

  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let lastOffset: number | null = null;
  let totalTitles = 0;

  for await (const line of rl) {
    if (!line) continue;
    const rec = parseIndexLine(line);
    if (!rec) continue;
    const { offset, title } = rec;

    if (lastOffset !== null && offset !== lastOffset) {
      // We just crossed into a new stream — fix the previous stream's end
      // only if we actually need that stream.
      if (offsetToTitles.has(lastOffset) && !offsetToEndOffset.has(lastOffset)) {
        offsetToEndOffset.set(lastOffset, offset);
      }
    }
    lastOffset = offset;

    const normTitle = normalizeTitle(title);
    if (!HAN_TITLE_RE.test(normTitle)) continue;

    let set = offsetToTitles.get(offset);
    if (!set) {
      set = new Set();
      offsetToTitles.set(offset, set);
    }
    if (!set.has(normTitle)) {
      set.add(normTitle);
      totalTitles++;
    }
  }

  if (proc) {
    await new Promise<void>((resolve, reject) => {
      proc.on("error", reject);
      proc.on("close", (code) => {
        if (code !== 0)
          reject(new Error(`Index decompression failed (code ${code})`));
        else resolve();
      });
    });
  }

  return { offsetToTitles, offsetToEndOffset, totalTitles };
}

const PAGE_OPEN = "<page>";
const PAGE_CLOSE = "</page>";
const TITLE_OPEN = "<title>";
const TITLE_CLOSE = "</title>";
const TEXT_OPEN_RE = /<text\b[^>]*>/;
const TEXT_CLOSE = "</text>";

// Wikitext value: bare string = raw page text; [string] = redirect target.
type PageValue = string | [string];

// MediaWiki redirect syntax: leading "#REDIRECT [[target]]" (case-insensitive,
// optional whitespace, optional anchor like [[target#section]] which we strip).
const REDIRECT_RE = /^\s*#redirect\s*\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/i;

function parsePageValue(text: string): PageValue {
  const m = REDIRECT_RE.exec(text);
  if (!m) return text;
  return [normalizeTitle(m[1]!.trim())];
}

function extractFieldFromPage(
  pageXml: string,
): { title: string; text: string } | null {
  const tOpen = pageXml.indexOf(TITLE_OPEN);
  if (tOpen === -1) return null;
  const tClose = pageXml.indexOf(TITLE_CLOSE, tOpen + TITLE_OPEN.length);
  if (tClose === -1) return null;
  const rawTitle = pageXml.slice(tOpen + TITLE_OPEN.length, tClose);

  const textOpenMatch = TEXT_OPEN_RE.exec(pageXml);
  if (!textOpenMatch) return { title: xmlUnescape(rawTitle), text: "" };
  const textBodyStart = textOpenMatch.index + textOpenMatch[0].length;
  const textClose = pageXml.indexOf(TEXT_CLOSE, textBodyStart);
  if (textClose === -1) return { title: xmlUnescape(rawTitle), text: "" };
  const rawText = pageXml.slice(textBodyStart, textClose);

  return { title: xmlUnescape(rawTitle), text: xmlUnescape(rawText) };
}

async function extractPagesFromStreamBlock(
  dumpPath: string,
  startOffset: number,
  endOffsetExclusive: number,
  wantedTitles: Set<string>,
  out: Map<string, PageValue>,
): Promise<void> {
  const input = createReadStream(dumpPath, {
    start: startOffset,
    end: endOffsetExclusive - 1,
  });
  const bz = spawnBz2Decompress([], "pipe");

  let buffer = "";
  let sawAnyOutput = false;
  let remaining = wantedTitles.size;

  bz.stdout.setEncoding("utf8");

  const done = new Promise<void>((resolve, reject) => {
    input.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EPIPE") return;
      reject(err);
    });
    bz.stdin?.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EPIPE") return;
      reject(err);
    });
    bz.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        reject(new Error("Missing 'bzip2' command on PATH."));
      } else {
        reject(err);
      }
    });

    bz.stdout.on("data", (chunk: string) => {
      sawAnyOutput = true;
      buffer += chunk;

      // Discard pre-page junk so the buffer can't grow without bound.
      const firstPage = buffer.indexOf(PAGE_OPEN);
      if (firstPage > 0) buffer = buffer.slice(firstPage);
      else if (firstPage === -1) {
        // Keep only enough tail bytes to recognise <page> across a chunk seam.
        if (buffer.length > PAGE_OPEN.length)
          buffer = buffer.slice(-PAGE_OPEN.length);
        return;
      }

      while (true) {
        const start = buffer.indexOf(PAGE_OPEN);
        if (start === -1) break;
        const end = buffer.indexOf(PAGE_CLOSE, start);
        if (end === -1) {
          if (start > 0) buffer = buffer.slice(start);
          break;
        }
        const pageXml = buffer.slice(start, end + PAGE_CLOSE.length);
        buffer = buffer.slice(end + PAGE_CLOSE.length);

        const fields = extractFieldFromPage(pageXml);
        if (!fields) continue;
        const title = normalizeTitle(fields.title);
        if (!wantedTitles.has(title)) continue;
        if (out.has(title)) continue;
        out.set(title, parsePageValue(fields.text));
        remaining--;
        if (remaining === 0) {
          // Stop early: tear down the decompressor; we have everything for
          // this block.
          input.destroy();
          bz.kill("SIGPIPE");
          return;
        }
      }
    });

    bz.on("close", (code) => {
      // SIGPIPE / early-exit codes are expected when we tear down after
      // finding every wanted title. Code 2 is "compressed file ends
      // unexpectedly", which happens when EPIPE hits bzip2's input.
      if (code === 0 || code === null || (code === 2 && sawAnyOutput)) {
        resolve();
      } else {
        reject(new Error(`bzip2 failed for stream (code ${code})`));
      }
    });
  });

  input.pipe(bz.stdin!);
  await done;
}

function bucketKey(title: string): string {
  const cp = title.codePointAt(0);
  if (cp === undefined) throw new Error("Empty title has no code point");
  return `${(cp >>> 8).toString(16)}xx`;
}

async function main(): Promise<void> {
  await fsp.mkdir(OUT_DIR, { recursive: true });

  const dumpStat = await fsp.stat(DUMP_FILE);
  const dumpSize = dumpStat.size;

  console.log(`📑 Scanning index ${INDEX_FILE}…`);
  const { offsetToTitles, offsetToEndOffset, totalTitles } =
    await scanIndex(INDEX_FILE);

  console.log(
    `📚 Matched ${totalTitles} Han title(s) across ${offsetToTitles.size} stream(s).`,
  );

  const pages = new Map<string, PageValue>();
  const missing: string[] = [];

  let streamIdx = 0;
  const totalStreams = offsetToTitles.size;
  for (const [offset, titles] of offsetToTitles) {
    streamIdx++;
    const endOffset = offsetToEndOffset.get(offset) ?? dumpSize;
    if (endOffset <= offset) {
      console.warn(
        `⚠️ Bad stream boundary at offset ${offset} (end=${endOffset}). Skipping.`,
      );
      continue;
    }

    if (streamIdx % 100 === 0 || streamIdx === totalStreams) {
      console.log(
        `🔎 [${streamIdx}/${totalStreams}] stream offset=${offset} titles=${titles.size}`,
      );
    }

    await extractPagesFromStreamBlock(
      DUMP_FILE,
      offset,
      endOffset,
      titles,
      pages,
    );

    for (const title of titles) {
      if (!pages.has(title)) missing.push(title);
    }
  }

  if (missing.length) {
    console.warn(
      `⚠️ ${missing.length} titles listed in index were not found in their streams.`,
    );
  }

  const buckets = new Map<string, Record<string, PageValue>>();
  // Insertion order is irrelevant for downstream consumers but sorted output
  // makes diffs across dump versions readable.
  for (const title of [...pages.keys()].sort()) {
    const key = bucketKey(title);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {};
      buckets.set(key, bucket);
    }
    bucket[title] = pages.get(title)!;
  }

  await Promise.all(
    [...buckets].map(([key, obj]) =>
      fsp.writeFile(path.join(OUT_DIR, `${key}.json`), JSON.stringify(obj), "utf8"),
    ),
  );
  console.log(
    `🎉 Wrote ${pages.size} pages across ${buckets.size} buckets -> ${OUT_DIR}`,
  );

  const titleToBucket = new Map<string, string>();
  for (const [key, obj] of buckets) {
    for (const title of Object.keys(obj)) {
      titleToBucket.set(title, key);
    }
  }

  const indexLines: string[] = ["const wiktionaryPages = {"];
  for (const title of [...titleToBucket.keys()].sort()) {
    const key = titleToBucket.get(title)!;
    const titleLiteral = JSON.stringify(title);
    indexLines.push(
      `\t${titleLiteral}: async () => (await import('./${OUT_DIR_NAME}/${key}.json', { with: { type: 'json' } })).default[${titleLiteral}],`,
    );
  }
  indexLines.push("};", "", "export default wiktionaryPages;", "");
  await fsp.writeFile(INDEX_FILE_PATH, indexLines.join("\n"), "utf8");
  console.log(`🗂️ Wrote character index -> ${INDEX_FILE_PATH}`);

  const dtsLines: string[] = [
    "export type WiktionaryPageValue = string | [string];",
    "",
    "declare const wiktionaryPages: {",
  ];
  for (const title of [...titleToBucket.keys()].sort()) {
    const titleLiteral = JSON.stringify(title);
    dtsLines.push(`\t${titleLiteral}: () => Promise<WiktionaryPageValue>;`);
  }
  dtsLines.push("};", "", "export default wiktionaryPages;", "");
  await fsp.writeFile(INDEX_DTS_PATH, dtsLines.join("\n"), "utf8");
  console.log(`🗂️ Wrote character index types -> ${INDEX_DTS_PATH}`);
}

main().catch((err: unknown) => {
  console.error("💥 Fatal error:", err);
  process.exitCode = 1;
});
