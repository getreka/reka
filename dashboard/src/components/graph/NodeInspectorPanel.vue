<script setup lang="ts">
import Card from "primevue/card";
import Button from "primevue/button";
import Tag from "primevue/tag";
import Chip from "primevue/chip";
import ProgressSpinner from "primevue/progressspinner";
import { useGraphStore } from "@/stores/graph";

const store = useGraphStore();

function navigateToNode(file: string) {
  store.searchFile = file;
  store.search();
}
</script>

<template>
  <Card v-if="store.selectedNode" style="height: 100%; overflow-y: auto">
    <template #title>
      <div
        style="
          display: flex;
          justify-content: space-between;
          align-items: center;
        "
      >
        <span style="font-size: 0.9rem">Node Inspector</span>
        <Button
          icon="pi pi-times"
          text
          size="small"
          @click="store.clearSelection()"
        />
      </div>
    </template>
    <template #content>
      <div
        v-if="store.inspectorLoading"
        style="text-align: center; padding: 2rem"
      >
        <ProgressSpinner style="width: 2rem; height: 2rem" />
      </div>
      <div
        v-else-if="store.inspectorData"
        style="
          display: flex;
          flex-direction: column;
          gap: 0.75rem;
          font-size: 0.85rem;
        "
      >
        <!-- File path -->
        <div>
          <b>File:</b>
          <div
            style="
              font-family: monospace;
              font-size: 0.8rem;
              word-break: break-all;
              margin-top: 0.25rem;
              color: var(--p-primary-color);
            "
          >
            {{ store.inspectorData.file }}
          </div>
        </div>

        <!-- Exports -->
        <div v-if="store.inspectorData.exports.length > 0">
          <b>Exports ({{ store.inspectorData.exports.length }}):</b>
          <div
            style="
              display: flex;
              flex-direction: column;
              gap: 0.25rem;
              margin-top: 0.25rem;
            "
          >
            <div
              v-for="exp in store.inspectorData.exports"
              :key="exp.name"
              style="display: flex; align-items: center; gap: 0.5rem"
            >
              <Tag
                :value="exp.kind"
                :severity="
                  exp.kind === 'function'
                    ? 'info'
                    : exp.kind === 'class'
                      ? 'success'
                      : 'secondary'
                "
                style="font-size: 0.7rem"
              />
              <code style="font-size: 0.8rem">{{ exp.name }}</code>
            </div>
          </div>
        </div>

        <!-- Dependencies -->
        <div v-if="store.inspectorData.dependencies.length > 0">
          <b>Dependencies ({{ store.inspectorData.dependencies.length }}):</b>
          <div
            style="
              display: flex;
              flex-wrap: wrap;
              gap: 0.25rem;
              margin-top: 0.25rem;
            "
          >
            <Chip
              v-for="d in store.inspectorData.dependencies"
              :key="d"
              :label="d.split('/').pop() || d"
              v-tooltip="d"
              style="font-size: 0.7rem; cursor: pointer"
              @click="navigateToNode(d)"
            />
          </div>
        </div>

        <!-- Dependents -->
        <div v-if="store.inspectorData.dependents.length > 0">
          <b>Dependents ({{ store.inspectorData.dependents.length }}):</b>
          <div
            style="
              display: flex;
              flex-wrap: wrap;
              gap: 0.25rem;
              margin-top: 0.25rem;
            "
          >
            <Chip
              v-for="d in store.inspectorData.dependents"
              :key="d"
              :label="d.split('/').pop() || d"
              v-tooltip="d"
              style="font-size: 0.7rem; cursor: pointer"
              @click="navigateToNode(d)"
            />
          </div>
        </div>

        <div
          v-if="
            store.inspectorData.exports.length === 0 &&
            store.inspectorData.dependencies.length === 0 &&
            store.inspectorData.dependents.length === 0
          "
          style="color: var(--p-text-muted-color)"
        >
          No detailed info available for this file.
        </div>
      </div>
    </template>
  </Card>
</template>
