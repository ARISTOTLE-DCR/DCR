import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig, loadMockConfig, loadXAuthConfig } from "../config.js";

test("full and picked configuration schemas can coexist at runtime", () => {
  assert.equal(typeof loadConfig, "function");
  assert.equal(typeof loadMockConfig, "function");
  assert.equal(typeof loadXAuthConfig, "function");
});
