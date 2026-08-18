#!/usr/bin/env python3
"""Extrai e categoriza ocorrencias de style={{ }} em client/src/."""
import csv
import os
import re
from pathlib import Path

ROOT = Path("client/src")
OUT = Path("docs/inline-styles-audit.csv")

def extract_style_blocks(text):
    """Retorna lista de (linha_inicio, snippet) para cada style={{...}}."""
    results = []
    pattern = re.compile(r'style=\{\{')
    for m in pattern.finditer(text):
        start = m.start()
        brace_count = 2  # ja vimos {{
        pos = start + len('style={{')
        while pos < len(text) and brace_count > 0:
            ch = text[pos]
            if ch == '{':
                brace_count += 1
            elif ch == '}':
                brace_count -= 1
            pos += 1
        snippet = text[start:pos]
        line = text.count('\n', 0, start) + 1
        results.append((line, snippet.strip()))
    return results

def classify(snippet: str) -> str:
    """Classifica em dinamico, tematico ou estatico."""
    # Remove quebras de linha para analise
    flat = ' '.join(snippet.split())

    # Dinamico: interpolacao, props/estado, dados, variaveis de objeto
    if re.search(r'\$\{|\b(agent|status|documentConfig|member|config|readiness|item|percentage|progress|typeColor|skillShUrl|isActive|isGoLive|isSelected|isSelectionMode|color|borderColor|backgroundColor)\b', flat):
        return 'dinamico'

    # Tematico: var(--*) fixo
    if re.search(r"var\(--[a-zA-Z0-9_-]+\)", flat):
        return 'tematico'

    return 'estatico'

def main():
    OUT.parent.mkdir(parents=True, exist_ok=True)
    rows = []
    for ext in ('*.tsx', '*.ts', '*.jsx', '*.js'):
        for path in ROOT.rglob(ext):
            text = path.read_text(encoding='utf-8')
            for line, snippet in extract_style_blocks(text):
                rows.append({
                    'arquivo': str(path),
                    'linha': line,
                    'trecho': snippet,
                    'tipo': classify(snippet),
                })

    with OUT.open('w', newline='', encoding='utf-8') as f:
        writer = csv.DictWriter(f, fieldnames=['arquivo', 'linha', 'trecho', 'tipo'])
        writer.writeheader()
        writer.writerows(rows)

    print(f"Audit salvo em {OUT} ({len(rows)} ocorrencias)")

if __name__ == '__main__':
    main()
