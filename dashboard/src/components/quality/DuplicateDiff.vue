<script setup lang="ts">
import { computed } from "vue";
import Card from "primevue/card";
import Button from "primevue/button";
import Tag from "primevue/tag";
import type { DuplicateGroup } from "@/types/quality";

const props = defineProps<{ group: DuplicateGroup }>();
const emit = defineEmits<{ close: [] }>();

const fileA = computed(() => props.group.files[0]);
const fileB = computed(() => props.group.files[1]);

const linesA = computed(() => (fileA.value?.content || "").split("\n"));
const linesB = computed(() => (fileB.value?.content || "").split("\n"));

const maxLines = computed(() =>
  Math.max(linesA.value.length, linesB.value.length),
);

function lineClass(
  lineA: string | undefined,
  lineB: string | undefined,
): string {
  if (lineA === lineB) return "";
  if (!lineA) return "diff-added";
  if (!lineB) return "diff-removed";
  return "diff-changed";
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
        <div style="display: flex; align-items: center; gap: 0.5rem">
          <span>Comparison</span>
          <Tag
            :value="`${(group.similarity * 100).toFixed(1)}% similar`"
            severity="info"
          />
        </div>
        <Button icon="pi pi-times" text size="small" @click="emit('close')" />
      </div>
    </template>
    <template #content>
      <div
        v-if="!fileA?.content && !fileB?.content"
        style="
          color: var(--p-text-muted-color);
          font-size: 0.85rem;
          padding: 1rem;
        "
      >
        No code content available for comparison. The API returned file
        references without inline content.
        <div
          style="
            margin-top: 0.75rem;
            display: flex;
            flex-direction: column;
            gap: 0.25rem;
          "
        >
          <div
            v-for="f in group.files"
            :key="f.file"
            style="font-family: monospace; font-size: 0.8rem"
          >
            {{ f.file }}
          </div>
        </div>
      </div>

      <div v-else class="diff-container">
        <!-- File headers -->
        <div class="diff-header">
          <div class="diff-col">
            {{ fileA?.file?.split("/").pop() || "File A" }}
          </div>
          <div class="diff-col">
            {{ fileB?.file?.split("/").pop() || "File B" }}
          </div>
        </div>

        <!-- Lines -->
        <div class="diff-body">
          <div v-for="i in maxLines" :key="i" class="diff-row">
            <div :class="['diff-col', lineClass(linesA[i - 1], linesB[i - 1])]">
              <span class="diff-line-num">{{ i }}</span>
              <code>{{ linesA[i - 1] || "" }}</code>
            </div>
            <div :class="['diff-col', lineClass(linesA[i - 1], linesB[i - 1])]">
              <span class="diff-line-num">{{ i }}</span>
              <code>{{ linesB[i - 1] || "" }}</code>
            </div>
          </div>
        </div>
      </div>
    </template>
  </Card>
</template>

<style scoped>
.diff-container {
  font-family: monospace;
  font-size: 0.8rem;
  border: 1px solid var(--p-surface-200);
  border-radius: 4px;
  overflow: auto;
  max-height: 500px;
}
.diff-header {
  display: flex;
  background: var(--p-surface-100);
  font-weight: 600;
  font-size: 0.8rem;
  border-bottom: 1px solid var(--p-surface-200);
}
.diff-header .diff-col {
  flex: 1;
  padding: 0.5rem;
  overflow: hidden;
  text-overflow: ellipsis;
}
.diff-body {
  display: flex;
  flex-direction: column;
}
.diff-row {
  display: flex;
  border-bottom: 1px solid var(--p-surface-100);
}
.diff-row:last-child {
  border-bottom: none;
}
.diff-col {
  flex: 1;
  padding: 0.1rem 0.5rem;
  display: flex;
  gap: 0.5rem;
  min-width: 0;
  white-space: pre;
  overflow-x: auto;
}
.diff-line-num {
  color: var(--p-text-muted-color);
  min-width: 2.5rem;
  text-align: right;
  user-select: none;
}
.diff-added {
  background: rgba(34, 197, 94, 0.1);
}
.diff-removed {
  background: rgba(239, 68, 68, 0.1);
}
.diff-changed {
  background: rgba(234, 179, 8, 0.1);
}
</style>
