import { readFileSync } from "node:fs";
import ts from "typescript";
import { scan } from "./astGrep.js";
import { collectFiles } from "./fileWalk.js";
import type {
  BranchingCounts,
  ComponentMetrics,
  FileMetrics,
  HookCounts,
  StoreMetrics,
} from "./metricsTypes.js";
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

export interface CollectedMetrics {
  components: ComponentMetrics[];
  files: FileMetrics[];
  store: StoreMetrics;
  inlineMapRowCount: number;
}

function parse(file: string, text: string): ts.SourceFile {
  const kind =
    file.endsWith(".tsx") || file.endsWith(".jsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
}

function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

function calleeName(node: ts.CallExpression): string | undefined {
  if (ts.isIdentifier(node.expression)) return node.expression.text;
  if (ts.isPropertyAccessExpression(node.expression)) return node.expression.name.text;
  return undefined;
}

/** Unwrap `observer(fn)`, `memo(observer(fn))` … down to the function itself. */
function componentFunction(node: ts.Node): ts.SignatureDeclaration | undefined {
  if (ts.isFunctionDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    return node;
  }
  if (ts.isCallExpression(node) && node.arguments.length > 0) {
    const first = node.arguments[0];
    if (first !== undefined) return componentFunction(first);
  }
  return undefined;
}

function isObserverWrapped(node: ts.Node): boolean {
  if (!ts.isCallExpression(node)) return false;
  if (calleeName(node) === "observer") return true;
  const first = node.arguments[0];
  return first !== undefined && isObserverWrapped(first);
}

function propsCountOf(fn: ts.SignatureDeclaration | undefined): number {
  const param = fn?.parameters[0];
  if (param === undefined || !ts.isObjectBindingPattern(param.name)) return 0;
  return param.name.elements.length;
}

interface WalkCounts {
  hooks: HookCounts;
  branching: BranchingCounts;
  jsxMaxDepth: number;
}

function walkComponent(root: ts.Node): WalkCounts {
  const hooks: HookCounts = { useState: 0, useEffect: 0, useMemo: 0, useCallback: 0, useRef: 0 };
  const branching: BranchingCounts = {
    match: 0,
    exhaustive: 0,
    otherwise: 0,
    ternaryInJsx: 0,
    andInJsx: 0,
  };
  let jsxMaxDepth = 0;

  const visit = (node: ts.Node, jsxDepth: number, inJsxExpr: boolean): void => {
    let depth = jsxDepth;
    let inExpr = inJsxExpr;
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) {
      depth += 1;
      if (depth > jsxMaxDepth) jsxMaxDepth = depth;
      inExpr = false;
    } else if (ts.isJsxExpression(node)) {
      inExpr = true;
    }

    if (ts.isCallExpression(node)) {
      const name = calleeName(node);
      if (name !== undefined) {
        for (const h of HOOK_NAMES) {
          if (name === h) hooks[h] += 1;
        }
        if (name === "match" && ts.isIdentifier(node.expression)) branching.match += 1;
        if (name === "exhaustive" && ts.isPropertyAccessExpression(node.expression)) {
          branching.exhaustive += 1;
        }
        if (name === "otherwise" && ts.isPropertyAccessExpression(node.expression)) {
          branching.otherwise += 1;
        }
      }
    }
    if (ts.isConditionalExpression(node) && inExpr) branching.ternaryInJsx += 1;
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
      inExpr
    ) {
      branching.andInJsx += 1;
    }

    node.forEachChild((child) => visit(child, depth, inExpr));
  };
  visit(root, 0, false);
  return { hooks, branching, jsxMaxDepth };
}

/** Find the declaration node for a component-decl marker match (by name, then line). */
function declNodeFor(sf: ts.SourceFile, name: string, line: number): ts.Node | undefined {
  let byName: ts.Node | undefined;
  let byLine: ts.Node | undefined;
  const consider = (node: ts.Node, declName: string | undefined): void => {
    if (declName !== name) return;
    byName ??= node;
    if (lineOf(sf, node) === line) byLine ??= node;
  };
  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt)) consider(stmt, stmt.name?.text);
    if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations) {
        if (ts.isIdentifier(d.name)) consider(d, d.name.text);
      }
    }
  }
  return byLine ?? byName;
}

function fileImportedIdentifiers(sf: ts.SourceFile): number {
  let count = 0;
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    const clause = stmt.importClause;
    if (clause === undefined) continue;
    if (clause.name !== undefined) count += 1;
    const bindings = clause.namedBindings;
    if (bindings === undefined) continue;
    if (ts.isNamespaceImport(bindings)) count += 1;
    else count += bindings.elements.length;
  }
  return count;
}

function importLineSet(sf: ts.SourceFile): Set<number> {
  const lines = new Set<number>();
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    const start = sf.getLineAndCharacterOfPosition(stmt.getStart(sf)).line;
    const end = sf.getLineAndCharacterOfPosition(stmt.getEnd()).line;
    for (let l = start; l <= end; l++) lines.add(l + 1);
  }
  return lines;
}

function collectStoreMetrics(sf: ts.SourceFile, store: StoreMetrics): void {
  const visit = (node: ts.Node, inStoreClass: boolean): void => {
    let inStore = inStoreClass;
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      inStore = node.name !== undefined && /Store$/.test(node.name.text);
    }
    if (ts.isCallExpression(node)) {
      const name = calleeName(node);
      if (name === "runInAction") store.runInActionCount += 1;
      if ((name === "reaction" || name === "autorun") && ts.isIdentifier(node.expression)) {
        store.reactionsTotal += 1;
      }
    }
    if (
      inStore &&
      ts.isMethodDeclaration(node) &&
      node.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) === true
    ) {
      store.asyncInStore += 1;
    }
    if (
      inStore &&
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "Map"
    ) {
      store.newMapInStore += 1;
    }
    // A boolean-shaped async-progress DECLARATION (`loading: boolean`,
    // `uploading = false`) — the §14 antipattern Resource<T>/QueryState
    // replaces. Declarations, not write sites: the number of flags measures
    // the state design; counting every `this.loading = …` would just scale
    // with method count.
    if (
      (ts.isPropertySignature(node) || ts.isPropertyDeclaration(node)) &&
      ts.isIdentifier(node.name) &&
      PROGRESS_FLAG.test(node.name.text) &&
      (node.type?.kind === ts.SyntaxKind.BooleanKeyword ||
        (ts.isPropertyDeclaration(node) &&
          node.type === undefined &&
          node.initializer !== undefined &&
          (node.initializer.kind === ts.SyntaxKind.TrueKeyword ||
            node.initializer.kind === ts.SyntaxKind.FalseKeyword)))
    ) {
      store.loadingBooleanShapes += 1;
    }
    node.forEachChild((child) => visit(child, inStore));
  };
  visit(sf, false);
}

export function collectMetrics(targets: string[]): CollectedMetrics {
  const allFiles = collectFiles(targets, [".ts", ".tsx", ".jsx"]).filter(
    (f) => !EXCLUDED_FILE.test(f),
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

  const inlineMapRowCount = scan(rulesConfig, targets).filter(
    (r) => r.ruleId === "inline-map-row" && !EXCLUDED_FILE.test(r.file),
  ).length;

  const components: ComponentMetrics[] = [];
  const files: FileMetrics[] = [];
  const store: StoreMetrics = {
    runInActionCount: 0,
    asyncInStore: 0,
    newMapInStore: 0,
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
    const sf = parse(file, text);
    const kinds = classifyLines(text);
    const importLines = importLineSet(sf);
    let fileSloc = 0;
    kinds.forEach((k, i) => {
      if (k === "code" && !importLines.has(i + 1)) fileSloc += 1;
    });

    collectStoreMetrics(sf, store);

    const fileDecls = declsByFile.get(file) ?? [];
    let filePropsTotal = 0;
    for (const decl of fileDecls) {
      const name = decl.metaText("N") ?? "?";
      const node = declNodeFor(sf, name, decl.startLine);
      if (node === undefined) continue;
      const target = ts.isVariableDeclaration(node) ? (node.initializer ?? node) : node;
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

    const importedIdentifiers = fileImportedIdentifiers(sf);
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
