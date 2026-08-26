import assert from "node:assert/strict";
import test from "node:test";
import { rpcContract } from "../contract.ts";

const OPERATION_ID = "a5a3434e-3728-4951-8c3f-a17ca2f5f234";

test("the account-switch contract rejects the removed email-prefill field", () => {
  const result = rpcContract.beginSwitch.input.safeParse({
    email: "someone@example.com",
    mode: "login",
    operationId: OPERATION_ID,
    threadId: "thread_1",
  });

  assert.equal(result.success, false);
});

test("authorization-code input is one bounded printable line", () => {
  assert.equal(
    rpcContract.submitLoginCode.input.safeParse({
      code: "printable-code_123-ABC",
      operationId: OPERATION_ID,
      threadId: "thread_1",
    }).success,
    true,
  );
  for (const code of ["line-one\nline-two", "carriage\rreturn", "escape\x1b", ""])
    assert.equal(
      rpcContract.submitLoginCode.input.safeParse({
        code,
        operationId: OPERATION_ID,
        threadId: "thread_1",
      }).success,
      false,
    );
  assert.equal(
    rpcContract.submitLoginCode.input.safeParse({
      code: "printable-code_123-ABC",
      threadId: "thread_1",
    }).success,
    false,
  );
});

test("the account-switch contract does not promise an unsupported automatic retry", () => {
  const result = rpcContract.attachSwitch.output.safeParse({ outcome: "retried" });

  assert.equal(result.success, false);
});

test("active switch inspection has one server-authoritative shape", () => {
  const inspectSwitch = Reflect.get(rpcContract, "inspectSwitch") as
    | { readonly output: { safeParse(value: unknown): { success: boolean } } }
    | undefined;

  assert.equal(inspectSwitch?.output.safeParse({ status: "none" }).success, true);
  assert.equal(
    inspectSwitch?.output.safeParse({
      canReturnToAuthorization: true,
      codeReady: true,
      mode: "login",
      operationId: "a5a3434e-3728-4951-8c3f-a17ca2f5f234",
      phase: "cancellable",
      step: "login",
      status: "running",
    }).success,
    true,
  );
  assert.equal(
    inspectSwitch?.output.safeParse({
      completion: {
        kind: "result",
        result: { outcome: "ready-next-message" },
      },
      mode: "current",
      operationId: OPERATION_ID,
      status: "finished",
    }).success,
    true,
  );
});

test("authorization return is bound to one switch operation", () => {
  assert.equal(
    rpcContract.reopenAuthorization.input.safeParse({
      operationId: OPERATION_ID,
      threadId: "thread_1",
    }).success,
    true,
  );
  assert.equal(
    rpcContract.reopenAuthorization.input.safeParse({ threadId: "thread_1" }).success,
    false,
  );
  assert.equal(
    rpcContract.reopenAuthorization.output.safeParse({ opened: true }).success,
    true,
  );
});

test("reattachment never starts a missing account switch", () => {
  const attachSwitch = Reflect.get(rpcContract, "attachSwitch") as
    | {
        readonly input: { safeParse(value: unknown): { success: boolean } };
        readonly output: { safeParse(value: unknown): { success: boolean } };
      }
    | undefined;
  assert.equal(
    attachSwitch?.input.safeParse({
      operationId: OPERATION_ID,
      threadId: "thread_1",
    }).success,
    true,
  );
  assert.equal(attachSwitch?.input.safeParse({ threadId: "thread_1" }).success, false);
  assert.equal(
    attachSwitch?.output.safeParse({ outcome: "ready-next-message" }).success,
    true,
  );
  assert.equal(
    attachSwitch?.output.safeParse({ outcome: "login-changed-not-rebound" }).success,
    true,
  );
  assert.equal(
    attachSwitch?.output.safeParse({ outcome: "not-running" }).success,
    true,
  );
  assert.equal(
    rpcContract.beginSwitch.output.safeParse({ outcome: "not-running" }).success,
    false,
  );
});

test("every switch mutation is bound to one operation", () => {
  assert.equal(
    rpcContract.beginSwitch.input.safeParse({
      mode: "login",
      operationId: OPERATION_ID,
      threadId: "thread_1",
    }).success,
    true,
  );
  assert.equal(
    rpcContract.beginSwitch.input.safeParse({
      mode: "login",
      threadId: "thread_1",
    }).success,
    false,
  );
  assert.equal(
    rpcContract.cancelSwitch.input.safeParse({
      operationId: OPERATION_ID,
      threadId: "thread_1",
    }).success,
    true,
  );
  assert.equal(
    rpcContract.cancelSwitch.input.safeParse({ threadId: "thread_1" }).success,
    false,
  );
});

test("switch admission has typed accepted and busy outcomes", () => {
  for (const value of [
    { outcome: "accepted" },
    {
      mode: "login",
      operationId: OPERATION_ID,
      outcome: "thread-busy",
    },
    { outcome: "host-busy" },
    { outcome: "thread-not-ready", reason: "thread-not-idle" },
    { outcome: "cancelled" },
  ]) {
    assert.equal(rpcContract.beginSwitch.output.safeParse(value).success, true);
  }
  assert.equal(Reflect.has(rpcContract, "switchAccount"), false);
});
