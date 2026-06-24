import type { Metadata } from "next";
import "./globals.css";
import "./routines.css";

export const metadata: Metadata = {
  title: "Rhythm & Routine",
  description: "让计划适应真实的你。",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
