"use client";
import { Moon, Sun } from "lucide-react";
import { useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";

/** Dark / light switch. `variant="row"` for menus, `"icon"` for toolbars. */
export function ThemeToggle({ variant = "row", className }: { variant?: "row" | "icon"; className?: string }) {
  const [theme, setTheme] = useTheme();
  const light = theme === "light";
  const toggle = () => setTheme(light ? "dark" : "light");

  if (variant === "icon") {
    return (
      <button type="button" onClick={toggle}
        aria-label={light ? "Switch to dark mode" : "Switch to light mode"} title={light ? "Dark mode" : "Light mode"}
        className={cn("w-9 h-9 flex items-center justify-center rounded-lg text-white/50 hover:text-white hover:bg-white/[0.06] transition-colors", className)}>
        {light ? <Moon size={16} /> : <Sun size={16} />}
      </button>
    );
  }

  return (
    <button type="button" role="switch" aria-checked={light} onClick={toggle}
      className={cn("w-full flex items-center gap-2 px-4 py-3 text-sm text-white/70 hover:bg-white/[0.04] transition-colors", className)}>
      {light ? <Sun size={15} className="text-amber-400" /> : <Moon size={15} className="text-white/45" />}
      <span className="flex-1 text-left">Light mode</span>
      {/* Switch */}
      <span className={cn("relative w-8 h-[18px] rounded-full transition-colors", light ? "bg-violet-500" : "bg-white/[0.15]")}>
        <span className={cn("absolute top-[2px] w-[14px] h-[14px] rounded-full bg-[#ffffff] shadow transition-all", light ? "left-[16px]" : "left-[2px]")} />
      </span>
    </button>
  );
}
