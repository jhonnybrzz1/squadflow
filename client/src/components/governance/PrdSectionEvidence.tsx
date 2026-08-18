import { useState, useMemo } from 'react';
import {
  CheckCircle2,
  XCircle,
  ChevronDown,
  ChevronUp,
  FileText,
  AlertCircle,
  CheckSquare,
  Square,
} from 'lucide-react';

interface SectionStatus {
  title: string;
  found: boolean;
  filesReferenced: string[];
  checkedManually: boolean;
}

interface PrdSectionEvidenceProps {
  prdContent: string;
  sectionChecklist: Record<string, boolean>;
  onChecklistChange?: (section: string, checked: boolean) => void;
}

const MANDATORY_SECTIONS = [
  {
    key: 'requisitos_funcionais',
    title: 'Requisitos Funcionais',
    pattern: /requisitos?\s*funcionais?/i,
  },
  {
    key: 'criterios_aceite',
    title: 'Critérios de Aceite',
    pattern: /crit[eé]rios?\s*de\s*aceite/i,
  },
  { key: 'dependencias', title: 'Dependências', pattern: /depend[eê]ncias?/i },
  { key: 'decisoes', title: 'Decisões', pattern: /decis[oõ]es?/i },
];

// Regex to extract file references from PRD content
const FILE_REFERENCE_PATTERN =
  /(?:^|[\s`'"(])((?:[A-Za-z0-9_.-]+\/)+(?:[A-Za-z0-9_.-]+(?:\.(?:ts|tsx|js|jsx|json|md|yaml|yml|sql|css|html|py|sh))?\/?))/g;

function extractFileReferences(text: string): string[] {
  const references = new Set<string>();
  let match: RegExpExecArray | null;

  while ((match = FILE_REFERENCE_PATTERN.exec(text)) !== null) {
    const candidate = match[1]
      .replace(/[),.;:!?]+$/g, '')
      .replace(/^\/+/, '')
      .trim();

    if (!candidate) continue;
    if (candidate.includes('://')) continue;
    if (candidate.includes('..')) continue;
    if (candidate.startsWith('node_modules/')) continue;

    references.add(candidate);
  }

  return Array.from(references);
}

function extractSectionContent(content: string, sectionPattern: RegExp): string {
  const lowerContent = content.toLowerCase();
  const match = sectionPattern.exec(lowerContent);
  if (!match) return '';

  const startIdx = match.index;
  // Find next section header (## or #)
  const restContent = content.slice(startIdx);
  const nextSectionMatch = restContent.match(/\n#{1,3}\s+[A-Za-zÀ-ÿ]/);
  const endIdx = nextSectionMatch
    ? startIdx + (nextSectionMatch.index || restContent.length)
    : content.length;

  return content.slice(startIdx, endIdx);
}

export function PrdSectionEvidence({
  prdContent,
  sectionChecklist,
  onChecklistChange,
}: PrdSectionEvidenceProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  const sectionStatuses = useMemo((): SectionStatus[] => {
    return MANDATORY_SECTIONS.map((section) => {
      const found = section.pattern.test(prdContent);
      const sectionContent = found ? extractSectionContent(prdContent, section.pattern) : '';
      const filesReferenced = found ? extractFileReferences(sectionContent) : [];
      const checkedManually = sectionChecklist[section.key] ?? false;

      return {
        title: section.title,
        found,
        filesReferenced,
        checkedManually,
      };
    });
  }, [prdContent, sectionChecklist]);

  const allFilesReferenced = useMemo(() => {
    const allFiles = new Set<string>();
    sectionStatuses.forEach((s) => s.filesReferenced.forEach((f) => allFiles.add(f)));
    return Array.from(allFiles);
  }, [sectionStatuses]);

  const foundCount = sectionStatuses.filter((s) => s.found).length;
  const totalCount = sectionStatuses.length;
  const allFound = foundCount === totalCount;

  const handleChecklistToggle = (sectionKey: string, currentValue: boolean) => {
    if (onChecklistChange) {
      onChecklistChange(sectionKey, !currentValue);
    }
  };

  return (
    <div className="neo-card border-2 border-[var(--border)] overflow-hidden mb-4">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center justify-between p-3 bg-[var(--muted)] hover:bg-[var(--border)] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
      >
        <div className="flex items-center gap-2">
          {allFound ? (
            <CheckCircle2 className="w-5 h-5 text-[var(--success)]" />
          ) : (
            <AlertCircle className="w-5 h-5 text-[var(--warning)]" />
          )}
          <div className="text-left">
            <h4 className="font-mono text-xs font-bold">
              EVIDÊNCIAS PRD: {foundCount}/{totalCount} SEÇÕES
            </h4>
            <p className="font-mono text-[10px] text-[var(--foreground-muted)]">
              {allFilesReferenced.length} arquivo(s) referenciado(s)
            </p>
          </div>
        </div>
        {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
      </button>

      {isExpanded && (
        <div className="p-3 border-t-2 border-[var(--border)] space-y-3">
          {sectionStatuses.map((section, idx) => (
            <div
              key={idx}
              className={`p-2 border-l-4 ${
                section.found
                  ? 'border-[var(--success)] bg-[var(--success)]/5'
                  : 'border-[var(--destructive)] bg-[var(--destructive)]/5'
              }`}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  {section.found ? (
                    <CheckCircle2 className="w-4 h-4 text-[var(--success)]" />
                  ) : (
                    <XCircle className="w-4 h-4 text-[var(--destructive)]" />
                  )}
                  <span className="font-mono text-xs font-bold">{section.title}</span>
                </div>
                {onChecklistChange && (
                  <button
                    onClick={() =>
                      handleChecklistToggle(MANDATORY_SECTIONS[idx].key, section.checkedManually)
                    }
                    className="flex items-center gap-1 text-[var(--foreground-muted)] hover:text-[var(--foreground)] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
                    title="Marcar como revisado manualmente"
                  >
                    {section.checkedManually ? (
                      <CheckSquare className="w-4 h-4 text-[var(--accent-cyan)]" />
                    ) : (
                      <Square className="w-4 h-4" />
                    )}
                    <span className="font-mono text-[10px]">Revisado</span>
                  </button>
                )}
              </div>

              {section.found && section.filesReferenced.length > 0 && (
                <div className="mt-2 pl-6">
                  <p className="font-mono text-[10px] text-[var(--foreground-muted)] mb-1">
                    Arquivos referenciados:
                  </p>
                  <div className="flex flex-wrap gap-1">
                    {section.filesReferenced.map((file, fileIdx) => (
                      <span
                        key={fileIdx}
                        className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-[var(--muted)] border border-[var(--border)] font-mono text-[10px]"
                      >
                        <FileText className="w-3 h-3" />
                        {file}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {!section.found && (
                <p className="mt-1 pl-6 font-mono text-[10px] text-[var(--destructive)]">
                  Seção obrigatória não encontrada no documento
                </p>
              )}
            </div>
          ))}

          {allFilesReferenced.length > 0 && (
            <div className="pt-3 border-t border-[var(--border)] border-dashed">
              <h5 className="font-mono text-[10px] font-bold text-[var(--foreground-muted)] mb-2">
                TODOS OS ARQUIVOS REFERENCIADOS ({allFilesReferenced.length})
              </h5>
              <div className="flex flex-wrap gap-1">
                {allFilesReferenced.map((file, idx) => (
                  <span
                    key={idx}
                    className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-[var(--background)] border border-[var(--border)] font-mono text-[10px]"
                  >
                    <FileText className="w-3 h-3" />
                    {file}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
