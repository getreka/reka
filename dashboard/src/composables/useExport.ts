import { saveAs } from "file-saver";

function getFilename(page: string, ext: string): string {
  const project = localStorage.getItem("rag_project") || "rag";
  const date = new Date().toISOString().slice(0, 10);
  return `${page}_${project}_${date}.${ext}`;
}

export function useExport() {
  function exportCSV(data: Record<string, any>[], page: string) {
    if (data.length === 0) return;
    const headers = Object.keys(data[0]);
    const rows = data.map((row) =>
      headers
        .map((h) => {
          const val = row[h];
          const str =
            typeof val === "object" ? JSON.stringify(val) : String(val ?? "");
          return `"${str.replace(/"/g, '""')}"`;
        })
        .join(","),
    );
    const csv = [headers.join(","), ...rows].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    saveAs(blob, getFilename(page, "csv"));
  }

  function exportJSON(data: any, page: string) {
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: "application/json;charset=utf-8" });
    saveAs(blob, getFilename(page, "json"));
  }

  async function exportPDF(element: HTMLElement, page: string) {
    const html2canvas = (await import("html2canvas")).default;
    const jsPDF = (await import("jspdf")).default;

    const canvas = await html2canvas(element, {
      scale: 2,
      useCORS: true,
      logging: false,
    });

    const imgData = canvas.toDataURL("image/png");
    const pdf = new jsPDF({
      orientation: canvas.width > canvas.height ? "landscape" : "portrait",
      unit: "px",
      format: [canvas.width, canvas.height],
    });
    pdf.addImage(imgData, "PNG", 0, 0, canvas.width, canvas.height);
    pdf.save(getFilename(page, "pdf"));
  }

  return { exportCSV, exportJSON, exportPDF };
}
