/** @type {import('jest').Config} */
const tsJestTransform = {
  '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json', isolatedModules: true }],
};

module.exports = {
  projects: [
    {
      displayName: 'unit',
      testEnvironment: 'node',
      rootDir: __dirname,
      testMatch: ['<rootDir>/tests/unit/**/*.test.ts'],
      transform: tsJestTransform,
    },
    {
      displayName: 'integration',
      testEnvironment: 'node',
      rootDir: __dirname,
      testMatch: ['<rootDir>/tests/integration/**/*.test.ts'],
      transform: tsJestTransform,
      globalSetup: '<rootDir>/tests/setup/globalSetup.ts',
      globalTeardown: '<rootDir>/tests/setup/globalTeardown.ts',
      setupFilesAfterEnv: ['<rootDir>/tests/setup/afterEnv.ts'],
    },
  ],
  // The stress tests deliberately queue hundreds of lock waiters; the default
  // 5s timeout would fire before Postgres finished draining the queue.
  testTimeout: 120_000,
  // Surface a hanging pool instead of letting Jest exit silently.
  detectOpenHandles: false,
  verbose: true,
};
