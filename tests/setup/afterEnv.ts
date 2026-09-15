import { applyTestEnv } from './env';

// globalSetup runs in a separate process, so the env must be applied again
// inside each test worker before any application module reads it.
applyTestEnv();
