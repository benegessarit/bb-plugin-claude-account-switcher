// @vitest-environment jsdom

import { fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { expect, test } from "vitest";
import type { rpcContract } from "../contract";

const actionProps = {
  isCompactViewport: false,
  projectId: "project_1",
  threadId: "thread_1",
};

const defaultRpc = {
  cancelSwitch: async () => ({ outcome: "not-running" as const }),
  inspectThread: async () => ({ isClaude: true }),
  submitLoginCode: async () => ({ submitted: true as const }),
  switchAccount: async () => ({ outcome: "ready-next-message" as const }),
};

async function renderAction(
  rpc: typeof defaultRpc | Record<string, unknown> = defaultRpc,
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
        input: { mode: "current", threadId: "thread_1" },
      });
    });
  } finally {
    slot.lifecycle.unmount();
  }
});

test("sign-in is optional, uses an isolated browser, and accepts a blank email prefill", async () => {
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
    expect(
      await slot.findByRole("textbox", { name: "Email to prefill (optional)" }),
    ).toHaveProperty("value", "");
    expect(await slot.findByText(/isolated browser window/i)).not.toBeNull();
    fireEvent.click(
      await slot.findByRole("button", { name: "Open isolated Claude login" }),
    );

    await waitFor(() => {
      expect(slot.inspection.rpcCalls).toContainEqual({
        method: "switchAccount",
        input: { mode: "login", threadId: "thread_1" },
      });
    });
  } finally {
    slot.lifecycle.unmount();
  }
});

test("the browser handoff explains that Claude's home screen does not end the BB flow", async () => {
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
    fireEvent.click(
      await slot.findByRole("button", { name: "Open isolated Claude login" }),
    );

    expect(
      await slot.findByText(/Claude may leave you on its home screen/i),
    ).not.toBeNull();
    expect(await slot.findByText(/Leave this dialog open/i)).not.toBeNull();
  } finally {
    finishSwitch({ outcome: "ready-next-message" });
    await switchResult;
    slot.lifecycle.unmount();
  }
});

test("an invalid optional email stays in the dialog with one inline error", async () => {
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
    fireEvent.change(
      await slot.findByRole("textbox", { name: "Email to prefill (optional)" }),
      { target: { value: "not-an-email" } },
    );
    fireEvent.click(
      await slot.findByRole("button", { name: "Open isolated Claude login" }),
    );

    expect((await slot.findByRole("alert")).textContent).toContain(
      "valid email address or leave the prefill blank",
    );
    expect(
      slot.inspection.rpcCalls.filter(({ method }) => method === "switchAccount"),
    ).toHaveLength(0);
  } finally {
    slot.lifecycle.unmount();
  }
});

test("the authorization-code field is disclosed only while login waits", async () => {
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
    fireEvent.click(
      await slot.findByRole("button", { name: "Open isolated Claude login" }),
    );
    fireEvent.click(await slot.findByRole("button", { name: "Claude showed a code?" }));
    const code = await slot.findByRole("textbox", { name: "Authorization code" });
    fireEvent.change(code, { target: { value: "test-authorization-code" } });
    fireEvent.click(
      await slot.findByRole("button", { name: "Submit authorization code" }),
    );

    await waitFor(() => {
      expect(slot.inspection.rpcCalls).toContainEqual({
        method: "submitLoginCode",
        input: { code: "test-authorization-code", threadId: "thread_1" },
      });
    });
    fireEvent.click(await slot.findByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(slot.queryByRole("dialog")).toBeNull());
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
    fireEvent.click(
      await slot.findByRole("button", { name: "Open isolated Claude login" }),
    );

    expect((await slot.findByRole("alert")).textContent).toContain(
      "machine login may have changed",
    );
    expect(slot.queryByRole("dialog")).not.toBeNull();
  } finally {
    slot.lifecycle.unmount();
  }
});
