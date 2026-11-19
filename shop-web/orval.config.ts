// Orval: apps/api/openapi.yaml -> TanStack Query hooks and types in libs/api-client/src/gen (committed).
// Run: npx nx run api-client:generate
import { defineConfig } from 'orval';

export default defineConfig({
  shop: {
    input: { target: './apps/api/openapi.yaml' },
    output: {
      target: './libs/api-client/src/gen/shop.ts',
      schemas: './libs/api-client/src/gen/model',
      mode: 'single',
      client: 'react-query',
      httpClient: 'fetch',
      clean: true,
      override: {
        // every request goes through our fetch: same-origin cookies, JSON, errors thrown as ApiError
        mutator: { path: './libs/api-client/src/fetcher.ts', name: 'shopFetch' },
      },
    },
  },
});
