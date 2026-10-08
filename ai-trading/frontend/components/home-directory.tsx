"use client";

import { useState } from "react";
import { Search, X } from "lucide-react";
import { type CategoryId, type HubApp, hubApps, hubCategories } from "@/lib/apps";
import { AppCard } from "@/components/app-card";

const FOCUS_RING = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

function matchesQuery(app: HubApp, query: string, categoryLabel: string) {
  if (!query) return true;
  const q = query.toLowerCase();
  return [app.name, app.summary, categoryLabel, ...app.tags].some((field) => field.toLowerCase().includes(q));
}

export function HomeDirectory() {
  const [query, setQuery] = useState("");
  const [activeCategory, setActiveCategory] = useState<CategoryId | "all">("all");

  const categoryLabel = (id: CategoryId) => hubCategories.find((category) => category.id === id)?.label ?? "";

  // Matches the search query only (ignores the active category) so chip counts show
  // how many apps each category has available, independent of which chip is active.
  const searchedApps = hubApps.filter((app) => matchesQuery(app, query, categoryLabel(app.category)));

  // Matches the search query AND the active category; this is what actually renders.
  const filteredApps = searchedApps.filter((app) => activeCategory === "all" || app.category === activeCategory);
  // Every non-planned status (live, setup-required, ...) gets a category card; only
  // "planned" apps move to the separate "Coming next" section below.
  const filteredCardApps = filteredApps.filter((app) => app.status !== "planned");
  const filteredPlannedApps = filteredApps.filter((app) => app.status === "planned");

  const visibleCategories =
    activeCategory === "all" ? hubCategories : hubCategories.filter((category) => category.id === activeCategory);

  function clearFilters() {
    setQuery("");
    setActiveCategory("all");
  }

  return (
    <div className="mt-8">
      <div>
        <label htmlFor="app-search" className="mb-1 block text-sm font-medium text-foreground">
          Search apps
        </label>
        <div className="relative">
          <Search aria-hidden size={18} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground" />
          <input
            id="app-search"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search by name, tag, or category"
            className="w-full rounded-md border border-border bg-card py-3 pr-10 pl-10 text-base text-foreground placeholder:text-muted-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          />
          {query && (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => setQuery("")}
              className={`absolute top-1/2 right-0 flex h-11 w-11 -translate-y-1/2 cursor-pointer items-center justify-center rounded text-muted-foreground hover:text-foreground ${FOCUS_RING}`}
            >
              <X aria-hidden size={18} />
            </button>
          )}
        </div>
      </div>

      <div role="group" aria-label="Filter by category" className="mt-6 flex flex-wrap gap-2">
        <button
          type="button"
          aria-pressed={activeCategory === "all"}
          onClick={() => setActiveCategory("all")}
          className={`flex min-h-11 cursor-pointer items-center rounded-full border px-4 text-sm font-medium transition-colors duration-150 ${FOCUS_RING} ${
            activeCategory === "all"
              ? "border-accent bg-accent/15 text-accent"
              : "border-border bg-card text-muted-foreground hover:text-foreground"
          }`}
        >
          All ({searchedApps.length})
        </button>
        {hubCategories.map((category) => {
          const count = searchedApps.filter((app) => app.category === category.id).length;
          return (
            <button
              key={category.id}
              type="button"
              aria-pressed={activeCategory === category.id}
              onClick={() => setActiveCategory(category.id)}
              className={`flex min-h-11 cursor-pointer items-center rounded-full border px-4 text-sm font-medium transition-colors duration-150 ${FOCUS_RING} ${
                activeCategory === category.id
                  ? "border-accent bg-accent/15 text-accent"
                  : "border-border bg-card text-muted-foreground hover:text-foreground"
              }`}
            >
              {category.label} ({count})
            </button>
          );
        })}
      </div>

      {filteredApps.length === 0 ? (
        <div className="mt-10 rounded-lg border border-dashed border-border p-8 text-center">
          <p className="text-foreground">No apps match &quot;{query}&quot;</p>
          <p className="mt-1 text-sm text-muted-foreground">Try a different name, tag, or category.</p>
          <button
            type="button"
            onClick={clearFilters}
            className={`mt-4 cursor-pointer rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground transition-colors duration-150 hover:bg-muted ${FOCUS_RING}`}
          >
            Clear filters
          </button>
        </div>
      ) : (
        <>
          {visibleCategories.map((category) => {
            const apps = filteredCardApps.filter((app) => app.category === category.id);
            if (apps.length === 0) return null;
            return (
              <section key={category.id} className="mt-8">
                <h2 className="text-lg font-semibold text-foreground">
                  {category.label} · {apps.length}
                </h2>
                <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {apps.map((app) => (
                    <AppCard key={app.slug} app={app} />
                  ))}
                </div>
              </section>
            );
          })}

          {filteredPlannedApps.length > 0 && (
            <section className="mt-10">
              <h2 className="text-lg font-semibold text-foreground">Coming next</h2>
              <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {filteredPlannedApps.map((app) => (
                  <AppCard key={app.slug} app={app} />
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
