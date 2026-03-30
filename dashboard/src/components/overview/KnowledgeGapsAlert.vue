<script setup lang="ts">
import Message from "primevue/message";
import type { KnowledgeGap } from "@/types/api";

defineProps<{ gaps: KnowledgeGap[] }>();
</script>

<template>
  <div
    v-if="gaps.length === 0"
    style="color: var(--p-text-muted-color); padding: 1rem"
  >
    No knowledge gaps detected
  </div>
  <div
    v-else
    style="
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      max-height: 300px;
      overflow-y: auto;
    "
  >
    <Message
      v-for="gap in gaps"
      :key="gap.query + gap.timestamp"
      severity="warn"
      :closable="false"
    >
      <b>{{ gap.toolName }}</b
      >: "{{ gap.query }}" — {{ gap.resultCount }} results
    </Message>
  </div>
</template>
