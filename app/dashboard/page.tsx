import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getPersona, SESSION_COOKIE } from "@/lib/session";
import { Dashboard } from "./dashboard";

export const metadata: Metadata = {
  title: "Dashboard",
};

// The analyst calls Claude through /api/ai/studio, so it is offered only when the server can: with
// an Anthropic key, or with LLM_STUB replaying recorded replies.
const analystAvailable = () => Boolean(process.env.ANTHROPIC_API_KEY) || process.env.LLM_STUB === "1";

export default async function DashboardPage() {
  // The proxy already sends visitors without a persona to the picker; this keeps the page safe on
  // its own. The rows themselves load in the browser from /api/dashboard/data.
  const persona = await getPersona((await cookies()).get(SESSION_COOKIE)?.value);
  if (!persona) redirect("/");

  // Only whether the analyst is offered reaches the client; the Anthropic key stays on the server.
  return <Dashboard persona={persona} licenseKey={process.env.AG_STUDIO} analyst={analystAvailable()} />;
}
