import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "Timekeeper Work",
  description: "Workforce attendance and presence management",
  icons: { icon: "/icon.svg" },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="mn">
      <body className="min-h-screen bg-white text-slate-900 antialiased">{children}</body>
    </html>
  );
}
