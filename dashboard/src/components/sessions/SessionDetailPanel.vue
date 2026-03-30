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
} from "@/types/session";

const props = defineProps<{
  session: Record<string, any>;
  workingMemory?: WorkingMemoryState | null;
  sensoryStats?: SensoryStats | null;
}>();
const emit = defineEmits<{ close: []; "end-session": [id: string] }>();

const sensoryEvents = ref<SensoryEvent[]>([]);
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
