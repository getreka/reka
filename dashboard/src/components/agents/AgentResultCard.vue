<script setup lang="ts">
import Card from "primevue/card";
import Button from "primevue/button";
import Tag from "primevue/tag";
import Accordion from "primevue/accordion";
import AccordionPanel from "primevue/accordionpanel";
import AccordionHeader from "primevue/accordionheader";
import AccordionContent from "primevue/accordioncontent";
import type { AgentResult } from "@/api/agents";

defineProps<{
  result: AgentResult & {
    tab: "react" | "autonomous";
    task: string;
    timestamp: number;
  };
}>();
const emit = defineEmits<{ close: [] }>();

function statusSeverity(
  status: string,
): "success" | "danger" | "warn" | "secondary" | "info" {
  switch (status) {
    case "completed":
      return "success";
    case "failed":
      return "danger";
    case "budget_exceeded":
      return "warn";
    case "interrupted":
      return "secondary";
    default:
      return "info";
  }
}

function formatDuration(ms?: number): string {
  if (!ms) return "—";
  if (ms < 1000) return `${ms}ms`;
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  return `${mins}m ${secs % 60}s`;
}

function formatCost(cost?: number): string {
  if (cost == null) return "—";
  return `$${cost.toFixed(4)}`;
}

function formatTokens(tokens?: number): string {
  if (tokens == null) return "—";
  if (tokens > 1000) return `${(tokens / 1000).toFixed(1)}k`;
  return String(tokens);
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
        <span>Agent Result</span>
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
        <div>
          <b>Status:</b>
          <Tag
            :severity="statusSeverity(result.status)"
            :value="result.status"
            style="margin-left: 0.25rem"
          />
          <Tag
            :value="result.tab === 'react' ? 'ReAct' : 'Autonomous'"
            severity="info"
            style="margin-left: 0.25rem"
          />
        </div>

        <div>
          <b>Task:</b>
          <span style="margin-left: 0.25rem">{{ result.task }}</span>
        </div>

        <div style="display: flex; gap: 1.5rem; flex-wrap: wrap">
          <div v-if="result.cost != null">
            <b>Cost:</b> {{ formatCost(result.cost ?? result.budgetUsed) }}
          </div>
          <div v-if="result.totalTokens">
            <b>Tokens:</b> {{ formatTokens(result.totalTokens) }}
          </div>
          <div v-if="result.iterations">
            <b>Iterations:</b> {{ result.iterations }}
          </div>
          <div v-if="result.turns"><b>Turns:</b> {{ result.turns }}</div>
          <div v-if="result.duration">
            <b>Duration:</b> {{ formatDuration(result.duration) }}
          </div>
        </div>

        <div v-if="result.model">
          <b>Model:</b>
          <code style="font-size: 0.8rem; margin-left: 0.25rem">{{
            result.model
          }}</code>
        </div>

        <div v-if="result.result">
          <b>Result:</b>
          <pre
            style="
              white-space: pre-wrap;
              word-break: break-word;
              background: var(--p-surface-100);
              border-radius: 6px;
              padding: 0.75rem;
              margin-top: 0.25rem;
              font-size: 0.8rem;
              max-height: 20rem;
              overflow-y: auto;
            "
            >{{ result.result }}</pre
          >
        </div>

        <div v-if="result.error">
          <b>Error:</b>
          <pre
            style="
              white-space: pre-wrap;
              word-break: break-word;
              background: var(--p-red-50);
              color: var(--p-red-700);
              border-radius: 6px;
              padding: 0.75rem;
              margin-top: 0.25rem;
              font-size: 0.8rem;
            "
            >{{ result.error }}</pre
          >
        </div>

        <!-- ReAct steps -->
        <div v-if="result.steps?.length">
          <b>Steps ({{ result.steps.length }}):</b>
          <Accordion style="margin-top: 0.25rem">
            <AccordionPanel
              v-for="(step, i) in result.steps"
              :key="i"
              :value="String(i)"
            >
              <AccordionHeader
                >Step {{ i + 1
                }}{{ step.action ? ` — ${step.action}` : "" }}</AccordionHeader
              >
              <AccordionContent>
                <div
                  style="
                    display: flex;
                    flex-direction: column;
                    gap: 0.5rem;
                    font-size: 0.8rem;
                  "
                >
                  <div v-if="step.thought">
                    <b>Thought:</b> {{ step.thought }}
                  </div>
                  <div v-if="step.action">
                    <b>Action:</b> <code>{{ step.action }}</code>
                  </div>
                  <div v-if="step.observation">
                    <b>Observation:</b>
                    <pre
                      style="
                        white-space: pre-wrap;
                        background: var(--p-surface-100);
                        border-radius: 4px;
                        padding: 0.5rem;
                        margin-top: 0.25rem;
                      "
                      >{{ step.observation }}</pre
                    >
                  </div>
                  <div v-if="step.thinking">
                    <b>Thinking:</b>
                    <pre
                      style="
                        white-space: pre-wrap;
                        background: var(--p-surface-100);
                        border-radius: 4px;
                        padding: 0.5rem;
                        margin-top: 0.25rem;
                      "
                      >{{ step.thinking }}</pre
                    >
                  </div>
                </div>
              </AccordionContent>
            </AccordionPanel>
          </Accordion>
        </div>

        <div style="font-size: 0.75rem; color: var(--p-text-muted-color)">
          {{ new Date(result.timestamp).toLocaleString() }}
        </div>
      </div>
    </template>
  </Card>
</template>
