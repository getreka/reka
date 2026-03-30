<script setup lang="ts">
import { ref } from "vue";
import Button from "primevue/button";
import Menu from "primevue/menu";
import { useExport } from "@/composables/useExport";

const props = defineProps<{
  page: string;
  data?: Record<string, any>[] | any;
  elementRef?: HTMLElement;
}>();

const { exportCSV, exportJSON, exportPDF } = useExport();
const menu = ref();

const items = ref([
  {
    label: "CSV",
    icon: "pi pi-file",
    command: () => {
      if (Array.isArray(props.data)) exportCSV(props.data, props.page);
    },
  },
  {
    label: "JSON",
    icon: "pi pi-file-edit",
    command: () => {
      if (props.data) exportJSON(props.data, props.page);
    },
  },
  {
    label: "PDF (Screenshot)",
    icon: "pi pi-file-pdf",
    command: () => {
      if (props.elementRef) exportPDF(props.elementRef, props.page);
    },
  },
]);

function toggle(event: Event) {
  menu.value.toggle(event);
}
</script>

<template>
  <div>
    <Button
      icon="pi pi-download"
      label="Export"
      size="small"
      severity="secondary"
      text
      @click="toggle"
    />
    <Menu ref="menu" :model="items" :popup="true" />
  </div>
</template>
