import { useToast as usePrimeToast } from "primevue/usetoast";

export function useToast() {
  const toast = usePrimeToast();

  function success(summary: string, detail?: string) {
    toast.add({ severity: "success", summary, detail, life: 3000 });
  }

  function error(summary: string, detail?: string) {
    toast.add({ severity: "error", summary, detail, life: 5000 });
  }

  function info(summary: string, detail?: string) {
    toast.add({ severity: "info", summary, detail, life: 3000 });
  }

  return { success, error, info };
}
