import {
  Cancel01Icon,
  Loading03Icon,
  UserSwitchIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { cn } from "@/lib/utils";

const ICONS = {
  Loading: Loading03Icon,
  UserSwitch: UserSwitchIcon,
  X: Cancel01Icon,
} as const satisfies Record<string, IconSvgElement>;

export interface IconProps {
  readonly name: keyof typeof ICONS;
  readonly className?: string;
  readonly "aria-hidden"?: boolean | "true" | "false";
  readonly "aria-label"?: string;
}

export function Icon({
  name,
  className,
  "aria-hidden": ariaHidden,
  "aria-label": ariaLabel,
}: IconProps) {
  return (
    <HugeiconsIcon
      aria-hidden={ariaHidden}
      aria-label={ariaLabel}
      className={cn(className)}
      data-icon={name}
      icon={ICONS[name]}
    />
  );
}
