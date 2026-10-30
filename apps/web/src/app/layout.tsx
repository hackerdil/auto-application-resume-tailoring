import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { ModeBanner } from "@/components/ModeBanner";
import "./globals.css";

export const metadata: Metadata = {
  title: "Career Agent",
  description: "Local, human-in-the-loop job application preparation.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <a className="skip" href="#main">
          Skip to content
        </a>
        <header className="site">
          <nav aria-label="Main">
            <Link className="brand" href="/">
              Career Agent
            </Link>
            <Link href="/jobs">Jobs</Link>
            <Link href="/applications">Applications</Link>
            <Link href="/sources">Sources</Link>
            <Link href="/facts">Fact bank</Link>
            <Link href="/profile">Profile &amp; preferences</Link>
            <Link href="/usage">AI &amp; usage</Link>
            <a href="/api/v1/export" download>
              Export my data
            </a>
          </nav>
        </header>
        <ModeBanner />
        <main id="main">{children}</main>
      </body>
    </html>
  );
}
