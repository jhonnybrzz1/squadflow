import client from 'prom-client';

export const githubContentIndexedTotal = new client.Counter({
  name: 'github_content_indexed_total',
  help: 'GitHub text files accepted for use as grounded content',
  labelNames: ['source'],
  registers: [],
});

export const githubContentIndexFailureTotal = new client.Counter({
  name: 'github_content_index_failure_total',
  help: 'GitHub content rejected or unavailable by bounded reason',
  labelNames: ['reason'],
  registers: [],
});
