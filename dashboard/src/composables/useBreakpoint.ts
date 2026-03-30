import { ref, onMounted, onUnmounted } from "vue";

export function useBreakpoint(query = "(max-width: 768px)") {
  const matches = ref(false);
  let mql: MediaQueryList | null = null;

  function update(e: MediaQueryListEvent | MediaQueryList) {
    matches.value = e.matches;
  }

  onMounted(() => {
    mql = window.matchMedia(query);
    matches.value = mql.matches;
    mql.addEventListener("change", update);
  });

  onUnmounted(() => {
    mql?.removeEventListener("change", update);
  });

  return { matches };
}
