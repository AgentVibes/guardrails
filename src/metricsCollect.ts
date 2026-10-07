import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import type { ImportDeclaration, Node, Program } from "oxc-parser";
import { scan } from "./astGrep.js";
import { collectFiles } from "./fileWalk.js";
import type {
  BranchingCounts,
  ComponentMetrics,
  FileMetrics,
  HookCounts,
  StoreMetrics,
} from "./metricsTypes.js";
import {
  calleeName,
  forEachChild,
  isKind,
  type NodeOf,
  type ParsedFile,
  parseFile,
} from "./oxcAst.js";
import { rulesConfig, structureConfig } from "./packagePaths.js";
import { classifyLines, codeLinesInRange } from "./sourceLines.js";

// Production code only — same exclusions the vault audit used (§1: "тесты/
// showcase исключены"), so numbers stay comparable to the audit baselines.
const EXCLUDED_FILE = /\.(test|spec|stories)\.[jt]sx?$|__tests__|\/showcase\/|\.d\.ts$/;

const HOOK_NAMES = ["useState", "useEffect", "useMemo", "useCallback", "useRef"] as const;

// Async-progress flag names. Deliberately NOT every boolean (sidebarVisible,
// dialogOpen are legitimate UI state) — only the loading-machine flags that a
// Resource<T>/QueryState union should own.
const PROGRESS_FLAG =
  /^(is)?\w*([lL]oading|[pP]ending|[fF]etching|[sS]aving|[bB]usy|[rR]efreshing|[sS]canning|[eE]xporting|[iI]mporting|[sS]yncing|[sS]ubmitting|[pP]rocessing|[gG]enerating|[bB]uilding|[cC]onnecting)$/;

/**
 * Metrics describe the PROJECT — its tracked source — so gitignored files
 * (generated code, local build output) are dropped. Without this the numbers
 * depend on which machine ran them: a fresh CI checkout has no generated
 * files, a dev tree does, and the p90s disagree (observed: p90ContextCost
 * 20 locally vs 21 in CI on the same commit). The ast-grep-backed counters
 * were already deterministic — ast-grep honors .gitignore natively.
 */
function dropGitignored(files: string[]): string[] {
  if (files.length === 0) return files;
  const res = spawnSync("git", ["check-ignore", "--stdin"], {
    input: files.join("\n"),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  // Outside a repo (or git missing) there is no ignore standard to apply.
  if (res.error || res.status === null || res.status > 1) return files;
  const ignored = new Set(res.stdout.split("\n").filter((l) => l !== ""));
  return files.filter((f) => !ignored.has(f));
}

export interface CollectedMetrics {
  components: ComponentMetrics[];
  files: FileMetrics[];
  store: StoreMetrics;
  inlineMapRowCount: number;
}

const FUNCTION_KINDS = [
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
  "TSDeclareFunction",
] as const;
type FunctionNode = NodeOf<(typeof FUNCTION_KINDS)[number]>;

// A class field in any spelling the TypeScript AST called a PropertyDeclaration:
// plain, `abstract`, and `accessor`.
const CLASS_FIELD_KINDS = [
  "PropertyDefinition",
  "TSAbstractPropertyDefinition",
  "AccessorProperty",
  "TSAbstractAccessorProperty",
] as const;

/** Unwrap `observer(fn)`, `memo(observer(fn))` … down to the function itself. */
function componentFunction(node: Node): FunctionNode | undefined {
  if (isKind(node, ...FUNCTION_KINDS)) return node;
  if (isKind(node, "CallExpression") && node.arguments.length > 0) {
    const first = node.arguments[0];
    if (first !== undefined) return componentFunction(first);
  }
  return undefined;
}

function isObserverWrapped(node: Node): boolean {
  if (!isKind(node, "CallExpression")) return false;
  if (calleeName(node) === "observer") return true;
  const first = node.arguments[0];
  return first !== undefined && isObserverWrapped(first);
}

/** Destructured props of the first parameter; `({ a, b } = {})` counts too, as its binding pattern did. */
function propsCountOf(fn: FunctionNode | undefined): number {
  const param = fn?.params[0];
  if (param === undefined) return 0;
  const pattern = isKind(param, "AssignmentPattern") ? param.left : param;
  // A parameter that is not destructured has no props to count, not an unknown count.
  return isKind(pattern, "ObjectPattern") ? pattern.properties.length : 0;
}

interface WalkCounts {
  hooks: HookCounts;
  branching: BranchingCounts;
  jsxMaxDepth: number;
}

function walkComponent(root: Node): WalkCounts {
  const hooks: HookCounts = { useState: 0, useEffect: 0, useMemo: 0, useCallback: 0, useRef: 0 };
  const branching: BranchingCounts = {
    match: 0,
    exhaustive: 0,
    otherwise: 0,
    ternaryInJsx: 0,
    andInJsx: 0,
  };
  let jsxMaxDepth = 0;

  const visit = (node: Node, jsxDepth: number, inJsxExpr: boolean): void => {
    let depth = jsxDepth;
    let inExpr = inJsxExpr;
    // A self-closing element is a JSXElement here; the TypeScript AST split it out.
    if (isKind(node, "JSXElement", "JSXFragment")) {
      depth += 1;
      if (depth > jsxMaxDepth) jsxMaxDepth = depth;
      inExpr = false;
    } else if (isKind(node, "JSXExpressionContainer", "JSXSpreadChild")) {
      // `{x}` and `{...x}` were both a JsxExpression in the TypeScript AST.
      inExpr = true;
    }

    if (isKind(node, "CallExpression")) {
      const name = calleeName(node);
      if (name !== undefined) {
        for (const h of HOOK_NAMES) {
          if (name === h) hooks[h] += 1;
        }
        if (name === "match" && isKind(node.callee, "Identifier")) branching.match += 1;
        if (name === "exhaustive" && isKind(node.callee, "MemberExpression")) {
          branching.exhaustive += 1;
        }
        if (name === "otherwise" && isKind(node.callee, "MemberExpression")) {
          branching.otherwise += 1;
        }
      }
    }
    if (isKind(node, "ConditionalExpression") && inExpr) branching.ternaryInJsx += 1;
    if (isKind(node, "LogicalExpression") && node.operator === "&&" && inExpr) {
      branching.andInJsx += 1;
    }

    forEachChild(node, (child) => visit(child, depth, inExpr));
  };
  visit(root, 0, false);
  return { hooks, branching, jsxMaxDepth };
}

/**
 * A top-level statement the component-decl marker can point at, with the
 * offset its line is read from. The TypeScript AST kept `export` / `export
 * default` as modifiers ON the declaration, so its start was the `export`
 * keyword; the ESTree wraps the declaration instead, so the wrapper's start is
 * the equivalent.
 */
function topLevelDecls(
  program: Program,
): Array<{ node: Node; name: string | undefined; start: number }> {
  const out: Array<{ node: Node; name: string | undefined; start: number }> = [];
  for (const stmt of program.body) {
    const start = stmt.start;
    const decl = isKind(stmt, "ExportNamedDeclaration")
      ? stmt.declaration
      : isKind(stmt, "ExportDefaultDeclaration")
        ? stmt.declaration
        : stmt;
    if (decl === null) continue;
    if (isKind(decl, "FunctionDeclaration", "TSDeclareFunction")) {
      out.push({ node: decl, name: decl.id?.name, start });
    }
    if (isKind(decl, "VariableDeclaration")) {
      for (const d of decl.declarations) {
        if (isKind(d.id, "Identifier")) out.push({ node: d, name: d.id.name, start: d.start });
      }
    }
  }
  return out;
}

/** Find the declaration node for a component-decl marker match (by name, then line). */
function declNodeFor(file: ParsedFile, name: string, line: number): Node | undefined {
  let byName: Node | undefined;
  let byLine: Node | undefined;
  for (const d of topLevelDecls(file.program)) {
    if (d.name !== name) continue;
    byName ??= d.node;
    if (file.lineAt(d.start) === line) byLine ??= d.node;
  }
  return byLine ?? byName;
}

function importDecls(program: Program): ImportDeclaration[] {
  return program.body.filter((stmt): stmt is ImportDeclaration =>
    isKind(stmt, "ImportDeclaration"),
  );
}

/** Default, namespace and named bindings each count one — as the import clause's names did. */
function fileImportedIdentifiers(program: Program): number {
  return importDecls(program).reduce((n, stmt) => n + stmt.specifiers.length, 0);
}

function importLineSet(file: ParsedFile): Set<number> {
  const lines = new Set<number>();
  for (const stmt of importDecls(file.program)) {
    const start = file.lineAt(stmt.start);
    const end = file.lineAt(stmt.end);
    for (let l = start; l <= end; l++) lines.add(l);
  }
  return lines;
}

/** `loading: boolean`, or an untyped class field initialised to `true` / `false`. */
function isBooleanProgressFlag(node: Node): boolean {
  if (isKind(node, "TSPropertySignature")) {
    return (
      !node.computed &&
      isKind(node.key, "Identifier") &&
      PROGRESS_FLAG.test(node.key.name) &&
      node.typeAnnotation?.typeAnnotation.type === "TSBooleanKeyword"
    );
  }
  if (!isKind(node, ...CLASS_FIELD_KINDS)) return false;
  if (node.computed || !isKind(node.key, "Identifier") || !PROGRESS_FLAG.test(node.key.name)) {
    return false;
  }
  const annotation = node.typeAnnotation ?? null;
  if (annotation !== null) return annotation.typeAnnotation.type === "TSBooleanKeyword";
  return (
    node.value !== null && isKind(node.value, "Literal") && typeof node.value.value === "boolean"
  );
}

// runInAction / async-method / new-Map counters moved to the canon rule ids
// (store-no-runinaction, store-async-method, store-new-map) — see
// collectMetrics. Only what no rule covers yet stays as a direct AST count.
function collectStoreMetrics(program: Program, store: StoreMetrics): void {
  const visit = (node: Node): void => {
    if (isKind(node, "CallExpression")) {
      const name = calleeName(node);
      // No canon rule counts reactions yet — direct AST count until one lands.
      if ((name === "reaction" || name === "autorun") && isKind(node.callee, "Identifier")) {
        store.reactionsTotal += 1;
      }
    }
    // A boolean-shaped async-progress DECLARATION (`loading: boolean`,
    // `uploading = false`) — the §14 antipattern Resource<T>/QueryState
    // replaces. Declarations, not write sites: the number of flags measures
    // the state design; counting every `this.loading = …` would just scale
    // with method count.
    if (isBooleanProgressFlag(node)) store.loadingBooleanShapes += 1;
    forEachChild(node, visit);
  };
  visit(program);
}

export function collectMetrics(targets: string[]): CollectedMetrics {
  const allFiles = dropGitignored(
    collectFiles(targets, [".ts", ".tsx", ".jsx"]).filter((f) => !EXCLUDED_FILE.test(f)),
  );

  // Component spans come from the same ast-grep marker rule the structure
  // check uses — one definition of "a component" across the whole toolkit.
  const decls = scan(structureConfig, targets).filter(
    (r) => r.ruleId === "component-decl" && !EXCLUDED_FILE.test(r.file),
  );
  const declsByFile = new Map<string, typeof decls>();
  for (const d of decls) {
    const list = declsByFile.get(d.file) ?? [];
    list.push(d);
    declsByFile.set(d.file, list);
  }

  // One scan of the full rule canon feeds every rule-backed counter. The store
  // counters use the canon rules' definition of "a store" (a class calling
  // make(Auto)Observable) rather than a name or path heuristic — the metric
  // counts exactly what verify gates.
  const ruleRows = scan(rulesConfig, targets).filter((r) => !EXCLUDED_FILE.test(r.file));
  const ruleCount = (...ids: string[]): number =>
    ruleRows.filter((r) => ids.includes(r.ruleId)).length;
  const inlineMapRowCount = ruleCount("inline-map-row");

  const components: ComponentMetrics[] = [];
  const files: FileMetrics[] = [];
  const store: StoreMetrics = {
    runInActionCount: ruleCount("store-no-runinaction", "store-no-runinaction-tsx"),
    asyncInStore: ruleCount("store-async-method", "store-async-method-tsx"),
    newMapInStore: ruleCount("store-new-map", "store-new-map-tsx"),
    reactionsTotal: 0,
    loadingBooleanShapes: 0,
  };

  for (const file of allFiles) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const parsed = parseFile(file, text);
    const kinds = classifyLines(text);
    const importLines = importLineSet(parsed);
    let fileSloc = 0;
    kinds.forEach((k, i) => {
      if (k === "code" && !importLines.has(i + 1)) fileSloc += 1;
    });

    collectStoreMetrics(parsed.program, store);

    const fileDecls = declsByFile.get(file) ?? [];
    let filePropsTotal = 0;
    for (const decl of fileDecls) {
      const name = decl.metaText("N") ?? "?";
      const node = declNodeFor(parsed, name, decl.startLine);
      if (node === undefined) continue;
      const target = isKind(node, "VariableDeclarator") ? (node.init ?? node) : node;
      const fn = componentFunction(target);
      const props = propsCountOf(fn);
      filePropsTotal += props;
      const { hooks, branching, jsxMaxDepth } = walkComponent(target);
      components.push({
        file,
        name,
        line: decl.startLine,
        componentLoc: codeLinesInRange(kinds, decl.startLine, decl.startLine + decl.spanLines - 1),
        hooks,
        propsCount: props,
        observerWrapped: isObserverWrapped(target),
        jsxMaxDepth,
        branching,
      });
    }

    const importedIdentifiers = fileImportedIdentifiers(parsed.program);
    files.push({
      file,
      fileSloc,
      componentsPerFile: fileDecls.length,
      importedIdentifiers,
      contextCost: importedIdentifiers + filePropsTotal,
    });
  }

  return { components, files, store, inlineMapRowCount };
}
