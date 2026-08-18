import fs from 'node:fs';
import path from 'node:path';

const [resultFile = 'artifacts/prompt-eval.json', baselineFile = 'docs/evaluation-baseline.json'] =
  process.argv.slice(2);
const readJson = (file) => JSON.parse(fs.readFileSync(path.resolve(process.cwd(), file), 'utf8'));

const result = readJson(resultFile);
const baseline = readJson(baselineFile);
const failures = [];

for (const criterion of ['completude', 'precisao', 'aderencia', 'overall']) {
  const floor = baseline.calibration[criterion] - baseline.maxRegression;
  if (result.calibration[criterion] < floor) {
    failures.push(
      `${criterion}: ${result.calibration[criterion].toFixed(2)} abaixo do limite ${floor.toFixed(2)}`,
    );
  }
}
if (result.concordanceRate < baseline.minimumConcordanceRate) {
  failures.push(
    `concordanceRate: ${result.concordanceRate.toFixed(3)} abaixo de ${baseline.minimumConcordanceRate}`,
  );
}

if (failures.length > 0) {
  console.error(`Regressão de prompt detectada:\n- ${failures.join('\n- ')}`);
  process.exitCode = 1;
} else {
  console.log('Prompt eval aprovado contra o baseline versionado.');
}
