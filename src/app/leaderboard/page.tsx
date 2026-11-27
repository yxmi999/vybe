// Leaderboard is "coming soon" for now. The full board lives in
// ./LeaderboardBoard.tsx — to bring it back, re-export it from here:
//   export { default } from "./LeaderboardBoard";
import { Trophy } from "lucide-react";
import PageHeader from "@/components/PageHeader";

export default function LeaderboardPage() {
  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-10">
      <PageHeader eyebrow="Grow" title="Leaderboard" />
      <div className="rounded-2xl border border-white/[0.07] bg-white/[0.02] px-6 py-16 text-center">
        <div className="inline-flex p-4 rounded-2xl bg-violet-500/10 mb-4">
          <Trophy size={28} className="text-violet-300" />
        </div>
        <p className="text-lg font-semibold text-white/85">Coming soon</p>
        <p className="mt-1.5 text-sm text-white/45 max-w-sm mx-auto">
          Creators will compete on views from their Vybe clips, with monthly and yearly rankings.
        </p>
      </div>
    </div>
  );
}
