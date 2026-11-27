import { redirect } from "next/navigation";

// AI Studio (AI generation) is NOT part of the beta. The full implementation is
// preserved in ./StudioApp.tsx — to bring it back post-beta, render <StudioApp/>
// here instead of redirecting. Until then the route just sends users to the app.
export default function StudioPage() {
  redirect("/dashboard");
}
