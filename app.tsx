import { useEffect, useId, useRef, useState } from "react";
import { definePluginApp, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "./contract";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

const LOGIN_CHANGED_MESSAGE =
  "Claude sign-in finished, but BB could not verify that subscription for this session. The machine login may have changed; this session was not released.";
type CancellationResult = "cancelled" | "not-cancelled";
type SwitchPhase = "cancellable" | "cancelling" | "committed";

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : "The account switch failed.";
}

function SwitchClaudeAccountAction({ threadId }: { threadId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const [isClaude, setIsClaude] = useState(false);
  const [open, setOpen] = useState(false);
  const [switchingMode, setSwitchingMode] = useState<"current" | "login" | null>(null);
  const [switchPhase, setSwitchPhase] = useState<SwitchPhase | null>(null);
  const [codeReady, setCodeReady] = useState(false);
  const [codeExpanded, setCodeExpanded] = useState(false);
  const [authorizationCode, setAuthorizationCode] = useState("");
  const [submittingCode, setSubmittingCode] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const authorizationCodeId = useId();
  const activeOperationId = useRef<string | null>(null);
  const cancelRequested = useRef(false);
  const cancellation = useRef<Promise<CancellationResult> | null>(null);

  useEffect(() => {
    let mounted = true;
    void rpc
      .call("inspectThread", { threadId })
      .then(({ isClaude: next }) => {
        if (mounted) setIsClaude(next);
      })
      .catch(() => {
        if (mounted) setIsClaude(false);
      });
    return () => {
      mounted = false;
    };
  }, [rpc, threadId]);

  const finishWith = (
    result:
      | { outcome: "cancelled" }
      | { outcome: "ready-next-message" }
      | { outcome: "login-changed-not-rebound" },
  ) => {
    if (result.outcome === "cancelled") {
      setOpen(false);
      return;
    }
    if (result.outcome === "login-changed-not-rebound") {
      if (cancelRequested.current) toast.error(LOGIN_CHANGED_MESSAGE);
      else setError(LOGIN_CHANGED_MESSAGE);
      return;
    }

    toast.success("Ready. The next message will use the verified Claude subscription.");
    setOpen(false);
  };

  const runSwitch = async (
    mode: "current" | "login",
    operationId?: string,
    restored?: { readonly codeReady: boolean; readonly phase: SwitchPhase },
  ) => {
    const targetOperationId = operationId ?? globalThis.crypto.randomUUID();
    activeOperationId.current = targetOperationId;
    cancelRequested.current = false;
    cancellation.current = null;
    setSwitchingMode(mode);
    setSwitchPhase(restored?.phase ?? "cancellable");
    setCodeReady(restored?.codeReady ?? false);
    setCodeExpanded(false);
    setAuthorizationCode("");
    setError(null);
    try {
      const result = operationId
        ? await rpc.call("attachSwitch", {
            operationId: targetOperationId,
            threadId,
          })
        : await rpc.call("switchAccount", {
            mode,
            operationId: targetOperationId,
            threadId,
          });
      if (result.outcome === "not-running") {
        setOpen(false);
        return;
      }
      finishWith(result);
    } catch (caught) {
      if (cancelRequested.current && cancellation.current) {
        const result = await cancellation.current;
        if (result === "cancelled") return;
        toast.error(messageFrom(caught));
      } else {
        setError(messageFrom(caught));
      }
    } finally {
      if (activeOperationId.current === targetOperationId) {
        activeOperationId.current = null;
        setSwitchingMode(null);
        setSwitchPhase(null);
        setCodeReady(false);
      }
    }
  };

  useEffect(() => {
    let mounted = true;
    void rpc
      .call("inspectSwitch", { threadId })
      .then((active) => {
        if (!mounted || active.status === "none") return;
        setOpen(true);
        void runSwitch(active.mode, active.operationId, {
          codeReady: active.codeReady,
          phase: active.phase,
        });
      })
      .catch(() => undefined);
    return () => {
      mounted = false;
    };
  }, [rpc, threadId]);

  useEffect(() => {
    const operationId = activeOperationId.current;
    if (!operationId || switchingMode !== "login") return;

    let disposed = false;
    let needsRefresh = true;
    let refreshDelayMs = 250;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      try {
        const active = await rpc.call("inspectSwitch", { threadId });
        if (disposed) return;
        if (active.status !== "running" || active.operationId !== operationId) {
          needsRefresh = false;
          return;
        }
        setSwitchPhase(active.phase);
        setCodeReady(active.codeReady);
        needsRefresh = active.phase === "cancellable";
        refreshDelayMs = active.codeReady ? 500 : 250;
      } catch {
        // The attached result remains authoritative. Progress refresh is best-effort.
      } finally {
        if (!disposed && needsRefresh) {
          timer = setTimeout(() => void refresh(), refreshDelayMs);
        }
      }
    };
    void refresh();

    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
    };
  }, [rpc, switchingMode, threadId]);

  const closeDialog = () => {
    setOpen(false);
    setError(null);
    setCodeExpanded(false);
    setAuthorizationCode("");
    const operationId = activeOperationId.current;
    if (!switchingMode || !operationId || switchPhase !== "cancellable") return;

    cancelRequested.current = true;
    setSwitchPhase("cancelling");
    cancellation.current = rpc
      .call("cancelSwitch", { operationId, threadId })
      .then(({ outcome }) => {
        if (outcome === "completing") setSwitchPhase("committed");
        return outcome === "cancelled-before-login" ||
          outcome === "cancelled-before-release"
          ? "cancelled"
          : "not-cancelled";
      })
      .catch((caught) => {
        toast.error(`BB could not cancel the Claude login: ${messageFrom(caught)}`);
        return "not-cancelled";
      });
  };

  const submitAuthorizationCode = async () => {
    const operationId = activeOperationId.current;
    if (!authorizationCode.trim() || !operationId) return;
    setSubmittingCode(true);
    setError(null);
    try {
      await rpc.call("submitLoginCode", {
        code: authorizationCode,
        operationId,
        threadId,
      });
      setAuthorizationCode("");
      setCodeExpanded(false);
    } catch (caught) {
      setError(messageFrom(caught));
    } finally {
      setSubmittingCode(false);
    }
  };

  const switching = switchingMode !== null;

  if (!isClaude) return null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          closeDialog();
          return;
        }
        setOpen(true);
      }}
    >
      <TooltipProvider delayDuration={300}>
        <Tooltip>
          <TooltipTrigger asChild>
            <DialogTrigger asChild>
              <Button
                aria-label="Switch Claude login for this session"
                className="size-7 text-muted-foreground hover:text-foreground"
                size="icon"
                variant="ghost"
              >
                <Icon name="UserSwitch" aria-hidden="true" />
              </Button>
            </DialogTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom">Switch Claude login</TooltipContent>
        </Tooltip>
      </TooltipProvider>

      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Switch Claude login</DialogTitle>
          <DialogDescription className="space-y-2">
            <span className="block">
              Reuse the Claude subscription already signed in on this machine, then ask
              BB to release this session&apos;s loaded runtime.
            </span>
            <span className="block">
              Do not start another message until this finishes. Claude sign-in is
              machine-wide; other sessions use it after their own runtime is released.
            </span>
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <Button
            className="w-full"
            disabled={switching}
            onClick={() => void runSwitch("current")}
          >
            {switchingMode === "current" ? "Verifying login…" : "Use current login"}
          </Button>

          <Button
            className="w-full"
            disabled={switching}
            onClick={() => void runSwitch("login")}
            variant="outline"
          >
            {switchingMode === "login"
              ? "Waiting for Claude…"
              : "Sign in to another account"}
          </Button>

          {switchingMode === "login" && (
            <div className="space-y-3 rounded-lg border border-border bg-muted/30 p-3">
              <p className="text-sm text-muted-foreground">
                BB opens at most one Chrome Incognito window for this switch so Claude
                does not reuse the account signed in to your normal window.
              </p>
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Icon name="Loading" className="animate-spin" aria-hidden="true" />
                <span>
                  {switchPhase === "cancelling"
                    ? "Cancelling Claude login…"
                    : switchPhase === "committed"
                      ? "Claude login changed. BB is finishing the switch…"
                      : "Finish signing in on Claude's website."}
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                Choose the account there. Chrome may still offer saved passwords from
                that profile. Leave this dialog open; BB finishes only after Claude Code
                confirms the login.
              </p>
              {switchPhase === "cancellable" && !codeExpanded ? (
                <Button
                  className="h-auto p-0 text-xs"
                  onClick={() => setCodeExpanded(true)}
                  variant="link"
                >
                  Claude showed a code?
                </Button>
              ) : switchPhase === "cancellable" ? (
                <div className="space-y-2">
                  <label className="text-xs font-medium" htmlFor={authorizationCodeId}>
                    Authorization code
                  </label>
                  <Input
                    autoComplete="off"
                    id={authorizationCodeId}
                    onChange={(event) => setAuthorizationCode(event.target.value)}
                    placeholder="Paste the one-time code from Claude"
                    type="password"
                    value={authorizationCode}
                  />
                  <Button
                    className="w-full"
                    disabled={!codeReady || !authorizationCode.trim() || submittingCode}
                    onClick={() => void submitAuthorizationCode()}
                    size="sm"
                  >
                    {submittingCode
                      ? "Submitting…"
                      : codeReady
                        ? "Submit authorization code"
                        : "Waiting for Claude…"}
                  </Button>
                </div>
              ) : null}
            </div>
          )}
        </div>

        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}

        <DialogFooter>
          <DialogClose asChild>
            <Button
              aria-label={
                switching && switchPhase !== "cancellable"
                  ? "Close account switch"
                  : undefined
              }
              variant="ghost"
            >
              {switching && switchPhase !== "cancellable" ? "Close" : "Cancel"}
            </Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_threadHeaderAction({
    id: "switch-claude-account",
    title: "Switch Claude login",
    component: SwitchClaudeAccountAction,
  });
});
