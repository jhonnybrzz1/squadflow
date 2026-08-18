import { openAIService } from './services/openai-ai';

// This script tests the OpenAI integration
async function testOpenAI() {
  console.log('Testing OpenAI integration...');

  try {
    // Test basic chat completion
    console.log('Testing basic chat completion...');
    const response = await openAIService.generateChatCompletion(
      'You are a helpful assistant.',
      'What is the capital of France?',
      { temperature: 0.7 },
    );
    console.log('Response:', response);
    console.log('Basic chat completion test passed!');

    // Test multiple chat completions
    console.log('\nTesting multiple chat completions...');
    const responses = await openAIService.generateMultipleChatCompletions(
      [
        {
          systemPrompt: 'You are a helpful assistant.',
          userPrompt: 'What is the capital of Italy?',
        },
        {
          systemPrompt: 'You are a helpful assistant.',
          userPrompt: 'What is the capital of Germany?',
        },
      ],
      { temperature: 0.7 },
    );
    console.log('Responses:');
    responses.forEach((resp, i) => {
      console.log(`Response ${i + 1}:`, resp);
    });
    console.log('Multiple chat completions test passed!');

    // Test JSON response
    console.log('\nTesting JSON response...');
    const jsonResponse = await openAIService.generateJSONResponse(
      'You are a helpful assistant that provides information in JSON format.',
      'Provide information about France, including capital, population, and language.',
      { temperature: 0.3 },
    );
    console.log('JSON Response:', JSON.stringify(jsonResponse, null, 2));
    console.log('JSON response test passed!');

    console.log('\nAll tests passed! OpenAI integration is working correctly.');
  } catch (error) {
    console.error('Error testing OpenAI integration:', error);
    process.exit(1);
  }
}

// Run the test
testOpenAI();
