import type { Metadata, Viewport } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";
import "./globals.css";

// IBM Plex Sans for the interface, IBM Plex Mono for machine values: ids, hashes, SKUs, timestamps,
// tool calls and receipts. Plex Sans is a variable font, so one file covers weights 400 to 600.
const plexSans = IBM_Plex_Sans({
  variable: "--font-plex-sans",
  subsets: ["latin"],
});

const plexMono = IBM_Plex_Mono({
  variable: "--font-plex-mono",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

export const metadata: Metadata = {
  title: {
    template: "%s | Behest",
    default: "Behest",
  },
  description:
    "Behest attaches signed proof of what a person authorized to every purchase their AI agent makes on PayPal: a signed mandate, a rules gate, an intent check and a signed receipt the seller verifies.",
};

export const viewport: Viewport = {
  themeColor: "#0a1220",
  colorScheme: "dark",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${plexSans.variable} ${plexMono.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
