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

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : "The account switch failed.";
}

function SwitchClaudeAccountAction({
  threadId,
}: {
  threadId: string;
  projectId: string;
  isCompactViewport: boolean;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [isClaude, setIsClaude] = useState(false);
  const [open, setOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
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

  const startSwitch = async () => {
    const targetEmail = email.trim();
    if (!EMAIL_PATTERN.test(targetEmail)) {
      setError("Enter the email address for the Claude account you want to use.");
      return;
    }
    cancelRequested.current = false;
    setAuthorizationCode("");
    setSwitching(true);
    setError(null);
    try {
      await rpc.call("switchAccount", { email: targetEmail, threadId });
      toast.success("Claude login changed. Retrying this session.");
      setOpen(false);
    } catch (caught) {
      if (cancelRequested.current) return;
      const nextError = messageFrom(caught);
      setError(nextError);
      toast.error(nextError);
    } finally {
      setSwitching(false);
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
      toast.error(
        `BB could not submit the authorization code: ${messageFrom(caught)}`,
      );
    } finally {
      setSubmittingCode(false);
    }
  };

  const closeDialog = () => {
    setOpen(false);
    setError(null);
    setAuthorizationCode("");
    if (!switching) return;

    cancelRequested.current = true;
    void rpc.call("cancelSwitch", { threadId }).catch((caught) => {
      toast.error(`BB could not cancel the Claude login: ${messageFrom(caught)}`);
    });
  };

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
                aria-label="Switch Claude account and retry this session"
                className="size-7 text-muted-foreground hover:text-foreground"
                size="icon"
                variant="ghost"
              >
                <Icon name="UserSwitch" aria-hidden="true" />
              </Button>
            </DialogTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom">Switch Claude account</TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Switch Claude account?</DialogTitle>
          <DialogDescription className="space-y-2">
            <span className="block">
              BB will open Claude login on this session&apos;s machine. After
              you sign in, BB will release only this session&apos;s old Claude
              runtime and retry its failed turn.
            </span>
            <span className="block">
              The login is machine-wide. Other Claude sessions restarted on
              the same machine can also use the new account.
            </span>
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-1.5">
          <label className="text-sm font-medium" htmlFor={emailInputId}>
            Claude account email
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
            Choose the account here before the browser opens. Do not switch
            accounts inside Claude&apos;s browser flow.
          </p>
        </div>

        {switching && (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Icon name="Loading" className="animate-spin" aria-hidden="true" />
              <span>
                Finish signing in in the browser. BB will retry automatically.
              </span>
            </div>
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
                  {submittingCode ? "Sending…" : "Submit code"}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                If Claude shows a code instead of returning automatically,
                paste it here.
              </p>
            </div>
          </div>
        )}
        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">
              Cancel
            </Button>
          </DialogClose>
          <Button
            disabled={switching || !EMAIL_PATTERN.test(email.trim())}
            onClick={() => void startSwitch()}
          >
            {switching ? "Waiting for login…" : "Open login and retry"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_threadHeaderAction({
    id: "switch-claude-account",
    title: "Switch Claude account",
    component: SwitchClaudeAccountAction,
  });
});
