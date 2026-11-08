import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Tour } from "@/components/tour/tour";
import "./globals.css";

// Geist Sans for the interface, Geist Mono for machine values: ids, hashes, SKUs, amounts in tables,
// receipts and the console, and the wordmark. Both are variable fonts, so one file covers each.
const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
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
  themeColor: "#000000",
  colorScheme: "dark",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      {/* Browser extensions such as Grammarly add attributes to <body> before React loads; this
          silences that mismatch for the body's own attributes only, not for anything inside it. */}
      <body className="min-h-full flex flex-col" suppressHydrationWarning>
        {children}
        <Tour />
      </body>
    </html>
  );
}
