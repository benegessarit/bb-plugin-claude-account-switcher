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
          codeReady: z.boolean(),
          mode: z.enum(["current", "login"]),
          operationId: z.string().uuid(),
          phase: z.enum(["cancellable", "cancelling", "committed"]),
          status: z.literal("running"),
        })
        .strict(),
    ]),
  },
  submitLoginCode: {
    input: loginCodeInput,
    output: z.object({ submitted: z.literal(true) }).strict(),
  },
  switchAccount: {
    input: switchInput,
    output: switchResult,
  },
});
