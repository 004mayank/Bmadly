import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Bmadly",
  description: "Browser-based BMAD execution"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
      </body>
    </html>
  );
}
