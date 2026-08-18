# Admin Routes Documentation

## Overview

> **Nota:** A autenticação administrativa foi removida. Como o projeto roda apenas localmente na máquina do usuário, os endpoints administrativos não exigem mais `x-admin-key` nem `ADMIN_SECRET_KEY`. A rastreabilidade de auditoria continua existindo, mas com uma identidade local fixa (`Local User`).

Os endpoints a seguir executam operações destrutivas. Em um uso futuro em rede/multiusuário, a autenticação deve ser reintroduzida.

## Endpoints Administrativos

### System Endpoints (`server/routes/system.ts`)

| Method | Path                                     | Action                                       | Middleware                                    |
| ------ | ---------------------------------------- | -------------------------------------------- | --------------------------------------------- |
| POST   | `/api/ai/usage/reset`                    | Reset AI usage tracking metrics              | `adminAuditMiddleware('resetAI')`             |
| POST   | `/api/ai/cache/clear`                    | Clear AI response cache                      | `adminAuditMiddleware('clearCache')`          |
| POST   | `/api/ai/circuit-breaker/:service/reset` | Reset circuit breaker for a specific service | `adminAuditMiddleware('resetCircuitBreaker')` |

### Metrics Endpoints (`server/routes/metrics.ts`)

| Method | Path                             | Action                    | Middleware                             |
| ------ | -------------------------------- | ------------------------- | -------------------------------------- |
| POST   | `/api/metrics/performance/clear` | Clear performance metrics | `adminAuditMiddleware('clearMetrics')` |

## Auth Stub

O middleware de autenticação real (`server/middleware/admin-auth.ts` e `server/middleware/auth-context.ts`) foi substituído por `server/middleware/auth-stub.ts`, que:

- Sempre define `req.userContext` como um usuário local admin (`local-user`).
- Todos os middlewares de proteção (`adminAuthMiddleware`, `requireAuth`, `requireRole`, `secureAdminAuthMiddleware`) são no-op.
- `validateAdminKey` em `server/routes/shared.ts` sempre retorna `true`.

## Audit Logging

### Audit Middleware

O `adminAuditMiddleware` ainda registra todas as ações administrativas para rastreabilidade.

**Implementation:** `server/middleware/admin-audit.ts`

**Logged Fields:**

- `action` - The specific administrative action (e.g., `resetAI`, `clearCache`)
- `adminId` - Fixed local user ID (`local-user`)
- `adminRole` - Fixed role (`admin`)
- `adminName` - Fixed name (`Local User`)
- `isAuthenticated` - `true`
- `ip` - Client IP address (last octet anonymized for privacy, e.g., `192.168.1.x`)
- `timestamp` - ISO 8601 timestamp of the action
- `path` - Request path
- `method` - HTTP method
- `success` - Whether the operation completed successfully

**Log Format:**

```typescript
logger.info('Admin action executed', {
  context: {
    action: 'resetAI',
    adminId: 'local-user',
    adminRole: 'admin',
    adminName: 'Local User',
    isAuthenticated: true,
    ip: '192.168.1.x',
    timestamp: '2025-01-15T10:30:00.000Z',
    path: '/api/ai/usage/reset',
    method: 'POST',
    success: true,
  },
});
```

## Making Requests

### cURL Example

```bash
curl -X POST \
  http://localhost:5000/api/ai/usage/reset \
  -H 'Content-Type: application/json'
```

## Expected Behavior

### Successful Request (200)

```json
{
  "success": true
}
```

## Testing

Os testes foram ajustados para refletir o comportamento sem autenticação:

- `tests/admin-routes-security.test.ts`
- `tests/prompt-routes-auth.test.ts`
- `tests/unit/auth-stub.test.ts`

```bash
npm test -- tests/admin-routes-security.test.ts
```

## Change History

| Date       | Version | Description                                       |
| ---------- | ------- | ------------------------------------------------- |
| 2025-01-15 | 1.0.0   | Initial implementation of admin routes protection |
| 2026-06-28 | 2.0.0   | Authentication removed for local-only usage       |

---

**Document Version:** 2.0.0  
**Last Updated:** 2026-06-28
