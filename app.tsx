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
type SwitchMode = "current" | "login";
type SwitchStep = "admitting" | "cleanup" | "login" | "verification" | "release";

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : "The account switch failed.";
}

function admissionFailureMessage(
  admission:
    | { readonly outcome: "host-busy" }
    | {
        readonly outcome: "thread-not-ready";
        readonly reason:
          | "machine-unavailable"
          | "not-claude"
          | "thread-not-idle"
          | "thread-not-ready";
      },
): string {
  if (admission.outcome === "host-busy") {
    return "A Claude account switch is already open on this machine.";
  }
  switch (admission.reason) {
    case "machine-unavailable":
      return "BB could not identify this session's machine.";
    case "not-claude":
      return "This button only works in Claude Code sessions.";
    case "thread-not-idle":
      return "Wait for this session to become idle before switching its Claude login.";
    case "thread-not-ready":
      return "This session is not ready to rebind.";
  }
}

function progressMessage(step: SwitchStep, phase: SwitchPhase): string {
  if (phase === "cancelling") return "Cancelling Claude login…";
  if (phase === "committed") {
    return "Claude login changed. BB is finishing the switch…";
  }
  switch (step) {
    case "admitting":
      return "Checking session…";
    case "cleanup":
      return "Checking unfinished Claude login helpers…";
    case "login":
      return "Finish signing in on Claude's website.";
    case "verification":
      return "Verifying the Claude subscription…";
    case "release":
      return "Preparing the next message…";
  }
}

function SwitchClaudeAccountAction({ threadId }: { threadId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const [isClaude, setIsClaude] = useState(false);
  const [open, setOpen] = useState(false);
  const [switchingMode, setSwitchingMode] = useState<SwitchMode | null>(null);
  const [switchOperationId, setSwitchOperationId] = useState<string | null>(null);
  const [switchPhase, setSwitchPhase] = useState<SwitchPhase | null>(null);
  const [switchStep, setSwitchStep] = useState<SwitchStep | null>(null);
  const [codeReady, setCodeReady] = useState(false);
  const [codeExpanded, setCodeExpanded] = useState(false);
  const [authorizationCode, setAuthorizationCode] = useState("");
  const [submittingCode, setSubmittingCode] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const authorizationCodeId = useId();
  const isMounted = useRef(true);
  const activeOperationId = useRef<string | null>(null);
  const dialogDismissed = useRef(false);
  const cancelRequested = useRef(false);
  const cancellation = useRef<Promise<CancellationResult> | null>(null);

  useEffect(() => {
    isMounted.current = true;
    return () => {
      isMounted.current = false;
    };
  }, []);

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
    if (!isMounted.current) return;
    if (result.outcome === "cancelled") {
      setOpen(false);
      return;
    }
    if (result.outcome === "login-changed-not-rebound") {
      if (dialogDismissed.current) toast.error(LOGIN_CHANGED_MESSAGE);
      else setError(LOGIN_CHANGED_MESSAGE);
      return;
    }

    toast.success("Ready. The next message will use the verified Claude subscription.");
    setOpen(false);
  };

  const requestCancellation = (operationId: string): Promise<CancellationResult> => {
    const pending = rpc
      .call("cancelSwitch", { operationId, threadId })
      .then(({ outcome }) => {
        if (outcome === "completing" && isMounted.current) {
          setSwitchPhase("committed");
        }
        return outcome === "cancelled-before-login" ||
          outcome === "cancelled-before-release"
          ? "cancelled"
          : "not-cancelled";
      })
      .catch((caught) => {
        if (isMounted.current) {
          toast.error(`BB could not cancel the Claude login: ${messageFrom(caught)}`);
        }
        return "not-cancelled" as const;
      });
    cancellation.current = pending;
    return pending;
  };

  const runSwitch = async (
    mode: SwitchMode,
    operationId?: string,
    restored?: {
      readonly codeReady: boolean;
      readonly phase: SwitchPhase;
      readonly step: SwitchStep;
    },
  ) => {
    let targetOperationId = operationId ?? globalThis.crypto.randomUUID();
    let targetMode = mode;
    activeOperationId.current = targetOperationId;
    setSwitchOperationId(targetOperationId);
    dialogDismissed.current = false;
    cancelRequested.current = false;
    cancellation.current = null;
    setSwitchingMode(targetMode);
    setSwitchPhase(restored?.phase ?? "cancellable");
    setSwitchStep(restored?.step ?? "admitting");
    setCodeReady(restored?.codeReady ?? false);
    setCodeExpanded(false);
    setAuthorizationCode("");
    setError(null);
    try {
      if (!operationId) {
        const admission = await rpc.call("beginSwitch", {
          mode: targetMode,
          operationId: targetOperationId,
          threadId,
        });
        if (!isMounted.current && !cancelRequested.current) return;
        if (
          admission.outcome === "host-busy" ||
          admission.outcome === "thread-not-ready"
        ) {
          setError(admissionFailureMessage(admission));
          return;
        }
        if (admission.outcome === "cancelled") {
          setOpen(false);
          return;
        }
        if (admission.outcome === "thread-busy") {
          targetOperationId = admission.operationId;
          targetMode = admission.mode;
          activeOperationId.current = targetOperationId;
          setSwitchOperationId(targetOperationId);
          setSwitchingMode(targetMode);
        }
        setSwitchStep("cleanup");
        if (cancelRequested.current) {
          setSwitchPhase("cancelling");
          const cancellationResult = await requestCancellation(targetOperationId);
          if (cancellationResult === "cancelled") return;
        }
      }

      const result = await rpc.call("attachSwitch", {
        operationId: targetOperationId,
        threadId,
      });
      if (result.outcome === "not-running") {
        setOpen(false);
        return;
      }
      finishWith(result);
    } catch (caught) {
      if (!isMounted.current) return;
      if (cancelRequested.current && cancellation.current) {
        const result = await cancellation.current;
        if (result === "cancelled") return;
        toast.error(messageFrom(caught));
      } else if (dialogDismissed.current) {
        toast.error(messageFrom(caught));
      } else {
        setError(messageFrom(caught));
      }
    } finally {
      if (isMounted.current && activeOperationId.current === targetOperationId) {
        activeOperationId.current = null;
        setSwitchOperationId(null);
        setSwitchingMode(null);
        setSwitchPhase(null);
        setSwitchStep(null);
        setCodeReady(false);
      }
    }
  };

  useEffect(() => {
    let mounted = true;
    void rpc
      .call("inspectSwitch", { threadId })
      .then((active) => {
        if (!mounted || active.status === "none" || activeOperationId.current) {
          return;
        }
        if (active.status === "finished") {
          if (active.completion.kind === "error") {
            setOpen(true);
            setError(active.completion.message);
          } else if (active.completion.result.outcome === "login-changed-not-rebound") {
            setOpen(true);
            finishWith(active.completion.result);
          }
          return;
        }
        setOpen(true);
        void runSwitch(active.mode, active.operationId, {
          codeReady: active.codeReady,
          phase: active.phase,
          step: active.step,
        });
      })
      .catch(() => undefined);
    return () => {
      mounted = false;
    };
  }, [rpc, threadId]);

  useEffect(() => {
    const operationId = switchOperationId;
    if (!operationId || !switchingMode) return;

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
        setSwitchStep(active.step);
        setCodeReady(active.codeReady);
        needsRefresh = true;
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
  }, [rpc, switchOperationId, switchingMode, threadId]);

  const closeDialog = () => {
    setOpen(false);
    setError(null);
    setCodeExpanded(false);
    setAuthorizationCode("");
    const operationId = activeOperationId.current;
    if (!switchingMode || !operationId) return;

    dialogDismissed.current = true;
    if (switchPhase !== "cancellable") return;

    cancelRequested.current = true;
    setSwitchPhase("cancelling");
    void requestCancellation(operationId);
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
  const activeStep = switchStep ?? "admitting";
  const activePhase = switchPhase ?? "cancellable";

  if (!isClaude) return null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          closeDialog();
          return;
        }
        dialogDismissed.current = false;
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
            {switchingMode === "current"
              ? activeStep === "admitting"
                ? "Checking session…"
                : "Verifying login…"
              : "Use current login"}
          </Button>

          <Button
            className="w-full"
            disabled={switching}
            onClick={() => void runSwitch("login")}
            variant="outline"
          >
            {switchingMode === "login"
              ? activeStep === "admitting"
                ? "Checking session…"
                : "Waiting for Claude…"
              : "Sign in to another account"}
          </Button>

          {switchingMode === "current" && (
            <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/30 p-3 text-sm text-muted-foreground">
              <Icon name="Loading" className="animate-spin" aria-hidden="true" />
              <span>{progressMessage(activeStep, activePhase)}</span>
            </div>
          )}

          {switchingMode === "login" && activeStep !== "admitting" && (
            <div className="space-y-3 rounded-lg border border-border bg-muted/30 p-3">
              <p className="text-sm text-muted-foreground">
                BB asks Chrome at most once for this switch. It does not use cookies
                from your normal windows. Existing Incognito windows share one session,
                so close them first if you need a fresh Claude sign-in.
              </p>
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Icon name="Loading" className="animate-spin" aria-hidden="true" />
                <span>{progressMessage(activeStep, activePhase)}</span>
              </div>
              <p className="text-xs text-muted-foreground">
                Choose the account there. Chrome may offer passwords from the active
                profile; BB never reads or copies them. Leave this dialog open until
                Claude Code confirms the login.
              </p>
              {activeStep === "login" &&
              switchPhase === "cancellable" &&
              !codeExpanded ? (
                <Button
                  className="h-auto p-0 text-xs"
                  onClick={() => setCodeExpanded(true)}
                  variant="link"
                >
                  Claude showed a code?
                </Button>
              ) : activeStep === "login" && switchPhase === "cancellable" ? (
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
