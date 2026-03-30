<script setup lang="ts">
import { computed } from "vue";
import Tag from "primevue/tag";
import type { SensoryEvent } from "@/types/session";

const props = defineProps<{
  // New primary prop: raw sensory events
  events?: SensoryEvent[];
  // Fallback: legacy recentQueries strings
  recentQueries?: string[];
  sessionStartedAt?: string;
  // Legacy prop kept for backward compat
  activities?: Array<{
    id?: string;
    tool?: string;
    type?: string;
    query?: string;
    timestamp?: string;
  }>;
}>();

const TOOL_COLORS: Record<string, string> = {
  search: "#3B82F6",
  search_codebase: "#3B82F6",
  hybrid_search: "#3B82F6",
  find_symbol: "#8B5CF6",
  search_graph: "#8B5CF6",
  recall: "#22C55E",
  remember: "#22C55E",
  record_adr: "#22C55E",
  get_patterns: "#22C55E",
  ask_codebase: "#F97316",
  context_briefing: "#F97316",
  read_file: "#94A3B8",
  file: "#94A3B8",
  tool_call: "#EC4899",
};

function toolColor(tool: string): string {
  return TOOL_COLORS[tool] ?? "#94A3B8";
}

function toolCategory(tool: string): "search" | "memory" | "graph" | "other" {
  if (/search|find|hybrid|ask|brief/i.test(tool)) return "search";
  if (/memory|recall|remember|adr|pattern|insight/i.test(tool)) return "memory";
  if (/graph|symbol/i.test(tool)) return "graph";
  return "other";
}

const categorySeverity: Record<string, string> = {
  search: "info",
  memory: "success",
  graph: "contrast",
  other: "secondary",
};

// Normalise everything into a single list
interface NormalizedEvent {
  key: string;
  tool: string;
  label: string;
  timestamp?: string;
  color: string;
  category: string;
}

const normalizedEvents = computed((): NormalizedEvent[] => {
  // Prefer sensory events
  if (props.events && props.events.length > 0) {
    return props.events.map((e, i) => {
      const tool = e.tool ?? e.type ?? "event";
      const query = e.query ?? e.content ?? e.metadata?.query ?? "";
      return {
        key: e.id ?? `e-${i}`,
        tool,
        label: query ? `${tool}(${truncate(query, 40)})` : tool,
        timestamp: e.timestamp,
        color: toolColor(tool),
        category: toolCategory(tool),
      };
    });
  }

  // Fall back to legacy activities
  if (props.activities && props.activities.length > 0) {
    return props.activities.map((a, i) => {
      const tool = a.tool ?? a.type ?? "unknown";
      return {
        key: a.id ?? `a-${i}`,
        tool,
        label: a.query ? `${tool}(${truncate(a.query, 40)})` : tool,
        timestamp: a.timestamp,
        color: toolColor(tool),
        category: toolCategory(tool),
      };
    });
  }

  // Fall back to recent queries strings
  if (props.recentQueries && props.recentQueries.length > 0) {
    return props.recentQueries.map((q, i) => ({
      key: `q-${i}`,
      tool: "search",
      label: truncate(q, 50),
      timestamp: props.sessionStartedAt,
      color: toolColor("search"),
      category: "search",
    }));
  }

  return [];
});

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function formatTime(iso?: string): string {
  if (!iso) return "";
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}
</script>

<template>
  <div v-if="normalizedEvents.length > 0">
    <div style="font-size: 0.85rem; font-weight: 600; margin-bottom: 0.5rem">
      Activity Timeline
    </div>

    <!-- Horizontal bar summary -->
    <div
      style="
        display: flex;
        gap: 2px;
        height: 20px;
        background: var(--p-surface-100);
        border-radius: 4px;
        overflow: hidden;
        margin-bottom: 0.4rem;
      "
    >
      <div
        v-for="(ev, i) in normalizedEvents"
        :key="ev.key"
        v-tooltip="ev.label"
        :style="{
          flex: '1',
          background: ev.color,
          borderRadius: '2px',
          cursor: 'default',
          opacity: '0.85',
          transition: 'opacity 0.15s',
        }"
        class="timeline-bar"
      />
    </div>

    <!-- Legend -->
    <div
      style="
        display: flex;
        gap: 0.75rem;
        font-size: 0.72rem;
        color: var(--p-text-muted-color);
        margin-bottom: 0.5rem;
      "
    >
      <span>
        <span
          style="
            display: inline-block;
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background: #3b82f6;
            margin-right: 3px;
          "
        />Search
      </span>
      <span>
        <span
          style="
            display: inline-block;
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background: #22c55e;
            margin-right: 3px;
          "
        />Memory
      </span>
      <span>
        <span
          style="
            display: inline-block;
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background: #8b5cf6;
            margin-right: 3px;
          "
        />Graph
      </span>
      <span>
        <span
          style="
            display: inline-block;
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background: #94a3b8;
            margin-right: 3px;
          "
        />Other
      </span>
    </div>

    <!-- Event list (newest first) -->
    <div
      style="
        max-height: 220px;
        overflow-y: auto;
        display: flex;
        flex-direction: column;
        gap: 0.2rem;
      "
    >
      <div
        v-for="ev in [...normalizedEvents].reverse()"
        :key="ev.key"
        style="
          display: flex;
          align-items: center;
          gap: 0.5rem;
          font-size: 0.78rem;
          padding: 0.2rem 0;
          border-bottom: 1px solid var(--p-surface-100);
        "
      >
        <div
          :style="{
            width: '8px',
            height: '8px',
            borderRadius: '50%',
            background: ev.color,
            flexShrink: 0,
          }"
        />
        <Tag
          :value="ev.tool"
          :severity="(categorySeverity[ev.category] ?? 'secondary') as any"
          style="font-size: 0.63rem; flex-shrink: 0"
        />
        <span
          style="
            flex: 1;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            color: var(--p-text-color);
          "
        >
          {{
            ev.label !== ev.tool
              ? ev.label.replace(ev.tool, "").replace(/^\(|\)$/g, "")
              : ""
          }}
        </span>
        <span
          v-if="ev.timestamp"
          style="
            color: var(--p-text-muted-color);
            font-size: 0.68rem;
            white-space: nowrap;
            flex-shrink: 0;
          "
        >
          {{ formatTime(ev.timestamp) }}
        </span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.timeline-bar:hover {
  opacity: 1 !important;
}
</style>
