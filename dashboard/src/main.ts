import { createApp } from "vue";
import { createPinia } from "pinia";
import PrimeVue from "primevue/config";
import Aura from "@primevue/themes/aura";
import ToastService from "primevue/toastservice";
import ConfirmationService from "primevue/confirmationservice";
import Tooltip from "primevue/tooltip";
import router from "./router";
import App from "./App.vue";

// ECharts — register all chart types and components used across dashboard
import { use } from "echarts/core";
import {
  GraphChart,
  ScatterChart,
  BarChart,
  LineChart,
  PieChart,
  GaugeChart,
  TreeChart,
} from "echarts/charts";
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
  TitleComponent,
  ToolboxComponent,
  DataZoomComponent,
  VisualMapComponent,
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";

use([
  GraphChart,
  ScatterChart,
  BarChart,
  LineChart,
  PieChart,
  GaugeChart,
  TreeChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  TitleComponent,
  ToolboxComponent,
  DataZoomComponent,
  VisualMapComponent,
  CanvasRenderer,
]);

import "primeicons/primeicons.css";
import "./assets/main.css";

const app = createApp(App);

app.use(createPinia());
app.use(router);
app.use(PrimeVue, {
  theme: {
    preset: Aura,
    options: {
      darkModeSelector: ".dark",
    },
  },
});
app.use(ToastService);
app.use(ConfirmationService);
app.directive("tooltip", Tooltip);

app.mount("#app");
