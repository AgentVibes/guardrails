import { spawnSync } from "node:child_process";

// doctor's view of the Rust toolchain: cargo, clippy and rustfmt as the repo
// would run them. They run in the repo root, so a rust-toolchain.toml there
// picks the toolchain exactly as `cargo clippy` in CI would.

export type RustToolReport = { found: true; version: string } | { found: false; hint: string };

const TOOLS = {
  cargo: { args: ["--version"], hint: "install Rust: mise use -g rust@latest" },
  clippy: { args: ["clippy", "--version"], hint: "rustup component add clippy" },
  rustfmt: { args: ["fmt", "--version"], hint: "rustup component add rustfmt" },
} as const;

export type RustToolName = keyof typeof TOOLS;
export const RUST_TOOLS = Object.keys(TOOLS) as RustToolName[];

export function rustToolReport(root: string, name: RustToolName): RustToolReport {
  const tool = TOOLS[name];
  const res = spawnSync("cargo", [...tool.args], { cwd: root, encoding: "utf8", timeout: 60_000 });
  const out = (res.stdout ?? "").trim();
  if (res.error !== undefined || res.status !== 0 || out === "") {
    const why = res.error?.message ?? (res.stderr ?? "").trim().split("\n")[0] ?? "";
    return { found: false, hint: why === "" ? tool.hint : `${tool.hint} (${why})` };
  }
  return { found: true, version: out.split("\n")[0] ?? out };
}
