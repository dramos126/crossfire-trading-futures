"use client";

import { AppShell } from "@/components/app-shell";
import { Board } from "@/components/board/board";

/**
 * The Dashboard is the board: what is running this session, its money, and
 * the controls to act on it. The account picker, the account summary and the
 * always-on Positions and Orders tables are gone — broker truth that the
 * unmanaged-positions strip now carries where it matters, which is a hand
 * position on an instrument the engine claims.
 */
export default function Dashboard() {
  return (
    <AppShell>
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <Board />
      </div>
    </AppShell>
  );
}
