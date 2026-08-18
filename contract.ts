import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

const threadInput = z.object({ threadId: z.string().min(1) }).strict();
const switchInput = threadInput
  .extend({ email: z.string().trim().email().max(254) })
  .strict();
const loginCodeInput = threadInput
  .extend({ code: z.string().trim().min(1).max(4096) })
  .strict();

export const rpcContract = defineRpcContract({
  cancelSwitch: {
    input: threadInput,
    output: z.object({ cancelled: z.boolean() }).strict(),
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
    output: z.object({ retrying: z.literal(true) }).strict(),
  },
});
