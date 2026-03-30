import { defineStore } from "pinia";
import { ref, computed } from "vue";
import { scrollVectors, type VectorPoint } from "@/api/vectors";

export interface ProjectedPoint {
  x: number;
  y: number;
  id: string | number;
  file: string;
  language: string;
  layer: string;
  chunkType: string;
  content: string;
}

// Simple PCA: project high-dim vectors to 2D
function pca2d(vectors: number[][]): [number, number][] {
  if (vectors.length === 0) return [];
  const dim = vectors[0].length;

  // Compute mean
  const mean = new Array(dim).fill(0);
  for (const v of vectors) {
    for (let i = 0; i < dim; i++) mean[i] += v[i];
  }
  for (let i = 0; i < dim; i++) mean[i] /= vectors.length;

  // Center data
  const centered = vectors.map((v) => v.map((x, i) => x - mean[i]));

  // Power iteration for top 2 components
  function powerIteration(data: number[][], deflated?: number[]): number[] {
    let vec = Array.from({ length: dim }, () => Math.random() - 0.5);
    const norm = (v: number[]) => Math.sqrt(v.reduce((s, x) => s + x * x, 0));

    for (let iter = 0; iter < 50; iter++) {
      // A^T * A * vec  (via data)
      const projected = data.map((row) => {
        let d = row.reduce((s, x, i) => s + x * vec[i], 0);
        if (deflated)
          d -=
            deflated.reduce((s, x, i) => s + x * vec[i], 0) *
            row.reduce((s, x, i) => s + x * deflated[i], 0);
        return d;
      });
      const newVec = new Array(dim).fill(0);
      for (let i = 0; i < data.length; i++) {
        for (let j = 0; j < dim; j++) {
          newVec[j] += data[i][j] * projected[i];
        }
      }
      const n = norm(newVec);
      if (n > 0) vec = newVec.map((x) => x / n);
    }
    return vec;
  }

  const pc1 = powerIteration(centered);
  const pc2 = powerIteration(centered, pc1);

  return centered.map((row) => [
    row.reduce((s, x, i) => s + x * pc1[i], 0),
    row.reduce((s, x, i) => s + x * pc2[i], 0),
  ]);
}

export const useVectorsStore = defineStore("vectors", () => {
  const points = ref<VectorPoint[]>([]);
  const projected = ref<ProjectedPoint[]>([]);
  const loading = ref(false);
  const computing = ref(false);
  const error = ref("");
  const collection = ref("");
  const selectedPoint = ref<ProjectedPoint | null>(null);
  const colorBy = ref<"language" | "layer" | "chunkType">("language");
  const maxPoints = ref(300);

  async function loadAndProject(collectionName: string) {
    collection.value = collectionName;
    loading.value = true;
    error.value = "";
    selectedPoint.value = null;
    try {
      const result = await scrollVectors(
        collectionName,
        maxPoints.value,
        undefined,
        true,
      );
      points.value = result.points;

      // Filter points that have vectors
      const withVectors = result.points.filter(
        (p) => p.vector && p.vector.length > 0,
      );
      if (withVectors.length < 2) {
        projected.value = [];
        error.value = "Not enough vectors found for visualization";
        return;
      }

      computing.value = true;
      const vectors = withVectors.map((p) => p.vector!);
      const coords = pca2d(vectors);

      projected.value = withVectors.map((p, i) => ({
        x: coords[i][0],
        y: coords[i][1],
        id: p.id,
        file: (p.payload.file || p.payload.filePath || "") as string,
        language: (p.payload.language || "unknown") as string,
        layer: (p.payload.layer || "other") as string,
        chunkType: (p.payload.chunkType || p.payload.type || "code") as string,
        content: (p.payload.content || p.payload.text || "") as string,
      }));
    } catch (e: any) {
      error.value = e.message || "Failed to load vectors";
    } finally {
      loading.value = false;
      computing.value = false;
    }
  }

  return {
    points,
    projected,
    loading,
    computing,
    error,
    collection,
    selectedPoint,
    colorBy,
    maxPoints,
    loadAndProject,
  };
});
