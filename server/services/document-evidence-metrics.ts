interface BlockedEvidenceRecord {
  demandId: number;
  timestamp: string;
  invalidReferences: string[];
  issues: string[];
}

function extractInvalidReferences(issue: string): string[] {
  const markerMatch = issue.match(/(?:NÃO EXISTEM|ALUCINADOS removidos[^:]*):\s*(.+)$/i);
  if (!markerMatch) return [];

  return markerMatch[1]
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

class DocumentEvidenceMetrics {
  private records: BlockedEvidenceRecord[] = [];
  private readonly maxRecords = 500;

  recordValidation(input: { demandId: number; issues: string[] }): void {
    const invalidReferences = Array.from(
      new Set(input.issues.flatMap((issue) => extractInvalidReferences(issue))),
    );

    if (invalidReferences.length === 0) return;

    this.records.push({
      demandId: input.demandId,
      timestamp: new Date().toISOString(),
      invalidReferences,
      issues: input.issues,
    });

    if (this.records.length > this.maxRecords) {
      this.records.splice(0, this.records.length - this.maxRecords);
    }
  }

  getSummary(): {
    invalidFilesBlockedCount: number;
    invalidEvidenceBlockedDemandCount: number;
    recentInvalidEvidenceBlocks: BlockedEvidenceRecord[];
  } {
    const demandIds = new Set(this.records.map((record) => record.demandId));
    return {
      invalidFilesBlockedCount: this.records.reduce(
        (total, record) => total + record.invalidReferences.length,
        0,
      ),
      invalidEvidenceBlockedDemandCount: demandIds.size,
      recentInvalidEvidenceBlocks: this.records.slice(-10).reverse(),
    };
  }

  reset(): void {
    this.records = [];
  }
}

export const documentEvidenceMetrics = new DocumentEvidenceMetrics();
