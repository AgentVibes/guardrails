import { type CallExpression, type Node, type Program, parseSync } from "oxc-parser";

// The metrics walker's view of a source file: oxc-parser's ESTree (TS-ESTree
// shape) plus a line index. Replaces `ts.createSourceFile` (is-d47ee312):
// measured 4–5× faster on the same files, and the `typescript` package stops
// being a runtime dependency.

export interface ParsedFile {
  program: Program;
  /** 1-based line of a UTF-16 offset — oxc-parser reports UTF-16 offsets, as `text` indexes. */
  lineAt: (offset: number) => number;
}

/**
 * `.tsx` and `.jsx` both parse as TSX, as `ts.ScriptKind.TSX` did, so a `.jsx`
 * file carrying TypeScript syntax still parses. Parentheses are kept as
 * `ParenthesizedExpression` nodes (oxc's default), matching the TypeScript AST,
 * where `observer((fn))` does not unwrap to the function either.
 */
export function parseFile(file: string, text: string): ParsedFile {
  const lang = file.endsWith(".tsx") || file.endsWith(".jsx") ? "tsx" : "ts";
  const { program } = parseSync(file, text, { lang, preserveParens: true });
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1);
  }
  const lineAt = (offset: number): number => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((starts[mid] ?? 0) <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  return { program, lineAt };
}

/** The member(s) of the node union whose `type` can be `K` (a Function's `type` is itself a union). */
export type NodeOf<K extends Node["type"]> = Node extends infer N
  ? N extends { type: infer T }
    ? K extends T
      ? N
      : never
    : never
  : never;

/** `ts.isX(node)` for the ESTree: narrows by `type`. */
export function isKind<K extends Node["type"]>(node: Node, ...kinds: K[]): node is NodeOf<K> {
  return kinds.some((k) => k === node.type);
}

function isNode(value: unknown): value is Node {
  return (
    typeof value === "object" && value !== null && "type" in value && typeof value.type === "string"
  );
}

// Keys that can hold a child, per node type. A field's value kind is fixed by
// the node type (an `init` is a node or null, never a string), so the first node
// of a type fixes the list; walking every own key of every node through
// `Object.entries` was the single largest cost of `metrics` on a 4000-file repo.
const childKeys = new Map<string, string[]>();

function childKeysOf(node: Node): string[] {
  const known = childKeys.get(node.type);
  if (known !== undefined) return known;
  const keys = Object.entries(node)
    .filter(([key, value]) => key !== "parent" && typeof value === "object")
    .map(([key]) => key);
  childKeys.set(node.type, keys);
  return keys;
}

/** Every direct child node, the ESTree counterpart of `ts.Node.forEachChild`. */
export function forEachChild(node: Node, visit: (child: Node) => void): void {
  for (const key of childKeysOf(node)) {
    const value: unknown = Reflect.get(node, key);
    if (Array.isArray(value)) {
      for (const item of value) {
        if (isNode(item)) visit(item);
      }
    } else if (isNode(value)) {
      visit(value);
    }
  }
}

/**
 * `foo()` → "foo", `a.foo()` / `a?.foo()` → "foo", `a.#foo()` → "#foo";
 * anything else (computed, parenthesized, `super()`) has no name — the same
 * answers the TypeScript-AST version gave for Identifier / PropertyAccess.
 */
export function calleeName(node: CallExpression): string | undefined {
  const callee = node.callee;
  if (isKind(callee, "Identifier")) return callee.name;
  if (isKind(callee, "MemberExpression") && !callee.computed) {
    const property = callee.property;
    return isKind(property, "PrivateIdentifier") ? `#${property.name}` : property.name;
  }
  return undefined;
}
