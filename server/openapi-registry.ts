import { OpenAPIRegistry, OpenApiGeneratorV3 } from '@asteasolutions/zod-to-openapi';

export const registry = new OpenAPIRegistry();

// Configurações base de autenticação
registry.registerComponent('securitySchemes', 'bearerAuth', {
  type: 'http',
  scheme: 'bearer',
  bearerFormat: 'JWT',
});

// Helper para gerar o JSON
export function generateOpenApiDocument() {
  const generator = new OpenApiGeneratorV3(registry.definitions);

  return generator.generateDocument({
    openapi: '3.0.0',
    info: {
      version: '1.0.0',
      title: 'AiChatFlow API',
      description: 'Documentação da API para a plataforma AiChatFlow (Zod-based)',
    },
    servers: [{ url: '/', description: 'Servidor atual' }],
  });
}
