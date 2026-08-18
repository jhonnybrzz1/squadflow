import { PDFPage, PDFFont, rgb } from 'pdf-lib';
import { designTokens, professionalLayout } from './pdf-styles';

export function drawProfessionalHeader(
  page: PDFPage,
  boldFont: PDFFont,
  font: PDFFont,
  demandId: number,
  generatedAt: Date,
  docTitle?: string,
): void {
  const layout = professionalLayout;
  const { width, height } = page.getSize();
  const brandName: string = designTokens?.brand?.displayName ?? 'AICHATflow';
  const reportLabel = docTitle ?? 'PRD Executivo';

  page.drawRectangle({
    x: 0,
    y: height - 4,
    width,
    height: 4,
    color: layout.accentColor,
  });

  page.drawRectangle({
    x: 0,
    y: height - 90,
    width,
    height: 86,
    color: layout.headerFill,
  });

  const logoX = layout.marginX;
  const logoY = height - 64;
  page.drawRectangle({
    x: logoX,
    y: logoY,
    width: 40,
    height: 40,
    color: layout.primaryColor,
  });
  page.drawText('AI', {
    x: logoX + 8,
    y: logoY + 13,
    size: 16,
    font: boldFont,
    color: layout.tableHeaderText,
  });

  page.drawText(brandName.toUpperCase(), {
    x: logoX + 50,
    y: height - 38,
    size: 10,
    font: boldFont,
    color: layout.accentColor,
  });

  page.drawText(reportLabel, {
    x: logoX + 50,
    y: height - 60,
    size: 18,
    font: boldFont,
    color: layout.primaryColor,
  });

  const idText = `ID DEMANDA: #${demandId}`;
  const dateText = `EMITIDO EM: ${generatedAt.toLocaleDateString('pt-BR')}`;

  const idWidth = font.widthOfTextAtSize(idText, 8);
  page.drawText(idText, {
    x: width - layout.marginX - idWidth,
    y: height - 38,
    size: 8,
    font: boldFont,
    color: layout.primaryColor,
  });

  const dateWidth = font.widthOfTextAtSize(dateText, 8);
  page.drawText(dateText, {
    x: width - layout.marginX - dateWidth,
    y: height - 52,
    size: 8,
    font,
    color: layout.mutedColor,
  });

  page.drawLine({
    start: { x: layout.marginX, y: height - 98 },
    end: { x: width - layout.marginX, y: height - 98 },
    thickness: 1.5,
    color: layout.borderColor,
  });
}

export function drawProfessionalFooter(
  page: PDFPage,
  font: PDFFont,
  pageNumber: number,
  totalPages?: number,
): void {
  const layout = professionalLayout;
  const { width } = page.getSize();
  const brandName: string = designTokens?.brand?.displayName ?? 'AICHATflow';

  page.drawLine({
    start: { x: layout.marginX, y: 50 },
    end: { x: width - layout.marginX, y: 50 },
    thickness: 1,
    color: layout.borderColor,
  });

  page.drawText(`${brandName.toUpperCase()} · Relatório Inteligente`, {
    x: layout.marginX,
    y: 30,
    size: 7,
    font,
    color: layout.mutedColor,
  });

  const confText = 'DOCUMENTO CONFIDENCIAL';
  const confWidth = font.widthOfTextAtSize(confText, 7);
  page.drawText(confText, {
    x: width / 2 - confWidth / 2,
    y: 30,
    size: 7,
    font,
    color: layout.mutedColor,
  });

  const pageLabel = totalPages ? `PÁGINA ${pageNumber} DE ${totalPages}` : `PÁGINA ${pageNumber}`;
  const labelWidth = font.widthOfTextAtSize(pageLabel, 7);
  page.drawText(pageLabel, {
    x: width - layout.marginX - labelWidth,
    y: 30,
    size: 7,
    font,
    color: layout.mutedColor,
  });

  page.drawRectangle({
    x: 0,
    y: 0,
    width,
    height: 4,
    color: layout.primaryColor,
  });
}

export function drawSimpleHeader(
  page: PDFPage,
  font: PDFFont,
  demandId: number,
  docType: string = 'PRD',
): void {
  const { width, height } = page.getSize();

  page.drawRectangle({
    x: 50,
    y: height - 100,
    width: 60,
    height: 60,
    color: rgb(0.95, 0.95, 0.95),
    borderColor: rgb(0.8, 0.8, 0.8),
    borderWidth: 1,
  });

  page.drawText('AICHATflow', {
    x: 120,
    y: height - 60,
    size: 24,
    font,
    color: rgb(0, 0, 0),
  });

  page.drawText(docType, {
    x: 50,
    y: height - 120,
    size: 18,
    font,
    color: rgb(0.2, 0.4, 0.6),
  });

  page.drawText(`Demand ID: ${demandId}`, {
    x: 50,
    y: height - 140,
    size: 12,
    font,
    color: rgb(0.5, 0.5, 0.5),
  });

  page.drawText(`Date: ${new Date().toLocaleDateString()}`, {
    x: 50,
    y: height - 160,
    size: 12,
    font,
    color: rgb(0.5, 0.5, 0.5),
  });

  page.drawLine({
    start: { x: 50, y: height - 180 },
    end: { x: width - 50, y: height - 180 },
    thickness: 1,
    color: rgb(0.8, 0.8, 0.8),
  });
}

export function drawSimpleFooter(page: PDFPage, font: PDFFont, pageNumber: number = 1): void {
  const { width } = page.getSize();

  page.drawLine({
    start: { x: 50, y: 50 },
    end: { x: width - 50, y: 50 },
    thickness: 1,
    color: rgb(0.8, 0.8, 0.8),
  });

  page.drawText('AICHATflow - Documento confidencial', {
    x: 50,
    y: 30,
    size: 10,
    font,
    color: rgb(0.5, 0.5, 0.5),
  });

  page.drawText(`Pagina ${pageNumber}`, {
    x: width - 100,
    y: 30,
    size: 10,
    font,
    color: rgb(0.5, 0.5, 0.5),
  });
}
