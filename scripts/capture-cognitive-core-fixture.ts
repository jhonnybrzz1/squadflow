/**
 * Spec 10144 — Captura de fixture do cognitive-core.
 *
 * Este script gera fixtures/cognitive-core-output.fixture.json a partir de
 * uma demanda real persistida, executando o cognitive-core de verdade:
 * agentOrchestrator.createOrchestrationPlan e
 * realityBasedRefinement.getConstraintsForDemandType.
 *
 * Uso:
 *   npx tsx scripts/capture-cognitive-core-fixture.ts
 */

import '../server/db';
import * as fs from 'fs';
import * as path from 'path';
import { demandRepository } from '../server/repositories/demand-repository';
import { agentOrchestrator } from '../server/cognitive-core/agent-orchestrator';
import { RealityBasedRefinement } from '../server/cognitive-core/reality-based-refinement';
import { adaptCognitiveCoreOutput } from '../server/cognitive-core/cognitive-config-adapter';

const FIXTURE_DEMAND = {
  title: 'Refatorar módulo de autenticação para usar JWT',
  description:
    'Refatorar o módulo de autenticação atual para usar tokens JWT, eliminando sessões no servidor e melhorando escalabilidade.',
  type: 'security',
  status: 'pending',
  priority: 'alta',
  domain: 'padrao',
} as const;

async function main(): Promise<void> {
  const created = await demandRepository.create(FIXTURE_DEMAND);
  const demandId = created.id;

  // eslint-disable-next-line no-console
  console.log(`Demanda temporária criada: id=${demandId}`);

  try {
    const plan = await agentOrchestrator.createOrchestrationPlan(demandId);

    const realityBasedRefinement = new RealityBasedRefinement();
    const constraints = await realityBasedRefinement.getConstraintsForDemandType(created.type);

    const output = adaptCognitiveCoreOutput({
      demand: created,
      classification: plan.classification,
      constraints,
    });

    const fixturesDir = path.join(process.cwd(), 'fixtures');
    if (!fs.existsSync(fixturesDir)) {
      fs.mkdirSync(fixturesDir, { recursive: true });
    }

    const fixturePath = path.join(fixturesDir, 'cognitive-core-output.fixture.json');
    fs.writeFileSync(fixturePath, JSON.stringify(output, null, 2));

    // eslint-disable-next-line no-console
    console.log(`Fixture capturada em: ${fixturePath}`);
  } finally {
    await demandRepository.deleteById(demandId);
    // eslint-disable-next-line no-console
    console.log(`Demanda temporária removida: id=${demandId}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    // eslint-disable-next-line no-console
    console.error('Falha ao capturar fixture do cognitive-core:', error);
    process.exit(1);
  });
