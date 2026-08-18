# Task Classification Heuristics

## Overview

The task classifier (`server/services/task-classifier.ts`) uses a heuristic approach to categorize AI requests into complexity levels. This enables the request telemetry system to aggregate cost, latency, and error data by task type without requiring external ML services.

## Categories

| Category       | Description                                                      | Typical Token Range  |
| -------------- | ---------------------------------------------------------------- | -------------------- |
| `simple`       | Greetings, yes/no questions, status checks, basic lookups        | ≤200 tokens          |
| `intermediate` | Standard queries, single-topic analysis, moderate prompts        | 200-600 tokens       |
| `complex`      | Multi-step analysis, code generation, long context, architecture | 600-2000+ tokens     |
| `critical`     | Production deployments, security, compliance, financial ops      | Any (keyword-driven) |
| `unknown`      | Cannot classify with confidence, or classification is disabled   | N/A                  |

## Signals Used

The classifier combines 5 independent signals:

### 1. Token Count (weight: 1-3 points)

- ≤50 tokens → `simple` +3
- 51-200 tokens → `simple` +1, `intermediate` +1
- 201-600 tokens → `intermediate` +2
- 601-1500 tokens → `complex` +2
- > 1500 tokens → `complex` +3

### 2. Keyword Matching (weight: 1-4 points)

**Critical keywords** (deploy, security, compliance, financial, migration, PII, downtime):

- ≥2 matches → `critical` +4
- 1 match → `critical` +2

**Complex keywords** (refactor, architecture, implement, analysis, integration, performance, pipeline, requirements, microservices):

- ≥3 matches → `complex` +4
- 1-2 matches → `complex` +2

**Simple keywords** (greetings, thanks, yes/no, what is, list, show, status, summary):

- ≥2 matches → `simple` +3
- 1 match → `simple` +1

### 3. Operation Type (weight: 1-2 points)

- `classification`, `cache` → `simple` +2
- `embedding` → `simple` +1
- `document`, `prd` → `complex` +2
- `agent_interaction` → `intermediate` +1, `complex` +1

### 4. Internal TaskType Hint (weight: 1-2 points)

If the code already provides a `taskType` via `GenerateOptions`:

- `classification`, `json`, `simple` → `simple` +2
- `analysis`, `document`, `generation` → `complex` +2
- `technical` → `complex` +1, `critical` +1

### 5. Prompt Structure (weight: 1-2 points)

- Has code blocks (```) → `complex` +2
- Has JSON structure → `intermediate` +1
- Has ≥3 question marks → `intermediate` +1, `complex` +1
- Has >20 lines → `complex` +1

## Confidence Scoring

The confidence score is the ratio of the winning category's score to the total score sum:

```
confidence = topScore / totalScore
```

Special rules:

- If the top two scores are within 1 point of each other AND topScore < 4, confidence is capped at 0.4
- If topScore < 3, the result defaults to `intermediate` with confidence 0.5
- Maximum confidence is capped at 1.0

## Feature Flag

- **Environment variable:** `CLASSIFICATION_ENABLED=true|false`
- **Default:** `false` (classification returns `unknown` with confidence 0)
- **Auto-disable:** If accuracy drops below 60% after 200+ labeled requests, classification is automatically disabled and logged as a warning

## Validation

A ground truth fixture (`tests/fixtures/classification_ground_truth.json`) contains 50 manually-labeled requests. Target accuracy: ≥70%.

Run validation:

```bash
npm test -- tests/task-classifier.test.ts
```

## API Usage

### Providing task_type for the experiment

When creating a demand via `/api/demands/cognitive`, include an optional `task_type` field:

```json
{
  "title": "Fix login bug",
  "description": "...",
  "task_type": "simple"
}
```

Valid values: `simple`, `intermediate`, `complex`, `critical`, `unknown`

Invalid values are logged but don't cause errors.

### Viewing metrics

```bash
curl -H "X-Admin-Key: YOUR_KEY" http://localhost:5000/api/admin/metrics?days=14
```

Returns aggregated metrics by task_type and model, including classification accuracy comparison between inferred and provided labels.

## Architecture Decision

This heuristic approach was chosen over ML-based classification (e.g., Cohere Classify) because:

1. **Zero external dependencies** — runs locally with no API calls
2. **< 1ms latency** — no network overhead
3. **Deterministic** — same input always produces same output
4. **Transparent** — signals are logged for debugging
5. **PRD constraint** — "Não Fazer: Roteador baseado em modelo de ML"

The heuristic will be refined based on the accuracy comparison between inferred and manually-provided labels after 2 weeks of data collection.
