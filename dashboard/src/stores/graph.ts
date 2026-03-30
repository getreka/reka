import { defineStore } from "pinia";
import { ref } from "vue";
import {
  fetchDependencies,
  fetchDependents,
  fetchBlastRadius,
  fetchFileExports,
} from "@/api/graph";
import type {
  GraphNode,
  GraphLink,
  BlastRadiusResult,
  LayoutMode,
  EdgeTypeFilter,
  ConfidenceFilter,
  NodeInspectorData,
} from "@/types/graph";

export const useGraphStore = defineStore("graph", () => {
  const nodes = ref<GraphNode[]>([]);
  const links = ref<GraphLink[]>([]);
  const loading = ref(false);
  const error = ref("");
  const searchFile = ref("");
  const depth = ref(2);
  const mode = ref<"deps" | "dependents" | "both">("deps");

  // Enhanced features
  const layoutMode = ref<LayoutMode>("force");
  const edgeTypeFilter = ref<EdgeTypeFilter>("all");
  const confidenceFilter = ref<ConfidenceFilter>("all");
  const selectedNode = ref<string | null>(null);
  const inspectorData = ref<NodeInspectorData | null>(null);
  const inspectorLoading = ref(false);
  const filePatternFilter = ref("");

  // Blast radius
  const blastRadius = ref<BlastRadiusResult | null>(null);
  const blastLoading = ref(false);
  const blastViewMode = ref<"list" | "graph">("list");

  async function search() {
    if (!searchFile.value) return;
    loading.value = true;
    error.value = "";
    selectedNode.value = null;
    inspectorData.value = null;
    try {
      if (mode.value === "deps" || mode.value === "both") {
        const deps = await fetchDependencies(searchFile.value, depth.value);
        nodes.value = deps.nodes;
        links.value = deps.links;
      }
      if (mode.value === "dependents") {
        const deps = await fetchDependents(searchFile.value, depth.value);
        nodes.value = deps.nodes;
        links.value = deps.links;
      }
      if (mode.value === "both") {
        const revDeps = await fetchDependents(searchFile.value, depth.value);
        const nodeMap = new Map(nodes.value.map((n) => [n.id, n]));
        for (const n of revDeps.nodes) nodeMap.set(n.id, n);
        nodes.value = Array.from(nodeMap.values());
        // Deduplicate links
        const linkSet = new Set(
          links.value.map((l) => `${l.source}->${l.target}`),
        );
        for (const l of revDeps.links) {
          const key = `${l.source}->${l.target}`;
          if (!linkSet.has(key)) {
            links.value.push(l);
            linkSet.add(key);
          }
        }
      }
    } catch (e: any) {
      error.value = e.message || "Graph search failed";
    } finally {
      loading.value = false;
    }
  }

  async function selectNode(nodeId: string) {
    selectedNode.value = nodeId;
    inspectorLoading.value = true;
    try {
      inspectorData.value = await fetchFileExports(nodeId);
    } catch {
      inspectorData.value = null;
    } finally {
      inspectorLoading.value = false;
    }
  }

  function clearSelection() {
    selectedNode.value = null;
    inspectorData.value = null;
  }

  async function analyzeBlastRadius() {
    if (!searchFile.value) return;
    blastLoading.value = true;
    try {
      blastRadius.value = await fetchBlastRadius(searchFile.value);
    } catch (e: any) {
      error.value = e.message || "Blast radius analysis failed";
    } finally {
      blastLoading.value = false;
    }
  }

  return {
    nodes,
    links,
    loading,
    error,
    searchFile,
    depth,
    mode,
    layoutMode,
    edgeTypeFilter,
    confidenceFilter,
    selectedNode,
    inspectorData,
    inspectorLoading,
    filePatternFilter,
    blastRadius,
    blastLoading,
    blastViewMode,
    search,
    selectNode,
    clearSelection,
    analyzeBlastRadius,
  };
});
