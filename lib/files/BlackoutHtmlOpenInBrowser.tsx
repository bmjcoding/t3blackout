// t3blackout: "Open in browser" on an inline html_render page. It opens in the
// integrated browser, like a workspace HTML file does; with ⌘/Ctrl held, or
// where there's no integrated browser, it opens in the system browser.

import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { AuthPreviewOperateScope, type EnvironmentId, type ScopedThreadRef } from "@t3tools/contracts";
import { Globe2Icon } from "lucide-react";

import { openUrlInPreview } from "~/browser/openFileInPreview";
import { usePreviewAvailable } from "~/browser/previewRuntime";
import { readLocalApi } from "~/localApi";
import { previewEnvironment } from "~/state/preview";
import { useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";

import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

function openFailed(description: string) {
  toastManager.add({ type: "error", title: "Unable to open page in browser", description });
}

export function BlackoutHtmlOpenInBrowser(props: {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef | undefined;
  /** A URL for the page with enough life left to load. */
  readonly pageUrl: () => Promise<string | null>;
}) {
  const previewAvailable = usePreviewAvailable(props.environmentId);
  const canOperatePreview = useEnvironmentScope(props.environmentId, AuthPreviewOperateScope);
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: false });

  const open = async (external: boolean) => {
    const url = await props.pageUrl();
    if (url === null) {
      openFailed("Reconnect to the environment and try again.");
      return;
    }
    const { threadRef } = props;
    if (external || threadRef === undefined || !previewAvailable || !canOperatePreview) {
      await readLocalApi()
        ?.shell.openExternal(url)
        .catch((error: unknown) =>
          openFailed(error instanceof Error ? error.message : "An error occurred."),
        );
      return;
    }
    const result = await openUrlInPreview({ threadRef, url, openPreview });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      openFailed(error instanceof Error ? error.message : "An error occurred.");
    }
  };

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label="Open in browser"
            size="icon-xs"
            variant="glass"
            onClick={(event) => void open(event.metaKey || event.ctrlKey)}
          />
        }
      >
        <Globe2Icon className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup side="left">Open in browser</TooltipPopup>
    </Tooltip>
  );
}
