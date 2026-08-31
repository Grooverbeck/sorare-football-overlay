import type { CodegenConfig } from '@graphql-codegen/cli';
import { readFileSync } from 'node:fs';

const schemaLock = JSON.parse(readFileSync('schema/schema.lock.json', 'utf8')) as { file: string };

const config: CodegenConfig = {
  schema: `schema/${schemaLock.file}`,
  documents: [
    'src/graphql/**/*.ts',
    'src/services/mls-aa-benchmark.ts',
    'src/services/mls-market-prewarmer.ts',
  ],
  generates: {
    'src/generated/sorare.ts': {
      plugins: ['typescript', 'typescript-operations'],
      config: {
        avoidOptionals: false,
        enumsAsTypes: true,
        immutableTypes: true,
        maybeValue: 'T | null',
        useTypeImports: true,
      },
    },
  },
  ignoreNoDocuments: false,
};

export default config;
