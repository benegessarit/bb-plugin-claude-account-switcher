import assert from "node:assert/strict";
import test from "node:test";
import { rpcContract } from "../contract.ts";

test("the account-switch contract accepts an optional login email", () => {
  const result = rpcContract.switchAccount.input.safeParse({
    email: "someone@example.com",
    mode: "login",
    threadId: "thread_1",
  });

  assert.equal(result.success, true);
});

test("the account-switch contract does not promise an unsupported automatic retry", () => {
  const result = rpcContract.switchAccount.output.safeParse({ outcome: "retried" });

  assert.equal(result.success, false);
});
