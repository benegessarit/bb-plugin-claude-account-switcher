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
  vi.clearAllMocks();
  vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(
    "a5a3434e-3728-4951-8c3f-a17ca2f5f234",
  );
});

const OPERATION_ID = "a5a3434e-3728-4951-8c3f-a17ca2f5f234";
const OTHER_OPERATION_ID = "00000000-0000-4000-8000-000000000000";

const actionProps = {
  isCompactViewport: false,
  projectId: "project_1",
  threadId: "thread_1",
};

const defaultRpc = {
  attachSwitch: async () => ({ outcome: "not-running" as const }),
  beginSwitch: async () => ({ outcome: "accepted" as const }),
  cancelSwitch: async () => ({ outcome: "not-running" as const }),
  inspectSwitch: async () => ({ status: "none" as const }),
  inspectThread: async () => ({ isClaude: true }),
  submitLoginCode: async () => ({ submitted: true as const }),
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
        method: "beginSwitch",
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
        method: "beginSwitch",
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

test("rapid repeated clicks start only one server operation", async () => {
  let acceptSwitch!: (result: { outcome: "accepted" }) => void;
  const admission = new Promise<{ outcome: "accepted" }>((resolve) => {
    acceptSwitch = resolve;
  });
  const slot = await renderAction({
    ...defaultRpc,
    beginSwitch: async () => admission,
  });

  try {
    fireEvent.click(
      await slot.findByRole("button", {
        name: "Switch Claude login for this session",
      }),
    );
    const start = await slot.findByRole("button", {
      name: "Sign in to another account",
    });
    fireEvent.click(start);
    fireEvent.click(start);

    await waitFor(() => {
      expect(
        slot.inspection.rpcCalls.filter(({ method }) => method === "beginSwitch"),
      ).toHaveLength(1);
    });
  } finally {
    acceptSwitch({ outcome: "accepted" });
    await admission;
    slot.lifecycle.unmount();
  }
});

test("typed admission failures show an actionable error without attaching", async () => {
  const attachSwitch = vi.fn(async () => ({ outcome: "not-running" as const }));
  const slot = await renderAction({
    ...defaultRpc,
    attachSwitch,
    beginSwitch: async () => ({
      outcome: "thread-not-ready" as const,
      reason: "thread-not-idle" as const,
    }),
  });

  try {
    fireEvent.click(
      await slot.findByRole("button", {
        name: "Switch Claude login for this session",
      }),
    );
    fireEvent.click(await slot.findByRole("button", { name: "Use current login" }));

    expect((await slot.findByRole("alert")).textContent).toContain(
      "Wait for this session to become idle",
    );
    expect(attachSwitch).not.toHaveBeenCalled();
  } finally {
    slot.lifecycle.unmount();
  }
});

test("a host-busy admission does not claim that login has started", async () => {
  const attachSwitch = vi.fn(async () => ({ outcome: "not-running" as const }));
  const slot = await renderAction({
    ...defaultRpc,
    attachSwitch,
    beginSwitch: async () => ({ outcome: "host-busy" as const }),
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
      "already open on this machine",
    );
    expect(slot.queryByText(/BB asks Chrome at most once/i)).toBeNull();
    expect(attachSwitch).not.toHaveBeenCalled();
  } finally {
    slot.lifecycle.unmount();
  }
});

test("a thread-busy admission reattaches to the server's exact operation", async () => {
  let finishSwitch!: (result: { outcome: "cancelled" }) => void;
  const switchResult = new Promise<{ outcome: "cancelled" }>((resolve) => {
    finishSwitch = resolve;
  });
  const attachSwitch = vi.fn(async () => switchResult);
  const slot = await renderAction({
    ...defaultRpc,
    attachSwitch,
    beginSwitch: async () => ({
      mode: "login" as const,
      operationId: OTHER_OPERATION_ID,
      outcome: "thread-busy" as const,
    }),
  });

  try {
    fireEvent.click(
      await slot.findByRole("button", {
        name: "Switch Claude login for this session",
      }),
    );
    fireEvent.click(await slot.findByRole("button", { name: "Use current login" }));

    await waitFor(() => {
      expect(attachSwitch).toHaveBeenCalledWith({
        operationId: OTHER_OPERATION_ID,
        threadId: "thread_1",
      });
    });
    expect(await slot.findByText(/BB asks Chrome at most once/i)).not.toBeNull();
  } finally {
    finishSwitch({ outcome: "cancelled" });
    await switchResult;
    slot.lifecycle.unmount();
  }
});

test("same-mode thread-busy reattachment keeps polling the exact operation", async () => {
  let reportBusy!: () => void;
  const admissionReady = new Promise<void>((resolve) => {
    reportBusy = resolve;
  });
  let finishSwitch!: (result: { outcome: "cancelled" }) => void;
  const switchResult = new Promise<{ outcome: "cancelled" }>((resolve) => {
    finishSwitch = resolve;
  });
  let beginStarted = false;
  const inspectSwitch = vi.fn(async () =>
    beginStarted
      ? {
          codeReady: true,
          mode: "login" as const,
          operationId: OTHER_OPERATION_ID,
          phase: "cancellable" as const,
          status: "running" as const,
          step: "login" as const,
        }
      : { status: "none" as const },
  );
  const attachSwitch = vi.fn(async () => switchResult);
  const slot = await renderAction({
    ...defaultRpc,
    attachSwitch,
    beginSwitch: async () => {
      beginStarted = true;
      await admissionReady;
      return {
        mode: "login" as const,
        operationId: OTHER_OPERATION_ID,
        outcome: "thread-busy" as const,
      };
    },
    inspectSwitch,
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
    await waitFor(() => expect(inspectSwitch).toHaveBeenCalledTimes(2));
    reportBusy();

    await waitFor(() => {
      expect(attachSwitch).toHaveBeenCalledWith({
        operationId: OTHER_OPERATION_ID,
        threadId: "thread_1",
      });
    });
    expect(
      await slot.findByText("Finish signing in on Claude's website."),
    ).not.toBeNull();
    fireEvent.click(await slot.findByRole("button", { name: "Claude showed a code?" }));
    expect(
      await slot.findByRole("button", { name: "Submit authorization code" }),
    ).not.toBeNull();
  } finally {
    finishSwitch({ outcome: "cancelled" });
    await switchResult;
    slot.lifecycle.unmount();
  }
});

test("the browser handoff states only what BB and Incognito control", async () => {
  let acceptSwitch!: (result: { outcome: "accepted" }) => void;
  const admission = new Promise<{ outcome: "accepted" }>((resolve) => {
    acceptSwitch = resolve;
  });
  let finishSwitch!: (result: { outcome: "ready-next-message" }) => void;
  const switchResult = new Promise<{ outcome: "ready-next-message" }>((resolve) => {
    finishSwitch = resolve;
  });
  const slot = await renderAction({
    ...defaultRpc,
    attachSwitch: async () => switchResult,
    beginSwitch: async () => admission,
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
    expect(await slot.findByText("Checking session…")).not.toBeNull();
    expect(slot.queryByText(/BB asks Chrome at most once/i)).toBeNull();
    acceptSwitch({ outcome: "accepted" });
    expect(await slot.findByText(/BB asks Chrome at most once/i)).not.toBeNull();
    expect(
      await slot.findByText(/does not use cookies from your normal windows/i),
    ).not.toBeNull();
    expect(
      await slot.findByText(/Existing Incognito windows share one session/i),
    ).not.toBeNull();
    expect(
      await slot.findByText(/may offer passwords from the active profile/i),
    ).not.toBeNull();
    expect(await slot.findByText(/BB never reads or copies them/i)).not.toBeNull();
    expect(await slot.findByText(/Leave this dialog open/i)).not.toBeNull();
    expect(slot.queryByText(/one Chrome Incognito window/i)).toBeNull();
    expect(slot.queryByText(/email to prefill/i)).toBeNull();
    expect(slot.queryByRole("textbox", { name: /email/i })).toBeNull();
    expect(slot.queryByText(/home screen/i)).toBeNull();
  } finally {
    finishSwitch({ outcome: "ready-next-message" });
    await switchResult;
    slot.lifecycle.unmount();
  }
});

test("closing during admission cancels the accepted operation before attach", async () => {
  let acceptSwitch!: (result: { outcome: "accepted" }) => void;
  const admission = new Promise<{ outcome: "accepted" }>((resolve) => {
    acceptSwitch = resolve;
  });
  const attachSwitch = vi.fn(async () => ({ outcome: "not-running" as const }));
  const cancelSwitch = vi
    .fn()
    .mockResolvedValueOnce({ outcome: "not-running" as const })
    .mockResolvedValueOnce({ outcome: "cancelled-before-login" as const });
  const slot = await renderAction({
    ...defaultRpc,
    attachSwitch,
    beginSwitch: async () => admission,
    cancelSwitch,
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
    expect(await slot.findByText("Checking session…")).not.toBeNull();
    fireEvent.click(await slot.findByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(cancelSwitch).toHaveBeenCalledTimes(1));

    acceptSwitch({ outcome: "accepted" });

    await waitFor(() => expect(cancelSwitch).toHaveBeenCalledTimes(2));
    expect(attachSwitch).not.toHaveBeenCalled();
  } finally {
    slot.lifecycle.unmount();
  }
});

test("unmounting during admission leaves the server operation recoverable", async () => {
  let acceptSwitch!: (result: { outcome: "accepted" }) => void;
  const admission = new Promise<{ outcome: "accepted" }>((resolve) => {
    acceptSwitch = resolve;
  });
  const cancelSwitch = vi.fn(async () => ({ outcome: "not-running" as const }));
  const slot = await renderAction({
    ...defaultRpc,
    beginSwitch: async () => admission,
    cancelSwitch,
  });

  fireEvent.click(
    await slot.findByRole("button", {
      name: "Switch Claude login for this session",
    }),
  );
  fireEvent.click(await slot.findByRole("button", { name: "Use current login" }));
  expect(await slot.findByRole("button", { name: "Checking session…" })).not.toBeNull();

  slot.lifecycle.unmount();
  expect(cancelSwitch).not.toHaveBeenCalled();
  acceptSwitch({ outcome: "accepted" });
  await admission;
  expect(cancelSwitch).not.toHaveBeenCalled();
});

test("a late mount inspection cannot attach the operation a second time", async () => {
  let resolveInspection!: (result: {
    codeReady: boolean;
    mode: "login";
    operationId: string;
    phase: "cancellable";
    status: "running";
    step: "login";
  }) => void;
  const inspection = new Promise<{
    codeReady: boolean;
    mode: "login";
    operationId: string;
    phase: "cancellable";
    status: "running";
    step: "login";
  }>((resolve) => {
    resolveInspection = resolve;
  });
  let finishSwitch!: (result: { outcome: "cancelled" }) => void;
  const switchResult = new Promise<{ outcome: "cancelled" }>((resolve) => {
    finishSwitch = resolve;
  });
  const attachSwitch = vi.fn(async () => switchResult);
  const slot = await renderAction({
    ...defaultRpc,
    attachSwitch,
    inspectSwitch: async () => inspection,
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
    await waitFor(() => expect(attachSwitch).toHaveBeenCalledTimes(1));

    resolveInspection({
      codeReady: false,
      mode: "login",
      operationId: OPERATION_ID,
      phase: "cancellable",
      status: "running",
      step: "login",
    });
    await inspection;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(attachSwitch).toHaveBeenCalledTimes(1);
  } finally {
    finishSwitch({ outcome: "cancelled" });
    await switchResult;
    slot.lifecycle.unmount();
  }
});

test("only the mounted attachment reports completion after a remount", async () => {
  let operationActive = false;
  let finishSwitch!: (result: { outcome: "ready-next-message" }) => void;
  const switchResult = new Promise<{ outcome: "ready-next-message" }>((resolve) => {
    finishSwitch = resolve;
  });
  const attachSwitch = vi.fn(async () => switchResult);
  const rpc = {
    ...defaultRpc,
    attachSwitch,
    beginSwitch: async () => {
      operationActive = true;
      return { outcome: "accepted" as const };
    },
    inspectSwitch: async () =>
      operationActive
        ? {
            codeReady: false,
            mode: "current" as const,
            operationId: OPERATION_ID,
            phase: "cancellable" as const,
            status: "running" as const,
            step: "verification" as const,
          }
        : { status: "none" as const },
  };
  const first = await renderAction(rpc);
  let second: Awaited<ReturnType<typeof renderAction>> | undefined;

  try {
    fireEvent.click(
      await first.findByRole("button", {
        name: "Switch Claude login for this session",
      }),
    );
    fireEvent.click(await first.findByRole("button", { name: "Use current login" }));
    await waitFor(() => expect(attachSwitch).toHaveBeenCalledTimes(1));
    first.lifecycle.unmount();

    second = await renderAction(rpc);
    await waitFor(() => expect(attachSwitch).toHaveBeenCalledTimes(2));
    finishSwitch({ outcome: "ready-next-message" });
    await switchResult;

    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1));
  } finally {
    finishSwitch({ outcome: "ready-next-message" });
    await switchResult;
    first.lifecycle.unmount();
    second?.lifecycle.unmount();
  }
});

test("a remounted pending code submission cannot submit a duplicate", async () => {
  let finishSwitch!: (result: { outcome: "ready-next-message" }) => void;
  const switchResult = new Promise<{ outcome: "ready-next-message" }>((resolve) => {
    finishSwitch = resolve;
  });
  const slot = await renderAction({
    ...defaultRpc,
    attachSwitch: async () => switchResult,
    inspectSwitch: async () => ({
      codeReady: false,
      mode: "login" as const,
      operationId: OPERATION_ID,
      phase: "cancellable" as const,
      status: "running" as const,
      step: "login" as const,
    }),
  });

  try {
    fireEvent.click(await slot.findByRole("button", { name: "Claude showed a code?" }));
    const code = await slot.findByLabelText("Authorization code");
    fireEvent.change(code, {
      target: { value: "duplicate-code" },
    });
    const submit = code.parentElement?.querySelector("button");
    expect(submit).not.toBeNull();
    if (!submit) throw new Error("Expected authorization-code submit button.");
    expect(submit.textContent).toBe("Waiting for Claude…");
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(submit);
    expect(
      slot.inspection.rpcCalls.some(({ method }) => method === "submitLoginCode"),
    ).toBe(false);
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
      step: "login" as const,
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

test("a remounted action renders the latest finished receipt without reattaching", async () => {
  const attachSwitch = vi.fn(async () => ({ outcome: "not-running" as const }));
  const slot = await renderAction({
    ...defaultRpc,
    attachSwitch,
    inspectSwitch: async () => ({
      completion: {
        kind: "result" as const,
        result: { outcome: "login-changed-not-rebound" as const },
      },
      mode: "login" as const,
      operationId: OPERATION_ID,
      status: "finished" as const,
    }),
  });

  try {
    expect((await slot.findByRole("alert")).textContent).toContain(
      "machine login may have changed",
    );
    expect(attachSwitch).not.toHaveBeenCalled();
  } finally {
    slot.lifecycle.unmount();
  }
});

test("a finished success receipt does not repeat the original completion toast", async () => {
  const slot = await renderAction({
    ...defaultRpc,
    inspectSwitch: async () => ({
      completion: {
        kind: "result" as const,
        result: { outcome: "ready-next-message" as const },
      },
      mode: "current" as const,
      operationId: OPERATION_ID,
      status: "finished" as const,
    }),
  });

  try {
    await waitFor(() => {
      expect(slot.inspection.rpcCalls).toContainEqual({
        input: { threadId: "thread_1" },
        method: "inspectSwitch",
      });
    });
    expect(toast.success).not.toHaveBeenCalled();
    expect(slot.queryByRole("dialog")).toBeNull();
  } finally {
    slot.lifecycle.unmount();
  }
});

test("a remounted action restores the server cancellation phase", async () => {
  let finishSwitch!: (result: { outcome: "ready-next-message" }) => void;
  const switchResult = new Promise<{ outcome: "ready-next-message" }>((resolve) => {
    finishSwitch = resolve;
  });
  const cancelSwitch = vi.fn(async () => ({ outcome: "completing" as const }));
  const slot = await renderAction({
    ...defaultRpc,
    attachSwitch: async () => switchResult,
    cancelSwitch,
    inspectSwitch: async () => ({
      codeReady: false,
      mode: "login" as const,
      operationId: OPERATION_ID,
      phase: "cancelling" as const,
      status: "running" as const,
      step: "login" as const,
    }),
  });

  try {
    expect(await slot.findByText("Cancelling Claude login…")).not.toBeNull();
    expect(slot.queryByRole("button", { name: "Claude showed a code?" })).toBeNull();
    fireEvent.click(await slot.findByRole("button", { name: "Close account switch" }));
    expect(cancelSwitch).not.toHaveBeenCalled();
  } finally {
    finishSwitch({ outcome: "ready-next-message" });
    await switchResult;
    slot.lifecycle.unmount();
  }
});

test("a remounted action keeps tracking the phase after code input is ready", async () => {
  let finishSwitch!: (result: { outcome: "ready-next-message" }) => void;
  const switchResult = new Promise<{ outcome: "ready-next-message" }>((resolve) => {
    finishSwitch = resolve;
  });
  let phase: "cancellable" | "committed" = "cancellable";
  let inspections = 0;
  const cancelSwitch = vi.fn(async () => ({ outcome: "completing" as const }));
  const slot = await renderAction({
    ...defaultRpc,
    attachSwitch: async () => switchResult,
    cancelSwitch,
    inspectSwitch: async () => {
      inspections += 1;
      return {
        codeReady: true,
        mode: "login" as const,
        operationId: OPERATION_ID,
        phase,
        status: "running" as const,
        step: "login" as const,
      };
    },
  });

  try {
    expect(
      await slot.findByText("Finish signing in on Claude's website."),
    ).not.toBeNull();
    await waitFor(() => expect(inspections).toBeGreaterThanOrEqual(2));
    phase = "committed";

    expect(
      await slot.findByText("Claude login changed. BB is finishing the switch…"),
    ).not.toBeNull();
    fireEvent.click(await slot.findByRole("button", { name: "Close account switch" }));
    expect(cancelSwitch).not.toHaveBeenCalled();
  } finally {
    finishSwitch({ outcome: "ready-next-message" });
    await switchResult;
    slot.lifecycle.unmount();
  }
});

test("closing a committed switch keeps a later changed-login result visible", async () => {
  let operationActive = false;
  let finishSwitch!: (result: { outcome: "login-changed-not-rebound" }) => void;
  const switchResult = new Promise<{
    outcome: "login-changed-not-rebound";
  }>((resolve) => {
    finishSwitch = resolve;
  });
  const cancelSwitch = vi.fn(async () => ({ outcome: "completing" as const }));
  const slot = await renderAction({
    ...defaultRpc,
    attachSwitch: async () => switchResult,
    beginSwitch: async () => {
      operationActive = true;
      return { outcome: "accepted" as const };
    },
    cancelSwitch,
    inspectSwitch: async () =>
      operationActive
        ? {
            codeReady: false,
            mode: "login" as const,
            operationId: OPERATION_ID,
            phase: "committed" as const,
            status: "running" as const,
            step: "release" as const,
          }
        : { status: "none" as const },
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
    expect(
      await slot.findByText("Claude login changed. BB is finishing the switch…"),
    ).not.toBeNull();
    fireEvent.click(await slot.findByRole("button", { name: "Close account switch" }));
    expect(cancelSwitch).not.toHaveBeenCalled();

    finishSwitch({ outcome: "login-changed-not-rebound" });

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        expect.stringContaining("machine login may have changed"),
      );
    });
  } finally {
    finishSwitch({ outcome: "login-changed-not-rebound" });
    await switchResult;
    slot.lifecycle.unmount();
  }
});

test("closing a committed switch keeps a later attachment error visible", async () => {
  let operationActive = false;
  let rejectSwitch!: (error: Error) => void;
  const switchResult = new Promise<never>((_resolve, reject) => {
    rejectSwitch = reject;
  });
  const cancelSwitch = vi.fn(async () => ({ outcome: "completing" as const }));
  const slot = await renderAction({
    ...defaultRpc,
    attachSwitch: async () => switchResult,
    beginSwitch: async () => {
      operationActive = true;
      return { outcome: "accepted" as const };
    },
    cancelSwitch,
    inspectSwitch: async () =>
      operationActive
        ? {
            codeReady: false,
            mode: "current" as const,
            operationId: OPERATION_ID,
            phase: "committed" as const,
            status: "running" as const,
            step: "release" as const,
          }
        : { status: "none" as const },
  });

  try {
    fireEvent.click(
      await slot.findByRole("button", {
        name: "Switch Claude login for this session",
      }),
    );
    fireEvent.click(await slot.findByRole("button", { name: "Use current login" }));
    expect(
      await slot.findByText("Claude login changed. BB is finishing the switch…"),
    ).not.toBeNull();
    fireEvent.click(await slot.findByRole("button", { name: "Close account switch" }));
    expect(cancelSwitch).not.toHaveBeenCalled();

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

test("reopening a committed switch restores inline failure feedback", async () => {
  let operationActive = false;
  let rejectSwitch!: (error: Error) => void;
  const switchResult = new Promise<never>((_resolve, reject) => {
    rejectSwitch = reject;
  });
  const slot = await renderAction({
    ...defaultRpc,
    attachSwitch: async () => switchResult,
    beginSwitch: async () => {
      operationActive = true;
      return { outcome: "accepted" as const };
    },
    inspectSwitch: async () =>
      operationActive
        ? {
            codeReady: false,
            mode: "current" as const,
            operationId: OPERATION_ID,
            phase: "committed" as const,
            status: "running" as const,
            step: "release" as const,
          }
        : { status: "none" as const },
  });

  try {
    fireEvent.click(
      await slot.findByRole("button", {
        name: "Switch Claude login for this session",
      }),
    );
    fireEvent.click(await slot.findByRole("button", { name: "Use current login" }));
    expect(
      await slot.findByText("Claude login changed. BB is finishing the switch…"),
    ).not.toBeNull();
    fireEvent.click(await slot.findByRole("button", { name: "Close account switch" }));
    fireEvent.click(
      await slot.findByRole("button", {
        name: "Switch Claude login for this session",
      }),
    );

    rejectSwitch(new Error("BB could not release this session's runtime."));

    expect((await slot.findByRole("alert")).textContent).toContain(
      "BB could not release this session's runtime.",
    );
    expect(toast.error).not.toHaveBeenCalled();
  } finally {
    rejectSwitch(new Error("test cleanup"));
    await switchResult.catch(() => undefined);
    slot.lifecycle.unmount();
  }
});

test("the authorization-code fallback is disclosed only while login waits", async () => {
  let finishSwitch!: (result: { outcome: "cancelled" }) => void;
  let loginStarted = false;
  const switchResult = new Promise<{ outcome: "cancelled" }>((resolve) => {
    finishSwitch = resolve;
  });
  const slot = await renderAction({
    ...defaultRpc,
    cancelSwitch: async () => {
      finishSwitch({ outcome: "cancelled" });
      return { outcome: "cancelled-before-login" as const };
    },
    inspectSwitch: async () =>
      loginStarted
        ? {
            codeReady: true,
            mode: "login" as const,
            operationId: OPERATION_ID,
            phase: "cancellable" as const,
            status: "running" as const,
            step: "login" as const,
          }
        : { status: "none" as const },
    beginSwitch: async () => {
      loginStarted = true;
      return { outcome: "accepted" as const };
    },
    attachSwitch: async () => switchResult,
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
    expect(toast.error).not.toHaveBeenCalled();
  } finally {
    finishSwitch({ outcome: "cancelled" });
    await switchResult;
    slot.lifecycle.unmount();
  }
});

test("failed post-login verification keeps the selected session unreleased", async () => {
  const slot = await renderAction({
    ...defaultRpc,
    attachSwitch: async () => ({
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
    attachSwitch: async () => switchResult,
    cancelSwitch: async () => {
      reportCompleting();
      return { outcome: "completing" as const };
    },
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
