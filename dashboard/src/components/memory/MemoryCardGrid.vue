<script setup lang="ts">
import Skeleton from "primevue/skeleton";
import MemoryCard from "./MemoryCard.vue";
import type { Memory } from "@/types/memory";

defineProps<{ memories: Memory[]; loading: boolean }>();
const emit = defineEmits<{ delete: [id: string] }>();
</script>

<template>
  <div
    v-if="loading"
    style="
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(20rem, 1fr));
      gap: 1rem;
    "
  >
    <Skeleton v-for="i in 6" :key="i" height="10rem" />
  </div>
  <div
    v-else-if="memories.length === 0"
    style="padding: 2rem; text-align: center; color: var(--p-text-muted-color)"
  >
    No memories found
  </div>
  <div
    v-else
    style="
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(20rem, 1fr));
      gap: 1rem;
    "
  >
    <MemoryCard
      v-for="m in memories"
      :key="m.id"
      :memory="m"
      @delete="emit('delete', $event)"
    />
  </div>
</template>
