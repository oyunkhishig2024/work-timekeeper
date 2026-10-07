import { resolve } from "node:path";
import PDFDocument from "pdfkit";
import QRCode from "qrcode";

// DejaVu Sans covers the full Cyrillic range including Ү ү Ө ө (see assets/fonts/README.md).
const FONT_REGULAR = resolve(__dirname, "../../assets/fonts/DejaVuSans.ttf");
const FONT_BOLD = resolve(__dirname, "../../assets/fonts/DejaVuSans-Bold.ttf");

export interface ConsentFormData {
  organization: string;
  employeeName: string;
  employeeNo: string;
  department: string;
  location: string;
  formCode: string;
  textVersion: string;
  isDraft: boolean;
  /** YYYY-MM-DD */
  printedOn: string;
  title: string;
  paragraphs: string[];
}

const LINE = "____________";

/** Renders one A4 page per form: pre-filled employee block, the consent text, and signature lines (PRD 15.4). */
export async function renderConsentForms(forms: ConsentFormData[]): Promise<Buffer> {
  const doc = new PDFDocument({
    size: "A4",
    margins: { top: 50, left: 56, right: 56, bottom: 20 },
    info: { Title: "Consent forms", Producer: "Timekeeper Work" },
    autoFirstPage: false,
  });
  const chunks: Buffer[] = [];
  doc.on("data", (chunk: Buffer) => chunks.push(chunk));
  const finished = new Promise<Buffer>((resolveDone, reject) => {
    doc.on("end", () => resolveDone(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
  doc.registerFont("regular", FONT_REGULAR);
  doc.registerFont("bold", FONT_BOLD);

  for (const form of forms) {
    doc.addPage();
    const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const qr = await QRCode.toBuffer(form.formCode, { margin: 1, width: 110 });

    if (form.isDraft) {
      doc
        .font("bold")
        .fontSize(9)
        .fillColor("#b00020")
        .text("ЖИШЭЭ ХУВИЛБАР — ХУУЛЬЧИЙН ХЯНАЛТГҮЙ. БОДИТ ХЭРЭГЛЭЭНД ХЭРЭГЛЭХГҮЙ.", { width })
        .fillColor("black");
      doc.moveDown(0.5);
    }

    const top = doc.y;
    doc.image(qr, doc.page.margins.left + width - 92, top, { width: 92 });
    doc
      .font("bold")
      .fontSize(13)
      .text(form.title, doc.page.margins.left, top, { width: width - 110 });
    doc.moveDown(0.8);

    doc.font("regular").fontSize(10);
    const field = (label: string, value: string) =>
      doc
        .font("bold")
        .text(`${label} `, { continued: true, width: width - 110 })
        .font("regular")
        .text(value);
    field("Байгууллага:", form.organization);
    field("Ажилтны овог, нэр:", `${form.employeeName}    Ажилтны код: ${form.employeeNo}`);
    field("Хэлтэс:", `${form.department}    Үндсэн салбар: ${form.location}`);
    field("Маягтын дугаар:", `${form.formCode}    Хувилбар: ${form.textVersion}`);
    field("Хэвлэсэн огноо:", form.printedOn);

    doc.y = Math.max(doc.y, top + 100) + 8;
    doc.x = doc.page.margins.left;
    doc
      .moveTo(doc.page.margins.left, doc.y)
      .lineTo(doc.page.margins.left + width, doc.y)
      .strokeColor("#999")
      .stroke();
    doc.moveDown(0.8);

    doc.font("regular").fontSize(10.5).fillColor("black");
    for (const paragraph of form.paragraphs) {
      doc.text(paragraph, { width, align: "left", lineGap: 2 });
      doc.moveDown(0.5);
    }

    doc.moveDown(1.2);
    doc.fontSize(10.5);
    doc.text(`Ажилтны гарын үсэг: ${LINE}   Огноо: ${LINE}`, { width });
    doc.moveDown(1.2);
    doc.text(`Хүлээн авсан Хүний нөөцийн ажилтан: ${LINE}`, { width });
    doc.moveDown(0.8);
    doc.text(`Гарын үсэг: ${LINE}   Огноо: ${LINE}`, { width });
    doc.moveDown(1);
    doc
      .font("regular")
      .fontSize(9)
      .fillColor("#444")
      .text("Энэ хуудсыг ажилтны хөдөлмөрийн гэрээний хамт хавсаргаж хадгална.", { width });

    // Footer: written in the bottom margin, so the bottom margin is released for these two calls.
    const bottomMargin = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc
      .fontSize(8)
      .fillColor("#666")
      .text(
        `${form.formCode} · ${form.textVersion} · ${form.employeeNo}`,
        doc.page.margins.left,
        doc.page.height - 34,
        {
          width,
          align: "center",
          lineBreak: false,
        },
      );
    doc.page.margins.bottom = bottomMargin;
    doc.fillColor("black");
  }

  doc.end();
  return finished;
}
