"use client";
import { useState, useRef, useEffect } from "react";
import { Smile } from "lucide-react";

const CATEGORIES = [
  {
    label: "⭐ Popular",
    emojis: ["🔥","❤️","😂","👍","🎉","✨","💯","🙌","😍","🥰","😎","💪","🤙","👏","🫶","😁","🤣","🎊","💥","🌟"],
  },
  {
    label: "😊 Faces",
    emojis: ["😀","😁","😅","😆","🤣","😂","😊","😇","🥲","😉","😌","😍","🥰","😘","😜","😎","🤩","😏","🫡","🤔","😢","😭","😤","😡","🥳","🤯","😱","🤗","🫠","🙃"],
  },
  {
    label: "👍 Hands",
    emojis: ["👍","👎","👌","🤌","✌️","🤞","🤙","👋","🙌","👏","🤝","🫶","💪","🙏","🫂","👊","✊","🤛","🤜","🖐️"],
  },
  {
    label: "❤️ Hearts",
    emojis: ["❤️","🧡","💛","💚","💙","💜","🖤","🤍","💕","💞","💓","💗","💖","💘","💝","❤️‍🔥","💔","♥️","💟","🩷"],
  },
  {
    label: "🎬 Media",
    emojis: ["🎬","🎵","🎮","📱","💻","🎯","🏆","🥇","🎁","💡","📸","🎤","🎧","🚀","⭐","🎥","📹","🎞️","📺","🎶"],
  },
  {
    label: "🌿 Nature",
    emojis: ["🌟","⭐","✨","💫","🌙","☀️","🌈","🌊","🌺","🌸","🍀","🦋","🌴","🌿","🍃","🌻","🌼","🌹","🦄","🐉"],
  },
];

interface Props {
  onSelect: (emoji: string) => void;
  /** "up" (default) opens above the button, "down" opens below */
  direction?: "up" | "down";
}

export default function EmojiPicker({ onSelect, direction = "up" }: Props) {
  const [open, setOpen] = useState(false);
  const [tab, setTab]   = useState(0);
  const containerRef    = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onMouseDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [open]);

  return (
    <div className="relative flex-shrink-0" ref={containerRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Add emoji"
        className={`p-1.5 rounded-lg transition-colors ${
          open
            ? "bg-violet-500/15 text-violet-400"
            : "text-white/30 hover:text-white/60 hover:bg-white/[0.05]"
        }`}
      >
        <Smile size={15} />
      </button>

      {open && (
        <div
          className={`absolute z-50 right-0 w-72 bg-d1c border border-white/[0.09] rounded-xl shadow-2xl overflow-hidden
            ${direction === "up" ? "bottom-full mb-2" : "top-full mt-2"}`}
        >
          {/* Category tabs */}
          <div className="flex items-center gap-0.5 px-2 pt-2 pb-1.5 border-b border-white/[0.06] overflow-x-auto scrollbar-hide">
            {CATEGORIES.map((c, i) => (
              <button
                key={i}
                type="button"
                onClick={() => setTab(i)}
                className={`flex-shrink-0 px-2 py-1 rounded-md text-[10px] font-medium whitespace-nowrap transition-colors
                  ${tab === i
                    ? "bg-violet-600/20 text-violet-300"
                    : "text-white/30 hover:text-white/60 hover:bg-white/[0.05]"
                  }`}
              >
                {c.label}
              </button>
            ))}
          </div>

          {/* Emoji grid */}
          <div className="p-2 grid grid-cols-10 gap-0.5 max-h-36 overflow-y-auto">
            {CATEGORIES[tab].emojis.map((emoji) => (
              <button
                key={emoji}
                type="button"
                onClick={() => { onSelect(emoji); setOpen(false); }}
                className="w-[26px] h-[26px] flex items-center justify-center rounded text-[15px] hover:bg-white/[0.08] transition-colors"
              >
                {emoji}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** Insert emoji at cursor position in a controlled input or textarea. */
export function insertEmoji(
  el: HTMLInputElement | HTMLTextAreaElement | null,
  current: string,
  emoji: string,
  setter: (v: string) => void
) {
  const pos = el?.selectionStart ?? current.length;
  const end = el?.selectionEnd   ?? pos;
  const next = current.slice(0, pos) + emoji + current.slice(end);
  setter(next);
  requestAnimationFrame(() => {
    if (!el) return;
    el.focus();
    const cur = pos + emoji.length;
    el.setSelectionRange(cur, cur);
  });
}
