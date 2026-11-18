import type { DocumentKind, TextStatus } from "../../api/types";

export const KIND_LABEL: Record<DocumentKind, string> = {
  pdf: "PDF",
  text: "Testo",
  markdown: "Markdown",
  docx: "Word",
  image: "Immagine",
};

/** Extensions accepted for a new version of a document of the given kind. */
export const KIND_ACCEPT: Record<DocumentKind, string> = {
  pdf: ".pdf",
  text: ".txt",
  markdown: ".md,.markdown",
  docx: ".docx",
  image: ".png,.jpg,.jpeg,.gif,.webp",
};

export const STATUS_LABEL: Record<TextStatus, string> = {
  pending: "Estrazione in corso…",
  extracted: "Ricercabile",
  no_text: "Senza testo ricercabile",
  failed: "Estrazione non riuscita",
  not_applicable: "Non ricercabile",
};

/** Longer, plain explanation used as tooltip and in the viewer. */
export const STATUS_EXPLANATION: Record<TextStatus, string> = {
  pending: "Localis sta estraendo il testo per la ricerca.",
  extracted: "Il testo è stato estratto ed è incluso nella ricerca.",
  no_text:
    "Il file non contiene testo selezionabile (ad esempio un PDF scansionato). Il riconoscimento del testo (OCR) non è disponibile.",
  failed: "Non è stato possibile estrarre il testo. Il file resta consultabile.",
  not_applicable: "Le immagini non sono incluse nella ricerca.",
};
