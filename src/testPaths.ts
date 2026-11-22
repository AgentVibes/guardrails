// One definition of "test code by path" for the toolkit. A test directory
// (`tests/`, `test/`, `e2e/`, `spec/`, `__tests__/`, `__e2e__/`, `__mocks__/`)
// or a `*.test.*` / `*.spec.*` file.

const TEST_DIRS = "__tests__|__e2e__|__mocks__|tests?|e2e|spec";

/** A repo-relative POSIX file path that is test code. */
export const TEST_FILE_PATH = new RegExp(`(^|/)(${TEST_DIRS})/|\\.(test|spec)\\.[jt]sx?$`);

/** A path glob that names test code (for config carve-outs such as biome overrides). */
export const TEST_PATH_GLOB = new RegExp(
  `(^|/|\\*)(${TEST_DIRS})(/|$)|\\.(test|spec)\\.[jt]sx?$|\\.(test|spec)\\.\\*|\\*\\.(test|spec)\\b`,
);
