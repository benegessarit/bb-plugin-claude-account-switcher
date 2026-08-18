// @vitest-environment jsdom

import { fireEvent, waitFor } from "@testing-library/react";
import {
  loadPluginApp,
  renderSlot,
} from "@get-bb/plugin-sdk/testing/app";
import { expect, test } from "vitest";
import type { rpcContract } from "../contract";

const actionProps = {
  isCompactViewport: false,
  projectId: "project_1",
  threadId: "thread_1",
};

test("the account switch icon has BB's native tooltip", async () => {
  const app = await loadPluginApp(() => import("../app.tsx"));
  const slot = renderSlot<
    typeof actionProps,
    typeof rpcContract
  >(app.threadHeaderActions[0]!, actionProps, {
    rpc: {
      cancelSwitch: async () => ({ cancelled: false }),
      inspectThread: async () => ({ isClaude: true }),
      submitLoginCode: async () => ({ submitted: true }),
      switchAccount: async () => ({ retrying: true }),
    },
  });

  try {
    const trigger = await slot.findByRole("button", {
      name: "Switch Claude account and retry this session",
    });
    expect(trigger.querySelector('[data-icon="UserSwitch"]')).not.toBeNull();
    fireEvent.focus(trigger);

    expect((await slot.findByRole("tooltip")).textContent).toContain(
      "Switch Claude account",
    );
  } finally {
    slot.lifecycle.unmount();
  }
});

test("the target account email is chosen before OAuth starts", async () => {
  const app = await loadPluginApp(() => import("../app.tsx"));
  const slot = renderSlot<
    typeof actionProps,
    typeof rpcContract
  >(app.threadHeaderActions[0]!, actionProps, {
    rpc: {
      cancelSwitch: async () => ({ cancelled: false }),
      inspectThread: async () => ({ isClaude: true }),
      submitLoginCode: async () => ({ submitted: true }),
      switchAccount: async () => ({ retrying: true }),
    },
  });

  try {
    fireEvent.click(
      await slot.findByRole("button", {
        name: "Switch Claude account and retry this session",
      }),
    );
    const email = await slot.findByRole("textbox", {
      name: "Claude account email",
    });
    fireEvent.change(email, {
      target: { value: "second+claude@example.com" },
    });
    fireEvent.click(
      await slot.findByRole("button", { name: "Open login and retry" }),
    );

    await waitFor(() => {
      expect(slot.inspection.rpcCalls).toContainEqual({
        method: "switchAccount",
        input: {
          email: "second+claude@example.com",
          threadId: "thread_1",
        },
      });
    });
  } finally {
    slot.lifecycle.unmount();
  }
});

test("a browser authorization code can be returned to the waiting login", async () => {
  let rejectSwitch!: (error: Error) => void;
  const switchResult = new Promise<{ retrying: true }>((_resolve, reject) => {
    rejectSwitch = reject;
  });
  const app = await loadPluginApp(() => import("../app.tsx"));
  const slot = renderSlot<
    typeof actionProps,
    typeof rpcContract
  >(app.threadHeaderActions[0]!, actionProps, {
    rpc: {
      cancelSwitch: async () => {
        rejectSwitch(new Error("Claude login was cancelled."));
        return { cancelled: true };
      },
      inspectThread: async () => ({ isClaude: true }),
      submitLoginCode: async () => ({ submitted: true }),
      switchAccount: async () => switchResult,
    },
  });

  try {
    fireEvent.click(
      await slot.findByRole("button", {
        name: "Switch Claude account and retry this session",
      }),
    );
    fireEvent.change(
      await slot.findByRole("textbox", { name: "Claude account email" }),
      { target: { value: "second+claude@example.com" } },
    );
    fireEvent.click(
      await slot.findByRole("button", { name: "Open login and retry" }),
    );
    const code = await slot.findByRole("textbox", {
      name: "Authorization code",
    });
    fireEvent.change(code, { target: { value: "test-authorization-code" } });
    fireEvent.click(
      await slot.findByRole("button", { name: "Submit authorization code" }),
    );

    await waitFor(() => {
      expect(slot.inspection.rpcCalls).toContainEqual({
        method: "submitLoginCode",
        input: {
          code: "test-authorization-code",
          threadId: "thread_1",
        },
      });
    });
    fireEvent.click(await slot.findByRole("button", { name: "Cancel" }));
  } finally {
    rejectSwitch(new Error("test cleanup"));
    await switchResult.catch(() => undefined);
    slot.lifecycle.unmount();
  }
});

test("Cancel closes the dialog and cancels the active login", async () => {
  let rejectSwitch!: (error: Error) => void;
  const switchResult = new Promise<{ retrying: true }>((_resolve, reject) => {
    rejectSwitch = reject;
  });
  const app = await loadPluginApp(() => import("../app.tsx"));
  const action = app.threadHeaderActions[0]!;
  const slot = renderSlot<
    { threadId: string; projectId: string; isCompactViewport: boolean },
    typeof rpcContract
  >(
    action,
    actionProps,
    {
      rpc: {
        cancelSwitch: async () => {
          rejectSwitch(new Error("Claude login was cancelled."));
          return { cancelled: true };
        },
        inspectThread: async () => ({ isClaude: true }),
        submitLoginCode: async () => ({ submitted: true }),
        switchAccount: async () => switchResult,
      },
    },
  );

  try {
    const trigger = await slot.findByRole("button", {
      name: "Switch Claude account and retry this session",
    });
    fireEvent.click(trigger);
    fireEvent.change(
      await slot.findByRole("textbox", { name: "Claude account email" }),
      { target: { value: "second+claude@example.com" } },
    );
    fireEvent.click(
      await slot.findByRole("button", { name: "Open login and retry" }),
    );
    const cancel = await slot.findByRole("button", { name: "Cancel" });

    expect((cancel as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(cancel);

    await waitFor(() => {
      expect(slot.queryByRole("dialog")).toBeNull();
      expect(slot.inspection.rpcCalls.map((call) => call.method)).toContain(
        "cancelSwitch",
      );
    });
  } finally {
    rejectSwitch(new Error("test cleanup"));
    await switchResult.catch(() => undefined);
    slot.lifecycle.unmount();
  }
});
