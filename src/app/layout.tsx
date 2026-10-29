import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { TradingProvider } from "@/components/trading-provider";
import { PrivacyProvider } from "@/components/privacy/privacy-provider";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Crossfire Trading - Automated Futures Trading",
  description: "Automated futures trading platform powered by the Topstep API",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={inter.variable}>
      <body>
        <TradingProvider>
          <PrivacyProvider>{children}</PrivacyProvider>
        </TradingProvider>
      </body>
    </html>
  );
}
