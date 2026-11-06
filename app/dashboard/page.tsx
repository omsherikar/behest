import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { aiEnabled, aiModels } from "@/lib/ai";
import { getPersona, SESSION_COOKIE } from "@/lib/session";
import { Dashboard } from "./dashboard";

export const metadata: Metadata = {
  title: "Dashboard",
};

export default async function DashboardPage() {
  // The proxy already sends visitors without a persona to the picker; this keeps the page safe on
  // its own. The rows themselves load in the browser from /api/dashboard/data.
  const persona = await getPersona((await cookies()).get(SESSION_COOKIE)?.value);
  if (!persona) redirect("/");

  // Only the model ids reach the client; the OpenAI key stays on the server (lib/ai.ts).
  return (
    <Dashboard
      persona={persona}
      licenseKey={process.env.AG_STUDIO}
      aiModels={aiEnabled() ? aiModels() : undefined}
    />
  );
}
