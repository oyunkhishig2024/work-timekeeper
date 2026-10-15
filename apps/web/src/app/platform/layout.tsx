import type { ReactNode } from "react";

export const metadata = { title: "Платформ", robots: { index: false, follow: false } };

export default function Layout({ children }: { children: ReactNode }) {
  return children;
}
