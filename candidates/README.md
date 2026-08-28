# candidates/ — triaged, wave 2

The 11 PPA R-rules that came verbatim from `merkle-substrate/apps/ppa/.ast-grep/rules/`
have been triaged. **Three were promoted into `rules/` and deleted from here.**
The eight below stay **repo-local**: they encode a PPA convention rather than a
house rule, so they keep living in the PPA repo and load through the repo-local
`ruleDirs` entry (see the package README, "Repo-local extra rules").

They are still NOT in the package `sgconfig.yml` and load nowhere from here.

## Promoted to canon

| R-rule | canon id | why |
|---|---|---|
| r4-ternary-on-discriminator | `discriminator-ternary` | 18 hits outside PPA, and measured **disjoint** from both rules it looked like a duplicate of: `∩ jsx-ternary = 0`, `∩ kind-if-without-match = 0`. The three partition the space — `if` on a discriminator, ternary yielding JSX, ternary yielding values. A `not: is-jsx` clause makes that disjointness structural rather than lucky. |
| r14-literal-union-in-component | `literal-union-in-component` | Already a house rule — report §8 bans string-literal unions from component files in the `ui/` tier. Globs generalised from `apps/ppa/**` to `**/components/**`, `**/screens/**`, `**/app/**`. |
| r1a-hardcoded-url-in-component | `hardcoded-url-in-component` | Enforces CLAUDE.md "No localhost": every service URL comes from `dev url`, never a literal. Same reusability boundary `ui-imports-app-store` guards from the other side. |

## Staying repo-local

| R-rule | why it is not canon |
|---|---|
| r10-as-cast | 121 hits in tg-gallery + observatory alone. `as Type` is legitimate at boundaries this codebase does not yet route through Zod, and `as-any-escape` already covers the escape-hatch half. Canon-promoting it buys a suppression campaign. |
| r1d-scattered-numeric-const-in-component | 25 hits, but "module-level ALL_CAPS numeric belongs in tokens.ts" is a PPA layout convention, not a house rule. |
| r2-helper-fn-in-tsx | Its own message admits "unavoidable false positives — it can't distinguish PascalCase observer-wrapped components from helpers". A rule its author documents as broken does not become canon. (The stated cause, "metavariable regex unsupported in ast-grep 0.42", no longer holds on 0.45 — so a corrected version is a real candidate for a later wave, but it would be a new rule, not this one.) |
| r3-hooks-outside-layout | Bans useState/useEffect/useMemo outside two named layout files. That is PPA's architectural stance; the house rule (C24) permits a hook that owns DOM or lifecycle, and `usePageStore` is sanctioned. |
| r6-jsx-comment-smell | "A JSX comment is a smell" at severity `hint`. House code uses JSX comments for real explanation (tg-gallery, observatory); this is a PPA style preference. |
| r7-raw-hsl-outside-tokens | Points at `apps/ppa/lib/tokens.ts`. Tailwind remains a legal manifest value for web apps, so a raw-colour ban cannot be unconditional canon. |
| r8-inline-style-prop | **Stale as well as local.** It tells you to prefer NativeWind `className` over `style={{}}` — but decision #10 (2026-08-28) converges PPA to *theme-inline*, which makes inline style from a theme hook the intended idiom. The rule now argues against the decision it lives under; PPA should retire or invert it. |
| r9-optional-store-arg | Flags every `?:` parameter and property in store source. The principle is house-wide (make invalid states unrepresentable), but the rule as written has no way to tell a genuine optional from a modelled one, which is why PPA scoped it to two directories with three ignores. |
