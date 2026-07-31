import test from "node:test";
import assert from "node:assert/strict";
import { parseEther } from "ethers";
import { gasTopUpAmount } from "../src/gas.js";

test("gas reserve unwraps only its own WETH below the minimum", () => {
  assert.equal(gasTopUpAmount(parseEther("0.0003"), parseEther("1")), 0n);
  assert.equal(
    gasTopUpAmount(parseEther("0.0001"), parseEther("1")),
    parseEther("0.0004"),
  );
  assert.equal(
    gasTopUpAmount(parseEther("0.0001"), parseEther("0.0002")),
    parseEther("0.0002"),
  );
  assert.equal(gasTopUpAmount(0n, 0n), 0n);
});
