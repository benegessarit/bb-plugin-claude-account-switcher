import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

const threadInput = z.object({ threadId: z.string().min(1) }).strict();
const switchInput = threadInput
  .extend({
    email: z.string().trim().email().max(254).optional(),
    mode: z.enum(["current", "login"]),
  })
  .strict();
const loginCodeInput = threadInput
  .extend({ code: z.string().trim().min(1).max(4096) })
  .strict();

export const rpcContract = defineRpcContract({
  cancelSwitch: {
    input: threadInput,
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
  submitLoginCode: {
    input: loginCodeInput,
    output: z.object({ submitted: z.literal(true) }).strict(),
  },
  switchAccount: {
    input: switchInput,
    output: z.discriminatedUnion("outcome", [
      z.object({ outcome: z.literal("ready-next-message") }).strict(),
      z.object({ outcome: z.literal("retried") }).strict(),
      z.object({ outcome: z.literal("login-changed-not-rebound") }).strict(),
    ]),
  },
});
