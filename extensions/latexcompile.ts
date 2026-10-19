/**
 * latexcompile — compile a .tex file with pdflatex (non-interactive) and
 * automatically find & fix common errors/warnings so the document compiles.
 *
 * Registers:
 *   - a model-callable tool `latexcompile`
 *   - a slash command `/latexcompile`
 *
 * Behaviour:
 *   1. Runs pdflatex non-interactively, re-running (up to MAX_PASSES passes) to
 *      resolve cross-references, labels, and tables of contents.
 *   2. Parses the .log for errors and warnings.
 *   3. Auto-fixes well-defined, safe error classes directly in the .tex source:
 *        - missing \input/\include/\includegraphics/\bibliography file → the
 *          offending line is commented out (the file does not exist, so there is
 *          nothing to include).
 *        - undefined control sequence → the offending line is commented out
 *          (the original text is preserved in the comment).
 *        - undefined environment → the offending \begin/\end line is commented out.
 *   4. Mitigates overfull/underfull \hbox warnings by injecting
 *      \emergencystretch=3em into the preamble (once, if not already present).
 *   5. Re-runs the compile→fix loop until the document compiles or no further
 *      automatic fix is possible, then reports the remaining errors/warnings.
 *
 * On success, the PDF is opened in the system's default PDF viewer.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdirSync } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const execFileAsync = promisify(execFile);

const MAX_PASSES = 5;
const MAX_FIX_ITERATIONS = 15; // compile → fix → recompile cycles
const PASS_TIMEOUT_MS = 120_000; // per-pass safety timeout
const MAX_ERRORS = 40;
const MAX_WARNINGS = 80;

interface LatexCompileDetails {
  success: boolean;
  file: string;
  pdfPath: string;
  logPath: string;
  passes: number;
  errors: string[];
  warnings: string[];
  rerunNeeded: boolean;
  viewerOpened: boolean;
  viewerError: string | null;
}

/** A single edit made to the .tex source by the auto-fixer. */
interface Fix {
  line: number; // 1-based source line; 0 = preamble/global change
  before: string;
  after: string;
  reason: string;
}

interface LatexCompileResult extends LatexCompileDetails {
  fixIterations: number;
  fixes: Fix[];
}

type TexErrorKind =
  | "missing-file"
  | "undefined-control-sequence"
  | "environment-undefined"
  | "math-mode"
  | "fatal"
  | "unknown";

interface TexError {
  kind: TexErrorKind;
  message: string;
  line: number | null;
  sourceLine: string;
  context: string[];
}

/** Warning lines: overfull/underfull boxes, LaTeX/package/class warnings. */
const WARNING_RE =
  /Overfull \\hbox[^\n]*|Underfull \\hbox[^\n]*|Overfull \\vbox[^\n]*|Underfull \\vbox[^\n]*|LaTeX (?:Font )?Warning:[^\n]*|(?:Package|Class) \S+ Warning:[^\n]*/g;

/** Indicators that another pdflatex pass is needed (labels/TOC/cross-refs). */
const RERUN_RES = [
  /Rerun to get cross-references right/i,
  /Label\(s\) may have changed/i,
  /There were undefined references/i,
  /There were undefined citations/i,
  /Citation\(s\) may have changed/i,
  /Rerun LaTeX/i,
  /rerunfilecheck/i,
];

const FATAL_RE = /(?:^|\n)\s*(?:Fatal error|Emergency stop|No pages of output)\b/m;

function parseLog(text: string): { errors: string[]; warnings: string[]; rerunNeeded: boolean } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const lines = text.split(/\r?\n/);

  // Classic TeX error lines begin with "!". Follow-up "l.123 ..." lines are
  // the source context; attach them to the error for easier fixing.
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^!\s*(.*)$/);
    if (m) {
      let msg = m[1].trim();
      const next = lines[i + 1]?.trim() ?? "";
      if (/^l\.\d+/.test(next)) {
        msg += `\n  ${next}`;
        i++;
      }
      errors.push(msg);
    }
  }

  for (const m of text.matchAll(WARNING_RE)) {
    const w = m[0].trim();
    if (w) warnings.push(w);
  }

  if (errors.length === 0 && FATAL_RE.test(text)) {
    errors.push("Fatal error / emergency stop (see log for details)");
  }

  const rerunNeeded = RERUN_RES.some((re) => re.test(text));
  return { errors, warnings, rerunNeeded };
}

function classifyError(message: string): TexErrorKind {
  if (/file `[^']+' not found/i.test(message) || /^LaTeX Error: File /i.test(message)) return "missing-file";
  if (/Undefined control sequence/i.test(message)) return "undefined-control-sequence";
  if (/Environment \S+ undefined/i.test(message)) return "environment-undefined";
  if (/Missing \$ inserted|Display math should end with \$\$|Missing \} inserted|Extra \}, or forgotten \$|Missing \\right inserted/i.test(message)) return "math-mode";
  if (/Emergency stop|Fatal error/i.test(message)) return "fatal";
  return "unknown";
}

/** Parse errors together with their source line number (l.NNN) and context. */
function parseErrorsWithContext(logText: string): TexError[] {
  const errors: TexError[] = [];
  const lines = logText.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^!\s*(.*)$/);
    if (!m) continue;
    const message = m[1].trim();
    let line: number | null = null;
    let sourceLine = "";
    const context: string[] = [];
    for (let j = i + 1; j < lines.length && j <= i + 20; j++) {
      const l = lines[j];
      if (/^!\s/.test(l)) break;
      const lm = l.match(/^l\.(\d+)\s?(.*)$/);
      if (lm) {
        line = parseInt(lm[1], 10);
        sourceLine = lm[2] ?? "";
      } else if (l.trim()) {
        context.push(l);
      }
    }
    errors.push({ kind: classifyError(message), message, line, sourceLine, context });
  }
  return errors;
}

function extractMissingFile(message: string): string | null {
  const m = message.match(/File `([^']+)' not found/i);
  return m ? m[1] : null;
}

/** Best-effort identification of the unknown control sequence. */
function extractUndefinedCommand(e: TexError): string | null {
  const inSource = e.sourceLine.match(/\\[a-zA-Z@]+/g);
  if (inSource && inSource.length) return inSource[inSource.length - 1];
  for (const c of e.context) {
    const cm = c.match(/\\[a-zA-Z@]+/g);
    if (cm && /^<[^>]+>/.test(c.trim())) return cm[cm.length - 1];
  }
  return null;
}

function makeFix(line: number, before: string, after: string, reason: string): Fix {
  return { line, before: before.trim(), after, reason };
}

/**
 * Produce a fix for a single error, or null when the error is not auto-fixable
 * (or was already attempted). `lines` is mutated in place.
 */
function fixError(lines: string[], e: TexError, done: Set<string>): Fix | null {
  if (e.kind === "missing-file") {
    const missingFile = extractMissingFile(e.message);
    if (!missingFile) return null;
    const base = missingFile.replace(/\.[^.]+$/, "");
    const sig = `missing-file:${missingFile}`;
    if (done.has(sig)) return null;
    done.add(sig);
    for (let i = 0; i < lines.length; i++) {
      const src = lines[i];
      const m = src.match(
        /\\(?:input|include|includegraphics|bibliography|addbibresource|subfile|loadglsentries)\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/,
      );
      if (m && m[1].includes(base)) {
        return makeFix(
          i + 1,
          src,
          `% [latexcompile] auto-fixed: disabled reference to missing file "${missingFile}" (was: ${src.trim()})`,
          `missing file "${missingFile}" — commented out the reference so the document compiles`,
        );
      }
    }
    return null;
  }

  if (e.line == null || e.line < 1 || e.line > lines.length) return null;
  const idx = e.line - 1;
  const src = lines[idx];
  if (src == null) return null;

  if (e.kind === "undefined-control-sequence") {
    if (!/\\[a-zA-Z@]/.test(src)) return null;
    const sig = `undefined-control-sequence:${e.line}`;
    if (done.has(sig)) return null;
    done.add(sig);
    const cmd = extractUndefinedCommand(e);
    return makeFix(
      e.line,
      src,
      `% [latexcompile] auto-fixed: disabled undefined control sequence${cmd ? ` ${cmd}` : ""} (was: ${src.trim()})`,
      cmd ? `undefined control sequence ${cmd}` : "undefined control sequence",
    );
  }

  if (e.kind === "environment-undefined") {
    if (!/\\(?:begin|end|newenvironment|renewenvironment)\b/.test(src)) return null;
    const sig = `environment-undefined:${e.line}`;
    if (done.has(sig)) return null;
    done.add(sig);
    const env = e.message.match(/Environment (\S+) undefined/i)?.[1] ?? "";
    return makeFix(
      e.line,
      src,
      `% [latexcompile] auto-fixed: disabled reference to undefined environment${env ? ` ${env}` : ""} (was: ${src.trim()})`,
      env ? `undefined environment "${env}"` : "undefined environment",
    );
  }

  return null;
}

function applyFixes(lines: string[], errors: TexError[], done: Set<string>): Fix[] {
  const fixes: Fix[] = [];
  // Apply from the bottom of the file upward so earlier edits cannot shift
  // later (higher) line numbers.
  const sorted = [...errors].sort((a, b) => (b.line ?? 0) - (a.line ?? 0));
  for (const e of sorted) {
    const fix = fixError(lines, e, done);
    if (fix) {
      lines[fix.line - 1] = fix.after;
      fixes.push(fix);
    }
  }
  return fixes;
}

function hasOverfull(warnings: string[]): boolean {
  return warnings.some((w) => /Overfull \\hbox|Underfull \\hbox/.test(w));
}

/** Insert \emergencystretch=3em once to reduce overfull/underfull hboxes. */
function injectEmergencyStretch(lines: string[]): boolean {
  const joined = lines.join("\n");
  if (/\\emergencystretch\s*=/.test(joined)) return false;
  if (/\\sloppy/.test(joined)) return false;
  const idx = lines.findIndex((l) => /\\documentclass/.test(l));
  if (idx < 0) return false;
  if (!lines[idx].includes("}")) return false; // documentclass spans lines; be conservative
  lines.splice(
    idx + 1,
    0,
    "% [latexcompile] auto-fixed: allow extra line stretch to reduce overfull/underfull hboxes",
    "\\emergencystretch=3em",
  );
  return true;
}

/** Open a file with the system's default handler (cross-platform). */
async function openPdf(filePath: string): Promise<string | null> {
  try {
    if (process.platform === "win32") {
      // `start` is a cmd builtin; the empty title argument keeps paths with
      // spaces intact. execFile passes args directly (no shell), so no manual
      // quoting is needed.
      await execFileAsync("cmd", ["/c", "start", "", filePath], { windowsHide: true, timeout: 10_000 });
    } else if (process.platform === "darwin") {
      await execFileAsync("open", [filePath], { timeout: 10_000 });
    } else {
      await execFileAsync("xdg-open", [filePath], { timeout: 10_000 });
    }
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

async function compileLatex(
  fileArg: string,
  cwd: string,
  signal?: AbortSignal,
  openViewer = false,
  onPass?: (pass: number, details: LatexCompileDetails) => void,
): Promise<LatexCompileDetails> {
  let file = fileArg.trim();
  if (!file) throw new Error("No .tex file provided. Usage: latexcompile <path/to/file.tex>");
  if (!extname(file)) file += ".tex";

  const absFile = isAbsolute(file) ? file : resolve(cwd, file);
  const dir = dirname(absFile);
  const base = basename(absFile, extname(absFile));
  const texName = `${base}.tex`;
  const logPath = join(dir, `${base}.log`);
  const pdfPath = join(dir, `${base}.pdf`);

  try {
    const st = await stat(absFile);
    if (!st.isFile()) throw new Error(`Not a file: ${absFile}`);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err?.code === "ENOENT") throw new Error(`File not found: ${absFile}`);
    throw new Error(`Cannot access ${absFile}: ${err?.message ?? String(e)}`);
  }

  const allErrors: string[] = [];
  const allWarnings: string[] = [];
  let rerunNeeded = false;
  let passes = 0;

  for (let pass = 1; pass <= MAX_PASSES; pass++) {
    if (signal?.aborted) throw new Error("latexcompile aborted");
    passes = pass;

    let stdout = "";
    let stderr = "";
    let code = 0;
    try {
      const r = await execFileAsync(
        "pdflatex",
        ["-interaction=nonstopmode", "-synctex=1", texName],
        { cwd: dir, timeout: PASS_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024, signal },
      );
      stdout = r.stdout;
      stderr = r.stderr;
    } catch (e) {
      const err = e as NodeJS.ErrnoException & { stdout?: string; stderr?: string; killed?: boolean; signal?: string };
      stdout = err?.stdout ?? "";
      stderr = err?.stderr ?? "";
      code = typeof err?.code === "number" ? err.code : 1;
      if (err?.killed || err?.signal) {
        throw new Error(`pdflatex was killed (timeout/abort). Last output:\n${(stderr || stdout).slice(0, 2000)}`);
      }
      if (err?.code === "ENOENT") {
        throw new Error(
          "pdflatex not found. Install a TeX distribution (MiKTeX or TeX Live) and ensure pdflatex is on PATH.",
        );
      }
    }

    let logText = "";
    try {
      logText = await readFile(logPath, "utf8");
    } catch {
      logText = `${stdout}\n${stderr}`;
    }

    const parsed = parseLog(logText);
    if (code !== 0 && parsed.errors.length === 0) {
      parsed.errors.push(`pdflatex exited with code ${code}. Last output:\n${(stderr || stdout).slice(0, 1500)}`);
    }

    // Keep only the current pass's findings: the last pass reflects the
    // final state (cross-reference "rerun" warnings disappear once resolved).
    allErrors.length = 0;
    allErrors.push(...parsed.errors);
    allWarnings.length = 0;
    for (const w of parsed.warnings) if (!allWarnings.includes(w)) allWarnings.push(w);
    rerunNeeded = parsed.rerunNeeded;

    onPass?.(pass, {
      success: false,
      file: absFile,
      pdfPath,
      logPath,
      passes: pass,
      errors: [...allErrors],
      warnings: [...allWarnings],
      rerunNeeded,
      viewerOpened: false,
      viewerError: null,
    });

    if (parsed.errors.length > 0) break; // must fix before re-running
    if (!rerunNeeded) break; // compiled fully
  }

  const pdfExists = await stat(pdfPath).then((s) => s.isFile()).catch(() => false);
  const success = allErrors.length === 0 && pdfExists;

  let viewerOpened = false;
  let viewerError: string | null = null;
  if (success && openViewer) {
    const err = await openPdf(pdfPath);
    if (err) viewerError = err;
    else viewerOpened = true;
  }

  return {
    success,
    file: absFile,
    pdfPath,
    logPath,
    passes,
    errors: allErrors.slice(0, MAX_ERRORS),
    warnings: allWarnings.slice(0, MAX_WARNINGS),
    rerunNeeded,
    viewerOpened,
    viewerError,
  };
}

async function readLogText(logPath: string): Promise<string> {
  try {
    return await readFile(logPath, "utf8");
  } catch {
    return "";
  }
}

async function readTexLines(absFile: string): Promise<{ lines: string[]; eol: string }> {
  const content = await readFile(absFile, "utf8");
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  return { lines: content.split(/\r?\n/), eol };
}

/**
 * Compile a .tex file and auto-fix common, well-defined errors so it compiles.
 * Repeats the compile → fix → recompile loop until the document succeeds or no
 * further automatic fix is possible. Warnings (overfull/underfull boxes) are
 * mitigated by a one-time \emergencystretch injection when applicable.
 */
async function compileAndFix(
  fileArg: string,
  cwd: string,
  signal?: AbortSignal,
  openViewer = true,
  fix = true,
  onPass?: (pass: number, details: LatexCompileDetails) => void,
  onFix?: (fixes: Fix[], fixIteration: number) => void,
): Promise<LatexCompileResult> {
  let file = fileArg.trim();
  if (!file) throw new Error("No .tex file provided. Usage: latexcompile <path/to/file.tex>");
  if (!extname(file)) file += ".tex";
  const absFile = isAbsolute(file) ? file : resolve(cwd, file);

  const fixes: Fix[] = [];
  const done = new Set<string>();
  let passesSoFar = 0;
  let fixIterations = 0;

  const wrapPass = (pass: number, d: LatexCompileDetails) => onPass?.(passesSoFar + pass, d);

  let details = await compileLatex(absFile, cwd, signal, false, wrapPass);
  passesSoFar += details.passes;

  while (fix && details.errors.length > 0 && fixIterations < MAX_FIX_ITERATIONS) {
    if (signal?.aborted) throw new Error("latexcompile aborted");
    fixIterations++;
    const logText = await readLogText(details.logPath);
    const errors = parseErrorsWithContext(logText);
    const { lines, eol } = await readTexLines(absFile);
    const applied = applyFixes(lines, errors, done);
    if (applied.length === 0) break; // nothing left that is auto-fixable
    await writeFile(absFile, lines.join(eol), "utf8");
    fixes.push(...applied);
    onFix?.(applied, fixIterations);

    details = await compileLatex(absFile, cwd, signal, false, wrapPass);
    passesSoFar += details.passes;
  }

  // One-time warning mitigation for overfull/underfull hboxes.
  if (fix && details.success && details.errors.length === 0 && hasOverfull(details.warnings)) {
    const { lines, eol } = await readTexLines(absFile);
    if (injectEmergencyStretch(lines)) {
      await writeFile(absFile, lines.join(eol), "utf8");
      const stretchFix: Fix = {
        line: 0,
        before: "",
        after: "\\emergencystretch=3em (injected into preamble)",
        reason: "mitigate overfull/underfull hbox warnings",
      };
      fixes.push(stretchFix);
      onFix?.([stretchFix], fixIterations);
      details = await compileLatex(absFile, cwd, signal, false, wrapPass);
      passesSoFar += details.passes;
    }
  }

  let viewerOpened = false;
  let viewerError: string | null = null;
  if (details.success && openViewer) {
    const err = await openPdf(details.pdfPath);
    if (err) viewerError = err;
    else viewerOpened = true;
  }

  return {
    success: details.success,
    file: absFile,
    pdfPath: details.pdfPath,
    logPath: details.logPath,
    passes: passesSoFar,
    fixIterations,
    fixes,
    errors: details.errors.slice(0, MAX_ERRORS),
    warnings: details.warnings.slice(0, MAX_WARNINGS),
    rerunNeeded: details.rerunNeeded,
    viewerOpened,
    viewerError,
  };
}

function formatContent(d: LatexCompileResult): string {
  const lines: string[] = [];
  lines.push(d.success ? "SUCCESS — PDF produced" : "FAILED — compilation has errors");
  lines.push(`file:   ${d.file}`);
  lines.push(`pdf:    ${d.pdfPath}${d.success ? "" : " (not produced or incomplete)"}`);
  lines.push(`log:    ${d.logPath}`);
  lines.push(`passes: ${d.passes}`);
  if (d.fixIterations) lines.push(`auto-fix cycles: ${d.fixIterations}`);
  if (d.viewerOpened) lines.push("viewer:  opened in the system's default PDF viewer");
  else if (d.viewerError) lines.push(`viewer:  open failed (${d.viewerError})`);

  if (d.fixes.length) {
    lines.push(`\nAuto-fixes applied (${d.fixes.length}):`);
    for (const f of d.fixes) {
      const loc = f.line > 0 ? `line ${f.line}` : "preamble";
      lines.push(`  • ${loc}: ${f.reason}`);
      if (f.before) lines.push(`      was: ${f.before}`);
    }
  }

  if (d.errors.length) {
    lines.push(`\nErrors (${d.errors.length}${d.errors.length >= MAX_ERRORS ? "+" : ""}):`);
    for (const e of d.errors) lines.push(`  • ${e.replace(/\n/g, "\n    ")}`);
  }
  if (d.warnings.length) {
    lines.push(`\nWarnings (${d.warnings.length}${d.warnings.length >= MAX_WARNINGS ? "+" : ""}):`);
    for (const w of d.warnings) lines.push(`  • ${w}`);
  }
  if (d.rerunNeeded) {
    lines.push("\nNote: LaTeX requested another pass (cross-references/labels may still need re-running).");
  }
  if (d.errors.length) {
    lines.push(`\nRemaining errors are not auto-fixable. Fix them in ${d.file}, then run latexcompile again.`);
  }
  return lines.join("\n");
}

const latexcompileTool = defineTool({
  name: "latexcompile",
  label: "LaTeX Compile",
  description:
    "Compile a .tex file with pdflatex in nonstop (non-interactive) mode and automatically find & fix common LaTeX errors so the document compiles. Re-runs pdflatex across a compile→fix→recompile loop (up to 5 passes per compile) to resolve cross-references and labels. Auto-fixes safe, well-defined errors directly in the .tex source (missing \\input/\\include/\\includegraphics files, undefined control sequences, undefined environments), mitigates overfull/underfull hbox warnings, and reports any remaining errors/warnings that require manual attention.",
  promptSnippet: "Compile a .tex file with pdflatex, auto-fixing errors/warnings so it compiles",
  promptGuidelines: [
    "Use latexcompile to compile a .tex file; it will attempt to auto-fix errors and mitigate warnings so the document compiles.",
    "Review the reported auto-fixes. For any remaining (non-auto-fixable) errors, fix them in the .tex file and run latexcompile again until it succeeds.",
  ],
  parameters: Type.Object({
    file: Type.String({
      description: "Path to the .tex file to compile (relative to the project root, or absolute).",
    }),
    open: Type.Optional(
      Type.Boolean({
        description: "Open the resulting PDF in the system's default viewer after a successful compile (default: true).",
      }),
    ),
    fix: Type.Optional(
      Type.Boolean({
        description: "Automatically find and fix common LaTeX errors and mitigate warnings so the document compiles (default: true).",
      }),
    ),
  }),
  outputSchema: Type.Object({
    success: Type.Boolean(),
    file: Type.String(),
    pdfPath: Type.String(),
    logPath: Type.String(),
    passes: Type.Integer(),
    fixIterations: Type.Integer(),
    fixes: Type.Array(
      Type.Object({
        line: Type.Integer(),
        before: Type.String(),
        after: Type.String(),
        reason: Type.String(),
      }),
    ),
    errors: Type.Array(Type.String()),
    warnings: Type.Array(Type.String()),
    rerunNeeded: Type.Boolean(),
    viewerOpened: Type.Boolean(),
    viewerError: Type.Union([Type.String(), Type.Null()]),
  }),

  async execute(_toolCallId, params, signal, onUpdate, ctx) {
    const result = await compileAndFix(
      params.file,
      ctx.cwd,
      signal,
      params.open ?? true,
      params.fix ?? true,
      (pass, d) => {
        onUpdate?.({
          content: [{ type: "text", text: `Compiling ${d.file} — pass ${pass}...` }],
          details: d,
        });
      },
    );

    return {
      content: [{ type: "text", text: formatContent(result) }],
      details: result,
      structuredContent: {
        success: result.success,
        file: result.file,
        pdfPath: result.pdfPath,
        logPath: result.logPath,
        passes: result.passes,
        fixIterations: result.fixIterations,
        fixes: result.fixes,
        errors: result.errors,
        warnings: result.warnings,
        rerunNeeded: result.rerunNeeded,
        viewerOpened: result.viewerOpened,
        viewerError: result.viewerError,
      },
      isError: !result.success,
    };
  },
});

export default function (pi: ExtensionAPI) {
  pi.registerTool(latexcompileTool);

  pi.registerCommand("latexcompile", {
    description: "Compile a .tex file with pdflatex, auto-fixing errors/warnings",
    getArgumentCompletions: (prefix) => {
      try {
        const files = readdirSync(process.cwd())
          .filter((f) => f.endsWith(".tex") && f.startsWith(prefix))
          .map((f) => ({ value: f, label: f }));
        return files.length ? files : null;
      } catch {
        return null;
      }
    },
    handler: async (args, ctx) => {
      const file = args.trim().split(/\s+/)[0];
      if (!file) {
        ctx.ui.notify("Usage: /latexcompile <file.tex>", "warning");
        return;
      }
      try {
        const details = await compileAndFix(
          file,
          ctx.cwd,
          undefined,
          true,
          true,
          (pass, d) => {
            const name = basename(d.file);
            const errCount = d.errors.length;
            const err = errCount ? ` — ${errCount} error${errCount === 1 ? "" : "s"}` : "";
            ctx.ui.setStatus("latexcompile", `Compiling ${name} — pass ${pass}${err}`);
          },
          (fixes, iteration) => {
            const n = fixes.length;
            const cycle = iteration > 0 ? ` — cycle ${iteration}` : "";
            ctx.ui.setStatus("latexcompile", `Auto-fixing ${n} issue${n === 1 ? "" : "s"}${cycle} — recompiling…`);
          },
        );
        ctx.ui.setStatus("latexcompile", undefined);
        if (details.success) {
          ctx.ui.notify(
            `✓ ${details.file} → ${details.pdfPath} (${details.passes} pass${details.passes === 1 ? "" : "es"})`,
            "info",
          );
          if (details.viewerOpened) ctx.ui.notify("Opened in the system's default PDF viewer.", "info");
          else if (details.viewerError) ctx.ui.notify(`Could not open PDF: ${details.viewerError}`, "warning");
        } else {
          ctx.ui.notify(`✗ Compile failed: ${details.errors.length} error(s). See log ${details.logPath}`, "error");
        }
        if (details.fixes.length) {
          ctx.ui.notify(`Auto-fixed ${details.fixes.length} issue(s) in ${details.file}.`, "info");
        }
        if (details.warnings.length) {
          ctx.ui.notify(`${details.warnings.length} warning(s) (e.g., overfull/underfull hboxes). See log.`, "warning");
        }
      } catch (e) {
        ctx.ui.setStatus("latexcompile", undefined);
        ctx.ui.notify(`latexcompile: ${e instanceof Error ? e.message : String(e)}`, "error");
      }
    },
  });
}
