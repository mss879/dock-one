"use client";

import { Eye, EyeOff } from "lucide-react";
import { useState, type ComponentProps } from "react";
import { Input } from "@/components/ui/form";
import { MAX_PASSWORD_LENGTH } from "./auth";

/**
 * Password input with a show/hide toggle. Place it inside a <Field> (the Field wires the label,
 * hint, error and aria attributes to the input).
 */
export function PasswordInput({ className = "", disabled, ...rest }: Omit<ComponentProps<"input">, "type">) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="relative">
      <Input type={visible ? "text" : "password"} maxLength={MAX_PASSWORD_LENGTH} spellCheck={false} autoCapitalize="none" disabled={disabled} className={`pr-12 ${className}`} {...rest} />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        disabled={disabled}
        aria-label={visible ? "Hide password" : "Show password"}
        aria-pressed={visible}
        className="absolute top-0 right-0 grid h-11 w-11 place-items-center text-mute transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-violet disabled:opacity-40"
      >
        {visible ? <EyeOff aria-hidden className="size-4" /> : <Eye aria-hidden className="size-4" />}
      </button>
    </div>
  );
}
