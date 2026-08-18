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

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LOGIN_CHANGED_MESSAGE =
  "Claude sign-in finished, but BB could not verify that subscription for this session. The machine login may have changed; this session was not released.";

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : "The account switch failed.";
}

function SwitchClaudeAccountAction({ threadId }: { threadId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const [isClaude, setIsClaude] = useState(false);
  const [open, setOpen] = useState(false);
  const [loginExpanded, setLoginExpanded] = useState(false);
  const [codeExpanded, setCodeExpanded] = useState(false);
  const [switchingMode, setSwitchingMode] = useState<"current" | "login" | null>(null);
  const [submittingCode, setSubmittingCode] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [authorizationCode, setAuthorizationCode] = useState("");
  const cancelRequested = useRef(false);
  const emailInputId = useId();
  const authorizationCodeInputId = useId();

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

  if (!isClaude) return null;

  const finishWith = (
    result:
      | { outcome: "ready-next-message" }
      | { outcome: "retried" }
      | { outcome: "login-changed-not-rebound" },
  ) => {
    if (result.outcome === "login-changed-not-rebound") {
      if (cancelRequested.current) toast.error(LOGIN_CHANGED_MESSAGE);
      else setError(LOGIN_CHANGED_MESSAGE);
      return;
    }

    toast.success(
      result.outcome === "retried"
        ? "This session is retrying with the verified Claude subscription."
        : "Ready. The next message will use the verified Claude subscription.",
    );
    setOpen(false);
  };

  const startSwitch = async (mode: "current" | "login") => {
    const targetEmail = email.trim();
    if (mode === "login" && targetEmail && !EMAIL_PATTERN.test(targetEmail)) {
      setError("Enter a valid email address or leave the prefill blank.");
      return;
    }

    cancelRequested.current = false;
    setAuthorizationCode("");
    setCodeExpanded(false);
    setSwitchingMode(mode);
    setError(null);
    try {
      const result = await rpc.call("switchAccount", {
        ...(mode === "login" && targetEmail ? { email: targetEmail } : {}),
        mode,
        threadId,
      });
      finishWith(result);
    } catch (caught) {
      if (cancelRequested.current) return;
      setError(messageFrom(caught));
    } finally {
      setSwitchingMode(null);
    }
  };

  const submitAuthorizationCode = async () => {
    const code = authorizationCode.trim();
    if (!code) return;

    setSubmittingCode(true);
    try {
      await rpc.call("submitLoginCode", { code, threadId });
      setAuthorizationCode("");
      toast.success("Authorization code sent to Claude.");
    } catch (caught) {
      setError(`BB could not submit the authorization code: ${messageFrom(caught)}`);
    } finally {
      setSubmittingCode(false);
    }
  };

  const closeDialog = () => {
    setOpen(false);
    setError(null);
    setAuthorizationCode("");
    setCodeExpanded(false);
    setLoginExpanded(false);
    if (!switchingMode) return;

    cancelRequested.current = true;
    void rpc.call("cancelSwitch", { threadId }).catch((caught) => {
      toast.error(`BB could not cancel the Claude login: ${messageFrom(caught)}`);
    });
  };

  const switching = switchingMode !== null;

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
              Reuse the Claude subscription already signed in on this machine, then
              release only this session&apos;s loaded runtime.
            </span>
            <span className="block">
              Claude sign-in is machine-wide. Other sessions use it after their own
              runtime is released.
            </span>
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <Button
            className="w-full"
            disabled={switching}
            onClick={() => void startSwitch("current")}
          >
            {switchingMode === "current" ? "Verifying login…" : "Use current login"}
          </Button>

          <Button
            aria-expanded={loginExpanded}
            className="w-full"
            disabled={switching}
            onClick={() => setLoginExpanded((value) => !value)}
            variant="outline"
          >
            Sign in to another account
          </Button>

          {loginExpanded && (
            <div className="space-y-3 rounded-lg border border-border bg-muted/30 p-3">
              <div className="space-y-1.5">
                <label className="text-sm font-medium" htmlFor={emailInputId}>
                  Email to prefill (optional)
                </label>
                <Input
                  id={emailInputId}
                  type="email"
                  autoComplete="username"
                  disabled={switching}
                  placeholder="you@example.com"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  This only pre-fills Claude&apos;s login page. Leave it blank to choose
                  in the browser.
                </p>
              </div>

              <Button
                className="w-full"
                disabled={switching}
                onClick={() => void startSwitch("login")}
                variant="secondary"
              >
                {switchingMode === "login"
                  ? "Waiting for Claude…"
                  : "Open Claude login"}
              </Button>

              {switchingMode === "login" && (
                <div className="space-y-2">
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Icon name="Loading" className="animate-spin" aria-hidden="true" />
                    <span>Finish signing in in the browser.</span>
                  </div>
                  <Button
                    aria-expanded={codeExpanded}
                    onClick={() => setCodeExpanded((value) => !value)}
                    size="sm"
                    variant="ghost"
                  >
                    Claude showed a code?
                  </Button>
                </div>
              )}

              {switchingMode === "login" && codeExpanded && (
                <div className="space-y-1.5">
                  <label
                    className="text-sm font-medium"
                    htmlFor={authorizationCodeInputId}
                  >
                    Authorization code
                  </label>
                  <div className="flex gap-2">
                    <Input
                      id={authorizationCodeInputId}
                      autoComplete="off"
                      placeholder="Paste code from Claude"
                      spellCheck={false}
                      value={authorizationCode}
                      onChange={(event) => setAuthorizationCode(event.target.value)}
                    />
                    <Button
                      aria-label="Submit authorization code"
                      disabled={!authorizationCode.trim() || submittingCode}
                      onClick={() => void submitAuthorizationCode()}
                      variant="outline"
                    >
                      {submittingCode ? "Sending…" : "Submit"}
                    </Button>
                  </div>
                </div>
              )}
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
            <Button variant="ghost">Cancel</Button>
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
