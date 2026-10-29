"use client";

import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { BookGrid } from "@/components/book/book-grid";
import { BOOKS_SUBTITLE } from "@/components/book/book-grid-model";

/**
 * `/books` — the configuration screen, and nothing else.
 *
 * A thin `AppShell` wrapper over the grid, the way `/playbooks` and
 * `/deployments/[id]` are thin over theirs. Nothing here reads search params,
 * so it needs no `Suspense` boundary.
 *
 * It carries its own `← Dashboard` affordance, the pattern the drill-in set:
 * nav-only back loses browser-back semantics and forgets where the operator
 * came from. The title and subtitle are handed to the grid as two nodes, which
 * it draws beside the page's one *Deploy a book* control and above the book
 * sections; on a phone the view cluster sits between them.
 */
export default function BooksPage() {
  return (
    <AppShell>
      <Link
        href="/"
        className="text-xs text-[var(--muted)] transition-colors hover:text-[var(--foreground)]"
      >
        ← Dashboard
      </Link>
      <div className="mt-2">
        <BookGrid
          title={<h1 className="text-2xl font-semibold tracking-tight">Books</h1>}
          subtitle={
            <p className="mt-1 max-w-3xl text-xs leading-relaxed text-[var(--muted)]">{BOOKS_SUBTITLE}</p>
          }
        />
      </div>
    </AppShell>
  );
}
