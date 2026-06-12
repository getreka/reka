<script setup lang="ts">
import { ref, watch, onUnmounted, computed } from "vue";
import Card from "primevue/card";
import Button from "primevue/button";
import Chip from "primevue/chip";
import Tag from "primevue/tag";
import Divider from "primevue/divider";
import SessionTimeline from "./SessionTimeline.vue";
import WorkingMemoryPanel from "./WorkingMemoryPanel.vue";
import { fetchSensoryEvents } from "@/api/sessions";
import type {
  WorkingMemoryState,
  SensoryStats,
  SensoryEvent,
  SessionRetrieval,
  RetrievalSurface,
} from "@/types/session";

const props = defineProps<{
  session: Record<string, any>;
  workingMemory?: WorkingMemoryState | null;
  sensoryStats?: SensoryStats | null;
  retrievals?: SessionRetrieval[] | null;
}>();
const emit = defineEmits<{ close: []; "end-session": [id: string] }>();

const sensoryEvents = ref<SensoryEvent[]>([]);
// Per-entry "show all snippets" toggles for the retrieval trail (reset on
// session change in the watch below, which runs immediately at setup).
const expandedSnippets = ref<Set<string>>(new Set());
let pollTimer: ReturnType<typeof setInterval> | null = null;

function getId(): string {
  return props.session?.sessionId ?? props.session?.id ?? "";
}

function formatDuration(): string {
  const start = new Date(props.session.startedAt).getTime();
  const end = props.session.endedAt
    ? new Date(props.session.endedAt).getTime()
    : Date.now();
  const mins = Math.floor((end - start) / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ${mins % 60}m`;
}

async function loadEvents() {
  const id = getId();
  if (!id) return;
  sensoryEvents.value = await fetchSensoryEvents(id);
}

watch(
  () => getId(),
  (id) => {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    sensoryEvents.value = [];
    expandedSnippets.value = new Set();
    if (id) {
      loadEvents();
      if (props.session.status === "active") {
        pollTimer = setInterval(loadEvents, 10000);
      }
    }
  },
  { immediate: true },
);

watch(
  () => props.session.status,
  (status) => {
    if (status !== "active" && pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  },
);

onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer);
});

const sensoryEventTypes = computed(() => {
  return props.sensoryStats?.eventsByType ?? {};
});

// --- Retrieved / Injected memories (M3 retrieval trail) ---

const SNIPPET_PREVIEW = 5;

const SURFACE_META: Record<
  RetrievalSurface,
  { label: string; severity: "info" | "success" | "warn" }
> = {
  digest: { label: "Digest", severity: "info" },
  recall: { label: "Recall", severity: "success" },
  enrichment: { label: "Enrichment", severity: "warn" },
};

interface RetrievalEntry extends SessionRetrieval {
  key: string;
}

const retrievalsList = computed<SessionRetrieval[]>(
  () => props.retrievals ?? [],
);

const retrievalGroups = computed(() => {
  const order: RetrievalSurface[] = ["digest", "recall", "enrichment"];
  return order
    .map((surface) => {
      const entries: RetrievalEntry[] = retrievalsList.value
        .filter((r) => r.surface === surface)
        .map((r, i) => ({ ...r, key: `${surface}-${i}` }));
      const memoryCount = entries.reduce(
        (n, e) => n + (e.memoryIds?.length ?? 0),
        0,
      );
      return { surface, ...SURFACE_META[surface], entries, memoryCount };
    })
    .filter((g) => g.entries.length > 0);
});

function toggleSnippets(key: string) {
  const next = new Set(expandedSnippets.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  expandedSnippets.value = next;
}

function visibleSnippets(entry: RetrievalEntry): string[] {
  const snippets = entry.snippets ?? [];
  return expandedSnippets.value.has(entry.key)
    ? snippets
    : snippets.slice(0, SNIPPET_PREVIEW);
}

function memoryIdsTooltip(ids: string[]): string {
  const shown = ids.slice(0, 10);
  return (
    shown.join("\n") + (ids.length > 10 ? `\n… +${ids.length - 10} more` : "")
  );
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}
</script>

<template>
  <Card>
    <template #title>
      <div
        style="
          display: flex;
          justify-content: space-between;
          align-items: center;
        "
      >
        <span style="font-size: 1rem">Session Detail</span>
        <Button icon="pi pi-times" text size="small" @click="emit('close')" />
      </div>
    </template>
    <template #content>
      <div
        style="
          display: flex;
          flex-direction: column;
          gap: 0.75rem;
          font-size: 0.875rem;
        "
      >
        <!-- Session Info -->
        <div style="display: flex; flex-direction: column; gap: 0.4rem">
          <div>
            <b>ID:</b>
            <code style="font-size: 0.8rem; margin-left: 0.25rem">{{
              getId()
            }}</code>
          </div>
          <div style="display: flex; align-items: center; gap: 0.5rem">
            <b>Status:</b>
            <Tag
              :severity="session.status === 'active' ? 'success' : 'secondary'"
              :value="session.status"
            />
          </div>
          <div v-if="session.projectName">
            <b>Project:</b> {{ session.projectName }}
          </div>
          <div v-if="session.initialContext">
            <b>Context:</b> {{ session.initialContext }}
          </div>
          <div>
            <b>Started:</b> {{ new Date(session.startedAt).toLocaleString() }}
          </div>
          <div v-if="session.endedAt">
            <b>Ended:</b> {{ new Date(session.endedAt).toLocaleString() }}
          </div>
          <div><b>Duration:</b> {{ formatDuration() }}</div>
        </div>

        <!-- Sensory Stats -->
        <div v-if="sensoryStats && sensoryStats.totalEvents > 0">
          <Divider style="margin: 0.25rem 0" />
          <div
            style="font-size: 0.85rem; font-weight: 600; margin-bottom: 0.4rem"
          >
            Sensory Stats
          </div>
          <div
            style="
              display: flex;
              gap: 0.5rem;
              flex-wrap: wrap;
              align-items: center;
            "
          >
            <Tag
              severity="primary"
              :value="`${sensoryStats.totalEvents} events`"
            />
            <Tag
              v-for="(count, type) in sensoryEventTypes"
              :key="type"
              severity="secondary"
              :value="`${type}: ${count}`"
              style="font-size: 0.7rem"
            />
          </div>
        </div>

        <!-- Files -->
        <div v-if="session.currentFiles?.length">
          <Divider style="margin: 0.25rem 0" />
          <div
            style="font-size: 0.85rem; font-weight: 600; margin-bottom: 0.4rem"
          >
            Files
          </div>
          <div style="display: flex; gap: 0.25rem; flex-wrap: wrap">
            <Chip
              v-for="f in session.currentFiles"
              :key="f"
              :label="f.split('/').pop() || f"
              v-tooltip="f"
              style="font-size: 0.75rem"
            />
          </div>
        </div>

        <!-- Tools Used -->
        <div v-if="session.toolsUsed?.length">
          <Divider style="margin: 0.25rem 0" />
          <div
            style="font-size: 0.85rem; font-weight: 600; margin-bottom: 0.4rem"
          >
            Tools Used
          </div>
          <div style="display: flex; gap: 0.25rem; flex-wrap: wrap">
            <Chip
              v-for="t in session.toolsUsed"
              :key="t"
              :label="t"
              style="font-size: 0.75rem"
            />
          </div>
        </div>

        <!-- Working Memory -->
        <div v-if="workingMemory && workingMemory.slots.length > 0">
          <Divider style="margin: 0.25rem 0" />
          <WorkingMemoryPanel :working-memory="workingMemory" />
        </div>

        <!-- Retrieved / Injected Memories (M3 retrieval trail) -->
        <div>
          <Divider style="margin: 0.25rem 0" />
          <div
            style="
              display: flex;
              align-items: center;
              gap: 0.5rem;
              margin-bottom: 0.4rem;
            "
          >
            <span style="font-size: 0.85rem; font-weight: 600">
              Retrieved / Injected Memories
            </span>
            <Tag
              v-if="retrievalsList.length > 0"
              :value="String(retrievalsList.length)"
              severity="info"
              style="font-size: 0.7rem"
            />
          </div>

          <!-- Empty state: older sessions predate the retrieval log -->
          <div
            v-if="retrievalsList.length === 0"
            style="color: var(--p-text-muted-color); font-size: 0.8rem"
          >
            No retrievals logged for this session
          </div>

          <div
            v-else
            style="display: flex; flex-direction: column; gap: 0.75rem"
          >
            <div v-for="group in retrievalGroups" :key="group.surface">
              <!-- Surface group header with counts -->
              <div
                style="
                  display: flex;
                  align-items: center;
                  gap: 0.5rem;
                  margin-bottom: 0.375rem;
                "
              >
                <Tag
                  :value="group.label"
                  :severity="group.severity"
                  style="font-size: 0.7rem"
                />
                <span
                  style="font-size: 0.75rem; color: var(--p-text-muted-color)"
                >
                  {{ group.entries.length }}
                  {{ group.entries.length === 1 ? "entry" : "entries" }}
                  · {{ group.memoryCount }}
                  {{ group.memoryCount === 1 ? "memory" : "memories" }}
                </span>
              </div>

              <div style="display: flex; flex-direction: column; gap: 0.5rem">
                <div
                  v-for="entry in group.entries"
                  :key="entry.key"
                  style="
                    border-left: 3px solid var(--p-primary-200);
                    padding-left: 0.75rem;
                    font-size: 0.8rem;
                  "
                >
                  <div
                    style="
                      display: flex;
                      justify-content: space-between;
                      align-items: center;
                      gap: 0.5rem;
                      margin-bottom: 0.2rem;
                    "
                  >
                    <span
                      style="color: var(--p-text-muted-color)"
                      v-tooltip="memoryIdsTooltip(entry.memoryIds ?? [])"
                    >
                      {{ (entry.memoryIds ?? []).length }}
                      {{
                        (entry.memoryIds ?? []).length === 1
                          ? "memory"
                          : "memories"
                      }}
                    </span>
                    <span
                      style="
                        font-size: 0.75rem;
                        color: var(--p-text-muted-color);
                        white-space: nowrap;
                      "
                      v-tooltip="new Date(entry.timestamp).toLocaleString()"
                    >
                      {{ relativeTime(entry.timestamp) }}
                    </span>
                  </div>

                  <div
                    v-if="entry.query"
                    style="margin-bottom: 0.2rem; line-height: 1.4"
                  >
                    <span style="color: var(--p-text-muted-color)">Query:</span>
                    <span style="font-weight: 500; margin-left: 0.25rem">
                      {{ entry.query }}
                    </span>
                  </div>

                  <div
                    v-if="(entry.snippets ?? []).length > 0"
                    style="
                      display: flex;
                      flex-direction: column;
                      gap: 0.25rem;
                      margin-top: 0.2rem;
                    "
                  >
                    <div
                      v-for="(snippet, si) in visibleSnippets(entry)"
                      :key="si"
                      style="
                        color: var(--p-text-muted-color);
                        line-height: 1.4;
                        border-left: 2px solid var(--p-surface-200);
                        padding-left: 0.5rem;
                      "
                    >
                      {{ snippet }}
                    </div>
                    <Button
                      v-if="(entry.snippets ?? []).length > SNIPPET_PREVIEW"
                      :label="
                        expandedSnippets.has(entry.key)
                          ? 'Show less'
                          : `Show all (${(entry.snippets ?? []).length})`
                      "
                      text
                      size="small"
                      style="
                        align-self: flex-start;
                        font-size: 0.75rem;
                        padding: 0.1rem 0.25rem;
                      "
                      @click="toggleSnippets(entry.key)"
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Activity Timeline -->
        <div v-if="sensoryEvents.length > 0 || session.recentQueries?.length">
          <Divider style="margin: 0.25rem 0" />
          <SessionTimeline
            :events="sensoryEvents"
            :recent-queries="session.recentQueries"
            :session-started-at="session.startedAt"
          />
        </div>

        <!-- Actions -->
        <div v-if="session.status === 'active'" style="margin-top: 0.25rem">
          <Divider style="margin: 0.25rem 0" />
          <Button
            label="End Session"
            icon="pi pi-stop-circle"
            severity="warn"
            size="small"
            @click="emit('end-session', getId())"
          />
        </div>
      </div>
    </template>
  </Card>
</template>
