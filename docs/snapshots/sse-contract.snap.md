# SSE Contract Snapshot

**Data:** 2026-05-09
**Versão:** 1.0
**Endpoint:** `GET /api/demands/:id/events`

## Contrato de Eventos SSE

### Sequência Mínima Obrigatória

```
started → (opcional: processing) → (opcional: progress*) → completed|error
```

### Eventos Definidos

#### 1. started (OBRIGATÓRIO - Primeiro Evento)

**Propósito:** Indica que a conexão SSE foi estabelecida com sucesso
**Timing:** Imediatamente após aceitar a conexão HTTP
**Payload:**

```json
{
  "type": "started",
  "timestamp": 1715308800000,
  "demandId": 1,
  "data": {
    "connectionId": "uuid-string",
    "message": "SSE connection established"
  }
}
```

#### 2. processing (RECOMENDADO - Antes de Trabalho Pesado)

**Propósito:** Indica que o processamento da demanda está começando
**Timing:** Antes de qualquer trabalho pesado ou lazy loading
**Payload:**

```json
{
  "type": "processing",
  "timestamp": 1715308800100,
  "demandId": 1,
  "data": {
    "message": "Starting demand processing"
  }
}
```

#### 3. progress (OPCIONAL - Atualizações de Progresso)

**Propósito:** Fornece atualizações de progresso durante o processamento
**Timing:** Durante o processamento, múltiplas vezes
**Payload:**

```json
{
  "type": "progress",
  "timestamp": 1715308800200,
  "demandId": 1,
  "data": {
    "progress": 50,
    "message": "50% complete",
    "demand": { ... }
  }
}
```

#### 4. completed (TERMINAL - Sucesso)

**Propósito:** Indica que o processamento foi concluído com sucesso
**Timing:** Ao final do processamento ou ao fechar conexão
**Payload:**

```json
{
  "type": "completed",
  "timestamp": 1715308801000,
  "demandId": 1,
  "data": {
    "message": "Demand processing completed"
  }
}
```

#### 5. error (TERMINAL - Falha)

**Propósito:** Indica que ocorreu um erro durante o processamento
**Timing:** Quando ocorre um erro fatal
**Payload:**

```json
{
  "type": "error",
  "timestamp": 1715308800500,
  "demandId": 1,
  "error": {
    "code": "ERROR_CODE",
    "message": "Error description",
    "retriable": false
  }
}
```

## Headers HTTP

### Response Headers

```
HTTP/1.1 200 OK
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
```

CRIT-7: `Access-Control-Allow-Origin` não é mais `*`. O frontend consome este
endpoint com URL relativa (same-origin, não precisa do header). Só é refletido
quando a requisição chega com um `Origin` presente na allowlist compartilhada
com o WebSocket (`webSocketOriginPolicy` / `WS_ALLOWED_ORIGINS`), e nesse caso
o servidor também envia `Vary: Origin`.

## Formato de Serialização SSE

### Formato Geral

```
event: [tipo do evento]
data: [JSON do evento]
id: [ID opcional]
retry: [retry interval em ms]

[linha em branco]
```

### Exemplo Completo

```
event: started
data: {"type":"started","timestamp":1715308800000,"demandId":1,"data":{"connectionId":"abc-123","message":"SSE connection established"}}

event: processing
data: {"type":"processing","timestamp":1715308800100,"demandId":1,"data":{"message":"Starting demand processing"}}

event: progress
data: {"type":"progress","timestamp":1715308800200,"demandId":1,"data":{"progress":25,"message":"25% complete"}}

event: completed
data: {"type":"completed","timestamp":1715308801000,"demandId":1,"data":{"message":"Demand processing completed"}}

```

## Regras de Validação

### Regras Obrigatórias

1. **Primeiro evento deve ser 'started'** - Sem exceções
2. **Último evento deve ser 'completed' ou 'error'** - Sem exceções
3. **'processing' deve vir antes de trabalho pesado** - Recomendado
4. **'error' não retriable deve ser último evento** - Sem exceções
5. **'error' retriable pode ser seguido por outros eventos** - Para retry

### Regras de Formato

1. **Cada evento deve ter 'type'** - String do tipo SSEEventType
2. **Cada evento deve ter 'timestamp'** - Number (Unix timestamp)
3. **Cada evento deve ter 'demandId'** - Number (ID da demanda)
4. **'data' é opcional** - Object com metadados adicionais
5. **'error' só presente em eventos de erro** - Object com code, message, retriable

## Comportamento em Casos de Borda

### Cliente Desconecta Durante Stream

- **Esperado:** Conexão é marcada como inativa
- **Esperado:** Recursos são limpos (timers, listeners)
- **Esperado:** Evento 'completed' pode não ser enviado
- **Não esperado:** Exceções não tratadas

### Erro na API de IA Durante Streaming

- **Esperado:** Evento 'error' é enviado com código e mensagem
- **Esperado:** Stream é fechado normalmente
- **Esperado:** Error code é estável e documentado
- **Esperado:** Flag 'retriable' indica se pode tentar novamente

### Eventos Fora de Ordem por Concorrência

- **Esperado:** Validação de sequência detecta ordem incorreta
- **Esperado:** Warning é logado
- **Esperado:** Sequência mínima é garantida pelo gerenciador

### Payload Grande / Evento Frequente

- **Esperado:** Métricas de contagem de eventos ajudam a detectar
- **Esperado:** Heartbeat mantém conexão viva
- **Esperado:** Timeout de conexão previne conexões zumbis

## Métricas Coletadas

### Métricas de Conexão

- `sse_first_event_latency_ms`: Tempo até primeiro evento
- `sse_events_per_connection`: Número de eventos por conexão
- `sse_connection_lifetime_ms`: Tempo de vida da conexão

### Métricas de Validação

- Sequência de eventos por demandId
- Validação de contrato (pass/fail)
- Erros de validação registrados

## Configurações

### Timeout e Heartbeat

- **Heartbeat interval:** 15 segundos
- **Connection timeout:** 5 minutos (300 segundos)
- **Retry interval:** 3 segundos (para reconexão automática)

### Limites

- **Máximo conexões por demandId:** Sem limite (gerenciado pelo sistema)
- **Máximo conexões totais:** Sem limite (limitado por recursos do servidor)
- **Tamanho do histórico de eventos:** Por demandId, limpo ao completar

## Implementação Atual

**Arquivos:**

- `server/services/sse/protocol.ts` - Definição de contrato e validação
- `server/services/sse/manager.ts` - Gerenciador de conexões
- `server/routes.ts` (endpoint `/api/demands/:id/events`) - Implementação HTTP

**Integrações:**

- `metrics/collector.ts` - Coleta de métricas de performance
- `utils/logger.ts` - Logging de eventos e erros

**Status:** ✅ Contrato implementado e validado
