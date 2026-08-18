#!/usr/bin/env python3
"""
M-2 RAG — Avaliação de geração com RAGAS e fallback LLM-as-judge.

O script tenta usar `ragas` (versão 0.1.22) para faithfulness e context_precision.
Se o pacote ragas não estiver instalado ou retornar NaN/falha, faz fallback para
juiz LLM via OpenAI, garantindo que o job scheduled sempre produza um JSON.

Entrada:
  docs/golden-rag.json (query, relevantSourceKeys, notes)
  docs/evaluate-generation-dataset.json (opcional) com contextos e respostas reais.

Saída:
  docs/evaluate-generation-report.json

Uso:
  python3 scripts/evaluate-generation.py [--smoke] [--output PATH]

Exemplo de evaluate-generation-dataset.json:
[
  {
    "id": "rag-01",
    "query": "...",
    "contexts": ["trecho 1", "trecho 2"],
    "answer": "resposta gerada"
  }
]
"""

import json
import os
import sys
import argparse
from datetime import datetime, timezone
from pathlib import Path

REPORT_VERSION = "1.0.0"
JUDGE_MODEL = os.environ.get("RAGAS_JUDGE_MODEL", "gpt-4o-mini")
RAGAS_VERSION = "0.1.22"
DEFAULT_OUTPUT = Path(__file__).resolve().parent.parent / "docs" / "evaluate-generation-report.json"
GOLDEN_PATH = Path(__file__).resolve().parent.parent / "docs" / "golden-rag.json"
DATASET_PATH = Path(__file__).resolve().parent.parent / "docs" / "evaluate-generation-dataset.json"


def load_json(path: Path) -> dict | list:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def write_json(path: Path, data: dict) -> None:
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2, default=str)


def build_stub_dataset(golden: dict) -> list[dict]:
    """Gera dataset stub quando não há evaluate-generation-dataset.json."""
    samples = []
    for case in golden.get("cases", []):
        samples.append({
            "id": case["id"],
            "query": case["query"],
            "contexts": [f"Contexto recuperado para: {case['query']}", str(case.get("notes", ""))],
            "answer": f"Resposta para '{case['query']}': depende dos documentos relevantes listados em {case.get('relevantSourceKeys', [])}.",
        })
    return samples


def llm_judge_score(prompt: str) -> float | None:
    """Fallback: chama OpenAI para retornar um score 0.0-1.0."""
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        return None

    try:
        from openai import OpenAI
        client = OpenAI(api_key=api_key)
        response = client.chat.completions.create(
            model=JUDGE_MODEL,
            temperature=0.0,
            messages=[
                {
                    "role": "system",
                    "content": (
                        "Você é um juiz de avaliação RAG. Responda apenas com um número "
                        "decimal entre 0.0 e 1.0, sem explicações."
                    ),
                },
                {"role": "user", "content": prompt},
            ],
        )
        content = response.choices[0].message.content.strip()
        # Extrai primeiro número decimal encontrado
        for token in content.replace(",", ".").split():
            try:
                return max(0.0, min(1.0, float(token)))
            except ValueError:
                continue
        return None
    except Exception as exc:
        print(f"  ⚠ LLM judge error: {exc}", file=sys.stderr)
        return None


def evaluate_with_llm_judge(samples: list[dict]) -> dict:
    samples_out = []
    faithfulness_scores = []
    context_precision_scores = []

    for sample in samples:
        f_prompt = (
            f"Pergunta: {sample['query']}\n\n"
            f"Contexto recuperado:\n" + "\n".join(sample["contexts"]) + "\n\n"
            f"Resposta gerada: {sample['answer']}\n\n"
            "Avalie a FAITHFULNESS (fidelidade): a resposta é totalmente fundamentada no contexto, "
            "sem informações inventadas ou não suportadas. 1.0 = perfeitamente fiel; 0.0 = totalmente alucinada."
        )
        cp_prompt = (
            f"Pergunta: {sample['query']}\n\n"
            f"Contexto recuperado:\n" + "\n".join(sample["contexts"]) + "\n\n"
            "Avalie a CONTEXT PRECISION: a proporção do contexto recuperado que é realmente relevante "
            "para responder a pergunta. 1.0 = todo contexto é relevante; 0.0 = nenhum contexto é relevante."
        )

        f = llm_judge_score(f_prompt)
        cp = llm_judge_score(cp_prompt)

        samples_out.append({
            "id": sample["id"],
            "query": sample["query"],
            "faithfulness_score": f,
            "context_precision_score": cp,
        })
        if f is not None:
            faithfulness_scores.append(f)
        if cp is not None:
            context_precision_scores.append(cp)

    return {
        "error": None,
        "ragas_version": None,
        "judge_model": JUDGE_MODEL,
        "evaluation_backend": "llm_as_judge",
        "samples": samples_out,
        "summary": {
            "count": len(samples_out),
            "mean_faithfulness": sum(faithfulness_scores) / len(faithfulness_scores) if faithfulness_scores else None,
            "mean_context_precision": sum(context_precision_scores) / len(context_precision_scores) if context_precision_scores else None,
            "thresholds": {
                "faithfulness": 0.7,
                "context_precision": 0.7,
            },
        },
    }


def evaluate_with_ragas(samples: list[dict]) -> dict:
    try:
        from datasets import Dataset
        from ragas import evaluate
        from ragas.metrics import faithfulness, context_precision
        from ragas.llms import LangchainLLMWrapper
        from langchain_openai import ChatOpenAI
    except ImportError as exc:
        return {
            "error": "ragas_import_failed",
            "error_message": str(exc),
            "ragas_version": None,
            "judge_model": JUDGE_MODEL,
            "samples": [],
            "summary": {},
            "evaluation_backend": "ragas",
        }

    os.environ.setdefault("OPENAI_MODEL_NAME", JUDGE_MODEL)

    try:
        llm = ChatOpenAI(model=JUDGE_MODEL, temperature=0.0)
        evaluator_llm = LangchainLLMWrapper(llm)

        dataset = Dataset.from_dict({
            "question": [s["query"] for s in samples],
            "answer": [s["answer"] for s in samples],
            "contexts": [s["contexts"] for s in samples],
            "ground_truth": [""] * len(samples),
        })

        result = evaluate(
            dataset,
            metrics=[faithfulness, context_precision],
            llm=evaluator_llm,
        )

        scores = result.to_pandas().to_dict(orient="records")
        samples_out = []
        faithfulness_scores = []
        context_precision_scores = []

        for idx, sample in enumerate(samples):
            row = scores[idx] if idx < len(scores) else {}
            f = row.get("faithfulness")
            cp = row.get("context_precision")
            # Convert NaN to None
            if f is not None and (isinstance(f, float) and f != f):
                f = None
            if cp is not None and (isinstance(cp, float) and cp != cp):
                cp = None
            samples_out.append({
                "id": sample["id"],
                "query": sample["query"],
                "faithfulness_score": float(f) if f is not None else None,
                "context_precision_score": float(cp) if cp is not None else None,
            })
            if f is not None:
                faithfulness_scores.append(float(f))
            if cp is not None:
                context_precision_scores.append(float(cp))

        # Se todos os scores forem None/NaN, considera falha silenciosa
        if not faithfulness_scores and not context_precision_scores:
            raise ValueError("RAGAS retornou todos os scores como NaN/None")

        return {
            "error": None,
            "ragas_version": RAGAS_VERSION,
            "judge_model": JUDGE_MODEL,
            "evaluation_backend": "ragas",
            "samples": samples_out,
            "summary": {
                "count": len(samples_out),
                "mean_faithfulness": sum(faithfulness_scores) / len(faithfulness_scores) if faithfulness_scores else None,
                "mean_context_precision": sum(context_precision_scores) / len(context_precision_scores) if context_precision_scores else None,
                "thresholds": {
                    "faithfulness": 0.7,
                    "context_precision": 0.7,
                },
            },
        }
    except Exception as exc:
        return {
            "error": "ragas_evaluation_failed",
            "error_message": str(exc),
            "ragas_version": RAGAS_VERSION,
            "judge_model": JUDGE_MODEL,
            "evaluation_backend": "ragas",
            "samples": [],
            "summary": {},
        }


def evaluate_samples(samples: list[dict]) -> dict:
    ragas_report = evaluate_with_ragas(samples)
    if ragas_report.get("error") or (
        ragas_report.get("summary", {}).get("mean_faithfulness") is None
        and ragas_report.get("summary", {}).get("mean_context_precision") is None
    ):
        print("  ⚠ RAGAS indisponível ou retornou NaN; usando LLM-as-judge fallback", file=sys.stderr)
        return evaluate_with_llm_judge(samples)
    return ragas_report


def main():
    parser = argparse.ArgumentParser(description="RAG generation evaluation with RAGAS")
    parser.add_argument("--smoke", action="store_true", help="Run only first 5 cases")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT, help="Output report path")
    args = parser.parse_args()

    report = {
        "version": REPORT_VERSION,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "mode": "smoke" if args.smoke else "full",
        "ragas_version": RAGAS_VERSION,
        "judge_model": JUDGE_MODEL,
    }

    if not GOLDEN_PATH.exists():
        report["error"] = "golden_set_missing"
        report["error_message"] = f"Golden set não encontrado: {GOLDEN_PATH}"
        write_json(args.output, report)
        print(json.dumps(report, indent=2))
        sys.exit(0)

    golden = load_json(GOLDEN_PATH)
    cases = golden.get("cases", [])
    if args.smoke:
        cases = cases[:5]

    if not cases:
        report["error"] = "empty_dataset"
        report["error_message"] = "Nenhum caso encontrado no golden set"
        write_json(args.output, report)
        print(json.dumps(report, indent=2))
        sys.exit(0)

    if DATASET_PATH.exists():
        dataset = load_json(DATASET_PATH)
        if not isinstance(dataset, list):
            dataset = []
    else:
        dataset = build_stub_dataset({"cases": cases})

    if args.smoke:
        dataset = dataset[:5]

    eval_report = evaluate_samples(dataset)
    report.update(eval_report)

    if report.get("error"):
        report["passed"] = False
    else:
        s = report.get("summary", {})
        report["passed"] = (
            (s.get("mean_faithfulness") or 0) >= 0.7
            and (s.get("mean_context_precision") or 0) >= 0.7
        )

    write_json(args.output, report)
    print(json.dumps(report, indent=2))
    sys.exit(0)


if __name__ == "__main__":
    main()
