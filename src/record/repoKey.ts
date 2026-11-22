import { spawnSync } from "node:child_process";
import { basename, resolve } from "node:path";
import type { RepoIdentity } from "./runRecord.js";

// The repo key: `host/owner/name` from the `origin` remote, lowercase, without
// `.git` and without any `user:token@` credentials. Accepted remote forms:
//
//   https://host/owner/name(.git)        http(s) with user, token or port
//   ssh://git@host:2222/owner/name.git   ssh:// with a port (port dropped)
//   git@host:owner/name.git              scp form
//   https://host/group/sub/name          GitLab subgroups: owner = "group/sub"
//
// A checkout with no origin is `local/<directory name>`.

export function parseRemote(url: string): Omit<RepoIdentity, "key"> | undefined {
  const u = url.trim();
  let host: string;
  let path: string;
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/.exec(u);
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(u);
  if (withScheme?.[1] !== undefined && withScheme[2] !== undefined) {
    host = withScheme[1];
    path = withScheme[2];
  } else if (scp?.[1] !== undefined && scp[2] !== undefined) {
    host = scp[1];
    path = scp[2];
  } else {
    return undefined;
  }
  const segments = path
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .split("/")
    .filter((s) => s !== "");
  const name = segments.pop();
  if (name === undefined || segments.length === 0) return undefined;
  return {
    host: host.toLowerCase(),
    owner: segments.join("/").toLowerCase(),
    name: name.toLowerCase(),
  };
}

export function identityFor(parsed: Omit<RepoIdentity, "key">): RepoIdentity {
  return { ...parsed, key: `${parsed.host}/${parsed.owner}/${parsed.name}` };
}

function git(root: string, args: string[]): string | undefined {
  const res = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  if (res.error || res.status !== 0) return undefined;
  const out = res.stdout.trim();
  return out === "" ? undefined : out;
}

/** The identity of the checkout at `root`. */
export function repoIdentity(root: string): RepoIdentity {
  const url = git(root, ["remote", "get-url", "origin"]);
  const parsed = url === undefined ? undefined : parseRemote(url);
  if (parsed !== undefined) return identityFor(parsed);
  const name = basename(resolve(root)).toLowerCase();
  return { key: `local/${name}`, host: "local", owner: "", name };
}

export function headSha(root: string): string | undefined {
  return git(root, ["rev-parse", "HEAD"]);
}

/** The current branch; undefined on a detached HEAD. */
export function currentBranch(root: string): string | undefined {
  const b = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return b === "HEAD" ? undefined : b;
}
