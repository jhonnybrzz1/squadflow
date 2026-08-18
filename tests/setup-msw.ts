import { setupServer } from 'msw/node';
import { HttpResponse, http } from 'msw';
import { afterAll, afterEach, beforeAll } from 'vitest';

export const handlers = [
  http.get('/api/demands', () => {
    return HttpResponse.json([{ id: 1, status: 'processing', chatMessages: [] }]);
  }),
  http.get('/api/demands/:id/events', () => {
    // Basic SSE mock
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue('data: {"status": "processing"}\n\n');
        // keep alive
      },
    });
    return new HttpResponse(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
      },
    });
  }),
  http.post('/api/demands/:id/refinement/answer', () => {
    return HttpResponse.json({ success: true });
  }),
];

export const server = setupServer(...handlers);

beforeAll(() => server.listen({ onUnhandledRequest: 'bypass' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
