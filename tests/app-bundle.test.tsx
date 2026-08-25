// @vitest-environment jsdom

import * as RadixDialog from "@radix-ui/react-dialog";
import * as RadixTooltip from "@radix-ui/react-tooltip";
import * as ClassVarianceAuthority from "class-variance-authority";
import * as Clsx from "clsx";
import {
  installTestPluginRuntime,
  loadPluginApp,
} from "@get-bb/plugin-sdk/testing/app";
import * as React from "react";
import * as ReactDom from "react-dom";
import * as JsxRuntime from "react/jsx-runtime";
import * as Sonner from "sonner";
import * as TailwindMerge from "tailwind-merge";
import { expect, test } from "vitest";

test("the built app bundle activates exactly one account-switch action", async () => {
  installTestPluginRuntime();
  const host = globalThis as typeof globalThis & {
    __bbPluginRuntime?: Record<string, unknown>;
  };
  host.__bbPluginRuntime = {
    ...host.__bbPluginRuntime,
    classVarianceAuthority: ClassVarianceAuthority,
    clsx: Clsx,
    jsxRuntime: JsxRuntime,
    radixDialog: RadixDialog,
    radixTooltip: RadixTooltip,
    react: React,
    reactDom: ReactDom,
    sonner: Sonner,
    tailwindMerge: TailwindMerge,
  };

  const app = await loadPluginApp(
    // @ts-expect-error The generated app bundle intentionally has no declaration file.
    () => import("../dist/app.js"),
  );

  expect(app.threadHeaderActions).toHaveLength(1);
  expect(app.threadHeaderActions[0]).toMatchObject({
    id: "switch-claude-account",
    title: "Switch Claude login",
  });
  expect(app.threadHeaderActions[0]?.component).toEqual(expect.any(Function));
});
