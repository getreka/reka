<script setup lang="ts">
import Card from "primevue/card";
import Button from "primevue/button";
import Tag from "primevue/tag";
import { useVectorsStore } from "@/stores/vectors";

const store = useVectorsStore();
</script>

<template>
  <Card v-if="store.selectedPoint">
    <template #title>
      <div
        style="
          display: flex;
          justify-content: space-between;
          align-items: center;
        "
      >
        <span style="font-size: 0.9rem">Point Inspector</span>
        <Button
          icon="pi pi-times"
          text
          size="small"
          @click="store.selectedPoint = null"
        />
      </div>
    </template>
    <template #content>
      <div
        style="
          display: flex;
          flex-direction: column;
          gap: 0.75rem;
          font-size: 0.85rem;
        "
      >
        <div>
          <b>ID:</b>
          <code style="font-size: 0.8rem; margin-left: 0.25rem">{{
            store.selectedPoint.id
          }}</code>
        </div>
        <div v-if="store.selectedPoint.file">
          <b>File:</b>
          <div
            style="
              font-family: monospace;
              font-size: 0.8rem;
              word-break: break-all;
              color: var(--p-primary-color);
              margin-top: 0.15rem;
            "
          >
            {{ store.selectedPoint.file }}
          </div>
        </div>
        <div style="display: flex; gap: 0.5rem; flex-wrap: wrap">
          <Tag :value="store.selectedPoint.language" severity="info" />
          <Tag :value="store.selectedPoint.layer" severity="secondary" />
          <Tag :value="store.selectedPoint.chunkType" severity="success" />
        </div>
        <div v-if="store.selectedPoint.content">
          <b>Content:</b>
          <pre
            style="
              margin: 0.25rem 0 0;
              padding: 0.5rem;
              background: var(--p-surface-100);
              border-radius: 4px;
              font-size: 0.75rem;
              max-height: 300px;
              overflow: auto;
              white-space: pre-wrap;
              word-break: break-word;
            "
            >{{ store.selectedPoint.content.slice(0, 2000) }}</pre
          >
        </div>
      </div>
    </template>
  </Card>
</template>
