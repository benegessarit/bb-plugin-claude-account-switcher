import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

const threadInput = z.object({ threadId: z.string().min(1) }).strict();
const operationInput = threadInput.extend({ operationId: z.string().uuid() }).strict();
const switchInput = operationInput
  .extend({ mode: z.enum(["current", "login"]) })
  .strict();
const loginCodeInput = operationInput
  .extend({
    code: z
      .string()
      .trim()
      .min(1)
      .max(2_048)
      .regex(/^[\x20-\x7e]+$/),
  })
  .strict();
const readyNextMessage = z
  .object({ outcome: z.literal("ready-next-message") })
  .strict();
const loginChangedNotRebound = z
  .object({ outcome: z.literal("login-changed-not-rebound") })
  .strict();
const cancelled = z.object({ outcome: z.literal("cancelled") }).strict();
const notRunning = z.object({ outcome: z.literal("not-running") }).strict();
const switchResult = z.discriminatedUnion("outcome", [
  cancelled,
  readyNextMessage,
  loginChangedNotRebound,
]);
const switchCompletion = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("result"), result: switchResult }).strict(),
  z
    .object({ kind: z.literal("error"), message: z.string().min(1).max(1_000) })
    .strict(),
]);
export const rpcContract = defineRpcContract({
  attachSwitch: {
    input: operationInput,
    output: z.discriminatedUnion("outcome", [
      cancelled,
      readyNextMessage,
      loginChangedNotRebound,
      notRunning,
    ]),
  },
  beginSwitch: {
    input: switchInput,
    output: z.discriminatedUnion("outcome", [
      z.object({ outcome: z.literal("accepted") }).strict(),
      z
        .object({
          mode: z.enum(["current", "login"]),
          operationId: z.string().uuid(),
          outcome: z.literal("thread-busy"),
        })
        .strict(),
      z.object({ outcome: z.literal("host-busy") }).strict(),
      z
        .object({
          outcome: z.literal("thread-not-ready"),
          reason: z.enum([
            "machine-unavailable",
            "not-claude",
            "thread-not-idle",
            "thread-not-ready",
          ]),
        })
        .strict(),
      cancelled,
    ]),
  },
  cancelSwitch: {
    input: operationInput,
    output: z
      .object({
        outcome: z.enum([
          "cancelled-before-login",
          "cancelled-before-release",
          "completing",
          "not-running",
        ]),
      })
      .strict(),
  },
  inspectThread: {
    input: threadInput,
    output: z.object({ isClaude: z.boolean() }).strict(),
  },
  inspectSwitch: {
    input: threadInput,
    output: z.discriminatedUnion("status", [
      z.object({ status: z.literal("none") }).strict(),
      z
        .object({
          canReturnToAuthorization: z.boolean(),
          codeReady: z.boolean(),
          mode: z.enum(["current", "login"]),
          operationId: z.string().uuid(),
          phase: z.enum(["cancellable", "cancelling", "committed"]),
          step: z.enum(["admitting", "cleanup", "login", "verification", "release"]),
          status: z.literal("running"),
        })
        .strict(),
      z
        .object({
          completion: switchCompletion,
          mode: z.enum(["current", "login"]),
          operationId: z.string().uuid(),
          status: z.literal("finished"),
        })
        .strict(),
    ]),
  },
  reopenAuthorization: {
    input: operationInput,
    output: z.object({ opened: z.literal(true) }).strict(),
  },
  submitLoginCode: {
    input: loginCodeInput,
    output: z.object({ submitted: z.literal(true) }).strict(),
  },
});
