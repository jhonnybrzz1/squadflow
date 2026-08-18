import { openAIService } from './services/openai-ai';

/**
 * Script to test multi-model routing.
 */
async function testMultiModel() {
  console.log('🧪 Testando Roteamento Multi-Modelo...');

  // Test 1: Default OpenAI
  console.log('\n1. Testando Modelo Padrão (OpenAI)...');
  try {
    const resp1 = await openAIService.generateResponse('Diga "OpenAI OK"');
    console.log('Resultado:', resp1);
  } catch (e: unknown) {
    console.warn('Erro (Provavelmente falta API Key):', e instanceof Error ? e.message : String(e));
  }

  // Test 2: Technical Task (should route to Codestral if key is present)
  console.log('\n2. Testando Tarefa Técnica (Codestral)...');
  try {
    const resp2 = await openAIService.generateChatCompletion(
      'Você é um assistente técnico.',
      'Explique brevemente o que é um Event Loop em JavaScript.',
      { taskType: 'technical' },
    );
    console.log('Resultado:', resp2);
  } catch (e: unknown) {
    console.warn(
      'Erro (Esperado se MISTRAL_API_KEY não estiver setada):',
      e instanceof Error ? e.message : String(e),
    );
  }

  // Test 3: Explicit Model
  console.log('\n3. Testando Modelo Explícito (Mistral)...');
  try {
    const resp3 = await openAIService.generateChatCompletion(
      'Você é um assistente.',
      'Diga "Mistral OK"',
      { model: 'codestral-latest' },
    );
    console.log('Resultado:', resp3);
  } catch (e: unknown) {
    console.warn('Erro:', e instanceof Error ? e.message : String(e));
  }

  console.log('\n✅ Teste concluído. Verifique os logs acima para confirmar o roteamento.');
}

testMultiModel().catch(console.error);
