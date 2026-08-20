// @vitest-environment jsdom

import { fireEvent, waitFor } from "@testing-library/react";
import {
  loadPluginApp,
  renderSlot,
  type PluginRpcTestHandlers,
} from "@get-bb/plugin-sdk/testing/app";
import { toast } from "sonner";
import { beforeEach, expect, test, vi } from "vitest";
import type { rpcContract } from "../contract";

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(
    "a5a3434e-3728-4951-8c3f-a17ca2f5f234",
  );
});

const OPERATION_ID = "a5a3434e-3728-4951-8c3f-a17ca2f5f234";

const actionProps = {
  isCompactViewport: false,
  projectId: "project_1",
  threadId: "thread_1",
};

const defaultRpc = {
  attachSwitch: async () => ({ outcome: "not-running" as const }),
  cancelSwitch: async () => ({ outcome: "not-running" as const }),
  inspectSwitch: async () => ({ status: "none" as const }),
  inspectThread: async () => ({ isClaude: true }),
  submitLoginCode: async () => ({ submitted: true as const }),
  switchAccount: async () => ({ outcome: "ready-next-message" as const }),
};

async function renderAction(
  rpc: PluginRpcTestHandlers<typeof rpcContract> = defaultRpc,
) {
  const app = await loadPluginApp(() => import("../app.tsx"));
  return renderSlot<typeof actionProps, typeof rpcContract>(
    app.threadHeaderActions[0]!,
    actionProps,
    { rpc },
  );
}

test("the account switch icon has BB's native tooltip", async () => {
  const slot = await renderAction();

  try {
    const trigger = await slot.findByRole("button", {
      name: "Switch Claude login for this session",
    });
    expect(trigger.querySelector('[data-icon="UserSwitch"]')).not.toBeNull();
    fireEvent.focus(trigger);
    expect((await slot.findByRole("tooltip")).textContent).toContain(
      "Switch Claude login",
    );
  } finally {
    slot.lifecycle.unmount();
  }
});

test("using the current login is the default and requires no email", async () => {
  const slot = await renderAction();

  try {
    fireEvent.click(
      await slot.findByRole("button", {
        name: "Switch Claude login for this session",
      }),
    );
    expect(slot.queryByRole("textbox", { name: /email/i })).toBeNull();
    fireEvent.click(await slot.findByRole("button", { name: "Use current login" }));

    await waitFor(() => {
      expect(slot.inspection.rpcCalls).toContainEqual({
        method: "switchAccount",
        input: {
          mode: "current",
          operationId: OPERATION_ID,
          threadId: "thread_1",
        },
      });
    });
  } finally {
    slot.lifecycle.unmount();
  }
});

test("sign-in starts on Claude's website without an email field", async () => {
  const slot = await renderAction();

  try {
    fireEvent.click(
      await slot.findByRole("button", {
        name: "Switch Claude login for this session",
      }),
    );
    fireEvent.click(
      await slot.findByRole("button", { name: "Sign in to another account" }),
    );
    expect(slot.queryByRole("textbox", { name: /email/i })).toBeNull();

    await waitFor(() => {
      expect(slot.inspection.rpcCalls).toContainEqual({
        method: "switchAccount",
        input: {
          mode: "login",
          operationId: OPERATION_ID,
          threadId: "thread_1",
        },
      });
    });
  } finally {
    slot.lifecycle.unmount();
  }
});

test("the browser handoff explains why BB opens Chrome Incognito", async () => {
  let finishSwitch!: (result: { outcome: "ready-next-message" }) => void;
  const switchResult = new Promise<{ outcome: "ready-next-message" }>((resolve) => {
    finishSwitch = resolve;
  });
  const slot = await renderAction({
    ...defaultRpc,
    switchAccount: async () => switchResult,
  });

  try {
    fireEvent.click(
      await slot.findByRole("button", {
        name: "Switch Claude login for this session",
      }),
    );
    fireEvent.click(
      await slot.findByRole("button", { name: "Sign in to another account" }),
    );
    expect(await slot.findByText(/one Chrome Incognito window/i)).not.toBeNull();
    expect(await slot.findByText(/may still offer saved passwords/i)).not.toBeNull();
    expect(await slot.findByText(/Leave this dialog open/i)).not.toBeNull();
    expect(slot.queryByText(/home screen/i)).toBeNull();
  } finally {
    finishSwitch({ outcome: "ready-next-message" });
    await switchResult;
    slot.lifecycle.unmount();
  }
});

test("a remounted action reattaches to the active server-side switch", async () => {
  let finishSwitch!: (result: { outcome: "ready-next-message" }) => void;
  const switchResult = new Promise<{ outcome: "ready-next-message" }>((resolve) => {
    finishSwitch = resolve;
  });
  const slot = await renderAction({
    ...defaultRpc,
    attachSwitch: async () => switchResult,
    inspectSwitch: async () => ({
      codeReady: true,
      mode: "login" as const,
      operationId: OPERATION_ID,
      phase: "cancellable" as const,
      status: "running" as const,
    }),
  });

  try {
    expect(await slot.findByRole("dialog")).not.toBeNull();
    expect(
      await slot.findByText("Finish signing in on Claude's website."),
    ).not.toBeNull();
    await waitFor(() => {
      expect(slot.inspection.rpcCalls).toContainEqual({
        method: "attachSwitch",
        input: {
          operationId: OPERATION_ID,
          threadId: "thread_1",
        },
      });
    });
  } finally {
    finishSwitch({ outcome: "ready-next-message" });
    await switchResult;
    slot.lifecycle.unmount();
  }
});

test("the authorization-code fallback is disclosed only while login waits", async () => {
  let rejectSwitch!: (error: Error) => void;
  const switchResult = new Promise<never>((_resolve, reject) => {
    rejectSwitch = reject;
  });
  const slot = await renderAction({
    ...defaultRpc,
    cancelSwitch: async () => {
      rejectSwitch(new Error("Claude login was cancelled."));
      return { outcome: "cancelled-before-login" as const };
    },
    switchAccount: async () => switchResult,
  });

  try {
    fireEvent.click(
      await slot.findByRole("button", {
        name: "Switch Claude login for this session",
      }),
    );
    fireEvent.click(
      await slot.findByRole("button", { name: "Sign in to another account" }),
    );
    expect(slot.queryByRole("textbox", { name: "Authorization code" })).toBeNull();
    fireEvent.click(await slot.findByRole("button", { name: "Claude showed a code?" }));
    const code = await slot.findByLabelText("Authorization code");
    fireEvent.change(code, { target: { value: "test-authorization-code" } });
    fireEvent.click(
      await slot.findByRole("button", { name: "Submit authorization code" }),
    );
    await waitFor(() => {
      expect(slot.inspection.rpcCalls).toContainEqual({
        method: "submitLoginCode",
        input: {
          code: "test-authorization-code",
          operationId: OPERATION_ID,
          threadId: "thread_1",
        },
      });
    });
    fireEvent.click(await slot.findByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(slot.queryByRole("dialog")).toBeNull());
    expect(slot.inspection.rpcCalls).toContainEqual({
      method: "cancelSwitch",
      input: { operationId: OPERATION_ID, threadId: "thread_1" },
    });
  } finally {
    rejectSwitch(new Error("test cleanup"));
    await switchResult.catch(() => undefined);
    slot.lifecycle.unmount();
  }
});

test("failed post-login verification keeps the selected session unreleased", async () => {
  const slot = await renderAction({
    ...defaultRpc,
    switchAccount: async () => ({
      outcome: "login-changed-not-rebound" as const,
    }),
  });

  try {
    fireEvent.click(
      await slot.findByRole("button", {
        name: "Switch Claude login for this session",
      }),
    );
    fireEvent.click(
      await slot.findByRole("button", { name: "Sign in to another account" }),
    );
    expect((await slot.findByRole("alert")).textContent).toContain(
      "machine login may have changed",
    );
    expect(slot.queryByRole("dialog")).not.toBeNull();
  } finally {
    slot.lifecycle.unmount();
  }
});

test("a post-commit failure stays visible after the dialog closes", async () => {
  let rejectSwitch!: (error: Error) => void;
  let reportCompleting!: () => void;
  const switchResult = new Promise<never>((_resolve, reject) => {
    rejectSwitch = reject;
  });
  const completing = new Promise<void>((resolve) => {
    reportCompleting = resolve;
  });
  const slot = await renderAction({
    ...defaultRpc,
    cancelSwitch: async () => {
      reportCompleting();
      return { outcome: "completing" as const };
    },
    switchAccount: async () => switchResult,
  });

  try {
    fireEvent.click(
      await slot.findByRole("button", {
        name: "Switch Claude login for this session",
      }),
    );
    fireEvent.click(await slot.findByRole("button", { name: "Use current login" }));
    fireEvent.click(await slot.findByRole("button", { name: "Cancel" }));
    await completing;

    rejectSwitch(new Error("BB could not release this session's runtime."));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        "BB could not release this session's runtime.",
      );
    });
  } finally {
    rejectSwitch(new Error("test cleanup"));
    await switchResult.catch(() => undefined);
    slot.lifecycle.unmount();
  }
});
