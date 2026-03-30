<script setup lang="ts">
import { ref, computed } from "vue";
import Button from "primevue/button";
import Select from "primevue/select";
import Textarea from "primevue/textarea";
import InputNumber from "primevue/inputnumber";
import InputText from "primevue/inputtext";
import Checkbox from "primevue/checkbox";
import type { AgentTypeInfo } from "@/api/agents";

const props = defineProps<{
  tab: "react" | "autonomous";
  agentTypes: AgentTypeInfo[];
  autonomousTypes: AgentTypeInfo[];
  loading: boolean;
}>();

const emit = defineEmits<{
  "run-react": [
    opts: {
      agentType: string;
      task: string;
      maxIterations?: number;
      includeThinking?: boolean;
    },
  ];
  "run-autonomous": [
    opts: {
      type: string;
      task: string;
      projectPath: string;
      maxTurns?: number;
      maxBudgetUsd?: number;
      effort?: string;
    },
  ];
}>();

// React fields
const reactType = ref("");
const reactTask = ref("");
const maxIterations = ref(10);
const includeThinking = ref(false);

// Autonomous fields
const autoType = ref("");
const autoTask = ref("");
const projectPath = ref("");
const maxTurns = ref(30);
const budgetUsd = ref(5);
const effort = ref("high");

const effortOptions = [
  { label: "Low", value: "low" },
  { label: "Medium", value: "medium" },
  { label: "High", value: "high" },
  { label: "Max", value: "max" },
];

const reactTypeOptions = computed(() =>
  props.agentTypes.map((a) => ({ label: a.type, value: a.type })),
);
const autoTypeOptions = computed(() =>
  props.autonomousTypes.map((a) => ({ label: a.type, value: a.type })),
);

const canSubmitReact = computed(
  () => reactType.value && reactTask.value.trim(),
);
const canSubmitAuto = computed(
  () => autoType.value && autoTask.value.trim() && projectPath.value.trim(),
);

function submitReact() {
  emit("run-react", {
    agentType: reactType.value,
    task: reactTask.value,
    maxIterations: maxIterations.value,
    includeThinking: includeThinking.value,
  });
}

function submitAutonomous() {
  emit("run-autonomous", {
    type: autoType.value,
    task: autoTask.value,
    projectPath: projectPath.value,
    maxTurns: maxTurns.value,
    maxBudgetUsd: budgetUsd.value,
    effort: effort.value,
  });
}
</script>

<template>
  <div style="display: flex; flex-direction: column; gap: 0.75rem">
    <!-- ReAct form -->
    <template v-if="tab === 'react'">
      <div>
        <label
          style="
            font-size: 0.875rem;
            font-weight: 600;
            display: block;
            margin-bottom: 0.25rem;
          "
          >Agent Type</label
        >
        <Select
          v-model="reactType"
          :options="reactTypeOptions"
          optionLabel="label"
          optionValue="value"
          placeholder="Select type"
          style="width: 100%"
        />
      </div>
      <div>
        <label
          style="
            font-size: 0.875rem;
            font-weight: 600;
            display: block;
            margin-bottom: 0.25rem;
          "
          >Task</label
        >
        <Textarea
          v-model="reactTask"
          rows="3"
          style="width: 100%"
          placeholder="Describe the task..."
        />
      </div>
      <div style="display: flex; gap: 1rem; align-items: center">
        <div style="flex: 1">
          <label
            style="font-size: 0.8rem; display: block; margin-bottom: 0.25rem"
            >Max Iterations</label
          >
          <InputNumber
            v-model="maxIterations"
            :min="1"
            :max="100"
            style="width: 100%"
          />
        </div>
        <div
          style="
            display: flex;
            align-items: center;
            gap: 0.5rem;
            padding-top: 1rem;
          "
        >
          <Checkbox
            v-model="includeThinking"
            :binary="true"
            inputId="thinking"
          />
          <label for="thinking" style="font-size: 0.8rem"
            >Include thinking</label
          >
        </div>
      </div>
      <Button
        label="Run Agent"
        icon="pi pi-play"
        :loading="loading"
        :disabled="!canSubmitReact"
        @click="submitReact"
        style="align-self: flex-start"
      />
    </template>

    <!-- Autonomous form -->
    <template v-if="tab === 'autonomous'">
      <div>
        <label
          style="
            font-size: 0.875rem;
            font-weight: 600;
            display: block;
            margin-bottom: 0.25rem;
          "
          >Agent Type</label
        >
        <Select
          v-model="autoType"
          :options="autoTypeOptions"
          optionLabel="label"
          optionValue="value"
          placeholder="Select type"
          style="width: 100%"
        />
      </div>
      <div>
        <label
          style="
            font-size: 0.875rem;
            font-weight: 600;
            display: block;
            margin-bottom: 0.25rem;
          "
          >Task</label
        >
        <Textarea
          v-model="autoTask"
          rows="3"
          style="width: 100%"
          placeholder="Describe the task..."
        />
      </div>
      <div>
        <label
          style="
            font-size: 0.875rem;
            font-weight: 600;
            display: block;
            margin-bottom: 0.25rem;
          "
          >Project Path</label
        >
        <InputText
          v-model="projectPath"
          style="width: 100%"
          placeholder="/path/to/project"
        />
      </div>
      <div style="display: flex; gap: 1rem">
        <div style="flex: 1">
          <label
            style="font-size: 0.8rem; display: block; margin-bottom: 0.25rem"
            >Max Turns</label
          >
          <InputNumber
            v-model="maxTurns"
            :min="1"
            :max="100"
            style="width: 100%"
          />
        </div>
        <div style="flex: 1">
          <label
            style="font-size: 0.8rem; display: block; margin-bottom: 0.25rem"
            >Budget (USD)</label
          >
          <InputNumber
            v-model="budgetUsd"
            :min="0.01"
            :max="50"
            :minFractionDigits="2"
            mode="currency"
            currency="USD"
            style="width: 100%"
          />
        </div>
        <div style="flex: 1">
          <label
            style="font-size: 0.8rem; display: block; margin-bottom: 0.25rem"
            >Effort</label
          >
          <Select
            v-model="effort"
            :options="effortOptions"
            optionLabel="label"
            optionValue="value"
            style="width: 100%"
          />
        </div>
      </div>
      <Button
        label="Run Agent"
        icon="pi pi-play"
        :loading="loading"
        :disabled="!canSubmitAuto"
        @click="submitAutonomous"
        style="align-self: flex-start"
      />
    </template>
  </div>
</template>
