import { watch } from "vue";
import { useAppStore } from "@/stores/app";

export function useProjectWatch(reload: () => void) {
  const app = useAppStore();
  watch(
    () => app.currentProject,
    () => {
      if (app.currentProject) reload();
    },
  );
}
