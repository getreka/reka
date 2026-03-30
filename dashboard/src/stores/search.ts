import { defineStore } from "pinia";
import { ref } from "vue";
import {
  searchHybrid,
  searchSemantic,
  searchSymbol,
  searchGraph,
} from "@/api/search";
import type { SearchResult, SearchMode, SearchMeta } from "@/types/search";

const RECENT_SEARCHES_KEY = "rag_recent_searches";

export const useSearchStore = defineStore("search", () => {
  const query = ref("");
  const mode = ref<SearchMode>("hybrid");
  const results = ref<SearchResult[]>([]);
  const meta = ref<SearchMeta | null>(null);
  const loading = ref(false);
  const error = ref("");
  const selectedResult = ref<SearchResult | null>(null);

  // Filters
  const languageFilter = ref("");
  const layerFilter = ref("");
  const scoreThreshold = ref(0);

  // Recent searches
  const recentSearches = ref<string[]>(loadRecent());

  function loadRecent(): string[] {
    try {
      return JSON.parse(
        localStorage.getItem(RECENT_SEARCHES_KEY) || "[]",
      ).slice(0, 10);
    } catch {
      return [];
    }
  }

  function saveRecent(q: string) {
    if (!q.trim()) return;
    recentSearches.value = [
      q,
      ...recentSearches.value.filter((s) => s !== q),
    ].slice(0, 10);
    localStorage.setItem(
      RECENT_SEARCHES_KEY,
      JSON.stringify(recentSearches.value),
    );
  }

  async function search() {
    if (!query.value.trim()) return;
    loading.value = true;
    error.value = "";
    selectedResult.value = null;
    const start = Date.now();

    try {
      const opts = {
        limit: 30,
        language: languageFilter.value || undefined,
        layer: layerFilter.value || undefined,
      };

      let res: { results: SearchResult[]; meta?: any };

      switch (mode.value) {
        case "semantic":
          res = await searchSemantic(query.value, opts);
          break;
        case "symbol":
          res = await searchSymbol(query.value, opts);
          break;
        case "graph":
          res = await searchGraph(query.value, opts);
          break;
        default:
          res = await searchHybrid(query.value, opts);
      }

      results.value = res.results;
      meta.value = {
        mode: mode.value,
        query: query.value,
        rewrittenQuery: res.meta?.rewrittenQuery,
        timing: Date.now() - start,
        totalResults: res.results.length,
      };
      saveRecent(query.value);
    } catch (e: any) {
      error.value = e.message || "Search failed";
    } finally {
      loading.value = false;
    }
  }

  function clearResults() {
    results.value = [];
    meta.value = null;
    selectedResult.value = null;
  }

  return {
    query,
    mode,
    results,
    meta,
    loading,
    error,
    selectedResult,
    languageFilter,
    layerFilter,
    scoreThreshold,
    recentSearches,
    search,
    clearResults,
  };
});
